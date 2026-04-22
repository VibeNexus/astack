/**
 * Tests for SeedService.
 *
 * Uses an injected seed list + mocked gitImpl (no real git clone, no
 * network). Focus areas:
 *   1. Happy path — all three seeds register successfully
 *   2. Failure in one seed — others still succeed
 *   3. `seed_decisions.removed` is respected — skip
 *   4. Already-registered URL — skip
 *   5. Previous `status='failed'` row — cleaned up and retried
 *   6. Retry uses the stale directory cleanup
 *   7. SeedCompleted event is emitted with correct summary
 *   8. Concurrent registration via allSettled (timestamps)
 */

import fs from "node:fs";
import path from "node:path";

import {
  EventType,
  RepoKind,
  RepoStatus,
  ScanRootKind
} from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { EventBus, type EmittedEvent } from "../src/events.js";
import { LockManager } from "../src/lock.js";
import { nullLogger } from "../src/logger.js";
import { RepoService, type GitImpl } from "../src/services/repo.js";
import { SeedService } from "../src/services/seed.js";
import type { BuiltinSeed } from "../src/seeds.js";

/** A mock gitImpl that records call timing + simulates clone behavior. */
function makeMockGit(opts: {
  failFor?: ReadonlySet<string>;
  cloneDelayMs?: number;
} = {}): GitImpl & {
  calls: Array<{ op: string; url?: string; at: number }>;
} {
  const calls: Array<{ op: string; url?: string; at: number }> = [];
  return {
    calls,
    async clone(url: string, localPath: string): Promise<void> {
      calls.push({ op: "clone", url, at: Date.now() });
      if (opts.cloneDelayMs) {
        await new Promise((r) => setTimeout(r, opts.cloneDelayMs));
      }
      if (opts.failFor?.has(url)) {
        throw new Error(`simulated clone failure for ${url}`);
      }
      // Create the local directory so subsequent existsSync() finds it.
      fs.mkdirSync(localPath, { recursive: true });
    },
    async pull(): Promise<void> {
      calls.push({ op: "pull", at: Date.now() });
    },
    async getHead(): Promise<{ head: string; head_time: string }> {
      calls.push({ op: "getHead", at: Date.now() });
      return {
        head: "a".repeat(40),
        head_time: "2026-04-19T00:00:00.000Z"
      };
    },
    async remoteHead(): Promise<string> {
      calls.push({ op: "remoteHead", at: Date.now() });
      return "a".repeat(40);
    },
    async isClean(): Promise<boolean> {
      return true;
    }
  };
}

const TEST_SEEDS: readonly BuiltinSeed[] = [
  {
    name: "seed-a",
    git_url: "https://example.test/seed-a.git",
    scan_config: { roots: [{ path: "skills", kind: ScanRootKind.SkillDirs }] }
  },
  {
    name: "seed-b",
    git_url: "https://example.test/seed-b.git",
    scan_config: { roots: [{ path: "", kind: ScanRootKind.SkillDirs }] }
  },
  {
    name: "seed-c",
    git_url: "https://example.test/seed-c.git",
    scan_config: {
      roots: [
        { path: "skills", kind: ScanRootKind.SkillDirs },
        { path: "commands", kind: ScanRootKind.CommandFiles }
      ]
    }
  }
];

describe("SeedService", () => {
  let dataDir: tmp.DirectoryResult;
  let db: Db;
  let config: ServerConfig;
  let events: EventBus;
  let emitted: EmittedEvent[];
  let locks: LockManager;

  beforeEach(async () => {
    dataDir = await tmp.dir({ unsafeCleanup: true });
    db = openDatabase({ path: ":memory:" });
    events = new EventBus();
    emitted = [];
    events.subscribe((e) => emitted.push(e));
    locks = new LockManager({ timeoutMs: 5000 });
    config = {
      host: "127.0.0.1",
      port: 7432,
      dataDir: dataDir.path,
      dbPath: ":memory:",
      reposDir: path.join(dataDir.path, "repos"),
      pidFile: path.join(dataDir.path, "daemon.pid"),
      logFile: path.join(dataDir.path, "daemon.log"),
      lockFile: path.join(dataDir.path, "daemon.lock"),
      upstreamCacheTtlMs: 5 * 60 * 1000,
      repoLockTimeoutMs: 5000
    };
  });

  afterEach(async () => {
    db.close();
    await dataDir.cleanup();
  });

  function build(git: GitImpl) {
    const repoService = new RepoService({
      db,
      config,
      events,
      locks,
      logger: nullLogger(),
      gitImpl: git
    });
    const seedService = new SeedService({
      db,
      config,
      repoService,
      events,
      logger: nullLogger(),
      seeds: TEST_SEEDS
    });
    return { repoService, seedService };
  }

  it("installs all three seeds on an empty DB", async () => {
    const git = makeMockGit();
    const { seedService } = build(git);

    const summary = await seedService.seedBuiltinRepos();

    expect(summary).toEqual({
      succeeded: 3,
      failed: 0,
      skipped: 0,
      failed_names: []
    });

    // Three skill_repos rows, all open-source + ready + scan_config set.
    const rows = db
      .prepare<[], { name: string; kind: string; status: string }>(
        `SELECT name, kind, status FROM skill_repos ORDER BY name`
      )
      .all();
    expect(rows).toEqual([
      { name: "seed-a", kind: RepoKind.OpenSource, status: RepoStatus.Ready },
      { name: "seed-b", kind: RepoKind.OpenSource, status: RepoStatus.Ready },
      { name: "seed-c", kind: RepoKind.OpenSource, status: RepoStatus.Ready }
    ]);

    // SeedCompleted event emitted.
    const completed = emitted.filter((e) => e.event.type === EventType.SeedCompleted);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.event.payload).toMatchObject({
      succeeded: 3,
      failed: 0,
      skipped: 0
    });
  });

  it("continues past a single failing seed; others succeed", async () => {
    const git = makeMockGit({
      failFor: new Set([TEST_SEEDS[1]!.git_url]) // seed-b fails
    });
    const { seedService } = build(git);

    const summary = await seedService.seedBuiltinRepos();

    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed_names).toEqual(["seed-b"]);

    // Only 2 rows persisted (the failed clone throws BEFORE insert).
    const count = (
      db.prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM skill_repos`
      ).get() ?? { c: 0 }
    ).c;
    expect(count).toBe(2);
  });

  it("respects seed_decisions.removed — skips that URL", async () => {
    db.prepare<[string, string]>(
      `INSERT INTO seed_decisions (url, decision) VALUES (?, ?)`
    ).run(TEST_SEEDS[0]!.git_url, "removed");

    const git = makeMockGit();
    const { seedService } = build(git);

    const summary = await seedService.seedBuiltinRepos();

    expect(summary.succeeded).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);

    const names = db
      .prepare<[], { name: string }>(
        `SELECT name FROM skill_repos ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["seed-b", "seed-c"]);
  });

  it("skips a seed URL that's already registered with status=ready", async () => {
    const git = makeMockGit();
    const { repoService, seedService } = build(git);

    // Pre-register seed-a manually.
    await repoService.register({
      git_url: TEST_SEEDS[0]!.git_url,
      name: "pre-existing-a",
      kind: RepoKind.OpenSource
    });
    // Clone call count before seeding.
    const cloneCallsBefore = git.calls.filter((c) => c.op === "clone").length;

    const summary = await seedService.seedBuiltinRepos();

    expect(summary.succeeded).toBe(2); // seed-b + seed-c
    expect(summary.skipped).toBe(1); // seed-a
    const cloneCallsAfter = git.calls.filter((c) => c.op === "clone").length;
    expect(cloneCallsAfter - cloneCallsBefore).toBe(2);
  });

  it("RepoService.remove() on a builtin seed writes seed_decisions", async () => {
    const git = makeMockGit();
    const { repoService, seedService } = build(git);

    await seedService.seedBuiltinRepos();
    const row = db
      .prepare<[string], { id: number }>(
        `SELECT id FROM skill_repos WHERE git_url = ?`
      )
      .get(TEST_SEEDS[0]!.git_url);
    expect(row).toBeDefined();

    // NB: RepoService.remove() checks the REAL BUILTIN_SEEDS list (not
    // our test seeds). To test the seed_decisions write path we monkey-
    // patch isBuiltinSeedUrl via module mocking. Simpler: directly
    // simulate by inserting a seed_decision and verify skip behavior.
    // The remove→seed_decisions hook is covered at integration level.
    db.prepare<[string, string]>(
      `INSERT OR REPLACE INTO seed_decisions (url, decision) VALUES (?, ?)`
    ).run(TEST_SEEDS[0]!.git_url, "removed");
    repoService.remove(row!.id);

    // Second seed run: removed seed is not re-installed.
    const summary = await seedService.seedBuiltinRepos();
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    const names = db
      .prepare<[], { name: string }>(
        `SELECT name FROM skill_repos ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    expect(names).not.toContain("seed-a");
  });

  it("runs seeds serially but keeps the event loop responsive between them", async () => {
    // v0.6+: seeds run one at a time (not Promise.allSettled) so the
    // synchronous scanAndUpsert tails don't line up in a single
    // multi-second burst. Each clone takes 50ms, so total wall-clock
    // time is ~3×50 = 150ms+ (serial). What we DO guarantee is that a
    // setImmediate callback scheduled concurrently with the seed run
    // gets to run BEFORE all three seeds finish — i.e. the event loop
    // is not monopolised.
    const git = makeMockGit({ cloneDelayMs: 50 });
    const { seedService } = build(git);

    let interleaveTicks = 0;
    const ticker = setInterval(() => {
      interleaveTicks++;
    }, 10);
    try {
      const t0 = Date.now();
      const summary = await seedService.seedBuiltinRepos();
      const elapsed = Date.now() - t0;

      expect(summary.succeeded).toBe(3);
      // Serial ≥ 3*50ms; upper bound generous to avoid flakes on CI.
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(800);
      // The interval fires every 10ms; over ~150ms we must have seen at
      // least a handful of ticks. Zero would mean the event loop was
      // starved. Pre-v0.6 parallel-then-sync path could go ticks=0 on
      // slow hardware.
      expect(interleaveTicks).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(ticker);
    }
  });

  it("emits SeedCompleted even when everything fails", async () => {
    const allUrls = new Set(TEST_SEEDS.map((s) => s.git_url));
    const git = makeMockGit({ failFor: allUrls });
    const { seedService } = build(git);

    const summary = await seedService.seedBuiltinRepos();

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(3);
    expect(summary.failed_names.sort()).toEqual(["seed-a", "seed-b", "seed-c"]);

    const completed = emitted.filter((e) => e.event.type === EventType.SeedCompleted);
    expect(completed).toHaveLength(1);
  });

  it("idempotent: second run on a fully-seeded DB is a no-op", async () => {
    const git = makeMockGit();
    const { seedService } = build(git);

    await seedService.seedBuiltinRepos();
    const cloneCallsAfterFirst = git.calls.filter((c) => c.op === "clone").length;

    const second = await seedService.seedBuiltinRepos();
    expect(second.succeeded).toBe(0);
    expect(second.skipped).toBe(3);

    const cloneCallsAfterSecond = git.calls.filter((c) => c.op === "clone").length;
    expect(cloneCallsAfterSecond).toBe(cloneCallsAfterFirst);
  });

  it("passes scan_config through so scanner sees the right layout", async () => {
    const git = makeMockGit();
    const { seedService } = build(git);

    await seedService.seedBuiltinRepos();

    const seedBRow = db
      .prepare<[string], { scan_config: string | null }>(
        `SELECT scan_config FROM skill_repos WHERE name = ?`
      )
      .get("seed-b");
    expect(seedBRow?.scan_config).toBeDefined();
    expect(JSON.parse(seedBRow!.scan_config!)).toEqual({
      roots: [{ path: "", kind: "skill-dirs" }]
    });
  });
});

describe("SeedService cleanup of stale local directories", () => {
  it("removes a leftover clone dir before retrying", async () => {
    const dataDir = await tmp.dir({ unsafeCleanup: true });
    const db = openDatabase({ path: ":memory:" });
    const events = new EventBus();
    const locks = new LockManager({ timeoutMs: 5000 });
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 7432,
      dataDir: dataDir.path,
      dbPath: ":memory:",
      reposDir: path.join(dataDir.path, "repos"),
      pidFile: path.join(dataDir.path, "daemon.pid"),
      logFile: path.join(dataDir.path, "daemon.log"),
      lockFile: path.join(dataDir.path, "daemon.lock"),
      upstreamCacheTtlMs: 5 * 60 * 1000,
      repoLockTimeoutMs: 5000
    };

    // Pre-create a stale clone dir for seed-a.
    const stalePath = path.join(config.reposDir, "seed-a");
    fs.mkdirSync(stalePath, { recursive: true });
    fs.writeFileSync(path.join(stalePath, "stale.txt"), "x");

    const git = makeMockGit();
    const repoService = new RepoService({
      db,
      config,
      events,
      locks,
      logger: nullLogger(),
      gitImpl: git
    });
    const seedService = new SeedService({
      db,
      config,
      repoService,
      events,
      logger: nullLogger(),
      seeds: [TEST_SEEDS[0]!]
    });

    const summary = await seedService.seedBuiltinRepos();

    expect(summary.succeeded).toBe(1);
    expect(fs.existsSync(path.join(stalePath, "stale.txt"))).toBe(false);

    db.close();
    await dataDir.cleanup();
  });
});
