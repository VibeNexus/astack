/**
 * SyncService — the two-copy shuttle between upstream mirror and working copy.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     Two-copy model                              │
 * │                                                                 │
 * │                     remote git repo                             │
 * │                         │     ▲                                 │
 * │               git pull  │     │  git commit+push                │
 * │                         ▼     │                                 │
 * │       ~/.astack/repos/<name>/   ← upstream mirror [UPSTREAM]    │
 * │                         │     ▲                                 │
 * │                 fs copy │     │  fs copy                        │
 * │                   [PULL]▼     │  [PUSH]                         │
 * │       <project>/.claude/...   ← working copy [WORKING]          │
 * │                                                                 │
 * │  PULL path:  remote  → upstream  → working                      │
 * │  PUSH path:  working → upstream  → remote                       │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Conflict detection (3-way hash):
 *   L = hash(working copy)
 *   U = hash(upstream mirror at time of last sync)
 *   R = hash(upstream mirror after fresh pull)
 *   - L==U, U==R : synced
 *   - L==U, U!=R : behind        → pull is safe (no local edits)
 *   - L!=U, U==R : local-ahead   → push is safe (upstream unchanged)
 *   - L!=U, U!=R : conflict      → block; require resolve()
 *
 * `last_synced version` = the sync_log's to_version (the upstream hash that
 * was active when we last successfully pulled/pushed this skill).
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  ResolveStrategy,
  type ResolveStrategy as ResolveStrategyT,
  SubscriptionState,
  type SubscriptionState as SubscriptionStateT,
  SkillType,
  type Skill,
  type SkillRepo,
  type Subscription,
  type SubscriptionWithState,
  type SyncLog
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { RepoRepository } from "../db/repos.js";
import { SkillRepository } from "../db/skills.js";
import { SyncLogRepository } from "../db/sync-logs.js";
import type { EventBus } from "../events.js";
import {
  copyFile,
  hashDir,
  hashFile,
  isDir,
  isFile,
  mirrorDir
} from "../fs-util.js";
import { gitCommitAndPush, gitGetHead, gitPull } from "../git.js";
import { projectBootstrapLockKey, type LockManager } from "../lock.js";
import type { Logger } from "../logger.js";

import type { ProjectService } from "./project.js";
import type { SubscriptionService } from "./subscription.js";

export interface SyncServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  locks: LockManager;
  projects: ProjectService;
  subscriptions: SubscriptionService;
  /** For commit author on push. */
  gitAuthor: { name: string; email: string };
  /** Override git ops in tests. */
  gitImpl?: {
    pull(p: string): Promise<void>;
    commitAndPush(
      p: string,
      msg: string,
      author: { name: string; email: string }
    ): Promise<string>;
  };
  /** For building conflict-resolve URL in events. */
  resolveUrl?: (projectId: number, skillId: number) => string;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface SyncOutcome {
  skill: Skill;
  state: SubscriptionStateT;
  log: SyncLog;
}

export interface PushOutcome extends SyncOutcome {
  new_version: string | null;
}

export interface ComputedSyncState {
  state: SubscriptionStateT;
  state_detail?: string;
  /** hash of working copy (sha256). null if file absent. */
  local: string | null;
  /** hash of upstream file/dir. */
  upstream: string | null;
  /** hash of last-synced version (from sync_logs). */
  base: string | null;
}

export class SyncService {
  private readonly repos: RepoRepository;
  private readonly skills: SkillRepository;
  private readonly logs: SyncLogRepository;
  private readonly git: NonNullable<SyncServiceDeps["gitImpl"]>;
  private readonly now: () => Date;

  constructor(private readonly deps: SyncServiceDeps) {
    this.repos = new RepoRepository(deps.db);
    this.skills = new SkillRepository(deps.db);
    this.logs = new SyncLogRepository(deps.db);
    this.git =
      deps.gitImpl ?? {
        pull: gitPull,
        commitAndPush: gitCommitAndPush
      };
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- PULL (upstream → working) ----------

  /**
   * Pull a single (project, skill) from upstream to working copy.
   *
   * - Takes the per-repo lock.
   * - Computes 3-way state; if conflict, records a conflict log and throws.
   * - Otherwise copies upstream file/dir to working copy and logs success.
   */
  async pullOne(
    projectId: number,
    skillId: number,
    opts: { force?: boolean } = {}
  ): Promise<SyncOutcome> {
    const project = this.deps.projects.mustFindById(projectId);
    const skill = this.mustFindSkill(skillId);
    const repo = this.mustFindRepo(skill.repo_id);

    return this.deps.locks.withLock(repo.id, async () => {
      if (!repo.local_path) {
        throw new AstackError(
          ErrorCode.REPO_STRUCTURE_INVALID,
          "repo has no local clone path",
          { repo_id: repo.id }
        );
      }

      // Always refresh the upstream mirror so we see the latest remote HEAD.
      // `opts.force` is reserved for future use (e.g. bypass local cache);
      // we keep it as a parameter for API parity but currently always pull.
      void opts.force;
      await this.git.pull(repo.local_path);

      const upstreamHead = await this.readRepoHead(repo);
      // Persist the refreshed HEAD back into SQLite so computeState sees
      // the truth (repo.head_hash is otherwise stale from register time).
      this.repos.updateSyncState(repo.id, {
        head_hash: upstreamHead,
        last_synced: this.now().toISOString()
      });
      const freshRepo = this.repos.findById(repo.id) ?? repo;
      const computed = this.computeState(project, skill, freshRepo, upstreamHead);

      switch (computed.state) {
        case SubscriptionState.Synced: {
          const log = this.logs.insert({
            project_id: projectId,
            skill_id: skillId,
            direction: "pull",
            from_version: upstreamHead,
            to_version: upstreamHead,
            status: "success",
            conflict_detail: null,
            content_hash: computed.local
          });
          return { skill, state: SubscriptionState.Synced, log };
        }

        case SubscriptionState.Pending:
        case SubscriptionState.Behind: {
          // Safe to write upstream → working.
          this.writeWorkingFromUpstream(project, skill, freshRepo);
          const afterHash = this.hashWorking(project, skill);
          const log = this.logs.insert({
            project_id: projectId,
            skill_id: skillId,
            direction: "pull",
            from_version: computed.base ?? null,
            to_version: upstreamHead,
            status: "success",
            conflict_detail: null,
            content_hash: afterHash
          });
          this.deps.events.emit({
            type: EventType.SkillUpdated,
            payload: {
              project_id: projectId,
              subscription: this.wrapWithState(
                project.id,
                skill,
                freshRepo,
                SubscriptionState.Synced,
                `synced to ${upstreamHead.slice(0, 7)}`
              ),
              log
            }
          });
          return { skill, state: SubscriptionState.Synced, log };
        }

        case SubscriptionState.LocalAhead: {
          // Working copy has edits; we don't clobber them on pull.
          const log = this.logs.insert({
            project_id: projectId,
            skill_id: skillId,
            direction: "pull",
            from_version: upstreamHead,
            to_version: upstreamHead,
            status: "success",
            conflict_detail: "local-ahead — pull skipped",
            content_hash: computed.local
          });
          return { skill, state: SubscriptionState.LocalAhead, log };
        }

        case SubscriptionState.Conflict:
        default: {
          const log = this.logs.insert({
            project_id: projectId,
            skill_id: skillId,
            direction: "pull",
            from_version: computed.base ?? null,
            to_version: upstreamHead,
            status: "conflict",
            conflict_detail:
              computed.state_detail ?? "working copy and upstream diverged",
            content_hash: computed.local
          });
          this.deps.events.emit({
            type: EventType.ConflictDetected,
            payload: {
              project_id: projectId,
              skill,
              log,
              resolve_url: this.buildResolveUrl(projectId, skillId)
            }
          });
          throw new AstackError(
            ErrorCode.CONFLICT_DETECTED,
            "conflict detected on pull",
            {
              project_id: projectId,
              skill_id: skillId,
              log_id: log.id
            }
          );
        }
      }
    });
  }

  /**
   * Sync all subscriptions of a project (or a subset given by skill_ids).
   *
   * Best-effort per skill: one failure does not abort the batch
   * (decision: Implementation TODO #3). Individual errors (other than
   * CONFLICT) are swallowed into 'error' status log rows.
   */
  async pullBatch(
    projectId: number,
    opts: {
      skill_ids?: number[];
      force?: boolean;
    } = {}
  ): Promise<{
    outcomes: SyncOutcome[];
    synced: number;
    up_to_date: number;
    conflicts: number;
    errors: number;
  }> {
    // v0.5 §A9: serialise with ProjectBootstrapService for the same project.
    // pullBatch starts with `reconcileFromManifest` (file-wins reconciliation
    // that can DELETE rows not in the manifest) and bootstrap writes both DB
    // rows + manifest. Without this lock, an interleaving exists where
    // bootstrap inserts a subscription, then sync reads the pre-bootstrap
    // manifest and deletes that subscription. The lock is per-project so
    // unrelated repos remain parallel.
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      () => this.pullBatchUnderLock(projectId, opts)
    );
  }

  private async pullBatchUnderLock(
    projectId: number,
    opts: {
      skill_ids?: number[];
      force?: boolean;
    }
  ): Promise<{
    outcomes: SyncOutcome[];
    synced: number;
    up_to_date: number;
    conflicts: number;
    errors: number;
  }> {
    const project = this.deps.projects.mustFindById(projectId);
    this.deps.subscriptions.reconcileFromManifest(projectId);

    const subs = this.deps.subscriptions.listForProject(project.id);
    const targets = opts.skill_ids
      ? subs.filter((s) => opts.skill_ids!.includes(s.skill_id))
      : subs;

    this.deps.events.emit({
      type: EventType.SyncStarted,
      payload: { project_id: project.id, total: Math.max(targets.length, 1) }
    });

    const outcomes: SyncOutcome[] = [];
    let synced = 0;
    let up_to_date = 0;
    let conflicts = 0;
    let errors = 0;

    for (const sub of targets) {
      try {
        const outcome = await this.pullOne(project.id, sub.skill_id, {
          force: opts.force
        });
        outcomes.push(outcome);

        // Distinguish "did work" vs "already synced" using the log's from/to.
        const { log } = outcome;
        if (log.from_version === log.to_version) {
          up_to_date++;
        } else {
          synced++;
        }
      } catch (err) {
        if (err instanceof AstackError && err.code === ErrorCode.CONFLICT_DETECTED) {
          conflicts++;
          // Surface the conflict so callers can see which skill needs
          // /resolve. The log row was already inserted inside pullOne.
          const logId = (err.details?.log_id as number | undefined) ?? -1;
          const conflictLog = logId > 0
            ? this.logs.latestForProjectSkill(project.id, sub.skill_id)
            : null;
          if (conflictLog) {
            outcomes.push({
              skill: this.mustFindSkill(sub.skill_id),
              state: SubscriptionState.Conflict,
              log: conflictLog
            });
          }
          continue;
        }
        errors++;
        this.deps.logger.warn("sync.skill_failed", {
          project_id: project.id,
          skill_id: sub.skill_id,
          error: err instanceof Error ? err.message : String(err)
        });
        const errLog = this.logs.insert({
          project_id: project.id,
          skill_id: sub.skill_id,
          direction: "pull",
          from_version: null,
          to_version: null,
          status: "error",
          conflict_detail: err instanceof Error ? err.message : String(err),
          content_hash: null
        });
        outcomes.push({
          skill: this.mustFindSkill(sub.skill_id),
          state: SubscriptionState.Conflict, // using a neutral "bad" state
          log: errLog
        });
      }
    }

    // Touch last_synced on successful batch (even partial).
    this.deps.subscriptions.touchLastSynced(
      project.id,
      this.now().toISOString()
    );

    this.deps.events.emit({
      type: EventType.SyncCompleted,
      payload: {
        project_id: project.id,
        synced,
        conflicts,
        errors
      }
    });

    return { outcomes, synced, up_to_date, conflicts, errors };
  }

  // ---------- PUSH (working → upstream → remote) ----------

  /**
   * Push local edits for a single skill back to upstream.
   *
   * - Takes the per-repo lock.
   * - If working copy equals upstream → no-op (no_changes).
   * - If upstream has moved past our base → conflict.
   * - Otherwise copy working → upstream, commit, push.
   */
  async pushOne(
    projectId: number,
    skillId: number,
    opts: { commit_message?: string } = {}
  ): Promise<PushOutcome> {
    const project = this.deps.projects.mustFindById(projectId);
    const skill = this.mustFindSkill(skillId);
    const repo = this.mustFindRepo(skill.repo_id);

    // Open-source repos are pull-only; reject before acquiring the lock.
    if (repo.kind === "open-source") {
      throw new AstackError(
        ErrorCode.REPO_READONLY,
        `cannot push to open-source repo '${repo.name}'`,
        { repo_id: repo.id, repo_name: repo.name, skill_id: skillId }
      );
    }

    return this.deps.locks.withLock(repo.id, async () => {
      if (!repo.local_path) {
        throw new AstackError(
          ErrorCode.REPO_STRUCTURE_INVALID,
          "repo has no local clone path",
          { repo_id: repo.id }
        );
      }

      // Ensure upstream is up-to-date before attempting push.
      await this.git.pull(repo.local_path);
      const upstreamHead = await this.readRepoHead(repo);
      // Persist for computeState.
      this.repos.updateSyncState(repo.id, {
        head_hash: upstreamHead,
        last_synced: this.now().toISOString()
      });
      const freshRepo = this.repos.findById(repo.id) ?? repo;
      const computed = this.computeState(project, skill, freshRepo, upstreamHead);

      if (
        computed.state === SubscriptionState.Synced ||
        computed.state === SubscriptionState.Pending
      ) {
        const log = this.logs.insert({
          project_id: projectId,
          skill_id: skillId,
          direction: "push",
          from_version: upstreamHead,
          to_version: upstreamHead,
          status: "success",
          conflict_detail: "no local changes",
          content_hash: computed.local
        });
        return {
          skill,
          state: SubscriptionState.Synced,
          log,
          new_version: null
        };
      }

      if (computed.state === SubscriptionState.Conflict) {
        const log = this.logs.insert({
          project_id: projectId,
          skill_id: skillId,
          direction: "push",
          from_version: computed.base ?? null,
          to_version: upstreamHead,
          status: "conflict",
          conflict_detail:
            computed.state_detail ?? "upstream diverged; resolve required",
          content_hash: computed.local
        });
        this.deps.events.emit({
          type: EventType.ConflictDetected,
          payload: {
            project_id: projectId,
            skill,
            log,
            resolve_url: this.buildResolveUrl(projectId, skillId)
          }
        });
        throw new AstackError(
          ErrorCode.CONFLICT_DETECTED,
          "conflict detected on push",
          {
            project_id: projectId,
            skill_id: skillId,
            log_id: log.id
          }
        );
      }

      // State is LocalAhead or Behind with only local changes.
      // Copy working → upstream and commit.
      this.writeUpstreamFromWorking(project, skill, freshRepo);
      const commitMessage =
        opts.commit_message ??
        `update: ${skill.name} from ${project.name}`;
      const newHash = await this.git.commitAndPush(
        freshRepo.local_path ?? repo.local_path,
        commitMessage,
        this.deps.gitAuthor
      );

      // Refresh stored HEAD.
      this.repos.updateSyncState(freshRepo.id, {
        head_hash: newHash,
        last_synced: this.now().toISOString()
      });
      this.skills.upsert({
        repo_id: freshRepo.id,
        type: skill.type,
        name: skill.name,
        path: skill.path,
        description: skill.description,
        version: newHash,
        updated_at: this.now().toISOString()
      });

      // After push, upstream and working copy are in sync; record the
      // After push, upstream and working copy are in sync; record the
      // working hash as content_hash so next pull sees "Synced".
      const afterHash = this.hashWorking(project, skill);
      const log = this.logs.insert({
        project_id: projectId,
        skill_id: skillId,
        direction: "push",
        from_version: computed.base ?? null,
        to_version: newHash,
        status: "success",
        conflict_detail: null,
        content_hash: afterHash
      });

      this.deps.events.emit({
        type: EventType.SkillUpdated,
        payload: {
          project_id: projectId,
          subscription: this.wrapWithState(
            projectId,
            skill,
            freshRepo,
            SubscriptionState.Synced,
            `pushed as ${newHash.slice(0, 7)}`
          ),
          log
        }
      });

      return {
        skill,
        state: SubscriptionState.Synced,
        log,
        new_version: newHash
      };
    });
  }

  // ---------- RESOLVE ----------

  /**
   * Resolve an active conflict for a (project, skill).
   *
   * Strategies:
   *   - keep-local  : overwrite upstream with working copy, commit+push
   *   - use-remote  : overwrite working copy with upstream
   *   - manual      : caller has manually edited working copy; verify there
   *                   are no `<<<<<<<` conflict markers, then push.
   */
  async resolve(
    projectId: number,
    skillId: number,
    strategy: ResolveStrategyT,
    opts: { manual_done?: boolean } = {}
  ): Promise<{ subscription: SubscriptionWithState; log: SyncLog }> {
    const project = this.deps.projects.mustFindById(projectId);
    const skill = this.mustFindSkill(skillId);
    const repo = this.mustFindRepo(skill.repo_id);

    // Ensure there is actually an active conflict to resolve.
    const latest = this.logs.latestForProjectSkill(projectId, skillId);
    if (!latest || latest.status !== "conflict") {
      throw new AstackError(
        ErrorCode.NO_ACTIVE_CONFLICT,
        "no active conflict to resolve",
        { project_id: projectId, skill_id: skillId }
      );
    }

    // Open-source repos are pull-only: keep-local and manual both push.
    if (
      repo.kind === "open-source" &&
      (strategy === ResolveStrategy.KeepLocal ||
        strategy === ResolveStrategy.Manual)
    ) {
      throw new AstackError(
        ErrorCode.REPO_READONLY,
        `cannot ${strategy} on open-source repo '${repo.name}'; only use-remote is allowed`,
        {
          repo_id: repo.id,
          repo_name: repo.name,
          skill_id: skillId,
          strategy
        }
      );
    }

    return this.deps.locks.withLock(repo.id, async () => {
      if (!repo.local_path) {
        throw new AstackError(
          ErrorCode.REPO_STRUCTURE_INVALID,
          "repo has no local clone path",
          { repo_id: repo.id }
        );
      }

      // Refresh before resolving to have the newest upstream.
      await this.git.pull(repo.local_path);

      if (strategy === ResolveStrategy.UseRemote) {
        this.writeWorkingFromUpstream(project, skill, repo);
      } else if (strategy === ResolveStrategy.KeepLocal) {
        this.writeUpstreamFromWorking(project, skill, repo);
        const msg = `resolve: keep-local ${skill.name} from ${project.name}`;
        await this.git.commitAndPush(repo.local_path, msg, this.deps.gitAuthor);
      } else {
        // manual
        if (!opts.manual_done) {
          throw new AstackError(
            ErrorCode.VALIDATION_FAILED,
            "manual resolve requires manual_done=true",
            { project_id: projectId, skill_id: skillId }
          );
        }
        this.assertNoConflictMarkers(project, skill);
        this.writeUpstreamFromWorking(project, skill, repo);
        const msg = `resolve: manual-merge ${skill.name} from ${project.name}`;
        await this.git.commitAndPush(repo.local_path, msg, this.deps.gitAuthor);
      }

      const newHead = await this.readRepoHead(repo);
      this.repos.updateSyncState(repo.id, {
        head_hash: newHead,
        last_synced: this.now().toISOString()
      });
      const afterHash = this.hashWorking(project, skill);

      const log = this.logs.insert({
        project_id: projectId,
        skill_id: skillId,
        direction: strategy === ResolveStrategy.UseRemote ? "pull" : "push",
        from_version: latest.to_version ?? null,
        to_version: newHead,
        status: "success",
        conflict_detail: `resolved via ${strategy}`,
        content_hash: afterHash
      });

      const sub = this.wrapWithState(
        projectId,
        skill,
        repo,
        SubscriptionState.Synced,
        `resolved via ${strategy}`
      );
      return { subscription: sub, log };
    });
  }

  // ---------- STATE / VIEW ----------

  /**
   * Compose a SubscriptionWithState row, re-computing live state against
   * current upstream (without pulling; uses local clone HEAD as upstream).
   */
  computeViewState(
    projectId: number,
    sub: Subscription
  ): SubscriptionWithState {
    const project = this.deps.projects.mustFindById(projectId);
    const skill = this.mustFindSkill(sub.skill_id);
    const repo = this.mustFindRepo(skill.repo_id);
    const upstream = repo.head_hash ?? "";
    const computed = this.computeState(project, skill, repo, upstream);
    return this.wrapWithState(
      projectId,
      skill,
      repo,
      computed.state,
      computed.state_detail
    );
  }

  listWithState(projectId: number): {
    subscriptions: SubscriptionWithState[];
    last_synced: string | null;
  } {
    this.deps.subscriptions.reconcileFromManifest(projectId);
    const subs = this.deps.subscriptions.listForProject(projectId);
    const rows = subs.map((s) => this.computeViewState(projectId, s));
    const last_synced = this.logs.latestSyncAtForProject(projectId);
    return { subscriptions: rows, last_synced };
  }

  /** Local-vs-upstream diff info; used by GET /projects/:id/diff/:skill_id. */
  readDiff(
    projectId: number,
    skillId: number
  ): {
    identical: boolean;
    upstream_version: string | null;
    working_version: string | null;
  } {
    const project = this.deps.projects.mustFindById(projectId);
    const skill = this.mustFindSkill(skillId);
    const repo = this.mustFindRepo(skill.repo_id);
    const local = this.hashWorking(project, skill);
    const upstream = this.hashUpstream(repo, skill);
    return {
      identical: local !== null && upstream !== null && local === upstream,
      upstream_version: upstream,
      working_version: local
    };
  }

  // ---------- Internal state computation ----------

  private computeState(
    project: { path: string; primary_tool: string },
    skill: Skill,
    repo: SkillRepo,
    _upstreamHead: string
  ): ComputedSyncState {
    const local = this.hashWorking(project, skill);
    const upstream = this.hashUpstream(repo, skill);

    const projectId = this.lookupProjectIdFor(project.path);
    const lastSuccess = this.logs.latestSuccessForProjectSkill(
      projectId,
      skill.id
    );
    const base = lastSuccess?.to_version ?? null;
    const baseContent = lastSuccess?.content_hash ?? null;

    if (local === null) {
      return {
        state: SubscriptionState.Pending,
        state_detail: "working copy not yet materialized",
        local: null,
        upstream,
        base
      };
    }

    if (upstream === null) {
      return {
        state: SubscriptionState.Pending,
        state_detail: "upstream content missing",
        local,
        upstream: null,
        base
      };
    }

    if (local === upstream) {
      return {
        state: SubscriptionState.Synced,
        local,
        upstream,
        base
      };
    }

    // local !== upstream. Decide via 3-way.
    if (base === null) {
      // No prior successful sync AND local !== upstream. Two realities
      // produce this combo:
      //   - v0.5 bootstrap adopted a drifted legacy skill (the common case):
      //     the user's .claude/skills/<name>/ has been edited relative to
      //     what the registered repo publishes. They need to choose
      //     keep-local (push), use-remote (overwrite), or manual merge.
      //   - A brand-new subscription race: sync_logs row not yet written
      //     but fs is already drifted (rare; recovers on next sync).
      //
      // Classify as Conflict (spec §5 §A5 acceptance criteria) rather
      // than Pending. Pending means "nothing has happened"; that's wrong
      // for an adopted-with-drift skill. The Resolve flow (existing UI)
      // then routes keep-local / use-remote / manual cleanly — including
      // for open-source repos where Push is rejected.
      return {
        state: SubscriptionState.Conflict,
        state_detail:
          "local content differs from upstream (no sync history); resolve required",
        local,
        upstream,
        base
      };
    }

    const localUnchangedSinceSync =
      baseContent !== null && local === baseContent;
    const upstreamAdvanced = repo.head_hash !== base;

    if (!upstreamAdvanced && !localUnchangedSinceSync) {
      // Upstream unchanged; local changed → local-ahead (safe to push).
      return {
        state: SubscriptionState.LocalAhead,
        state_detail: "local modifications not pushed",
        local,
        upstream,
        base
      };
    }

    if (upstreamAdvanced && localUnchangedSinceSync) {
      // Upstream moved; local untouched → behind (safe to pull).
      return {
        state: SubscriptionState.Behind,
        state_detail: "upstream has new commits",
        local,
        upstream,
        base
      };
    }

    if (!upstreamAdvanced && localUnchangedSinceSync) {
      // Shouldn't normally hit — local==base but local!=upstream. Treat as synced.
      return {
        state: SubscriptionState.Synced,
        local,
        upstream,
        base
      };
    }

    // Both sides diverged.
    return {
      state: SubscriptionState.Conflict,
      state_detail: "local and upstream both diverged from last sync",
      local,
      upstream,
      base
    };
  }

  private wrapWithState(
    projectId: number,
    skill: Skill,
    repo: SkillRepo,
    state: SubscriptionStateT,
    detail?: string
  ): SubscriptionWithState {
    const row = this.deps.subscriptions.findByProjectSkill(projectId, skill.id);
    const subscription: Subscription = row ?? {
      id: -1,
      project_id: projectId,
      skill_id: skill.id,
      pinned_version: null
    };
    return {
      subscription,
      skill,
      repo,
      state,
      state_detail: detail
    };
  }

  private lookupProjectIdFor(projectPath: string): number {
    const row = this.deps.projects.findByPath(projectPath);
    if (!row) {
      throw new AstackError(
        ErrorCode.PROJECT_NOT_FOUND,
        "project not found for path",
        { path: projectPath }
      );
    }
    return row.id;
  }

  // ---------- File / hash helpers ----------

  /**
   * Absolute path of the working copy for a given skill in a project.
   *
   * We use a CANONICAL layout for working copies — NOT `skill.path` from
   * the repo — because `skill.path` reflects the **upstream repo's**
   * scan_config, which may be flat (gstack: `autoplan/SKILL.md` at repo
   * root) or custom-rooted. A project's working tree follows the standard
   * Claude convention regardless of where the skill came from:
   *
   *   .claude/skills/<name>/      for type='skill'   (dir)
   *   .claude/commands/<name>.md  for type='command'
   *   .claude/agents/<name>.md    for type='agent'
   *
   * This alignment is what makes v0.5 bootstrap work: the local file
   * scanner (BOOTSTRAP_SCAN_CONFIG) emits `skills/<name>`, subscribe
   * inserts into SQLite, and subsequent `hashWorking` lookups land on
   * the exact same on-disk path the scanner saw.
   *
   * Pre-v0.5 this was `path.join(..., skill.path)` which conflated repo
   * layout with project layout; broke any flat-layout repo (see the
   * PrivSeal/gstack "working copy not yet materialized" bug).
   */
  private workingPath(
    project: { path: string; primary_tool: string },
    skill: Skill
  ): string {
    const rel = canonicalWorkingRelPath(skill);
    return path.join(project.path, project.primary_tool, rel);
  }

  /** Absolute path of the upstream mirror copy of a skill. */
  private upstreamPath(repo: SkillRepo, skill: Skill): string {
    if (!repo.local_path) {
      throw new AstackError(
        ErrorCode.REPO_STRUCTURE_INVALID,
        "repo has no local clone path",
        { repo_id: repo.id }
      );
    }
    // Upstream path DOES use skill.path — the scan_config is the source
    // of truth for how the repo laid its files out on disk.
    return path.join(repo.local_path, skill.path);
  }

  private hashWorking(
    project: { path: string; primary_tool: string },
    skill: Skill
  ): string | null {
    const p = this.workingPath(project, skill);
    return skill.type === SkillType.Skill ? hashDir(p) : hashFile(p);
  }

  private hashUpstream(repo: SkillRepo, skill: Skill): string | null {
    const p = this.upstreamPath(repo, skill);
    return skill.type === SkillType.Skill ? hashDir(p) : hashFile(p);
  }

  private writeWorkingFromUpstream(
    project: { path: string; primary_tool: string },
    skill: Skill,
    repo: SkillRepo
  ): void {
    const src = this.upstreamPath(repo, skill);
    const dest = this.workingPath(project, skill);
    if (skill.type === SkillType.Skill) {
      if (!isDir(src)) {
        throw new AstackError(
          ErrorCode.REPO_STRUCTURE_INVALID,
          "upstream skill dir missing",
          { src }
        );
      }
      mirrorDir(src, dest);
    } else {
      if (!isFile(src)) {
        throw new AstackError(
          ErrorCode.REPO_STRUCTURE_INVALID,
          "upstream command file missing",
          { src }
        );
      }
      copyFile(src, dest);
    }
  }

  private writeUpstreamFromWorking(
    project: { path: string; primary_tool: string },
    skill: Skill,
    repo: SkillRepo
  ): void {
    const src = this.workingPath(project, skill);
    const dest = this.upstreamPath(repo, skill);

    if (skill.type === SkillType.Skill) {
      if (!isDir(src)) {
        // Allow "delete" semantics only when user has explicitly cleared;
        // for v1 we don't push deletions, we just report missing.
        throw new AstackError(
          ErrorCode.FILESYSTEM_FAILED,
          "working copy skill dir missing",
          { src }
        );
      }
      mirrorDir(src, dest);
    } else {
      if (!isFile(src)) {
        throw new AstackError(
          ErrorCode.FILESYSTEM_FAILED,
          "working copy command file missing",
          { src }
        );
      }
      copyFile(src, dest);
    }
  }

  private assertNoConflictMarkers(
    project: { path: string; primary_tool: string },
    skill: Skill
  ): void {
    const p = this.workingPath(project, skill);
    if (skill.type === SkillType.Command) {
      const content = isFile(p) ? readText(p) : "";
      if (content.includes("<<<<<<<")) {
        throw new AstackError(
          ErrorCode.MERGE_INCOMPLETE,
          "file still contains conflict markers",
          { path: p }
        );
      }
    }
    // For skill directories, we'd need to recursively check all files.
    // Skipped in v1 — manual resolve on skills defaults to trust the user.
  }

  private async readRepoHead(repo: SkillRepo): Promise<string> {
    if (!repo.local_path) return repo.head_hash ?? "";
    try {
      const info = await gitGetHead(repo.local_path);
      return info.head;
    } catch {
      return repo.head_hash ?? "";
    }
  }

  private buildResolveUrl(projectId: number, skillId: number): string {
    return (
      this.deps.resolveUrl?.(projectId, skillId) ??
      `/resolve/${projectId}/${skillId}`
    );
  }

  private mustFindSkill(id: number): Skill {
    const row = this.skills.findById(id);
    if (!row) {
      throw new AstackError(ErrorCode.SKILL_NOT_FOUND, "skill not found", {
        skill_id: id
      });
    }
    return row;
  }

  private mustFindRepo(id: number): SkillRepo {
    const row = this.repos.findById(id);
    if (!row) {
      throw new AstackError(ErrorCode.REPO_NOT_FOUND, "repo not found", {
        repo_id: id
      });
    }
    return row;
  }
}

// ---------- helpers ----------

/**
 * Canonical relative path inside `<project>/<primary_tool>/` for a skill,
 * derived from its type + name only. Used by SyncService.workingPath so
 * that repos with non-standard layouts (flat, custom-rooted) still land
 * in the right place in the user's project tree.
 *
 * Mirrors the shape BOOTSTRAP_SCAN_CONFIG expects when scanning a
 * project's `.claude/`. See v0.5 spec §A6.
 */
function canonicalWorkingRelPath(skill: Skill): string {
  switch (skill.type) {
    case SkillType.Skill:
      return path.posix.join("skills", skill.name);
    case SkillType.Command:
      return path.posix.join("commands", `${skill.name}.md`);
    case SkillType.Agent:
      return path.posix.join("agents", `${skill.name}.md`);
    default: {
      // Exhaustiveness: new SkillType additions should re-visit this.
      const _exhaustive: never = skill.type;
      return _exhaustive;
    }
  }
}

function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
