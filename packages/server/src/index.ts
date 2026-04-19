/**
 * @astack/server — Backend service (Hono + SQLite + git).
 *
 * Public exports from this package entry are the stable API that the
 * `bin.ts` daemon entry and test harness consume. Internals are
 * intentionally NOT re-exported here.
 *
 * See docs/asset/design.md § Engineering Review for architecture.
 */

export const VERSION = "0.1.0";

export { loadConfig, type ServerConfig } from "./config.js";
export { createLogger, nullLogger, type Logger, type LogLevel } from "./logger.js";
export { openDatabase, migrate, getSchemaVersion, type Db } from "./db/connection.js";
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
