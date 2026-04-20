/**
 * /api/fs tests.
 *
 * Uses a real tmp dir so we exercise actual fs.readdir semantics (dot
 * files, symlinks, missing paths) instead of mocking node:fs.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FsListResponse } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { createApp, type AppInstance } from "../src/http/app.js";
import { nullLogger } from "../src/logger.js";

function buildConfig(dataDir: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7432,
    dataDir,
    dbPath: ":memory:",
    reposDir: path.join(dataDir, "repos"),
    pidFile: path.join(dataDir, "daemon.pid"),
    logFile: path.join(dataDir, "daemon.log"),
    lockFile: path.join(dataDir, "daemon.lock"),
    upstreamCacheTtlMs: 5 * 60 * 1000,
    repoLockTimeoutMs: 5000
  };
}

async function getJson<T>(
  app: AppInstance,
  url: string
): Promise<{ status: number; json: T }> {
  const res = await app.app.fetch(new Request(`http://localhost${url}`));
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as T };
}

describe("/api/fs/list", () => {
  let dataDir: tmp.DirectoryResult;
  let workdir: tmp.DirectoryResult;
  let db: Db;
  let app: AppInstance;

  beforeEach(async () => {
    dataDir = await tmp.dir({ unsafeCleanup: true });
    workdir = await tmp.dir({ unsafeCleanup: true });
    db = openDatabase({ path: ":memory:" });
    app = createApp({
      config: buildConfig(dataDir.path),
      logger: nullLogger(),
      db
    });

    // Seed the workdir with a known layout:
    //   <workdir>/alpha/      (dir)
    //   <workdir>/beta/       (dir)
    //   <workdir>/.hidden/    (dir, hidden)
    //   <workdir>/zeta.txt    (file)
    //   <workdir>/.secret     (file, hidden)
    await fsp.mkdir(path.join(workdir.path, "alpha"));
    await fsp.mkdir(path.join(workdir.path, "beta"));
    await fsp.mkdir(path.join(workdir.path, ".hidden"));
    await fsp.writeFile(path.join(workdir.path, "zeta.txt"), "hello");
    await fsp.writeFile(path.join(workdir.path, ".secret"), "shh");
  });

  afterEach(async () => {
    app.dispose();
    await workdir.cleanup();
    await dataDir.cleanup();
  });

  it("lists directory entries with dirs-first sorting", async () => {
    const { status, json } = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(workdir.path)}`
    );
    expect(status).toBe(200);
    expect(json.exists).toBe(true);
    expect(json.path).toBe(workdir.path);
    expect(json.parent).toBe(path.dirname(workdir.path));

    const names = json.entries.map((e) => e.name);
    // dirs first, then files, each alphabetical
    expect(names).toEqual(["alpha", "beta", "zeta.txt"]);

    const alpha = json.entries.find((e) => e.name === "alpha");
    expect(alpha?.kind).toBe("dir");
    expect(alpha?.path).toBe(path.join(workdir.path, "alpha"));
    expect(alpha?.hidden).toBe(false);

    const zeta = json.entries.find((e) => e.name === "zeta.txt");
    expect(zeta?.kind).toBe("file");
  });

  it("hides dot entries by default, reveals them with show_hidden=1", async () => {
    const hidden = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(workdir.path)}`
    );
    expect(hidden.json.entries.some((e) => e.name === ".hidden")).toBe(false);
    expect(hidden.json.entries.some((e) => e.name === ".secret")).toBe(false);

    const shown = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(workdir.path)}&show_hidden=1`
    );
    const hiddenEntry = shown.json.entries.find((e) => e.name === ".hidden");
    expect(hiddenEntry?.hidden).toBe(true);
    expect(hiddenEntry?.kind).toBe("dir");
    expect(shown.json.entries.some((e) => e.name === ".secret")).toBe(true);
  });

  it("defaults to $HOME when path is omitted", async () => {
    const { json } = await getJson<FsListResponse>(app, "/api/fs/list");
    // We can't guarantee $HOME listing succeeds on every CI but we can
    // at least assert the response shape and that the path resolved to
    // the user's home dir.
    expect(json.path).toBe(os.homedir());
  });

  it("expands ~ prefix to the user home directory", async () => {
    const { json } = await getJson<FsListResponse>(
      app,
      "/api/fs/list?path=~"
    );
    expect(json.path).toBe(os.homedir());
  });

  it("returns exists:false for missing paths, not a 500", async () => {
    const missing = path.join(workdir.path, "nope", "nada");
    const { status, json } = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(missing)}`
    );
    expect(status).toBe(200);
    expect(json.exists).toBe(false);
    expect(json.entries).toEqual([]);
  });

  it("returns exists:false for a non-absolute path instead of erroring", async () => {
    const { status, json } = await getJson<FsListResponse>(
      app,
      "/api/fs/list?path=relative/only"
    );
    expect(status).toBe(200);
    expect(json.exists).toBe(false);
    expect(json.entries).toEqual([]);
    // Falls back to $HOME so the UI has something to show next.
    expect(json.path).toBe(os.homedir());
  });

  it("sets parent=null for the filesystem root", async () => {
    const { json } = await getJson<FsListResponse>(app, "/api/fs/list?path=/");
    expect(json.path).toBe("/");
    expect(json.parent).toBeNull();
  });

  it("follows symlinks to directories and reports them as dir", async () => {
    const real = path.join(workdir.path, "alpha");
    const link = path.join(workdir.path, "linkdir");
    await fsp.symlink(real, link);

    const { json } = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(workdir.path)}`
    );
    const entry = json.entries.find((e) => e.name === "linkdir");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("dir");
  });

  it("silently drops dangling symlinks", async () => {
    const link = path.join(workdir.path, "broken");
    await fsp.symlink("/does/not/exist", link);

    const { json } = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(workdir.path)}`
    );
    expect(json.entries.some((e) => e.name === "broken")).toBe(false);
  });

  it("normalizes ../ segments", async () => {
    const weird = `${workdir.path}/alpha/..`;
    const { json } = await getJson<FsListResponse>(
      app,
      `/api/fs/list?path=${encodeURIComponent(weird)}`
    );
    expect(json.path).toBe(workdir.path);
  });
});
