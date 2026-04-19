/**
 * Integration tests for the command runXxx() functions.
 *
 * Unlike test/integration.test.ts which exercises AstackClient directly,
 * this file drives the user-facing commands that bin.ts wires into
 * commander. Ensures output formatting, flag handling, and error paths.
 *
 * We spin up a real daemon per describe block so command functions can
 * hit live endpoints. Output is captured from process.stdout/stderr.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import {
  loadConfig,
  startDaemon,
  type DaemonHandle,
  type ServerConfig
} from "@astack/server";
import { ResolveStrategy } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDiff } from "../src/commands/diff.js";
import { runInit } from "../src/commands/init.js";
import {
  runLinkAdd,
  runLinkList,
  runLinkRemove
} from "../src/commands/link.js";
import { runPush } from "../src/commands/push.js";
import {
  runReposList,
  runReposRefresh,
  runReposRegister,
  runReposRemove
} from "../src/commands/repos.js";
import { runResolve } from "../src/commands/resolve.js";
import { runStatus } from "../src/commands/status.js";
import { runSubscribe } from "../src/commands/subscribe.js";
import { runSync } from "../src/commands/sync.js";

const execFileAsync = promisify(execFile);

// ---------- Utilities ----------

function captureStdout<T>(fn: () => Promise<T> | T): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((data: string | Uint8Array) => {
    chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
    return true;
  }) as unknown as typeof process.stdout.write;
  return Promise.resolve()
    .then(() => fn())
    .then((result) => {
      process.stdout.write = orig;
      return { result, out: chunks.join("") };
    })
    .catch((err) => {
      process.stdout.write = orig;
      throw err;
    });
}

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
    "# v1\n"
  );
  await execFileAsync("git", ["add", "-A"], { cwd: workDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workDir });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: workDir });
  return { bareDir, workDir, cleanup: () => dir.cleanup() };
}

// ---------- Suite ----------

describe("CLI command functions", () => {
  let dataDir: tmp.DirectoryResult;
  let projectDir: tmp.DirectoryResult;
  let port: number;
  let baseUrl: string;
  let handle: DaemonHandle;
  let bare: Awaited<ReturnType<typeof createBareRepoWithCommand>>;
  let origCwd: string;

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
    bare = await createBareRepoWithCommand();
    origCwd = process.cwd();
    process.chdir(projectDir.path);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await handle.close();
    await Promise.all([
      dataDir.cleanup(),
      projectDir.cleanup(),
      bare.cleanup()
    ]);
  });

  // Helper: bootstrap a project + repo + subscription via the CLI entry points.
  async function bootstrap(): Promise<{ skillName: string }> {
    await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
    await runInit({ daemonUrl: baseUrl });
    await runSubscribe(["code_review"], {});
    return { skillName: "code_review" };
  }

  // ---- repos ----

  describe("repos", () => {
    it("register prints the command/skill counts", async () => {
      const { out } = await captureStdout(() =>
        runReposRegister(bare.bareDir, { daemonUrl: baseUrl })
      );
      expect(out).toContain("registered repo");
      expect(out).toContain("1 command(s)");
    });

    it("list shows registered repos; empty message before register", async () => {
      const empty = await captureStdout(() => runReposList({ daemonUrl: baseUrl }));
      expect(empty.out).toContain("no repos");

      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });

      const listed = await captureStdout(() =>
        runReposList({ daemonUrl: baseUrl })
      );
      expect(listed.out).toContain("1 repo(s)");
    });

    it("refresh reports no changes when HEAD unchanged", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      const { out } = await captureStdout(() =>
        runReposRefresh(1, { daemonUrl: baseUrl })
      );
      expect(out).toContain("refreshed repo");
      expect(out).toContain("no changes");
    });

    it("remove deletes by id", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      const { out } = await captureStdout(() =>
        runReposRemove(1, { daemonUrl: baseUrl })
      );
      expect(out).toContain("removed repo id=1");
    });
  });

  // ---- init ----

  describe("init", () => {
    it("writes .astack.json and prints next steps", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      const { out } = await captureStdout(() => runInit({ daemonUrl: baseUrl }));
      expect(out).toContain("registered project");
      expect(out).toContain("Next:");
      expect(fs.existsSync(path.join(projectDir.path, ".claude/.astack.json"))).toBe(
        true
      );
    });

    it("is a warn-and-return when already initialized", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      await runInit({ daemonUrl: baseUrl });
      const { out } = await captureStdout(() => runInit({ daemonUrl: baseUrl }));
      expect(out).toContain("already initialized");
    });
  });

  // ---- subscribe / sync / status ----

  describe("subscribe + sync + status", () => {
    it("subscribe syncs working copy by default", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      await runInit({ daemonUrl: baseUrl });

      const { out } = await captureStdout(() =>
        runSubscribe(["code_review"], {})
      );
      expect(out).toContain("subscribed 1 skill");
      expect(out).toContain("synced 1 skill(s)");
      expect(
        fs.readFileSync(
          path.join(projectDir.path, ".claude/commands/code_review.md"),
          "utf8"
        )
      ).toBe("# v1\n");
    });

    it("subscribe --no-sync skips initial sync", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      await runInit({ daemonUrl: baseUrl });

      const { out } = await captureStdout(() =>
        runSubscribe(["code_review"], { noSync: true })
      );
      expect(out).toContain("subscribed 1 skill");
      expect(out).not.toContain("synced 1 skill(s) to working copy");
    });

    it("sync reports no subscriptions when none exist", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      await runInit({ daemonUrl: baseUrl });

      const { out } = await captureStdout(() => runSync({}));
      expect(out).toContain("no subscriptions to sync");
    });

    it("sync reports conflicts with resolve hint", async () => {
      await bootstrap();
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# local\n"
      );

      const bare2Work = `${bare.workDir}-sync2`;
      await execFileAsync("git", ["clone", bare.bareDir, bare2Work]);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: bare2Work
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: bare2Work
      });
      fs.writeFileSync(
        path.join(bare2Work, "commands", "code_review.md"),
        "# remote\n"
      );
      await execFileAsync("git", ["add", "-A"], { cwd: bare2Work });
      await execFileAsync("git", ["commit", "-m", "remote"], { cwd: bare2Work });
      await execFileAsync("git", ["push"], { cwd: bare2Work });
      fs.rmSync(bare2Work, { recursive: true, force: true });

      const { out } = await captureStdout(() => runSync({ force: true }));
      expect(out).toContain("conflict");
      expect(out).toContain("astack resolve code_review");
    });

    it("status prints a table with the synced state", async () => {
      await bootstrap();
      const { out } = await captureStdout(() => runStatus());
      expect(out).toContain("code_review");
      expect(out).toContain("synced");
    });

    it("status prints onboarding hint when no subscriptions yet", async () => {
      await runReposRegister(bare.bareDir, { daemonUrl: baseUrl });
      await runInit({ daemonUrl: baseUrl });
      const { out } = await captureStdout(() => runStatus());
      expect(out).toContain("no subscriptions yet");
    });

    it("status renders local-ahead after editing the working copy", async () => {
      await bootstrap();
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# local edit\n"
      );
      const { out } = await captureStdout(() => runStatus());
      expect(out).toContain("local-ahead");
    });

    it("status shows linked tools when present", async () => {
      await bootstrap();
      await runLinkAdd("cursor");
      const { out } = await captureStdout(() => runStatus());
      expect(out).toContain("tools linked: cursor");
    });
  });

  // ---- push ----

  describe("push", () => {
    it("pushes local edits and reports success", async () => {
      await bootstrap();
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# v2 edit\n"
      );
      const { out } = await captureStdout(() => runPush([], {}));
      expect(out).toContain("pushed 1 skill");
    });

    it("targets a specific skill by name", async () => {
      await bootstrap();
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# v2\n"
      );
      const { out } = await captureStdout(() => runPush(["code_review"], {}));
      expect(out).toContain("pushed 1 skill");
    });

    it("reports no changes when working copy matches upstream", async () => {
      await bootstrap();
      const { out } = await captureStdout(() => runPush([], {}));
      expect(out).toContain("had no local changes");
    });

    it("reports conflict and resolve hint when upstream diverged", async () => {
      await bootstrap();

      // Local edit.
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# local\n"
      );

      // Remote edit via a second working copy.
      const bare2Work = `${bare.workDir}-push2`;
      await execFileAsync("git", ["clone", bare.bareDir, bare2Work]);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: bare2Work
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: bare2Work
      });
      fs.writeFileSync(
        path.join(bare2Work, "commands", "code_review.md"),
        "# remote\n"
      );
      await execFileAsync("git", ["add", "-A"], { cwd: bare2Work });
      await execFileAsync("git", ["commit", "-m", "remote"], { cwd: bare2Work });
      await execFileAsync("git", ["push"], { cwd: bare2Work });
      fs.rmSync(bare2Work, { recursive: true, force: true });

      const { out } = await captureStdout(() => runPush([], {}));
      expect(out).toContain("conflict");
      expect(out).toContain("astack resolve code_review");
    });

    it("rejects unknown skill ref", async () => {
      await bootstrap();
      await expect(runPush(["no-such-skill"], {})).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND"
      });
    });
  });

  // ---- diff ----

  describe("diff", () => {
    it("reports identical when working copy matches", async () => {
      await bootstrap();
      const { out } = await captureStdout(() => runDiff("code_review"));
      expect(out).toContain("matches upstream");
    });

    it("reports differs when local edited", async () => {
      await bootstrap();
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# edited\n"
      );
      const { out } = await captureStdout(() => runDiff("code_review"));
      expect(out).toContain("local differs from upstream");
    });

    it("throws SKILL_NOT_FOUND for unknown skill ref", async () => {
      await bootstrap();
      await expect(runDiff("no-such-skill")).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND"
      });
    });
  });

  // ---- resolve ----

  describe("resolve", () => {
    it("resolves a conflict via use-remote", async () => {
      await bootstrap();

      // Diverge.
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "# local\n"
      );
      const bare2Work = `${bare.workDir}-2`;
      await execFileAsync("git", ["clone", bare.bareDir, bare2Work]);
      await execFileAsync("git", ["config", "user.email", "t@t"], {
        cwd: bare2Work
      });
      await execFileAsync("git", ["config", "user.name", "t"], {
        cwd: bare2Work
      });
      fs.writeFileSync(
        path.join(bare2Work, "commands", "code_review.md"),
        "# remote\n"
      );
      await execFileAsync("git", ["add", "-A"], { cwd: bare2Work });
      await execFileAsync("git", ["commit", "-m", "remote"], { cwd: bare2Work });
      await execFileAsync("git", ["push"], { cwd: bare2Work });
      fs.rmSync(bare2Work, { recursive: true, force: true });

      // Trigger conflict.
      await captureStdout(() => runSync({}));

      const { out } = await captureStdout(() =>
        runResolve("code_review", { strategy: ResolveStrategy.UseRemote })
      );
      expect(out).toContain("resolved code_review via use-remote");
      expect(
        fs.readFileSync(
          path.join(projectDir.path, ".claude/commands/code_review.md"),
          "utf8"
        )
      ).toBe("# remote\n");
    });

    it("throws SKILL_NOT_FOUND for unknown skill", async () => {
      await bootstrap();
      await expect(
        runResolve("nope", { strategy: ResolveStrategy.UseRemote })
      ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    });
  });

  // ---- link ----

  describe("link", () => {
    it("add creates a symlink", async () => {
      await bootstrap();
      const { out } = await captureStdout(() => runLinkAdd("cursor"));
      expect(out).toContain("linked cursor");
      expect(
        fs
          .lstatSync(path.join(projectDir.path, ".cursor/commands"))
          .isSymbolicLink()
      ).toBe(true);
    });

    it("list shows tools in a table", async () => {
      await bootstrap();
      await runLinkAdd("cursor");
      const { out } = await captureStdout(() => runLinkList());
      expect(out).toContain("cursor");
      expect(out).toContain("active");
    });

    it("list prints hint when empty", async () => {
      await bootstrap();
      const { out } = await captureStdout(() => runLinkList());
      expect(out).toContain("no tool links");
    });

    it("remove deletes the link", async () => {
      await bootstrap();
      await runLinkAdd("cursor");
      const { out } = await captureStdout(() => runLinkRemove("cursor"));
      expect(out).toContain("removed link");
    });
  });
});
