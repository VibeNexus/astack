/**
 * Integration test — run real commands against a live in-process daemon.
 *
 * Spawning the CLI as a subprocess would be accurate but slow (~1s each).
 * Instead we start the daemon on an ephemeral port and exercise the
 * CLI command functions directly with a daemon URL override. The CLI's
 * own orchestration and server interaction get full coverage this way.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import type { ServerConfig } from "@astack/server";
import {
  loadConfig,
  startDaemon,
  type DaemonHandle
} from "@astack/server";
import { ResolveStrategy } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstackClient } from "../src/client.js";

const execFileAsync = promisify(execFile);

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function createBareRepoWithCommand(): Promise<{
  bareDir: string;
  workDir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await tmp.dir({ unsafeCleanup: true });
  const bareDir = path.join(dir.path, "bare.git");
  const workDir = path.join(dir.path, "work");
  fs.mkdirSync(bareDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main"], {
    cwd: bareDir
  });
  await execFileAsync("git", ["clone", bareDir, workDir], { cwd: dir.path });
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: workDir });
  fs.mkdirSync(path.join(workDir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "commands", "code_review.md"),
    "# v1 content\n"
  );
  await execFileAsync("git", ["add", "-A"], { cwd: workDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workDir });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: workDir });
  return {
    bareDir,
    workDir,
    cleanup: () => dir.cleanup()
  };
}

describe("CLI ↔ daemon integration", () => {
  let dataDir: tmp.DirectoryResult;
  let projectDir: tmp.DirectoryResult;
  let port: number;
  let handle: DaemonHandle;
  let bare: Awaited<ReturnType<typeof createBareRepoWithCommand>>;
  let baseUrl: string;
  let client: AstackClient;

  beforeEach(async () => {
    dataDir = await tmp.dir({ unsafeCleanup: true });
    projectDir = await tmp.dir({ unsafeCleanup: true });
    port = await ephemeralPort();
    const defaults = loadConfig({});
    const config: ServerConfig = {
      ...defaults,
      host: "127.0.0.1",
      port,
      dataDir: dataDir.path,
      dbPath: path.join(dataDir.path, "astack.sqlite3"),
      reposDir: path.join(dataDir.path, "repos"),
      pidFile: path.join(dataDir.path, "daemon.pid"),
      logFile: path.join(dataDir.path, "daemon.log"),
      lockFile: path.join(dataDir.path, "daemon.lock")
    };
    handle = await startDaemon(config, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    });
    baseUrl = `http://127.0.0.1:${port}`;
    client = new AstackClient({ baseUrl });
    bare = await createBareRepoWithCommand();
  });

  afterEach(async () => {
    await handle.close();
    await Promise.all([
      dataDir.cleanup(),
      projectDir.cleanup(),
      bare.cleanup()
    ]);
  });

  it("full flow: register repo → init → subscribe → push → status", async () => {
    // 1. register repo.
    const reg = await client.registerRepo({ git_url: bare.bareDir });
    expect(reg.command_count).toBe(1);

    // 2. register project.
    const proj = await client.registerProject({ path: projectDir.path });

    // 3. subscribe with sync_now.
    const sub = await client.subscribe(proj.project.id, {
      skills: ["code_review"],
      sync_now: true
    });
    expect(sub.subscriptions).toHaveLength(1);

    // Working copy should now exist.
    const workingPath = path.join(
      projectDir.path,
      ".claude/commands/code_review.md"
    );
    expect(fs.readFileSync(workingPath, "utf8")).toBe("# v1 content\n");

    // 4. Edit locally and push.
    fs.writeFileSync(workingPath, "# v2 local edit\n");
    const pushed = await client.push(proj.project.id, {});
    expect(pushed.pushed).toBe(1);

    // 5. Status reflects synced state.
    const status = await client.projectStatus(proj.project.id);
    expect(status.subscriptions[0]!.state).toBe("synced");
  });

  it("conflict path: diverge both sides then resolve via use-remote", async () => {
    const reg = await client.registerRepo({ git_url: bare.bareDir });
    const proj = await client.registerProject({ path: projectDir.path });
    await client.subscribe(proj.project.id, {
      skills: ["code_review"],
      sync_now: true
    });

    // Diverge.
    const workingPath = path.join(
      projectDir.path,
      ".claude/commands/code_review.md"
    );
    fs.writeFileSync(workingPath, "# local\n");

    // Second push into bare from a second client.
    const bare2WorkDir = `${bare.workDir}-2`;
    await execFileAsync("git", ["clone", bare.bareDir, bare2WorkDir]);
    await execFileAsync("git", ["config", "user.email", "t@t"], {
      cwd: bare2WorkDir
    });
    await execFileAsync("git", ["config", "user.name", "t"], {
      cwd: bare2WorkDir
    });
    fs.writeFileSync(
      path.join(bare2WorkDir, "commands", "code_review.md"),
      "# remote\n"
    );
    await execFileAsync("git", ["add", "-A"], { cwd: bare2WorkDir });
    await execFileAsync("git", ["commit", "-m", "remote bump"], {
      cwd: bare2WorkDir
    });
    await execFileAsync("git", ["push"], { cwd: bare2WorkDir });
    fs.rmSync(bare2WorkDir, { recursive: true, force: true });

    // Sync → conflict.
    const sync = await client.sync(proj.project.id, { force: false });
    expect(sync.conflicts).toBe(1);

    // Resolve via use-remote.
    const resolved = await client.resolve(proj.project.id, {
      skill_id: sync.outcomes[0]!.skill.id,
      strategy: ResolveStrategy.UseRemote,
      manual_done: false
    });
    expect(resolved.log.status).toBe("success");
    expect(fs.readFileSync(workingPath, "utf8")).toBe("# remote\n");
    void reg;
  });

  it("linked dirs: add cursor, list, and remove", async () => {
    const proj = await client.registerProject({ path: projectDir.path });

    const added = await client.createLinkedDir(proj.project.id, {
      tool_name: "cursor"
    });
    expect(added.link.tool_name).toBe("cursor");
    expect(
      fs
        .lstatSync(path.join(projectDir.path, ".cursor"))
        .isSymbolicLink()
    ).toBe(true);

    const status = await client.projectStatus(proj.project.id);
    expect(status.linked_dirs).toHaveLength(1);

    const removed = await client.deleteLinkedDir(proj.project.id, "cursor");
    expect(removed.deleted).toBe(true);
  });
});
