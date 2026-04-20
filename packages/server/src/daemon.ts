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
 *   - startDaemon(config, logger) — bind + serve + write pid/lock; returns
 *     a handle with .close() for graceful shutdown.
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
import type { Logger } from "./logger.js";
import { SeedService } from "./services/seed.js";

export interface DaemonHandle {
  config: ServerConfig;
  app: AppInstance;
  server: ServerType;
  close(): Promise<void>;
}

export interface StartDaemonOptions {
  /**
   * Whether to run SeedService on startup. Defaults to true. Tests
   * that spin up a real daemon should pass `false` to avoid real
   * `git clone` of the builtin seeds.
   */
  seeds?: boolean;
}

export async function startDaemon(
  config: ServerConfig,
  logger: Logger,
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
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      app.dispose();
      removePidFile(config);
      logger.info("daemon.stopped", { pid: process.pid });
    }
  };

  return handle;
}

/** Install SIGTERM/SIGINT handlers that cleanly shut down the daemon. */
export function installSignalHandlers(handle: DaemonHandle, logger: Logger): void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("daemon.signal", { signal });
    try {
      await handle.close();
    } catch (err) {
      logger.error("daemon.close_failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
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
