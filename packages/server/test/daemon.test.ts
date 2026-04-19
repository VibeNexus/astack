/**
 * Tests for daemon lifecycle helpers.
 *
 * We don't actually bind a TCP port in these tests (avoiding env flakiness);
 * we exercise pidfile / process-alive / port-probe helpers directly and
 * test startDaemon/stopDaemon on a free ephemeral port.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import {
  isPortInUse,
  isProcessAlive,
  readPidFile,
  startDaemon,
  stopDaemon
} from "../src/daemon.js";
import { nullLogger } from "../src/logger.js";

function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("could not allocate port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function buildConfig(dataDir: string, port: number): ServerConfig {
  return {
    host: "127.0.0.1",
    port,
    dataDir,
    dbPath: path.join(dataDir, "astack.sqlite3"),
    reposDir: path.join(dataDir, "repos"),
    pidFile: path.join(dataDir, "daemon.pid"),
    logFile: path.join(dataDir, "daemon.log"),
    lockFile: path.join(dataDir, "daemon.lock"),
    upstreamCacheTtlMs: 5 * 60 * 1000,
    repoLockTimeoutMs: 5000
  };
}

describe("daemon helpers", () => {
  it("isProcessAlive returns true for current process, false for bogus pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it("readPidFile returns null for missing / invalid files", async () => {
    const dir = await tmp.dir({ unsafeCleanup: true });
    try {
      const cfg = buildConfig(dir.path, 0);
      expect(readPidFile(cfg)).toBeNull();

      fs.writeFileSync(cfg.pidFile, "not-a-number");
      expect(readPidFile(cfg)).toBeNull();

      fs.writeFileSync(cfg.pidFile, String(process.pid));
      expect(readPidFile(cfg)).toBe(process.pid);
    } finally {
      await dir.cleanup();
    }
  });

  it("isPortInUse reports occupancy correctly", async () => {
    const port = await pickEphemeralPort();
    expect(await isPortInUse("127.0.0.1", port)).toBe(false);
  });

  it("stopDaemon returns false when nothing is running", async () => {
    const dir = await tmp.dir({ unsafeCleanup: true });
    try {
      expect(stopDaemon(buildConfig(dir.path, 0))).toBe(false);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("startDaemon", () => {
  let dir: tmp.DirectoryResult;
  let port: number;

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
    port = await pickEphemeralPort();
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("binds the port, writes pidfile, and serves /health", async () => {
    const cfg = buildConfig(dir.path, port);
    const handle = await startDaemon(cfg, nullLogger());
    try {
      expect(readPidFile(cfg)).toBe(process.pid);
      expect(await isPortInUse("127.0.0.1", port)).toBe(true);

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    } finally {
      await handle.close();
    }
    expect(readPidFile(cfg)).toBeNull();
  });

  it("refuses to start when port is already in use", async () => {
    const cfg = buildConfig(dir.path, port);
    const handle = await startDaemon(cfg, nullLogger());
    try {
      await expect(startDaemon(cfg, nullLogger())).rejects.toMatchObject({
        code: "SERVER_ALREADY_RUNNING"
      });
    } finally {
      await handle.close();
    }
  });
});
