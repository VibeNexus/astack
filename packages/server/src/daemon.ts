/**
 * Daemon lifecycle management.
 *
 * Design (§ Eng Review decision 4):
 *   - Host/port: 127.0.0.1:7432 (loopback only, single user).
 *   - Files:
 *       ~/.astack/daemon.pid
 *       ~/.astack/daemon.log
 *       ~/.astack/daemon.lock
 *
 * This module provides:
 *   - startDaemon(config, opts?) — bind + serve + write pid/lock; returns
 *     a handle with .close() for graceful shutdown. v0.6: the logger is
 *     now constructed internally (teeing stderr + config.logFile) and
 *     exposed on the returned handle as `handle.logger`; callers no
 *     longer pass one in.
 *   - readPidFile / isProcessAlive — used by `astack server status/stop`.
 *   - stopDaemon(config) — SIGTERM the process from PID file.
 *
 * The actual CLI subcommand dispatch lives in bin.ts.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { AstackError, ErrorCode } from "@astack/shared";

import type { ServerConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { createApp, type AppInstance } from "./http/app.js";
import { createLogger, type Logger, type LogLevel } from "./logger.js";
import { SeedService } from "./services/seed.js";

export interface DaemonHandle {
  config: ServerConfig;
  app: AppInstance;
  server: ServerType;
  /**
   * The logger constructed by `startDaemon` — tees `process.stderr` and
   * `config.logFile`. Exposed so CLI callers (e.g. `runServerStart`) can
   * hand the same logger to `installSignalHandlers` without re-opening
   * the log file. v0.6+.
   */
  logger: Logger;
  close(): Promise<void>;
}

export interface StartDaemonOptions {
  /**
   * Whether to run SeedService on startup. Defaults to true. Tests
   * that spin up a real daemon should pass `false` to avoid real
   * `git clone` of the builtin seeds.
   */
  seeds?: boolean;
  /**
   * Log level for the internally-constructed tee logger. Defaults to
   * "info". v0.6+.
   */
  logLevel?: LogLevel;
  /**
   * Override the internally-constructed tee logger. Primarily for tests
   * that want `nullLogger()` (no file I/O, no stderr noise). Production
   * daemon never sets this — it relies on the automatic
   * `config.logFile` + `process.stderr` tee. v0.6+.
   */
  logger?: Logger;
}

export async function startDaemon(
  config: ServerConfig,
  opts: StartDaemonOptions = {}
): Promise<DaemonHandle> {
  ensureDataDir(config);

  // Prevent a second daemon on the same port.
  if (await isPortInUse(config.host, config.port)) {
    throw new AstackError(
      ErrorCode.SERVER_ALREADY_RUNNING,
      `port ${config.port} is already in use`,
      { host: config.host, port: config.port }
    );
  }
  // Also refuse if a live pidfile exists (covers the race where port was
  // freed but process is zombie).
  const existingPid = readPidFile(config);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new AstackError(
      ErrorCode.SERVER_ALREADY_RUNNING,
      "another daemon is already running",
      { pid: existingPid, pid_file: config.pidFile }
    );
  }

  // v0.6: build the tee logger internally. Production path opens
  // `config.logFile` in append mode and writes to both stderr + file;
  // tests can override via `opts.logger` (typically `nullLogger()`).
  let logFileStream: fs.WriteStream | null = null;
  let logger: Logger;
  if (opts.logger) {
    logger = opts.logger;
  } else {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    logFileStream = fs.createWriteStream(config.logFile, { flags: "a" });
    logger = createLogger(opts.logLevel ?? "info", [
      process.stderr,
      logFileStream
    ]);
  }

  const db = openDatabase({ path: config.dbPath });
  const app = createApp({ config, logger, db });

  const server = serve(
    {
      fetch: app.app.fetch,
      hostname: config.host,
      port: config.port
    },
    (info) => {
      logger.info("daemon.started", {
        address: `http://${info.address}:${info.port}`,
        pid: process.pid
      });
    }
  );

  writePidFile(config, process.pid);

  // Kick off builtin-seed bootstrap in the background. The HTTP server
  // is already listening at this point, so users see a responsive
  // dashboard immediately; repos appear via SSE as they become ready.
  // Failures are swallowed here — SeedService itself emits a
  // SeedCompleted event with the failure list.
  if (opts.seeds !== false) {
    const seedService = new SeedService({
      db: app.container.db,
      config,
      repoService: app.container.repoService,
      events: app.container.events,
      logger
    });
    void seedService.seedBuiltinRepos().catch((err) => {
      logger.error("seed.unexpected_failure", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  const handle: DaemonHandle = {
    config,
    app,
    server,
    logger,
    close: async () => {
      // 1. Tell long-lived SSE handlers to bail out of their while loops.
      //    Without this, server.close() would wait indefinitely for the
      //    SSE response to finish (which only happens when the client
      //    disconnects — e.g. browser tab closed).
      app.container.events.shutdown();

      // 2. Ask the HTTP server to stop accepting new connections. The
      //    callback fires only after all active sockets are closed.
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // 3. Force-close idle keep-alive sockets and then any stragglers.
      //    `closeAllConnections` landed in Node 18.2; guard with optional
      //    chaining so older runtimes still shut down (just less quickly).
      const srv = server as ServerType & {
        closeIdleConnections?: () => void;
        closeAllConnections?: () => void;
      };
      srv.closeIdleConnections?.();
      // Give SSE handlers one tick to observe the shutdown flag and
      // close their streams cleanly, then drop anything still hanging.
      setTimeout(() => {
        srv.closeAllConnections?.();
      }, 100).unref();

      await closed;
      app.dispose();
      removePidFile(config);
      logger.info("daemon.stopped", { pid: process.pid });

      // v0.6: close the log file stream (if we opened one) so the next
      // daemon start on the same logFile doesn't race on an open fd.
      if (logFileStream !== null) {
        await new Promise<void>((resolve) => {
          logFileStream!.end(() => resolve());
        });
      }
    }
  };

  return handle;
}

/** Hard timeout for graceful shutdown before we force-exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Install SIGTERM/SIGINT handlers that cleanly shut down the daemon. */
export function installSignalHandlers(handle: DaemonHandle, logger: Logger): void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      // Second signal → escape hatch: exit immediately. Users sometimes
      // hit Ctrl+C repeatedly when the graceful shutdown appears stuck;
      // honour that intent instead of silently ignoring it.
      logger.info("daemon.signal.force_exit", { signal });
      process.exit(130); // 128 + SIGINT(2) by convention
    }
    shuttingDown = true;
    logger.info("daemon.signal", { signal });

    // Absolute timeout: if graceful shutdown doesn't complete in
    // SHUTDOWN_TIMEOUT_MS, bail out with a non-zero exit code.
    const watchdog = setTimeout(() => {
      logger.error("daemon.close_timeout", {
        timeout_ms: SHUTDOWN_TIMEOUT_MS
      });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref();

    try {
      await handle.close();
    } catch (err) {
      logger.error("daemon.close_failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      clearTimeout(watchdog);
      process.exit(0);
    }
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

// ---------- Pid file + port helpers ----------

export function ensureDataDir(config: ServerConfig): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

export function writePidFile(config: ServerConfig, pid: number): void {
  fs.mkdirSync(path.dirname(config.pidFile), { recursive: true });
  fs.writeFileSync(config.pidFile, String(pid));
}

export function readPidFile(config: ServerConfig): number | null {
  try {
    const raw = fs.readFileSync(config.pidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function removePidFile(config: ServerConfig): void {
  try {
    fs.rmSync(config.pidFile, { force: true });
  } catch {
    // ignore
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

/** Send SIGTERM to the daemon from pidfile. Returns true if signaled. */
export function stopDaemon(config: ServerConfig): boolean {
  const pid = readPidFile(config);
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    removePidFile(config);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
