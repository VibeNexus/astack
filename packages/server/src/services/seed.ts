/**
 * SeedService — bootstraps three opinionated open-source skill repos
 * on the first daemon start.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  seedBuiltinRepos() → Promise.allSettled over BUILTIN_SEEDS │
 *   │     for each seed:                                            │
 *   │       - if user already removed it (seed_decisions) → skip   │
 *   │       - if already registered (user did it manually) → skip  │
 *   │       - if prior attempt left a failed / orphan row → clean │
 *   │       - otherwise: RepoService.register(...) with            │
 *   │         kind='open-source' + scan_config = seed.scan_config   │
 *   │  Emit SeedCompleted event with the summary.                  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Non-blocking: callers fire-and-forget this from daemon startup.
 * Failures never bubble up past the service boundary — the dashboard
 * learns about them via the SeedCompleted event's `failed_names`.
 *
 * Retry policy: on every daemon start we re-inspect the state. A seed
 * with status='failed' gets deleted before the retry; a seed with
 * seed_decisions.decision='removed' is respected permanently; a
 * seed that's registered with any other status (ready, seeding) is
 * left alone.
 *
 * See docs/version/v0.2-sqlite-and-multi-repo.md § 2 (accepted risks)
 * and § PR4 for the surrounding design.
 */

import fs from "node:fs";
import path from "node:path";

import {
  EventType,
  RepoKind,
  RepoStatus,
  type SkillRepo
} from "@astack/shared";

import type { ServerConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { RepoRepository } from "../db/repos.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import { BUILTIN_SEEDS, type BuiltinSeed } from "../seeds.js";

import type { RepoService } from "./repo.js";

export interface SeedServiceDeps {
  db: Db;
  config: ServerConfig;
  repoService: RepoService;
  events: EventBus;
  logger: Logger;
  /** Override the seed list in tests. */
  seeds?: ReadonlyArray<BuiltinSeed>;
}

export interface SeedSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  failed_names: string[];
}

export class SeedService {
  private readonly repos: RepoRepository;
  private readonly seeds: ReadonlyArray<BuiltinSeed>;

  constructor(private readonly deps: SeedServiceDeps) {
    this.repos = new RepoRepository(deps.db);
    this.seeds = deps.seeds ?? BUILTIN_SEEDS;
  }

  /**
   * Walk all builtin seeds and ensure each one ends up registered, or
   * the reason it wasn't is captured. Emits a single SeedCompleted
   * event at the end.
   *
   * Serial (not parallel): every seed's register(...) ends in a
   * synchronous scanAndUpsert (node:sqlite writes + fs scans are both
   * sync) that blocks the event loop for a noticeable chunk of time on
   * large repos — everything-claude-code has ~320 skills/agents. When
   * we ran all three concurrently the three synchronous tails landed in
   * the same macro-task burst and the daemon appeared frozen for several
   * seconds; the dashboard's first-load /api/repos/:id/skills fetches
   * stacked up behind that burst and browsers showed "Provisional
   * headers, pending" until the last seed drained.
   *
   * Running one at a time, with a setImmediate yield between seeds,
   * lets HTTP requests interleave cleanly. Wall-clock time is ~unchanged
   * (the clone step is the long tail and is already async-git) but p99
   * event-loop lag drops from multi-second to <50ms.
   */
  async seedBuiltinRepos(): Promise<SeedSummary> {
    const started = Date.now();
    this.deps.logger.info("seed.started", {
      count: this.seeds.length,
      seeds: this.seeds.map((s) => s.name)
    });

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const failed_names: string[] = [];

    for (let i = 0; i < this.seeds.length; i++) {
      const seed = this.seeds[i]!;
      const seedStart = Date.now();
      try {
        const outcome = await this.seedOne(seed);
        if (outcome === "installed") {
          succeeded++;
        } else {
          skipped++;
        }
        this.deps.logger.info("seed.one_done", {
          seed: seed.name,
          outcome,
          elapsed_ms: Date.now() - seedStart
        });
      } catch (err) {
        failed++;
        failed_names.push(seed.name);
        this.deps.logger.error("seed.failed", {
          seed: seed.name,
          elapsed_ms: Date.now() - seedStart,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      // Yield control back to the event loop between seeds. Without this
      // three consecutive synchronous `scanAndUpsert` bursts can line up
      // on the same macro-task and starve HTTP requests for the full
      // duration. `setImmediate` runs after pending I/O callbacks, so any
      // accepted sockets / queued fetches get a chance to make progress
      // before the next clone+scan begins.
      if (i < this.seeds.length - 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    const summary: SeedSummary = { succeeded, failed, skipped, failed_names };
    this.deps.logger.info("seed.completed", {
      ...summary,
      elapsed_ms: Date.now() - started
    });
    this.deps.events.emit({
      type: EventType.SeedCompleted,
      payload: summary
    });
    return summary;
  }

  /**
   * Run one seed slot. Returns 'installed' when the clone+scan
   * succeeded, 'skipped' when we intentionally didn't touch it, or
   * throws on real failure (network, scan crash, etc.).
   */
  private async seedOne(
    seed: BuiltinSeed
  ): Promise<"installed" | "skipped"> {
    // 1. User explicitly removed this seed earlier — respect that.
    if (this.isUserRemoved(seed.git_url)) {
      this.deps.logger.info("seed.skipped.user_removed", {
        seed: seed.name
      });
      return "skipped";
    }

    // 2. Already registered (or seeding) with this URL.
    const existing = this.repos.findByGitUrl(seed.git_url);
    if (existing && existing.status !== RepoStatus.Failed) {
      this.deps.logger.info("seed.skipped.already_registered", {
        seed: seed.name,
        repo_id: existing.id,
        status: existing.status
      });
      return "skipped";
    }

    // 3. A previous attempt left a failed row. Delete it so we can retry.
    if (existing && existing.status === RepoStatus.Failed) {
      this.deps.logger.info("seed.retry.cleaning_failed_row", {
        seed: seed.name,
        repo_id: existing.id
      });
      this.repos.delete(existing.id);
      this.cleanupStaleLocalDir(seed.name);
    }

    // 4. Name collision from a previous aborted attempt (row was
    // deleted but clone dir remains).
    this.cleanupStaleLocalDir(seed.name);

    // 5. Clone + scan. RepoService.register handles the whole thing:
    // insert skill_repo row, clone with shallow, scan with our config,
    // upsert skills, emit RepoRegistered. We just funnel our metadata.
    await this.deps.repoService.register({
      git_url: seed.git_url,
      name: seed.name,
      kind: RepoKind.OpenSource,
      scan_config: seed.scan_config
    });

    return "installed";
  }

  private isUserRemoved(url: string): boolean {
    const row = this.deps.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM seed_decisions
         WHERE url = ? AND decision = 'removed'`
      )
      .get(url);
    return (row?.c ?? 0) > 0;
  }

  /**
   * Remove a leftover clone directory from an earlier aborted attempt.
   * Safe to call when the directory doesn't exist.
   */
  private cleanupStaleLocalDir(seedName: string): void {
    const localPath = path.join(this.deps.config.reposDir, seedName);
    if (!fs.existsSync(localPath)) return;
    try {
      fs.rmSync(localPath, { recursive: true, force: true });
      this.deps.logger.info("seed.cleanup.stale_dir", {
        seed: seedName,
        local_path: localPath
      });
    } catch (err) {
      // Non-fatal — register() will surface a clearer error if this
      // actually blocks the clone.
      this.deps.logger.warn("seed.cleanup.stale_dir_failed", {
        seed: seedName,
        local_path: localPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Exposed for tests that want to directly inspect seed state. */
  listCurrentSeeds(): SkillRepo[] {
    return this.seeds
      .map((s) => this.repos.findByGitUrl(s.git_url))
      .filter((r): r is SkillRepo => r !== null);
  }
}
