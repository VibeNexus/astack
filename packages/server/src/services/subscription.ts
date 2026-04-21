/**
 * SubscriptionService.
 *
 * Responsibilities:
 *   - Parse skill refs: "code_review" | "my-skills/code_review" |
 *     "my-skills/command/code_review" → concrete Skill row.
 *     Handles SKILL_REF_AMBIGUOUS and SKILL_TYPE_AMBIGUOUS per decision 6.
 *
 *   - Keep `.astack.json` and SQLite `subscriptions` in sync:
 *     file is authoritative (design.md § Eng Review decision 2). Every
 *     subscribe/unsubscribe writes both.
 *
 *   - Enforce "one local filename per project" — a project cannot subscribe
 *     to two skills of the same (type, name) from different repos
 *     (SUBSCRIPTION_NAME_COLLISION).
 */

import {
  AstackError,
  ErrorCode,
  type Skill,
  type SkillRepo,
  type SkillType as SkillTypeT,
  type Subscription
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { RepoRepository } from "../db/repos.js";
import { SkillRepository } from "../db/skills.js";
import { SubscriptionRepository } from "../db/subscriptions.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import {
  dedupeSubscriptions,
  readManifest,
  writeManifest,
  type AstackManifest,
  type NormalizedSubscription
} from "../manifest.js";

import type { ProjectService } from "./project.js";

export interface SubscriptionServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  projects: ProjectService;
  /** Used when composing manifest.server_url. */
  serverUrl: string;
}

export interface ResolvedSkillRef {
  skill: Skill;
  repo: SkillRepo;
}

export class SubscriptionService {
  private readonly repos: RepoRepository;
  private readonly skills: SkillRepository;
  private readonly subs: SubscriptionRepository;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.repos = new RepoRepository(deps.db);
    this.skills = new SkillRepository(deps.db);
    this.subs = new SubscriptionRepository(deps.db);
  }

  // ---------- Reference resolution ----------

  /**
   * Resolve a skill ref string to a concrete Skill + Repo.
   *
   * Forms accepted:
   *   "code_review"                      (short — requires 1 match across repos)
   *   "my-skills/code_review"            (repo-qualified — requires 1 type)
   *   "my-skills/command/code_review"    (fully qualified)
   *
   * `typeHint` disambiguates type when a repo has both a command and a skill
   * with the same name.
   *
   * Throws:
   *   SKILL_NOT_FOUND        — no match
   *   SKILL_REF_AMBIGUOUS    — short ref matches multiple repos
   *   SKILL_TYPE_AMBIGUOUS   — repo-qualified and both types match
   *   REPO_NOT_FOUND         — repo prefix given but repo not registered
   */
  resolveRef(ref: string, typeHint?: SkillTypeT): ResolvedSkillRef {
    const parts = ref.split("/");
    if (parts.length === 1) {
      return this.resolveShort(parts[0]!, typeHint);
    }
    if (parts.length === 2) {
      return this.resolveRepoQualified(parts[0]!, parts[1]!, typeHint);
    }
    if (parts.length === 3) {
      const [repoName, typeStr, name] = parts as [string, string, string];
      if (typeStr !== "command" && typeStr !== "skill") {
        throw new AstackError(
          ErrorCode.VALIDATION_FAILED,
          `invalid skill type in ref: '${typeStr}'`,
          { ref }
        );
      }
      return this.resolveFullyQualified(repoName, typeStr, name);
    }
    throw new AstackError(
      ErrorCode.VALIDATION_FAILED,
      "skill ref has too many segments",
      { ref }
    );
  }

  private resolveShort(
    name: string,
    typeHint?: SkillTypeT
  ): ResolvedSkillRef {
    let matches = this.skills.findByShortName(name);
    if (typeHint) {
      matches = matches.filter((m) => m.type === typeHint);
    }

    if (matches.length === 0) {
      throw new AstackError(
        ErrorCode.SKILL_NOT_FOUND,
        `no skill found named '${name}'`,
        { name, type: typeHint }
      );
    }

    // Multiple repos have this name → ambiguous.
    const uniqueRepos = new Set(matches.map((m) => m.repo_id));
    if (uniqueRepos.size > 1) {
      throw new AstackError(
        ErrorCode.SKILL_REF_AMBIGUOUS,
        `skill name '${name}' exists in multiple repos; use '<repo>/${name}'`,
        {
          name,
          repo_ids: Array.from(uniqueRepos)
        }
      );
    }

    // Same repo, but ambiguous type?
    if (matches.length > 1) {
      throw new AstackError(
        ErrorCode.SKILL_TYPE_AMBIGUOUS,
        `both a command and a skill are named '${name}'; pass --type`,
        { name, types: matches.map((m) => m.type) }
      );
    }

    const skill = matches[0]!;
    const repo = this.mustFindRepo(skill.repo_id);
    return { skill, repo };
  }

  private resolveRepoQualified(
    repoName: string,
    skillName: string,
    typeHint?: SkillTypeT
  ): ResolvedSkillRef {
    const repo = this.repos.findByName(repoName);
    if (!repo) {
      throw new AstackError(
        ErrorCode.REPO_NOT_FOUND,
        `repo '${repoName}' not registered`,
        { name: repoName }
      );
    }

    const all = this.skills.listByRepo(repo.id).filter(
      (s) => s.name === skillName
    );
    const filtered = typeHint ? all.filter((s) => s.type === typeHint) : all;

    if (filtered.length === 0) {
      throw new AstackError(
        ErrorCode.SKILL_NOT_FOUND,
        `no skill '${skillName}' in repo '${repoName}'`,
        { repo: repoName, name: skillName, type: typeHint }
      );
    }
    if (filtered.length > 1) {
      throw new AstackError(
        ErrorCode.SKILL_TYPE_AMBIGUOUS,
        `both a command and a skill are named '${skillName}' in '${repoName}'; pass --type`,
        { repo: repoName, name: skillName }
      );
    }
    return { skill: filtered[0]!, repo };
  }

  private resolveFullyQualified(
    repoName: string,
    typeStr: SkillTypeT,
    name: string
  ): ResolvedSkillRef {
    const repo = this.repos.findByName(repoName);
    if (!repo) {
      throw new AstackError(
        ErrorCode.REPO_NOT_FOUND,
        `repo '${repoName}' not registered`,
        { name: repoName }
      );
    }
    const skill = this.skills.findByRef(repo.id, typeStr, name);
    if (!skill) {
      throw new AstackError(
        ErrorCode.SKILL_NOT_FOUND,
        `no ${typeStr} '${name}' in repo '${repoName}'`,
        { repo: repoName, type: typeStr, name }
      );
    }
    return { skill, repo };
  }

  // ---------- Subscribe / unsubscribe ----------

  /**
   * Add a subscription: resolve the ref, enforce local-filename uniqueness,
   * insert row (upsert), then rewrite .astack.json.
   */
  subscribe(
    projectId: number,
    ref: string,
    opts: {
      type?: SkillTypeT;
      pinned_version?: string;
    } = {}
  ): { subscription: Subscription; skill: Skill; repo: SkillRepo } {
    const project = this.deps.projects.mustFindById(projectId);
    const { skill, repo } = this.resolveRef(ref, opts.type);

    // Enforce "one local file per project" rule (decision 6).
    this.ensureNoFileCollision(projectId, skill);

    const subscription = this.subs.upsert({
      project_id: projectId,
      skill_id: skill.id,
      pinned_version: opts.pinned_version ?? null
    });

    this.rewriteManifest(project.id);

    return { subscription, skill, repo };
  }

  /**
   * Batch subscribe with per-ref partial success semantics.
   *
   * v0.3: the main Web "Browse Skills" drawer calls this with 10+ refs at
   * once. Pre-v0.3, any single failure rolled the whole request back (HTTP
   * 500). That was strictly worse — users lost the 9 successful subs they
   * already picked when one ref collided with an existing subscription.
   *
   * New contract:
   *   - Every ref is attempted independently (try/catch per ref).
   *   - Successes are committed immediately (DB + manifest) — failures on
   *     later refs do NOT undo earlier successes.
   *   - Failures collect the structured AstackError code + message so the
   *     client can render per-row errors.
   *   - The caller decides HTTP status (200 for partial success, not 4xx).
   *
   * `opts.pinned_version` only applies when `refs.length === 1`; the
   * validator should enforce this (SubscribeRequestSchema does).
   */
  subscribeBatch(
    projectId: number,
    refs: string[],
    opts: {
      type?: SkillTypeT;
      pinned_version?: string;
    } = {}
  ): {
    subscriptions: Subscription[];
    skills: Skill[];
    failures: Array<{ ref: string; code: string; message: string }>;
  } {
    // Resolve project once at the top — it's a required-404 for the whole
    // batch. A bad projectId isn't a per-ref failure.
    this.deps.projects.mustFindById(projectId);

    const subscriptions: Subscription[] = [];
    const skills: Skill[] = [];
    const failures: Array<{ ref: string; code: string; message: string }> = [];

    for (const ref of refs) {
      try {
        const res = this.subscribe(projectId, ref, {
          type: opts.type,
          // pinned_version is only meaningful for single-ref; we pass it
          // through unconditionally here and let the caller's validator
          // have rejected length-mismatched input upstream.
          pinned_version:
            refs.length === 1 ? opts.pinned_version : undefined
        });
        subscriptions.push(res.subscription);
        skills.push(res.skill);
      } catch (err) {
        if (err instanceof AstackError) {
          failures.push({ ref, code: err.code, message: err.message });
          this.deps.logger.warn("subscribe.ref_failed", {
            project_id: projectId,
            ref,
            code: err.code
          });
          continue;
        }
        // Unknown (non-Astack) error is genuinely unexpected — bail so
        // we surface the bug instead of swallowing it into failures[].
        throw err;
      }
    }

    return { subscriptions, skills, failures };
  }

  /**
   * Remove a subscription. Returns true if a row was deleted.
   * Manifest rewritten if a subscription actually went away.
   */
  unsubscribe(projectId: number, skillId: number): boolean {
    const project = this.deps.projects.mustFindById(projectId);
    const deleted = this.subs.deleteByProjectSkill(projectId, skillId);
    if (deleted) this.rewriteManifest(project.id);
    return deleted;
  }

  listForProject(projectId: number): Subscription[] {
    return this.subs.listByProject(projectId);
  }

  findByProjectSkill(projectId: number, skillId: number): Subscription | null {
    return this.subs.findByProjectSkill(projectId, skillId);
  }

  // ---------- Manifest reconciliation ----------

  /**
   * Sync .astack.json → SQLite (file wins).
   *
   * Used at the top of operations that need current state (sync, status).
   * If the manifest file is missing, SQLite rows are kept as-is (first-run
   * scenario after `astack init` but before first subscribe).
   *
   * Skips manifest entries whose skill refs can't be resolved (e.g. the
   * user hand-edited the file); those are logged as warnings.
   */
  reconcileFromManifest(projectId: number): AstackManifest | null {
    const project = this.deps.projects.mustFindById(projectId);
    const manifest = readManifest(project.path, project.primary_tool);
    if (!manifest) return null;

    // Compute desired SQLite state from manifest.
    const desiredSkillIds = new Set<number>();
    for (const entry of manifest.subscriptions) {
      try {
        const { skill } = this.resolveFullyQualified(
          entry.repo,
          entry.type,
          entry.name
        );
        desiredSkillIds.add(skill.id);
        this.subs.upsert({
          project_id: projectId,
          skill_id: skill.id,
          pinned_version: null
        });
      } catch (err) {
        this.deps.logger.warn("manifest.unresolved_entry", {
          project_id: projectId,
          entry: `${entry.repo}/${entry.type}/${entry.name}`,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Drop SQLite subs not present in manifest.
    const current = this.subs.listByProject(projectId);
    for (const row of current) {
      if (!desiredSkillIds.has(row.skill_id)) {
        this.subs.deleteByProjectSkill(projectId, row.skill_id);
      }
    }

    return manifest;
  }

  /**
   * Rewrite the manifest from current SQLite state + project metadata.
   * Creates the file on first write. Preserves `last_synced` when present.
   */
  rewriteManifest(projectId: number): void {
    const project = this.deps.projects.mustFindById(projectId);
    const existing = readManifest(project.path, project.primary_tool);

    const linked_dirs = this.deps.projects.listLinkedDirRows(projectId);
    const rows = this.subs.listByProject(projectId);

    const subs: NormalizedSubscription[] = [];
    for (const row of rows) {
      const skill = this.skills.findById(row.skill_id);
      if (!skill) continue;
      const repo = this.repos.findById(skill.repo_id);
      if (!repo) continue;
      subs.push({ repo: repo.name, type: skill.type, name: skill.name });
    }

    const manifest: AstackManifest = {
      project_id: project.id,
      server_url: this.deps.serverUrl,
      primary_tool: project.primary_tool,
      linked_tools: linked_dirs.map((l) => l.tool_name),
      subscriptions: dedupeSubscriptions(subs),
      // v0.5 §A3 / R3: preserve user's bootstrap "Don't subscribe" choices.
      // rewriteManifest is called on every subscribe/unsubscribe; without
      // this line the very next subscribe after PR1 ships would silently
      // wipe `ignored_local`.
      ignored_local: existing?.ignored_local ?? [],
      last_synced: existing?.last_synced ?? null
    };

    writeManifest(project.path, manifest, project.primary_tool);
  }

  /**
   * Update `last_synced` in the manifest without touching other fields.
   * Called by SyncService after successful syncs.
   */
  touchLastSynced(projectId: number, when: string): void {
    const project = this.deps.projects.mustFindById(projectId);
    const existing = readManifest(project.path, project.primary_tool);
    if (!existing) {
      // Nothing to do; next rewriteManifest will set it.
      return;
    }
    writeManifest(
      project.path,
      { ...existing, last_synced: when },
      project.primary_tool
    );
  }

  // ---------- internal ----------

  private ensureNoFileCollision(projectId: number, incoming: Skill): void {
    const rows = this.subs.listByProject(projectId);
    for (const row of rows) {
      if (row.skill_id === incoming.id) continue; // same skill, upsert OK
      const other = this.skills.findById(row.skill_id);
      if (!other) continue;
      if (other.type === incoming.type && other.name === incoming.name) {
        const otherRepo = this.repos.findById(other.repo_id);
        throw new AstackError(
          ErrorCode.SUBSCRIPTION_NAME_COLLISION,
          `project already subscribes to a ${incoming.type} named '${incoming.name}' from repo '${otherRepo?.name ?? "?"}'`,
          {
            project_id: projectId,
            type: incoming.type,
            name: incoming.name,
            existing_repo: otherRepo?.name
          }
        );
      }
    }
  }

  private mustFindRepo(repoId: number): SkillRepo {
    const repo = this.repos.findById(repoId);
    if (!repo) {
      throw new AstackError(ErrorCode.REPO_NOT_FOUND, "repo not found", {
        repo_id: repoId
      });
    }
    return repo;
  }
}
