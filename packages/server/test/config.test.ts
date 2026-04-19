/**
 * Tests for config loader.
 *
 * Focus: correct default path derivation + env var overrides.
 */

import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("produces defaults rooted at ~/.astack when no env vars are set", () => {
    const cfg = loadConfig({});
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(7432);
    expect(cfg.dataDir).toBe(path.join(os.homedir(), ".astack"));
    expect(cfg.dbPath).toBe(path.join(cfg.dataDir, "astack.sqlite3"));
    expect(cfg.reposDir).toBe(path.join(cfg.dataDir, "repos"));
    expect(cfg.pidFile).toBe(path.join(cfg.dataDir, "daemon.pid"));
    expect(cfg.logFile).toBe(path.join(cfg.dataDir, "daemon.log"));
    expect(cfg.lockFile).toBe(path.join(cfg.dataDir, "daemon.lock"));
    expect(cfg.upstreamCacheTtlMs).toBe(5 * 60 * 1000);
    expect(cfg.repoLockTimeoutMs).toBe(30 * 1000);
  });

  it("uses ASTACK_DATA_DIR as root for all derived paths", () => {
    const cfg = loadConfig({ ASTACK_DATA_DIR: "/tmp/ax" });
    expect(cfg.dataDir).toBe("/tmp/ax");
    expect(cfg.dbPath).toBe("/tmp/ax/astack.sqlite3");
    expect(cfg.reposDir).toBe("/tmp/ax/repos");
    expect(cfg.pidFile).toBe("/tmp/ax/daemon.pid");
  });

  it("parses ASTACK_PORT as integer", () => {
    expect(loadConfig({ ASTACK_PORT: "9000" }).port).toBe(9000);
  });

  it("honors ASTACK_DB_PATH and ASTACK_REPOS_DIR overrides", () => {
    const cfg = loadConfig({
      ASTACK_DATA_DIR: "/tmp/ax",
      ASTACK_DB_PATH: "/custom/db.sqlite3",
      ASTACK_REPOS_DIR: "/custom/repos"
    });
    expect(cfg.dbPath).toBe("/custom/db.sqlite3");
    expect(cfg.reposDir).toBe("/custom/repos");
  });

  it("honors ASTACK_HOST override", () => {
    expect(loadConfig({ ASTACK_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});
