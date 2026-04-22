/**
 * ProjectBootstrapService — v0.5 "subscribe what's already there".
 *
 * Owns the legacy-project bootstrap flow:
 *   - scan(projectId)                  : pure read; classify local skills
 *                                        as matched / ambiguous / unmatched
 *   - scanAndAutoSubscribe(projectId)  : scan + auto-subscribe matched, emit SSE
 *   - applyResolutions(projectId, [..]) : user-resolved ambiguous → subscribe
 *                                        or append to ignored_local
 *   - ignore(projectId, [{type,name}]) : explicit ignore (manifest-only write)
 *
 * Source-of-truth boundaries (see v0.5 spec §A1–A9):
 *   - SubscriptionService still owns subscribe / rewriteManifest. Bootstrap
 *     never touches the SQLite subscriptions table directly.
 *   - `ignored_local` lives in `<project>/<primary_tool>/.astack.json`.
 *     Bootstrap reads + writes that field via manifest.ts helpers.
 *   - Scanner is reused; bootstrap supplies a custom ScanConfig that
 *     extends DEFAULT_SCAN_CONFIG with an `agents/` root (§A6).
 *
 * Concurrency:
 *   - A8 (process-internal): `inflightScan` Map de-duplicates concurrent
 *     `scan` / `scanAndAutoSubscribe` calls for the same project.
 *   - A9 (cross-service): every public method acquires the shared
 *     `projectBootstrapLockKey(projectId)` lock so bootstrap never
 *     interleaves with `SyncService.pullBatch`'s `reconcileFromManifest`.
 *
 * Error handling (R4):
 *   The subscribe loops in scanAndAutoSubscribe / applyResolutions use
 *   per-item try/catch. AstackError instances become structured
 *   `failed[]` entries; non-Astack errors propagate so genuine bugs
 *   are not swallowed.
 */

import path from "node:path";

import {
  AstackError,
  DEFAULT_SCAN_CONFIG,
  EventType,
  ScanRootKind,
  type ApplyResolutionsResult,
  type BootstrapAmbiguous,
  type BootstrapFailedEntry,
  type BootstrapIgnoredEntry,
  type BootstrapMatch,
  type BootstrapResolution,
  type BootstrapSubscribedEntry,
  type BootstrapUnmatched,
  type Id,
  type ProjectBootstrapResult,
  type ScanAndAutoSubscribeResult,
  type ScanConfig,
  type Skill,
  type SkillRepo,
  type SkillType
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { LocalSkillRepository } from "../db/local-skills.js";
import { RepoRepository } from "../db/repos.js";
import { SkillRepository } from "../db/skills.js";
import type { EventBus } from "../events.js";
import {
  dedupeIgnoredLocal,
  readManifest,
  writeManifest,
  type AstackManifest,
  type IgnoredLocalEntry
} from "../manifest.js";
import { projectBootstrapLockKey, type LockManager } from "../lock.js";
import type { Logger } from "../logger.js";
import { scanRepo } from "../scanner/index.js";
import { safeLog } from "../system-skills/service.js";

import type { LocalSkillService } from "./local-skill.js";
import type { ProjectService } from "./project.js";
import type { SubscriptionService } from "./subscription.js";
import type { SystemSkillService } from "../system-skills/service.js";

// ---------- Types ----------

export interface ProjectBootstrapServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  locks: LockManager;
  projects: ProjectService;
  subscriptions: SubscriptionService;
  systemSkills: SystemSkillService;
  /**
   * Late-bound LocalSkillService accessor (v0.7 PR4). Returns null before
   * the service is wired (kept optional so v0.5 / v0.6 tests and code
   * paths continue to work unchanged). Used inside `scanAndAutoSubscribe`
   * to auto-adopt eligible `unmatched` entries as `origin='auto'`
   * LocalSkills, and inside `scanRaw` to filter already-adopted entries
   * from the three-way classification. See spec §3.1 / §A2.
   *
   * Mirrors the `systemSkillServiceRef` late-bound pattern used in
   * `http/app.ts` to break the circular dependency between bootstrap and
   * LocalSkill services.
   */
  getLocalSkillService?: () => LocalSkillService | null;
}

// ---------- Constants ----------

/**
 * Bootstrap-specific scan config (§A6).
 *
 * Extends DEFAULT_SCAN_CONFIG with `agents/` because legacy projects
 * regularly have `.claude/agents/*.md`; DEFAULT_SCAN_CONFIG is shaped
 * for upstream repo scanning where many repos lack agents/. Adding
 * agents to DEFAULT_SCAN_CONFIG itself is intentionally out of scope
 * for v0.5.
 *
 * v0.7: exported so LocalSkillService can reuse the exact same scan
 * shape when computing content hashes and descriptions for adopt /
 * rescan operations (spec §A5–§A7). Importing the same constant
 * instead of duplicating the root list guarantees bootstrap and local
 * adopt agree on what counts as a scannable local skill.
 */
export const BOOTSTRAP_SCAN_CONFIG: ScanConfig = {
  roots: [
    ...DEFAULT_SCAN_CONFIG.roots,
    { path: "agents", kind: ScanRootKind.AgentFiles }
  ]
};

// ---------- Service ----------

export class ProjectBootstrapService {
  private readonly skills: SkillRepository;
  private readonly repos: RepoRepository;
  private readonly localSkills: LocalSkillRepository;
  /** A8: dedupe concurrent scan / scanAndAutoSubscribe calls per project. */
  private readonly inflightScan = new Map<Id, Promise<ProjectBootstrapResult>>();

  constructor(private readonly deps: ProjectBootstrapServiceDeps) {
    this.skills = new SkillRepository(deps.db);
    this.repos = new RepoRepository(deps.db);
    this.localSkills = new LocalSkillRepository(deps.db);

    // PR4 / spec §3.1: event-driven auto-bootstrap on project registration.
    // Mirrors SystemSkillService's subscriber pattern: fire-and-forget,
    // wrap any subscriber-internal failure with safeLog so a broken
    // logger cannot produce unhandledRejection.
    this.deps.events.subscribe(({ event }) => {
      if (event.type !== EventType.ProjectRegistered) return;
      const project = event.payload.project;
      this.handleProjectRegistered(project).catch((err) => {
        safeLog(this.deps.logger, "bootstrap.subscriber_crash", {
          project_id: project.id,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
  }

  /**
   * Handler for ProjectRegistered events (PR4). Skips non-`.claude` projects
   * so they do not waste a scan; on `.claude` projects it runs
   * `scanAndAutoSubscribe`. Errors are swallowed (logged) so register stays
   * 201 and the user can retry via [Re-scan local].
   */
  async handleProjectRegistered(project: {
    id: number;
    primary_tool: string;
  }): Promise<void> {
    if (project.primary_tool !== ".claude") {
      this.deps.logger.debug("bootstrap.skip_non_claude", {
        project_id: project.id,
        primary_tool: project.primary_tool
      });
      return;
    }
    try {
      await this.scanAndAutoSubscribe(project.id);
    } catch (err) {
      safeLog(this.deps.logger, "bootstrap.handle_failed", {
        project_id: project.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // ---------- Public API ----------

  /**
   * Pure scan — classifies local entries under
   * `<project>/<primary_tool>/` into matched/ambiguous/unmatched without
   * touching DB, manifest, or SSE.
   *
   * Returns an empty result (all three arrays empty) when
   * primary_tool != '.claude' (see §Out of scope).
   */
  async scan(projectId: Id): Promise<ProjectBootstrapResult> {
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      () => this.scanWithDedup(projectId)
    );
  }

  /**
   * scan + auto-subscribe matched entries. Emits exactly one SSE event
   * (NeedsResolution if ambiguous > 0, else Resolved if any side-effect
   * occurred, else nothing).
   */
  async scanAndAutoSubscribe(
    projectId: Id
  ): Promise<ScanAndAutoSubscribeResult> {
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      async () => {
        const result = await this.scanWithDedup(projectId);
        const { subscribed, failed } = this.subscribeMatched(
          projectId,
          result.matched
        );

        // v0.7 §3.1: auto-adopt unmatched entries as LocalSkills (origin
        // 'auto'). We call this INSIDE the bootstrap lock scope so DB
        // writes from adopt can't interleave with subsequent
        // bootstrap / sync writes. `autoAdoptFromUnmatched` is the
        // lock-free variant — passing it a lock would deadlock on the
        // same `projectBootstrapLockKey`.
        //
        // Wrapped in try/catch so a broken LocalSkillService wiring (e.g.
        // the late-bound getter throwing) cannot kill bootstrap's
        // primary contract of subscribeMatched + emit SSE. Per-entry
        // failures are already swallowed into `result.failed[]` by
        // LocalSkillService itself (R4).
        try {
          const localSkills = this.deps.getLocalSkillService?.() ?? null;
          if (localSkills) {
            const autoAdopted = localSkills.autoAdoptFromUnmatched(
              projectId,
              result.unmatched
            );
            if (autoAdopted.failed.length > 0) {
              this.deps.logger.warn("bootstrap.auto_adopt_failed", {
                project_id: projectId,
                failed: autoAdopted.failed.map((f) => ({
                  type: f.type,
                  name: f.name,
                  code: f.code
                }))
              });
            }
          }
        } catch (err) {
          safeLog(this.deps.logger, "bootstrap.auto_adopt_crash", {
            project_id: projectId,
            error: err instanceof Error ? err.message : String(err)
          });
        }

        this.emitPostScanEvent({
          projectId,
          result,
          subscribedCount: subscribed.length,
          failedCount: failed.length
        });

        return {
          result,
          subscribed,
          failed,
          remaining_ambiguous: result.ambiguous
        };
      }
    );
  }

  /**
   * Apply user-supplied ambiguous resolutions.
   *
   * Each resolution is either:
   *   - `repo_id !== null` → subscribe to `<repo>/<type>/<name>`
   *   - `repo_id === null` → append to `ignored_local`
   *
   * Per-item try/catch: AstackError → `failed[]`, other errors propagate.
   */
  async applyResolutions(
    projectId: Id,
    resolutions: BootstrapResolution[]
  ): Promise<ApplyResolutionsResult> {
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      async () => this.applyResolutionsUnderLock(projectId, resolutions)
    );
  }

  /**
   * Mark entries as ignored without subscribing — semantically equivalent
   * to `applyResolutions` with every `repo_id === null`.
   */
  async ignore(
    projectId: Id,
    entries: Array<{ type: SkillType; name: string }>
  ): Promise<ApplyResolutionsResult> {
    const resolutions: BootstrapResolution[] = entries.map((e) => ({
      type: e.type,
      name: e.name,
      repo_id: null
    }));
    return this.applyResolutions(projectId, resolutions);
  }

  /**
   * Read the persisted ignored_local list from the manifest. Returns []
   * when no manifest exists yet.
   */
  listIgnored(projectId: Id): IgnoredLocalEntry[] {
    const project = this.deps.projects.mustFindById(projectId);
    const manifest = readManifest(project.path, project.primary_tool);
    return manifest?.ignored_local ?? [];
  }

  // ---------- Internals: scan ----------

  private async scanWithDedup(projectId: Id): Promise<ProjectBootstrapResult> {
    const cached = this.inflightScan.get(projectId);
    if (cached) return cached;

    const promise = Promise.resolve().then(() => this.scanRaw(projectId));
    this.inflightScan.set(projectId, promise);
    try {
      return await promise;
    } finally {
      // Best-effort cleanup — only delete if we're still the same promise.
      if (this.inflightScan.get(projectId) === promise) {
        this.inflightScan.delete(projectId);
      }
    }
  }

  private scanRaw(projectId: Id): ProjectBootstrapResult {
    const project = this.deps.projects.mustFindById(projectId);
    const scannedAt = new Date().toISOString();

    // Out of scope: non-`.claude` primary tools (see spec §Out of scope).
    if (project.primary_tool !== ".claude") {
      return {
        project_id: project.id,
        matched: [],
        ambiguous: [],
        unmatched: [],
        scanned_at: scannedAt
      };
    }

    const root = path.join(project.path, project.primary_tool);
    const systemSkillIds = new Set(
      this.deps.systemSkills.list().map((s) => s.id)
    );

    const scanResult = scanRepo(root, BOOTSTRAP_SCAN_CONFIG, {
      systemSkillIds
    });

    if (scanResult.warnings.length > 0) {
      this.deps.logger.debug("bootstrap.scan_warnings", {
        project_id: project.id,
        warnings: scanResult.warnings
      });
    }

    const ignored = new Set(
      (
        readManifest(project.path, project.primary_tool)?.ignored_local ?? []
      ).map((e) => `${e.type}/${e.name}`)
    );
    const subscribedKeys = this.collectSubscribedKeys(project.id);
    // v0.7 §3.1 / §A2: entries already tracked as LocalSkill (adopted or
    // auto-adopted) must not re-appear in any of matched/ambiguous/
    // unmatched — the Local Skills tab owns their lifecycle.
    const adoptedLocalKeys = new Set(
      this.localSkills
        .listByProject(project.id)
        .map((r) => `${r.type}/${r.name}`)
    );

    const matched: BootstrapMatch[] = [];
    const ambiguous: BootstrapAmbiguous[] = [];
    const unmatched: BootstrapUnmatched[] = [];

    for (const local of scanResult.skills) {
      const key = `${local.type}/${local.name}`;
      if (ignored.has(key)) continue;
      if (subscribedKeys.has(key)) continue;
      if (adoptedLocalKeys.has(key)) continue;

      const candidates = this.findCandidates(local.type, local.name);

      if (candidates.length === 0) {
        unmatched.push({
          type: local.type,
          name: local.name,
          local_path: local.relPath
        });
      } else if (candidates.length === 1) {
        const c = candidates[0]!;
        matched.push({
          type: local.type,
          name: local.name,
          local_path: local.relPath,
          skill: c.skill,
          repo: c.repo
        });
      } else {
        ambiguous.push({
          type: local.type,
          name: local.name,
          local_path: local.relPath,
          candidates
        });
      }
    }

    return {
      project_id: project.id,
      matched,
      ambiguous,
      unmatched,
      scanned_at: scannedAt
    };
  }

  /** Collect existing subscriptions as `<type>/<name>` keys for fast lookup. */
  private collectSubscribedKeys(projectId: number): Set<string> {
    const out = new Set<string>();
    for (const row of this.deps.subscriptions.listForProject(projectId)) {
      const skill = this.skills.findById(row.skill_id);
      if (!skill) continue;
      out.add(`${skill.type}/${skill.name}`);
    }
    return out;
  }

  /** Find every (skill, repo) pair that matches by (type, name). */
  private findCandidates(
    type: SkillType,
    name: string
  ): Array<{ skill: Skill; repo: SkillRepo }> {
    const matches = this.skills
      .findByShortName(name)
      .filter((s) => s.type === type);
    const out: Array<{ skill: Skill; repo: SkillRepo }> = [];
    for (const skill of matches) {
      const repo = this.repos.findById(skill.repo_id);
      if (!repo) continue;
      out.push({ skill, repo });
    }
    return out;
  }

  // ---------- Internals: subscribe loop ----------

  private subscribeMatched(
    projectId: Id,
    matched: BootstrapMatch[]
  ): {
    subscribed: BootstrapSubscribedEntry[];
    failed: BootstrapFailedEntry[];
  } {
    const subscribed: BootstrapSubscribedEntry[] = [];
    const failed: BootstrapFailedEntry[] = [];

    for (const m of matched) {
      // R4 / §A4: per-item try/catch so one collision can't poison the batch
      // or escape into the fire-and-forget caller.
      try {
        const ref = `${m.repo.name}/${m.type}/${m.name}`;
        const res = this.deps.subscriptions.subscribe(projectId, ref);
        subscribed.push({
          type: m.type,
          name: m.name,
          subscription_id: res.subscription.id
        });
      } catch (err) {
        if (err instanceof AstackError) {
          failed.push({
            type: m.type,
            name: m.name,
            code: err.code,
            message: err.message
          });
          this.deps.logger.warn("bootstrap.subscribe_failed", {
            project_id: projectId,
            type: m.type,
            name: m.name,
            code: err.code
          });
          continue;
        }
        throw err;
      }
    }

    return { subscribed, failed };
  }

  // ---------- Internals: applyResolutions ----------

  private async applyResolutionsUnderLock(
    projectId: Id,
    resolutions: BootstrapResolution[]
  ): Promise<ApplyResolutionsResult> {
    const project = this.deps.projects.mustFindById(projectId);

    // Snapshot ambiguous BEFORE applying — used to compute remaining_ambiguous.
    const beforeScan = this.scanRaw(projectId);
    const ambiguousBefore = beforeScan.ambiguous;

    const subscribed: BootstrapSubscribedEntry[] = [];
    const ignored: BootstrapIgnoredEntry[] = [];
    const failed: BootstrapFailedEntry[] = [];

    // Group ignores so we batch the manifest write (1 read + 1 write).
    const ignoreEntries: IgnoredLocalEntry[] = [];

    for (const r of resolutions) {
      if (r.repo_id === null) {
        ignoreEntries.push({
          type: r.type,
          name: r.name,
          ignored_at: new Date().toISOString()
        });
        ignored.push({ type: r.type, name: r.name });
        continue;
      }

      const repo = this.repos.findById(r.repo_id);
      if (!repo) {
        failed.push({
          type: r.type,
          name: r.name,
          code: "REPO_NOT_FOUND",
          message: `repo id ${r.repo_id} not found`
        });
        continue;
      }
      const skill = this.skills.findByRef(repo.id, r.type, r.name);
      if (!skill) {
        failed.push({
          type: r.type,
          name: r.name,
          code: "SKILL_NOT_FOUND",
          message: `no ${r.type} '${r.name}' in repo '${repo.name}'`
        });
        continue;
      }

      // R4 / §A4: per-item try/catch.
      try {
        const ref = `${repo.name}/${r.type}/${r.name}`;
        const res = this.deps.subscriptions.subscribe(projectId, ref);
        subscribed.push({
          type: r.type,
          name: r.name,
          subscription_id: res.subscription.id
        });
      } catch (err) {
        if (err instanceof AstackError) {
          failed.push({
            type: r.type,
            name: r.name,
            code: err.code,
            message: err.message
          });
          continue;
        }
        throw err;
      }
    }

    if (ignoreEntries.length > 0) {
      this.appendIgnoredLocal(
        project.id,
        project.path,
        project.primary_tool,
        ignoreEntries
      );
    }

    const remaining = this.recomputeRemainingAmbiguous(
      ambiguousBefore,
      resolutions,
      failed
    );

    this.deps.events.emit({
      type: EventType.SubscriptionsBootstrapResolved,
      payload: {
        project_id: projectId,
        remaining_ambiguous_count: remaining.length,
        subscribed_count: subscribed.length,
        ignored_count: ignored.length
      }
    });

    return {
      subscribed,
      ignored,
      failed,
      remaining_ambiguous: remaining
    };
  }

  /**
   * Compute the ambiguous list after applying resolutions:
   *   - drop entries the user resolved successfully (subscribe or ignore)
   *   - keep entries the user did not touch
   *   - keep entries that failed with a non-fatal cause (the drawer should
   *     re-show them so the user can retry)
   */
  private recomputeRemainingAmbiguous(
    before: BootstrapAmbiguous[],
    resolutions: BootstrapResolution[],
    failed: BootstrapFailedEntry[]
  ): BootstrapAmbiguous[] {
    const failedKeys = new Set(failed.map((f) => `${f.type}/${f.name}`));
    const resolvedKeys = new Set<string>();
    for (const r of resolutions) {
      const key = `${r.type}/${r.name}`;
      if (failedKeys.has(key)) continue; // failed → not resolved
      resolvedKeys.add(key);
    }
    return before.filter(
      (a) => !resolvedKeys.has(`${a.type}/${a.name}`)
    );
  }

  private appendIgnoredLocal(
    projectId: Id,
    projectPath: string,
    primaryTool: string,
    additions: IgnoredLocalEntry[]
  ): void {
    let existing = readManifest(projectPath, primaryTool);
    if (!existing) {
      // No manifest yet — bootstrap rewriteManifest via SubscriptionService
      // first so we get the canonical server_url / project_id shape and
      // don't have to duplicate that knowledge here.
      this.deps.subscriptions.rewriteManifest(projectId);
      existing = readManifest(projectPath, primaryTool);
    }
    if (!existing) {
      // rewriteManifest above guarantees a write; the only way we reach
      // here is a deeply unusual fs error. Bail rather than write a half-
      // valid manifest that schema validation will reject on next read.
      throw new Error(
        `bootstrap: could not initialise manifest at ${projectPath}/${primaryTool}/.astack.json`
      );
    }
    const next: AstackManifest = {
      ...existing,
      ignored_local: dedupeIgnoredLocal([
        ...existing.ignored_local,
        ...additions
      ])
    };
    writeManifest(projectPath, next, primaryTool);
  }

  // ---------- Internals: SSE ----------

  private emitPostScanEvent(args: {
    projectId: Id;
    result: ProjectBootstrapResult;
    subscribedCount: number;
    failedCount: number;
  }): void {
    const { projectId, result, subscribedCount, failedCount } = args;
    if (result.ambiguous.length > 0) {
      this.deps.events.emit({
        type: EventType.SubscriptionsBootstrapNeedsResolution,
        payload: {
          project_id: projectId,
          matched_count: result.matched.length,
          ambiguous_count: result.ambiguous.length,
          unmatched_count: result.unmatched.length,
          auto_subscribed_count: subscribedCount
        }
      });
      return;
    }
    if (subscribedCount > 0 || failedCount > 0) {
      this.deps.events.emit({
        type: EventType.SubscriptionsBootstrapResolved,
        payload: {
          project_id: projectId,
          remaining_ambiguous_count: 0,
          subscribed_count: subscribedCount,
          ignored_count: 0
        }
      });
    }
    // matched=0 ambiguous=0 subscribed=0 failed=0 → no event.
  }
}
