/**
 * @astack/server — Backend service (Hono + SQLite + git).
 *
 * Public exports are the stable API that `bin.ts` and the test harness
 * consume. Internal helpers are intentionally NOT re-exported here.
 */

export const VERSION = "0.1.0";

export { loadConfig, type ServerConfig } from "./config.js";
export { createLogger, nullLogger, type Logger, type LogLevel } from "./logger.js";
export {
  openDatabase,
  type Db
} from "./db/connection.js";
export { LockManager, type LockManagerOptions } from "./lock.js";
export { EventBus, type EmittedEvent, type EventHandler } from "./events.js";
export {
  RepoService,
  deriveNameFromUrl,
  type GitImpl,
  type RepoServiceDeps,
  type RegisterRepoOutput,
  type RefreshOutput
} from "./services/repo.js";
export {
  ProjectService,
  type ProjectServiceDeps,
  type RegisterProjectInput
} from "./services/project.js";
export {
  SubscriptionService,
  type SubscriptionServiceDeps,
  type ResolvedSkillRef
} from "./services/subscription.js";
export {
  SymlinkService,
  type SymlinkServiceDeps,
  LINKED_SUBDIRS
} from "./services/symlink.js";
export {
  SyncService,
  type SyncServiceDeps,
  type SyncOutcome,
  type PushOutcome,
  type ComputedSyncState
} from "./services/sync.js";
export {
  SeedService,
  type SeedServiceDeps,
  type SeedSummary
} from "./services/seed.js";
export { BUILTIN_SEEDS, isBuiltinSeedUrl, type BuiltinSeed } from "./seeds.js";
export {
  AstackManifestSchema,
  MANIFEST_RELATIVE_PATH,
  manifestPath,
  readManifest,
  writeManifest,
  dedupeSubscriptions,
  type AstackManifest,
  type ManifestSubscription,
  type NormalizedSubscription
} from "./manifest.js";

// HTTP surface
export { createApp, type AppInstance, type CreateAppOptions } from "./http/app.js";
export type { ServiceContainer } from "./http/container.js";

// Daemon management
export {
  startDaemon,
  stopDaemon,
  installSignalHandlers,
  isPortInUse,
  isProcessAlive,
  readPidFile,
  ensureDataDir,
  type DaemonHandle
} from "./daemon.js";
