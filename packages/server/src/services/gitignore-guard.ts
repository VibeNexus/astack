/**
 * GitignoreGuardService — auto-append astack runtime paths to a project's
 * root `.gitignore` on registration.
 *
 * Problem (v0.7+):
 *   astack writes per-project, per-machine state under two locations:
 *     - `.astack/`       — daemon-managed local state (system-skills stub,
 *                          future caches). Pure per-machine; never ships.
 *     - `.astack.json`   — project-root manifest some integrations (e.g.
 *                          FinClaw tooling) drop next to AGENTS.md. Also
 *                          per-machine unless the project chose to commit
 *                          it. Safer default: ignore.
 *   Without a hint, users routinely `git add .` these paths and later
 *   have to untrack them. Write once on project register so it's done.
 *
 * Design:
 *   - Subscribes to `project.registered` at construction (mirrors
 *     SystemSkillService / ProjectBootstrapService).
 *   - Fire-and-forget: failure never blocks register; logs `warn` so the
 *     daemon.log carries breadcrumbs (v0.6 P7 — every config surface must
 *     have an observable read/write point).
 *   - Idempotent: skips lines already present. Recognizes common variants
 *     (with/without trailing slash, leading `/`) so re-runs are no-ops
 *     even when a user previously hand-wrote the line.
 *   - primary_tool-agnostic: both `.astack/` and `.astack.json` are
 *     astack-level paths, not `.claude`-scoped. Runs for every project.
 *   - Never touches `.gitignore` content the user already wrote beyond a
 *     single trailing append block; preserves original trailing newline
 *     conventions to avoid diff noise on projects with committed
 *     `.gitignore` files.
 *
 * Out of scope (v0.8+):
 *   - Updating `.gitignore` when a project's primary_tool changes later.
 *   - Writing into sub-dir `.gitignore` files (nested .claude/.gitignore).
 *   - CLI equivalent (`astack project gitignore ensure`) — the Web +
 *     auto-on-register cover the legacy bootstrap surface.
 */

import fs from "node:fs";
import path from "node:path";

import { EventType, type Id } from "@astack/shared";

import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import { safeLog } from "../system-skills/service.js";

// ---------- Types ----------

export interface GitignoreGuardServiceDeps {
  events: EventBus;
  logger: Logger;
}

export interface EnsureEntriesResult {
  /** Entries the call actually appended. Empty = .gitignore already covered them. */
  added: string[];
  /** `.gitignore` file path that was read/written. */
  gitignore_path: string;
  /** True if `.gitignore` existed before this call. */
  existed_before: boolean;
}

// ---------- Constants ----------

/**
 * The astack-managed paths to ensure. Order is meaningful — it dictates
 * append order when a project has zero prior entries (cosmetic but
 * stable across re-runs).
 *
 * Keep trailing slash on `.astack/` because git treats
 * `.astack` and `.astack/` identically for an ignored tree, but users
 * scanning `.gitignore` read the slash as "directory" — higher intent
 * signal when the line is reviewed in a PR diff.
 */
export const ASTACK_GITIGNORE_ENTRIES: readonly string[] = [
  ".astack/",
  ".astack.json"
];

/**
 * Header comment written alongside the first auto-append. Not an enum
 * because it's user-visible text and must stay in one place.
 */
const ASTACK_BLOCK_HEADER = "# astack local state (auto-added by astack)";

// ---------- Service ----------

export class GitignoreGuardService {
  constructor(private readonly deps: GitignoreGuardServiceDeps) {
    // Fire-and-forget subscriber — mirrors SystemSkillService's register
    // handler. Any throw inside handleProjectRegistered is caught here
    // so the daemon never sees an unhandledRejection (R4 lineage).
    this.deps.events.subscribe(({ event }) => {
      if (event.type !== EventType.ProjectRegistered) return;
      const project = event.payload.project;
      this.runForProject(project.id, project.path, "register");
    });
  }

  /**
   * Ensure the project's root `.gitignore` contains every astack-managed
   * entry. Idempotent across repeated calls and across hand-edits that
   * already covered the paths (see `entryAlreadyIgnored`).
   *
   * Public so callers (future CLI / routes) can re-run it without
   * re-emitting ProjectRegistered.
   */
  ensureProjectGitignore(projectPath: string): EnsureEntriesResult {
    return this.ensureEntries(projectPath, ASTACK_GITIGNORE_ENTRIES);
  }

  /**
   * Backfill: run `ensureProjectGitignore` for every project in the given
   * list. Idempotent — projects whose `.gitignore` already covers both
   * entries are a zero-cost read.
   *
   * Used by `startDaemon` on boot so projects registered **before** this
   * feature existed still get the ignore lines the next time the daemon
   * comes up. Not hooked to any event so tests can call it directly
   * with a curated list without spinning up EventBus traffic.
   *
   * Returns a summary: how many projects were updated vs skipped vs
   * errored. Per-project failures are logged + counted, NEVER thrown —
   * the daemon must continue booting.
   */
  backfillExisting(
    projects: ReadonlyArray<{ id: Id; path: string }>
  ): { updated: number; unchanged: number; failed: number } {
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    for (const p of projects) {
      const outcome = this.runForProject(p.id, p.path, "backfill");
      if (outcome === "updated") updated += 1;
      else if (outcome === "unchanged") unchanged += 1;
      else failed += 1;
    }
    this.deps.logger.info("gitignore.backfill_done", {
      total: projects.length,
      updated,
      unchanged,
      failed
    });
    return { updated, unchanged, failed };
  }

  /**
   * Shared worker: run ensureEntries once for a single project, emit a
   * log line tagged by `source`, and return a coarse outcome so
   * `backfillExisting` can tally. Never throws.
   */
  private runForProject(
    projectId: Id,
    projectPath: string,
    source: "register" | "backfill"
  ): "updated" | "unchanged" | "failed" {
    try {
      const result = this.ensureProjectGitignore(projectPath);
      if (result.added.length > 0) {
        this.deps.logger.info("gitignore.updated", {
          project_id: projectId,
          gitignore_path: result.gitignore_path,
          added: result.added,
          existed_before: result.existed_before,
          source
        });
        return "updated";
      }
      this.deps.logger.debug("gitignore.noop", {
        project_id: projectId,
        gitignore_path: result.gitignore_path,
        source
      });
      return "unchanged";
    } catch (err) {
      // Never propagate — register must stay 201, daemon boot must
      // continue. Swallow + log.
      safeLog(this.deps.logger, "gitignore.guard_failed", {
        project_id: projectId,
        project_path: projectPath,
        source,
        error: err instanceof Error ? err.message : String(err)
      });
      return "failed";
    }
  }

  /**
   * Core: read `.gitignore`, compute which requested entries are missing
   * according to `entryAlreadyIgnored`, and append the missing ones in
   * a single write behind a header comment.
   */
  private ensureEntries(
    projectPath: string,
    requested: readonly string[]
  ): EnsureEntriesResult {
    const gitignorePath = path.join(projectPath, ".gitignore");
    const existedBefore = fs.existsSync(gitignorePath);
    const original = existedBefore
      ? fs.readFileSync(gitignorePath, "utf8")
      : "";

    const existingLines = toLines(original);

    const missing: string[] = [];
    for (const entry of requested) {
      if (!entryAlreadyIgnored(existingLines, entry)) {
        missing.push(entry);
      }
    }

    if (missing.length === 0) {
      return {
        added: [],
        gitignore_path: gitignorePath,
        existed_before: existedBefore
      };
    }

    const next = appendBlock(original, missing);
    this.atomicWrite(gitignorePath, next);

    return {
      added: [...missing],
      gitignore_path: gitignorePath,
      existed_before: existedBefore
    };
  }

  /**
   * Same atomic-write pattern as fs-util.writeFileAtomic but inlined to
   * keep this service a self-contained leaf (writeFileAtomic throws
   * AstackError which this subscriber doesn't want surfacing — we
   * wrap the whole handler in its own try/catch instead).
   */
  private atomicWrite(dest: string, contents: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, dest);
  }
}

// ---------- Internals (exported for tests) ----------

/**
 * Decide whether `entry` (a single `.gitignore` path pattern from our
 * curated set) is already covered by an existing line.
 *
 * Covers common hand-written variants so re-runs truly no-op:
 *   - exact match
 *   - trailing-slash toggled (`.astack` ↔ `.astack/`)
 *   - leading slash anchored to root (`/.astack`, `/.astack/`)
 *
 * NOT handled (intentionally narrow scope, keep review simple):
 *   - negations (`!.astack/keep.txt`) — user's explicit un-ignore wins
 *     regardless of whether we also write the directory line; we'd
 *     write the directory line either way.
 *   - glob patterns that accidentally match (`**\/.astack`) — too many
 *     false positives; treat our entry as missing and let git merge
 *     the semantics.
 */
export function entryAlreadyIgnored(
  existingLines: readonly string[],
  entry: string
): boolean {
  const variants = gitignoreVariants(entry);
  for (const raw of existingLines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("!")) continue; // negation — see JSDoc
    if (variants.has(line)) return true;
  }
  return false;
}

/**
 * Build the set of .gitignore line forms that should all be treated as
 * equivalent to `entry` for idempotency purposes.
 */
function gitignoreVariants(entry: string): Set<string> {
  const out = new Set<string>();
  out.add(entry);

  // Toggle trailing slash.
  if (entry.endsWith("/")) {
    out.add(entry.slice(0, -1));
  } else {
    out.add(entry + "/");
  }

  // Root-anchored forms (`/.astack` / `/.astack/`).
  for (const v of [...out]) {
    out.add("/" + v);
  }

  return out;
}

/**
 * Split `.gitignore` contents into lines. Strips the trailing empty
 * element produced by a final newline so `existingLines.length` reflects
 * actual content lines.
 */
function toLines(contents: string): string[] {
  if (contents.length === 0) return [];
  const parts = contents.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Return `original` with a trailing "astack local state" block listing
 * `missing`. Preserves a trailing newline unconditionally so future
 * appends from the user or from astack stay line-aligned.
 */
function appendBlock(original: string, missing: string[]): string {
  const needsSeparator = original.length > 0 && !original.endsWith("\n");
  const leading = needsSeparator ? "\n" : "";
  const gap = original.length > 0 && !original.endsWith("\n\n") ? "\n" : "";
  const body = [ASTACK_BLOCK_HEADER, ...missing].join("\n") + "\n";
  return original + leading + gap + body;
}

/** Convenience alias — does NOT subscribe to any events. */
export type { GitignoreGuardServiceDeps as GitignoreGuardDeps };
