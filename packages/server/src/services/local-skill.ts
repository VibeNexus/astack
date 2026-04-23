/**
 * LocalSkillService — v0.7.
 *
 * Owns the lifecycle of project-local skills tracked without an upstream
 * repo. See docs/version/v0.7-local-skills.md §A1 / §1.5.
 *
 * Responsibilities:
 *   - `list(projectId)`  : read DB + apply lightweight fs probe for drift
 *   - `adopt(...)`       : user-initiated batch adopt (origin='adopted')
 *   - `autoAdoptFromUnmatched(...)` : bootstrap-driven auto-adopt
 *                          (origin='auto'); called from PR4
 *   - `unadopt(...)`     : batch delete rows; optionally rm files on disk
 *   - `rescan(...)`      : recompute hashes + transition status
 *   - `suggestFromUnmatched(projectId)` : adoption suggestions for UI
 *
 * Source-of-truth boundaries:
 *   - LocalSkill NEVER writes `.astack.json` (§A3). Only DB + optional fs
 *     mutation (delete_files on unadopt).
 *   - Filesystem is the eventual truth — `list` does a stat probe on
 *     every call and flips present→missing in the return value without
 *     writing DB (rescan is the only writer for status transitions).
 *
 * Concurrency (§A8):
 *   All writers (adopt / autoAdoptFromUnmatched / unadopt / rescan)
 *   acquire `projectBootstrapLockKey(projectId)` so they never interleave
 *   with `ProjectBootstrapService` / `SyncService.pullBatch`.
 *
 * Dependency on ProjectBootstrapService:
 *   Only `suggestFromUnmatched` consumes bootstrap's scan result. We
 *   receive it via a late-bound getter to avoid a circular constructor
 *   dependency — PR4 will need ProjectBootstrapService to call back into
 *   LocalSkillService for auto-adopt (mirror of v0.4
 *   `systemSkillServiceRef` pattern).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  SkillType,
  type ApplyLocalSkillsResult,
  type BootstrapFailedEntry,
  type BootstrapUnmatched,
  type Id,
  type LocalSkill,
  type LocalSkillOrigin,
  type LocalSkillStatus,
  type LocalSkillsChangedSummary,
  type UnadoptLocalSkillsResult
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { LocalSkillRepository } from "../db/local-skills.js";
import { SkillRepository } from "../db/skills.js";
import type { EventBus } from "../events.js";
import { hashDir, hashFile, isDir, isFile, removeDir, removeFile } from "../fs-util.js";
import { projectBootstrapLockKey, type LockManager } from "../lock.js";
import type { Logger } from "../logger.js";
import { scanRepo, type ScannedSkill } from "../scanner/index.js";

import { BOOTSTRAP_SCAN_CONFIG } from "./project-bootstrap.js";
import type { ProjectBootstrapService } from "./project-bootstrap.js";
import type { ProjectService } from "./project.js";
import type { SubscriptionService } from "./subscription.js";

// ---------- Types ----------

export interface LocalSkillServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  locks: LockManager;
  projects: ProjectService;
  subscriptions: SubscriptionService;
  /**
   * Late-bound ProjectBootstrapService accessor. Returns null before PR4
   * wires it (kept optional so v0.7 PR2 can ship/test without the full
   * integration). Used only by `suggestFromUnmatched`.
   */
  getBootstrapService?: () => ProjectBootstrapService | null;
}

/** Input tuple shared by adopt / unadopt / rescan. */
export interface LocalSkillRef {
  type: SkillType;
  name: string;
}

// ---------- Service ----------

export class LocalSkillService {
  private readonly repo: LocalSkillRepository;
  private readonly skills: SkillRepository;

  constructor(private readonly deps: LocalSkillServiceDeps) {
    this.repo = new LocalSkillRepository(deps.db);
    this.skills = new SkillRepository(deps.db);
  }

  // =====================================================================
  // Public API
  // =====================================================================

  /**
   * List LocalSkills for a project with a lightweight fs-drift probe:
   * rows whose DB status is `present` / `modified` but whose file/dir is
   * missing from disk are returned with `status: 'missing'` WITHOUT
   * touching the DB. The authoritative transition is performed by
   * `rescan`, which also writes.
   *
   * Returns an empty array for projects with primary_tool != '.claude'
   * (LocalSkill only supports Claude tooling in v0.7 — see spec §Out of
   * scope).
   */
  list(projectId: Id): LocalSkill[] {
    const project = this.deps.projects.mustFindById(projectId);
    if (project.primary_tool !== ".claude") return [];

    const rows = this.repo.listByProject(projectId);
    const primaryRoot = path.join(project.path, project.primary_tool);
    return rows.map((row) => {
      if (row.status === "missing") return row;
      // Only probe rows that claim to exist; missing already says so.
      const abs = path.join(primaryRoot, row.rel_path);
      const exists = row.type === SkillType.Skill ? isDir(abs) : isFile(abs);
      if (!exists) {
        return { ...row, status: "missing" as LocalSkillStatus };
      }
      return row;
    });
  }

  /**
   * Suggest entries the user could adopt. Returns the bootstrap scan's
   * `unmatched` list minus anything already tracked in `local_skills`.
   *
   * Requires `getBootstrapService` to be wired (see DI note). Throws
   * INTERNAL when called before PR4 wiring — the HTTP route guards this
   * by returning 503 until the feature is fully connected.
   */
  async suggestFromUnmatched(projectId: Id): Promise<BootstrapUnmatched[]> {
    const project = this.deps.projects.mustFindById(projectId);
    if (project.primary_tool !== ".claude") return [];

    const bootstrap = this.deps.getBootstrapService?.() ?? null;
    if (!bootstrap) {
      throw new AstackError(
        ErrorCode.INTERNAL,
        "ProjectBootstrapService not wired for LocalSkillService.suggestFromUnmatched",
        { project_id: projectId }
      );
    }
    const scan = await bootstrap.scan(projectId);
    const adoptedKeys = new Set(
      this.repo.listByProject(projectId).map((r) => `${r.type}/${r.name}`)
    );
    return scan.unmatched.filter(
      (u) => !adoptedKeys.has(`${u.type}/${u.name}`)
    );
  }

  /**
   * User-initiated adopt. `origin='adopted'`. See spec §1.5 item 3.
   *
   * Per-entry try/catch — AstackError → `failed[]`; non-AstackError
   * propagates (same R4 contract as v0.5 SubscriptionService).
   */
  async adopt(
    projectId: Id,
    entries: LocalSkillRef[]
  ): Promise<ApplyLocalSkillsResult> {
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      async () => this.adoptUnderLock(projectId, entries, "adopted")
    );
  }

  /**
   * Bootstrap-driven auto-adopt for unmatched entries. Called from
   * `ProjectBootstrapService.scanAndAutoSubscribe` in PR4. Entries that
   * are already tracked are skipped (not re-demoted to 'auto').
   *
   * The caller MUST already hold `projectBootstrapLockKey(projectId)` —
   * this method is called from inside bootstrap's own lock scope to avoid
   * double-acquire deadlock. Callers outside bootstrap should use
   * `adopt(...)` instead.
   */
  autoAdoptFromUnmatched(
    projectId: Id,
    unmatched: BootstrapUnmatched[]
  ): ApplyLocalSkillsResult {
    const filtered = unmatched.filter((u) => {
      const existing = this.repo.findByRef(projectId, u.type, u.name);
      return !existing;
    });
    const refs: LocalSkillRef[] = filtered.map((u) => ({
      type: u.type,
      name: u.name
    }));
    // Reuse the unlocked adopt implementation; caller already holds lock.
    return this.adoptInternal(projectId, refs, "auto");
  }

  /**
   * v0.8: Flip matching LocalSkill rows to `status='name_collision'`.
   *
   * Called by `ProjectBootstrapService.scanAndAutoSubscribe` after a
   * reclassify pass subscribes an entry that happens to already exist
   * as a LocalSkill (typically `origin='auto'` from an earlier bootstrap
   * that ran before the upstream repo was registered). Implements the
   * §A6 contract "LocalSkillService.upsert … 若 (project_id, type, name)
   * 已存在订阅，status 置 name_collision" but for the reverse order
   * (LocalSkill existed first, subscription arrived later).
   *
   * Caller MUST already hold `projectBootstrapLockKey(projectId)` — this
   * is a no-lock helper, the inverse double-acquire constraint that
   * `autoAdoptFromUnmatched` has.
   *
   * Emits `local_skills.changed` when at least one row flipped so the
   * UI refreshes; no event when the refs list is effectively a no-op.
   */
  markNameCollisionUnderLock(
    projectId: Id,
    refs: LocalSkillRef[]
  ): number {
    if (refs.length === 0) return 0;
    const now = new Date().toISOString();
    let flipped = 0;
    for (const ref of refs) {
      const row = this.repo.findByRef(projectId, ref.type, ref.name);
      if (!row) continue;
      if (row.status === "name_collision") continue;
      this.repo.updateStatus(row.id, {
        status: "name_collision",
        content_hash: row.content_hash,
        last_seen_at: now
      });
      flipped += 1;
    }
    if (flipped > 0) {
      // Use the "modified" bucket loosely as "a row transitioned"; the
      // web client re-fetches the full list on any changed event so the
      // exact bucket doesn't affect correctness, only future telemetry.
      this.emitChanged(projectId, {
        added: 0,
        removed: 0,
        modified: flipped,
        missing: 0
      });
    }
    return flipped;
  }

  /**
   * Batch unadopt. Always deletes DB rows; if `delete_files` is true,
   * also removes the backing file/directory from disk.
   */
  async unadopt(
    projectId: Id,
    entries: LocalSkillRef[],
    opts: { delete_files?: boolean } = {}
  ): Promise<UnadoptLocalSkillsResult> {
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      async () => this.unadoptUnderLock(projectId, entries, opts)
    );
  }

  /**
   * Re-evaluate every tracked LocalSkill's on-disk state and update
   * `status` / `content_hash` / `last_seen_at` accordingly.
   *
   *   file missing                     → status='missing'
   *   file present, hash matches       → status='present'  (or 'name_collision')
   *   file present, hash differs       → status='modified'
   *
   * Does NOT insert new rows — discovering new local entries is the
   * user's responsibility via `suggestFromUnmatched` + `adopt`.
   */
  async rescan(projectId: Id): Promise<LocalSkill[]> {
    return this.deps.locks.withLock(
      projectBootstrapLockKey(projectId),
      async () => this.rescanUnderLock(projectId)
    );
  }

  // =====================================================================
  // Internals (all `*UnderLock` assume caller holds the project lock)
  // =====================================================================

  private adoptUnderLock(
    projectId: Id,
    entries: LocalSkillRef[],
    origin: LocalSkillOrigin
  ): ApplyLocalSkillsResult {
    return this.adoptInternal(projectId, entries, origin);
  }

  private adoptInternal(
    projectId: Id,
    entries: LocalSkillRef[],
    origin: LocalSkillOrigin
  ): ApplyLocalSkillsResult {
    const project = this.deps.projects.mustFindById(projectId);
    const succeeded: LocalSkill[] = [];
    const failed: BootstrapFailedEntry[] = [];

    if (project.primary_tool !== ".claude") {
      // Soft no-op: report every entry as failed with a clear reason.
      for (const e of entries) {
        failed.push({
          type: e.type,
          name: e.name,
          code: ErrorCode.NOT_IMPLEMENTED,
          message: `LocalSkill adopt not supported for primary_tool='${project.primary_tool}'`
        });
      }
      return { succeeded, failed };
    }

    const primaryRoot = path.join(project.path, project.primary_tool);
    // Scan once so we can resolve description + rel_path per entry.
    const scanResult = scanRepo(primaryRoot, BOOTSTRAP_SCAN_CONFIG);
    const scannedByRef = new Map<string, ScannedSkill>();
    for (const s of scanResult.skills) {
      scannedByRef.set(`${s.type}/${s.name}`, s);
    }

    // Pre-compute subscription collisions once.
    const subscribedKeys = this.collectSubscribedKeys(projectId);

    const summary: LocalSkillsChangedSummary = {
      added: 0,
      removed: 0,
      modified: 0,
      missing: 0
    };

    for (const entry of entries) {
      try {
        const key = `${entry.type}/${entry.name}`;
        const scanned = scannedByRef.get(key);
        if (!scanned) {
          throw new AstackError(
            ErrorCode.LOCAL_SKILL_NOT_ON_DISK,
            `no ${entry.type} '${entry.name}' found under ${project.primary_tool}/`,
            { project_id: projectId, type: entry.type, name: entry.name }
          );
        }

        const absPath = path.join(primaryRoot, scanned.relPath);
        const contentHash =
          entry.type === SkillType.Skill ? hashDir(absPath) : hashFile(absPath);

        const previous = this.repo.findByRef(projectId, entry.type, entry.name);
        const status: LocalSkillStatus = subscribedKeys.has(key)
          ? "name_collision"
          : "present";

        const now = new Date().toISOString();
        // Preserve origin on existing rows: we never downgrade
        // adopted→auto. Auto-adopt that hits an existing adopted row
        // just bumps last_seen_at + status; user intent ("adopted")
        // wins.
        const resolvedOrigin: LocalSkillOrigin = previous
          ? previous.origin === "adopted"
            ? "adopted"
            : origin
          : origin;

        const row = this.repo.upsert({
          id: previous?.id ?? crypto.randomUUID(),
          project_id: projectId,
          type: entry.type,
          name: entry.name,
          rel_path: scanned.relPath,
          description: scanned.description,
          origin: resolvedOrigin,
          status,
          content_hash: contentHash,
          adopted_at: previous?.adopted_at ?? now,
          last_seen_at: now
        });

        // If upsert needed to promote origin, issue a targeted UPDATE —
        // UPSERT DO UPDATE above intentionally does NOT touch origin so
        // manual adopts after an auto-adopt correctly overwrite.
        if (previous && resolvedOrigin !== previous.origin) {
          this.repo.setOrigin(row.id, resolvedOrigin);
          row.origin = resolvedOrigin;
        }

        succeeded.push(row);
        if (!previous) summary.added += 1;
      } catch (err) {
        if (err instanceof AstackError) {
          failed.push({
            type: entry.type,
            name: entry.name,
            code: err.code,
            message: err.message
          });
          this.deps.logger.warn("local_skills.adopt_failed", {
            project_id: projectId,
            type: entry.type,
            name: entry.name,
            code: err.code
          });
          continue;
        }
        throw err;
      }
    }

    if (succeeded.length > 0) {
      this.emitChanged(projectId, summary);
    }
    return { succeeded, failed };
  }

  private unadoptUnderLock(
    projectId: Id,
    entries: LocalSkillRef[],
    opts: { delete_files?: boolean }
  ): UnadoptLocalSkillsResult {
    const project = this.deps.projects.mustFindById(projectId);
    const unadopted: Array<{ type: SkillType; name: string }> = [];
    const files_deleted: string[] = [];
    const failed: BootstrapFailedEntry[] = [];

    const primaryRoot = path.join(project.path, project.primary_tool);
    const summary: LocalSkillsChangedSummary = {
      added: 0,
      removed: 0,
      modified: 0,
      missing: 0
    };

    for (const entry of entries) {
      try {
        const existing = this.repo.findByRef(
          projectId,
          entry.type,
          entry.name
        );
        if (!existing) {
          throw new AstackError(
            ErrorCode.LOCAL_SKILL_NOT_FOUND,
            `no LocalSkill ${entry.type}/${entry.name} for this project`,
            { project_id: projectId, type: entry.type, name: entry.name }
          );
        }

        if (opts.delete_files) {
          const abs = path.join(primaryRoot, existing.rel_path);
          try {
            if (entry.type === SkillType.Skill) {
              if (isDir(abs)) removeDir(abs);
            } else {
              if (isFile(abs)) removeFile(abs);
            }
            files_deleted.push(existing.rel_path);
          } catch (fsErr) {
            // Don't delete the DB row if we failed to remove the file —
            // otherwise the UI would report "unadopted" while the file
            // silently survives.
            throw new AstackError(
              ErrorCode.LOCAL_SKILL_DELETE_FAILED,
              `failed to delete ${existing.rel_path} from disk`,
              {
                project_id: projectId,
                type: entry.type,
                name: entry.name,
                fs_error: fsErr instanceof Error ? fsErr.message : String(fsErr)
              }
            );
          }
        }

        this.repo.deleteByRef(projectId, entry.type, entry.name);
        unadopted.push({ type: entry.type, name: entry.name });
        summary.removed += 1;
      } catch (err) {
        if (err instanceof AstackError) {
          failed.push({
            type: entry.type,
            name: entry.name,
            code: err.code,
            message: err.message
          });
          this.deps.logger.warn("local_skills.unadopt_failed", {
            project_id: projectId,
            type: entry.type,
            name: entry.name,
            code: err.code
          });
          continue;
        }
        throw err;
      }
    }

    if (unadopted.length > 0) {
      this.emitChanged(projectId, summary);
    }
    return { unadopted, files_deleted, failed };
  }

  private rescanUnderLock(projectId: Id): LocalSkill[] {
    const project = this.deps.projects.mustFindById(projectId);
    if (project.primary_tool !== ".claude") return [];

    const primaryRoot = path.join(project.path, project.primary_tool);
    const subscribedKeys = this.collectSubscribedKeys(projectId);
    const now = new Date().toISOString();
    const summary: LocalSkillsChangedSummary = {
      added: 0,
      removed: 0,
      modified: 0,
      missing: 0
    };

    const rows = this.repo.listByProject(projectId);
    const refreshed: LocalSkill[] = [];

    for (const row of rows) {
      const abs = path.join(primaryRoot, row.rel_path);
      const exists = row.type === SkillType.Skill ? isDir(abs) : isFile(abs);
      if (!exists) {
        this.repo.updateStatus(row.id, {
          status: "missing",
          content_hash: row.content_hash,
          last_seen_at: now
        });
        if (row.status !== "missing") summary.missing += 1;
        refreshed.push({ ...row, status: "missing", last_seen_at: now });
        continue;
      }

      const freshHash =
        row.type === SkillType.Skill ? hashDir(abs) : hashFile(abs);

      let nextStatus: LocalSkillStatus;
      if (subscribedKeys.has(`${row.type}/${row.name}`)) {
        nextStatus = "name_collision";
      } else if (freshHash !== row.content_hash) {
        nextStatus = "modified";
      } else {
        nextStatus = "present";
      }

      this.repo.updateStatus(row.id, {
        status: nextStatus,
        content_hash: freshHash,
        last_seen_at: now
      });
      if (nextStatus === "modified" && row.status !== "modified") {
        summary.modified += 1;
      }
      refreshed.push({
        ...row,
        status: nextStatus,
        content_hash: freshHash,
        last_seen_at: now
      });
    }

    // Always emit after a rescan even if nothing changed — users who
    // click [Rescan] expect a "done" signal regardless of delta.
    this.emitChanged(projectId, summary);
    return refreshed;
  }

  // ---------- Helpers ----------

  private collectSubscribedKeys(projectId: Id): Set<string> {
    const out = new Set<string>();
    for (const sub of this.deps.subscriptions.listForProject(projectId)) {
      const skill = this.skills.findById(sub.skill_id);
      if (!skill) continue;
      out.add(`${skill.type}/${skill.name}`);
    }
    return out;
  }

  private emitChanged(
    projectId: Id,
    summary: LocalSkillsChangedSummary
  ): void {
    this.deps.events.emit({
      type: EventType.LocalSkillsChanged,
      payload: {
        project_id: projectId,
        summary
      }
    });
  }
}

// Make `fs` import survive tree-shaking guard — fs is referenced only
// via isDir/isFile/removeDir/removeFile in prod but tests may need the
// module loaded for mocking; this is a no-cost hint for bundlers.
void fs;
