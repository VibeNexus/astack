/**
 * RepoService — business logic for skill repo lifecycle.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  register(git_url) → clone → scan → upsert → emit       │
 *   │  refresh(repo_id)  → pull (if TTL expired) → re-scan    │
 *   │  remove(repo_id)   → delete DB rows (fs left alone)     │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Concurrency: every mutation on a repo goes through `LockManager`
 * keyed by repo_id (design.md § Eng Review decision 5).
 *
 * Caching: `refresh` consults `ttlCache` before calling `git ls-remote`.
 * See design.md § Eng Review decision 11.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  DEFAULT_SCAN_CONFIG,
  ErrorCode,
  EventType,
  RepoKind,
  SkillType,
  type ScanConfig,
  type Skill,
  type SkillRepo
} from "@astack/shared";

import type { ServerConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { RepoRepository } from "../db/repos.js";
import { SkillRepository } from "../db/skills.js";
import type { EventBus } from "../events.js";
import {
  gitClone,
  gitGetHead,
  gitIsClean,
  gitPull,
  gitRemoteHead
} from "../git.js";
import type { LockManager } from "../lock.js";
import type { Logger } from "../logger.js";
import { scanRepo } from "../scanner/index.js";
import { isBuiltinSeedUrl } from "../seeds.js";

export interface RepoServiceDeps {
  db: Db;
  config: ServerConfig;
  locks: LockManager;
  events: EventBus;
  logger: Logger;
  /** Override git functions for tests. Defaults to real git. */
  gitImpl?: GitImpl;
  /** Clock override for tests. */
  now?: () => number;
}

/** Minimal git surface that RepoService consumes (test-override point). */
export interface GitImpl {
  clone(gitUrl: string, localPath: string, opts: { shallow: boolean }): Promise<void>;
  pull(localPath: string): Promise<void>;
  getHead(localPath: string): Promise<{ head: string; head_time: string }>;
  remoteHead(localPath: string): Promise<string>;
  /**
   * True when the working tree has no uncommitted changes. Consulted by
   * refresh() for open-source repos to avoid silently overwriting any
   * hand-edits the user made inside ~/.astack/repos/<name>.
   */
  isClean(localPath: string): Promise<boolean>;
}

export const defaultGitImpl: GitImpl = {
  clone: gitClone,
  pull: gitPull,
  getHead: gitGetHead,
  remoteHead: gitRemoteHead,
  isClean: gitIsClean
};

export interface RegisterRepoOutput {
  repo: SkillRepo;
  skills: Skill[];
  command_count: number;
  skill_count: number;
}

export interface RefreshOutput {
  repo: SkillRepo;
  skills: Skill[];
  /** True if HEAD moved during this refresh. */
  changed: boolean;
}

export class RepoService {
  private readonly repos: RepoRepository;
  private readonly skills: SkillRepository;
  private readonly git: GitImpl;
  private readonly now: () => number;

  /** Per-repo upstream-HEAD cache. Key: repo_id → (hash, timestamp). */
  private readonly ttlCache = new Map<number, { hash: string; at: number }>();

  constructor(private readonly deps: RepoServiceDeps) {
    this.repos = new RepoRepository(deps.db);
    this.skills = new SkillRepository(deps.db);
    this.git = deps.gitImpl ?? defaultGitImpl;
    this.now = deps.now ?? Date.now;
  }

  // ---------- register ----------

  /**
   * Register a new skill repo.
   *
   * Steps:
   *   1. Reject if git_url already registered
   *   2. Derive name (from param or basename of URL)
   *   3. Clone into ~/.astack/repos/<name>
   *   4. Read HEAD; scan commands/ and skills/
   *   5. Insert into skill_repos; upsert each skill
   *   6. Emit repo.registered event
   */
  async register(input: {
    git_url: string;
    name?: string;
    /** Defaults to "custom" (two-way sync) if omitted. */
    kind?: RepoKind;
    /**
     * Scanner layout override. Omitted / null = use `DEFAULT_SCAN_CONFIG`
     * (skills/<n>/SKILL.md + commands/*.md). Added in v0.2 to support
     * upstream repos with different filesystem conventions (e.g. gstack
     * uses a flat layout, everything-claude-code has an `agents/` root).
     */
    scan_config?: ScanConfig | null;
  }): Promise<RegisterRepoOutput> {
    const gitUrl = input.git_url.trim();
    const kind: RepoKind = input.kind ?? RepoKind.Custom;
    const scanConfig = input.scan_config ?? null;

    if (this.repos.findByGitUrl(gitUrl)) {
      throw new AstackError(
        ErrorCode.REPO_ALREADY_REGISTERED,
        "repo already registered",
        { git_url: gitUrl }
      );
    }

    const name = (input.name ?? deriveNameFromUrl(gitUrl)).trim();
    if (!name) {
      throw new AstackError(
        ErrorCode.VALIDATION_FAILED,
        "could not derive repo name from git_url",
        { git_url: gitUrl }
      );
    }
    if (this.repos.findByName(name)) {
      throw new AstackError(
        ErrorCode.REPO_ALREADY_REGISTERED,
        "repo name collision",
        { name }
      );
    }

    const localPath = path.join(this.deps.config.reposDir, name);
    if (fs.existsSync(localPath)) {
      throw new AstackError(
        ErrorCode.REPO_GIT_FAILED,
        "local clone path already exists",
        { local_path: localPath }
      );
    }

    // Clone + scan before inserting; if clone fails, no partial state.
    await this.git.clone(gitUrl, localPath, { shallow: true });

    const head = await this.git.getHead(localPath);

    // Insert skill_repo row first so we have an id for FK.
    const repoRow = this.repos.insert({
      name,
      git_url: gitUrl,
      kind,
      local_path: localPath,
      scan_config: scanConfig
    });
    this.repos.updateSyncState(repoRow.id, {
      head_hash: head.head,
      last_synced: new Date().toISOString()
    });

    // Scan + upsert skills using the configured layout.
    const skills = this.scanAndUpsert(
      repoRow.id,
      localPath,
      head.head,
      head.head_time,
      scanConfig
    );

    const finalRepo = this.repos.findById(repoRow.id);
    if (!finalRepo) throw new Error("repo row disappeared after insert");

    this.deps.events.emit({
      type: EventType.RepoRegistered,
      payload: { repo: finalRepo }
    });

    return {
      repo: finalRepo,
      skills,
      // NOTE: `agent` type skills are included in `skills[]` but not in
      // these counts to preserve the pre-v0.2 response shape. Consumers
      // that care about agents should iterate `skills`. Future API can add
      // a `total_count` or `agent_count` field.
      command_count: skills.filter((s) => s.type === SkillType.Command).length,
      skill_count: skills.filter((s) => s.type === SkillType.Skill).length
    };
  }

  // ---------- refresh ----------

  /**
   * Force upstream pull + re-scan. Returns whether HEAD moved.
   * Takes the repo-level lock; throws REPO_BUSY if contended past timeout.
   *
   * For `open-source` repos we additionally check the working tree is
   * clean before pulling — if the user hand-edited a SKILL.md inside
   * ~/.astack/repos/<name>, we don't want to silently blow it away.
   * A dirty open-source repo short-circuits to no-op + warning; the
   * user can resolve manually (revert or commit + push) and refresh
   * again.
   */
  async refresh(repoId: number): Promise<RefreshOutput> {
    const repo = this.mustFindById(repoId);

    return this.deps.locks.withLock(repoId, async () => {
      if (!repo.local_path) {
        throw new AstackError(
          ErrorCode.REPO_STRUCTURE_INVALID,
          "repo has no local clone path",
          { repo_id: repoId }
        );
      }

      // Safety check: for read-only (open-source) repos, refuse to pull
      // over uncommitted local edits. This does NOT apply to 'custom'
      // repos because those are expected to have user edits that the
      // push workflow handles separately.
      if (repo.kind === RepoKind.OpenSource) {
        const clean = await this.git.isClean(repo.local_path);
        if (!clean) {
          this.deps.logger.warn("repo.refresh.dirty_skip", {
            repo_id: repoId,
            repo_name: repo.name,
            detail:
              "open-source repo has uncommitted local edits; skipping pull to avoid overwriting them"
          });
          const skills = this.skills.listByRepo(repoId);
          this.deps.events.emit({
            type: EventType.RepoRefreshed,
            payload: { repo, changed: false }
          });
          return { repo, skills, changed: false };
        }
      }

      const before = repo.head_hash;

      // Pull with retry? No — we surface the git error directly per design.
      await this.git.pull(repo.local_path);
      const head = await this.git.getHead(repo.local_path);

      this.repos.updateSyncState(repoId, {
        head_hash: head.head,
        last_synced: new Date().toISOString()
      });
      // Invalidate any stale cache entry.
      this.ttlCache.delete(repoId);

      const changed = head.head !== before;
      const skills = this.scanAndUpsert(
        repoId,
        repo.local_path,
        head.head,
        head.head_time,
        repo.scan_config
      );

      const updated = this.repos.findById(repoId);
      if (!updated) throw new Error("repo row disappeared during refresh");

      this.deps.events.emit({
        type: EventType.RepoRefreshed,
        payload: { repo: updated, changed }
      });

      return { repo: updated, skills, changed };
    });
  }

  // ---------- remove ----------

  /**
   * Unregister a repo. Cascades to skills (FK). Does NOT delete the
   * local clone from disk — user may want to keep it for other purposes.
   * (The row is gone so Astack won't reuse it; user can `rm -rf` manually.)
   *
   * When the removed URL matches a builtin seed, we persist the user's
   * decision in `seed_decisions` so SeedService skips it on next start
   * instead of re-seeding the repo the user just removed.
   */
  remove(repoId: number): void {
    const repo = this.mustFindById(repoId);
    const deleted = this.repos.delete(repoId);
    if (!deleted) {
      throw new AstackError(ErrorCode.REPO_NOT_FOUND, "repo not found", {
        repo_id: repoId
      });
    }
    this.ttlCache.delete(repoId);

    // Respect user's decision if this was a builtin seed — otherwise it
    // would auto-reinstall on the next daemon restart.
    if (isBuiltinSeedUrl(repo.git_url)) {
      this.deps.db
        .prepare<[string, string]>(
          `INSERT OR REPLACE INTO seed_decisions (url, decision)
           VALUES (?, ?)`
        )
        .run(repo.git_url, "removed");
    }

    this.deps.events.emit({
      type: EventType.RepoRemoved,
      payload: { repo_id: repo.id }
    });
  }

  // ---------- queries ----------

  findById(repoId: number): SkillRepo | null {
    return this.repos.findById(repoId);
  }

  list(opts: { offset: number; limit: number }): {
    repos: SkillRepo[];
    total: number;
  } {
    const { rows, total } = this.repos.list(opts);
    return { repos: rows, total };
  }

  listSkills(repoId: number): Skill[] {
    // Validate repo existence so caller gets REPO_NOT_FOUND, not silent [].
    this.mustFindById(repoId);
    return this.skills.listByRepo(repoId);
  }

  // ---------- upstream-HEAD TTL cache ----------

  /**
   * Read upstream HEAD hash. Consults the TTL cache; falls back to
   * `git ls-remote`. Pass `{ force: true }` to bypass cache.
   *
   * This is used by SyncService to decide whether pull is even necessary.
   */
  async getUpstreamHead(
    repoId: number,
    opts: { force: boolean } = { force: false }
  ): Promise<string> {
    const repo = this.mustFindById(repoId);
    if (!repo.local_path) {
      throw new AstackError(
        ErrorCode.REPO_STRUCTURE_INVALID,
        "repo has no local clone path",
        { repo_id: repoId }
      );
    }

    if (!opts.force) {
      const cached = this.ttlCache.get(repoId);
      if (cached && this.now() - cached.at < this.deps.config.upstreamCacheTtlMs) {
        return cached.hash;
      }
    }

    const hash = await this.git.remoteHead(repo.local_path);
    this.ttlCache.set(repoId, { hash, at: this.now() });
    return hash;
  }

  // ---------- internal ----------

  /**
   * Scan the local clone and reconcile `skills` table rows for this repo.
   * Returns the current skill rows.
   *
   * @param scanConfig  Layout override. null = use `DEFAULT_SCAN_CONFIG`.
   */
  private scanAndUpsert(
    repoId: number,
    localPath: string,
    headHash: string,
    headTime: string,
    scanConfig: ScanConfig | null
  ): Skill[] {
    const config = scanConfig ?? DEFAULT_SCAN_CONFIG;
    const { skills, warnings } = scanRepo(localPath, config);

    for (const w of warnings) {
      this.deps.logger.warn("scan.warning", { repo_id: repoId, detail: w });
    }

    const upserted: Skill[] = [];
    for (const s of skills) {
      upserted.push(
        this.skills.upsert({
          repo_id: repoId,
          type: s.type,
          name: s.name,
          path: s.relPath,
          description: s.description,
          version: headHash,
          updated_at: headTime
        })
      );
    }

    // Remove rows for skills that disappeared since last scan.
    this.skills.deleteMissing(
      repoId,
      skills.map((s) => ({ type: s.type, name: s.name }))
    );

    return upserted;
  }

  private mustFindById(repoId: number): SkillRepo {
    const repo = this.repos.findById(repoId);
    if (!repo) {
      throw new AstackError(ErrorCode.REPO_NOT_FOUND, "repo not found", {
        repo_id: repoId
      });
    }
    return repo;
  }
}

// ---------- helpers ----------

/**
 * Derive a repo name from its git URL.
 *
 *   git@github.com:user/my-skills.git       → my-skills
 *   https://github.com/user/my-skills       → my-skills
 *   /abs/local/path/my-skills               → my-skills
 */
export function deriveNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  // Strip .git suffix.
  const noExt = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
  // Last segment after / or :.
  const parts = noExt.split(/[\\/:]/);
  return parts[parts.length - 1] ?? "";
}
