/**
 * End-to-end service wiring for tests.
 *
 * Creates a fresh in-memory DB + real bare repo + real working-copy project
 * dir and wires all services together the way `bin.ts` will in production.
 *
 * Used by tests that exercise multiple services together (SubscriptionService,
 * SymlinkService, SyncService).
 */

import path from "node:path";

import tmp from "tmp-promise";

import type { ServerConfig } from "../../src/config.js";
import { openDatabase, type Db } from "../../src/db/connection.js";
import { EventBus, type EmittedEvent } from "../../src/events.js";
import { LockManager } from "../../src/lock.js";
import { nullLogger } from "../../src/logger.js";
import { ProjectService } from "../../src/services/project.js";
import { RepoService } from "../../src/services/repo.js";
import { SubscriptionService } from "../../src/services/subscription.js";
import { SymlinkService } from "../../src/services/symlink.js";
import { SyncService } from "../../src/services/sync.js";

import { createBareRepo, type BareRepoHandle } from "./git-fixture.js";

export interface Harness {
  dataDir: tmp.DirectoryResult;
  projectDir: tmp.DirectoryResult;
  bare: BareRepoHandle;
  db: Db;
  config: ServerConfig;
  events: EventBus;
  emitted: EmittedEvent[];
  locks: LockManager;
  repoService: RepoService;
  projectService: ProjectService;
  subscriptionService: SubscriptionService;
  symlinkService: SymlinkService;
  syncService: SyncService;
  cleanup(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const dataDir = await tmp.dir({ unsafeCleanup: true });
  const projectDir = await tmp.dir({ unsafeCleanup: true });
  const bare = await createBareRepo();

  const db = openDatabase({ path: ":memory:" });
  const events = new EventBus();
  const emitted: EmittedEvent[] = [];
  events.subscribe((e) => emitted.push(e));
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

  const repoService = new RepoService({
    db,
    config,
    events,
    locks,
    logger: nullLogger()
  });
  const projectService = new ProjectService({
    db,
    events,
    logger: nullLogger()
  });
  const subscriptionService = new SubscriptionService({
    db,
    events,
    logger: nullLogger(),
    projects: projectService,
    serverUrl: "http://127.0.0.1:7432"
  });
  const symlinkService = new SymlinkService({
    db,
    events,
    logger: nullLogger(),
    projects: projectService
  });
  const syncService = new SyncService({
    db,
    events,
    logger: nullLogger(),
    locks,
    projects: projectService,
    subscriptions: subscriptionService,
    gitAuthor: { name: "Test", email: "test@example.com" }
  });

  return {
    dataDir,
    projectDir,
    bare,
    db,
    config,
    events,
    emitted,
    locks,
    repoService,
    projectService,
    subscriptionService,
    symlinkService,
    syncService,
    async cleanup() {
      db.close();
      await Promise.all([
        dataDir.cleanup(),
        projectDir.cleanup(),
        bare.dir.cleanup()
      ]);
    }
  };
}
