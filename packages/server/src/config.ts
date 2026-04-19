/**
 * Runtime configuration for @astack/server.
 *
 * Defaults follow design.md § Eng Review decision 4 (daemon layout):
 *   ~/.astack/daemon.pid
 *   ~/.astack/daemon.log
 *   ~/.astack/daemon.lock
 *   ~/.astack/astack.sqlite3  (SQLite database)
 *   ~/.astack/repos/<name>/   (upstream mirror clones)
 *
 * All paths can be overridden via env vars — primarily for tests
 * (tmp-promise creates isolated dirs).
 */

import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  /** HTTP bind host. Always 127.0.0.1 (design constraint 4). */
  host: string;
  /** HTTP port. Default 7432. */
  port: number;
  /** Root data dir (default ~/.astack/). */
  dataDir: string;
  /** SQLite DB path. */
  dbPath: string;
  /** Upstream mirror clones root. */
  reposDir: string;
  /** PID file location (for daemon management). */
  pidFile: string;
  /** Log file location. */
  logFile: string;
  /** flock file to prevent concurrent daemon starts. */
  lockFile: string;
  /**
   * TTL for upstream HEAD-hash cache, in ms.
   * See design.md § Eng Review decision 11.
   */
  upstreamCacheTtlMs: number;
  /**
   * Max time to wait for a per-repo mutex before returning REPO_BUSY.
   * See design.md § Eng Review decision 5.
   */
  repoLockTimeoutMs: number;
}

/** Load config from env vars with sensible defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env.ASTACK_DATA_DIR ?? path.join(os.homedir(), ".astack");
  const host = env.ASTACK_HOST ?? "127.0.0.1";
  const port = env.ASTACK_PORT ? parseInt(env.ASTACK_PORT, 10) : 7432;

  return {
    host,
    port,
    dataDir,
    dbPath: env.ASTACK_DB_PATH ?? path.join(dataDir, "astack.sqlite3"),
    reposDir: env.ASTACK_REPOS_DIR ?? path.join(dataDir, "repos"),
    pidFile: path.join(dataDir, "daemon.pid"),
    logFile: path.join(dataDir, "daemon.log"),
    lockFile: path.join(dataDir, "daemon.lock"),
    upstreamCacheTtlMs: 5 * 60 * 1000,
    repoLockTimeoutMs: 30 * 1000
  };
}
