/**
 * Tests for RepoService.
 *
 * Uses real git (simple-git) against real bare repos in tmp dirs.
 * SQLite is in-memory per test.
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, EventType, SkillType } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { EventBus, type EmittedEvent } from "../src/events.js";
import { LockManager } from "../src/lock.js";
import { nullLogger } from "../src/logger.js";
import { RepoService, deriveNameFromUrl } from "../src/services/repo.js";

import { createBareRepo, type BareRepoHandle } from "./helpers/git-fixture.js";

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

describe("deriveNameFromUrl", () => {
  it.each([
    ["git@github.com:user/my-skills.git", "my-skills"],
    ["https://github.com/user/my-skills", "my-skills"],
    ["https://github.com/user/my-skills/", "my-skills"],
    ["/abs/local/path/my-skills", "my-skills"],
    ["my-skills.git", "my-skills"]
  ])("%s → %s", (url, expected) => {
    expect(deriveNameFromUrl(url)).toBe(expected);
  });
});

describe("RepoService", () => {
  let dataDir: tmp.DirectoryResult;
  let db: Db;
  let events: EventBus;
  let locks: LockManager;
  let service: RepoService;
  let bare: BareRepoHandle;

  // Captured events during the test for assertions.
  let emitted: EmittedEvent[];

  beforeEach(async () => {
    dataDir = await tmp.dir({ unsafeCleanup: true });
    db = openDatabase({ path: ":memory:" });
    events = new EventBus();
    emitted = [];
    events.subscribe((e) => emitted.push(e));
    locks = new LockManager({ timeoutMs: 5000 });
    service = new RepoService({
      db,
      config: buildConfig(dataDir.path),
      events,
      locks,
      logger: nullLogger()
    });
    bare = await createBareRepo();
  });

  afterEach(async () => {
    db.close();
    const tasks: Promise<void>[] = [];
    if (bare) tasks.push(bare.dir.cleanup());
    if (dataDir) tasks.push(dataDir.cleanup());
    await Promise.all(tasks);
  });

  // ---------- register ----------

  describe("register", () => {
    it("clones, scans, persists, and emits repo.registered", async () => {
      await bare.addCommitPush(
        "commands/code_review.md",
        "# code review\n",
        "add code_review"
      );
      await bare.addCommitPush(
        "skills/office-hours/SKILL.md",
        "# office hours\n",
        "add office-hours skill"
      );

      const result = await service.register({ git_url: bare.url });

      expect(result.repo.name).toBe(deriveNameFromUrl(bare.url));
      expect(result.repo.git_url).toBe(bare.url);
      expect(result.repo.local_path).toBe(
        path.join(dataDir.path, "repos", result.repo.name)
      );
      expect(result.repo.head_hash).toMatch(/^[0-9a-f]{40}$/);

      expect(result.command_count).toBe(1);
      expect(result.skill_count).toBe(1);
      expect(result.skills.map((s) => s.name).sort()).toEqual([
        "code_review",
        "office-hours"
      ]);

      // All skills pinned to the same HEAD commit.
      for (const s of result.skills) {
        expect(s.version).toBe(result.repo.head_hash);
      }

      const registeredEvent = emitted.find(
        (e) => e.event.type === EventType.RepoRegistered
      );
      expect(registeredEvent).toBeDefined();
    });

    it("derives the name when not provided, and uses override when given", async () => {
      await bare.addCommitPush("commands/x.md", "x", "init");
      const result = await service.register({
        git_url: bare.url,
        name: "my-custom-name"
      });
      expect(result.repo.name).toBe("my-custom-name");
    });

    it("rejects a second registration of the same git_url", async () => {
      await bare.addCommitPush("commands/x.md", "x", "init");
      await service.register({ git_url: bare.url });

      await expect(service.register({ git_url: bare.url })).rejects.toMatchObject({
        code: ErrorCode.REPO_ALREADY_REGISTERED
      });
    });

    it("wraps git clone failures as REPO_GIT_FAILED", async () => {
      await expect(
        service.register({ git_url: "/no/such/path/nowhere" })
      ).rejects.toMatchObject({ code: ErrorCode.REPO_GIT_FAILED });
    });

    it("tolerates empty repo (no commands/, no skills/)", async () => {
      // bare has initial state but no files — need at least one commit for HEAD.
      // Create an empty file at root to produce a commit.
      await bare.addCommitPush("README.md", "empty repo", "init");

      const result = await service.register({ git_url: bare.url });
      expect(result.skills).toEqual([]);
      expect(result.command_count).toBe(0);
      expect(result.skill_count).toBe(0);
    });
  });

  // ---------- refresh ----------

  describe("refresh", () => {
    it("pulls new commits, returns changed=true, and updates head_hash", async () => {
      const initHash = await bare.addCommitPush(
        "commands/v1.md",
        "v1",
        "init"
      );
      const result = await service.register({ git_url: bare.url });
      expect(result.repo.head_hash).toBe(initHash);

      const nextHash = await bare.addCommitPush(
        "commands/v2.md",
        "v2",
        "add v2"
      );

      const refreshed = await service.refresh(result.repo.id);
      expect(refreshed.changed).toBe(true);
      expect(refreshed.repo.head_hash).toBe(nextHash);
      expect(refreshed.skills.map((s) => s.name).sort()).toEqual(["v1", "v2"]);

      const refreshedEvent = emitted.find(
        (e) => e.event.type === EventType.RepoRefreshed
      );
      expect(refreshedEvent).toBeDefined();
    });

    it("returns changed=false when upstream has no new commits", async () => {
      await bare.addCommitPush("commands/v1.md", "v1", "init");
      const result = await service.register({ git_url: bare.url });

      const refreshed = await service.refresh(result.repo.id);
      expect(refreshed.changed).toBe(false);
      expect(refreshed.repo.head_hash).toBe(result.repo.head_hash);
    });

    it("removes skills that disappeared upstream", async () => {
      await bare.addCommitPush("commands/keep.md", "k", "init");
      await bare.addCommitPush("commands/drop.md", "d", "add drop");
      const result = await service.register({ git_url: bare.url });
      expect(result.skills.map((s) => s.name).sort()).toEqual(["drop", "keep"]);

      // Delete drop.md upstream.
      fs.rmSync(path.join(bare.workDir, "commands", "drop.md"));
      await (await import("simple-git"))
        .simpleGit(bare.workDir)
        .add("commands/drop.md");
      await bare.commit("delete drop");
      await bare.push();

      const refreshed = await service.refresh(result.repo.id);
      expect(refreshed.skills.map((s) => s.name)).toEqual(["keep"]);
    });

    it("throws REPO_NOT_FOUND when id does not exist", async () => {
      await expect(service.refresh(9999)).rejects.toMatchObject({
        code: ErrorCode.REPO_NOT_FOUND
      });
    });
  });

  // ---------- remove ----------

  describe("remove", () => {
    it("deletes the repo row, cascades skills, and emits repo.removed", async () => {
      await bare.addCommitPush("commands/x.md", "x", "init");
      const result = await service.register({ git_url: bare.url });

      service.remove(result.repo.id);

      expect(service.findById(result.repo.id)).toBeNull();
      // Skills cascaded.
      const skillCount = (
        db
          .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM skills")
          .get() ?? { c: 0 }
      ).c;
      expect(skillCount).toBe(0);

      const removedEvent = emitted.find(
        (e) => e.event.type === EventType.RepoRemoved
      );
      expect(removedEvent).toBeDefined();
    });

    it("throws REPO_NOT_FOUND on unknown id", () => {
      expect(() => service.remove(9999)).toThrow();
    });
  });

  // ---------- queries ----------

  describe("queries", () => {
    it("list returns paginated repos with total", async () => {
      await bare.addCommitPush("commands/a.md", "a", "init");
      await service.register({ git_url: bare.url });

      const { repos, total } = service.list({ offset: 0, limit: 10 });
      expect(total).toBe(1);
      expect(repos).toHaveLength(1);
    });

    it("listSkills returns only the target repo's skills", async () => {
      await bare.addCommitPush("commands/a.md", "a", "init");
      const { repo } = await service.register({ git_url: bare.url });
      const list = service.listSkills(repo.id);
      expect(list).toHaveLength(1);
      expect(list[0].type).toBe(SkillType.Command);
    });

    it("listSkills throws REPO_NOT_FOUND for unknown id", () => {
      expect(() => service.listSkills(9999)).toThrow();
    });
  });

  // ---------- upstream-head TTL cache ----------

  describe("getUpstreamHead", () => {
    it("caches results within TTL; bypasses on force=true", async () => {
      await bare.addCommitPush("commands/a.md", "a", "init");
      const { repo } = await service.register({ git_url: bare.url });

      // Use a fake clock to control the TTL.
      let now = 1_000_000;
      const service2 = new RepoService({
        db,
        config: buildConfig(dataDir.path),
        events,
        locks,
        logger: nullLogger(),
        now: () => now
      });

      const first = await service2.getUpstreamHead(repo.id);
      expect(first).toMatch(/^[0-9a-f]{40}$/);

      // Push a new commit upstream.
      const newer = await bare.addCommitPush("commands/b.md", "b", "newer");

      // Still within TTL → cached (returns old head).
      now += 60_000; // 1 minute
      const cached = await service2.getUpstreamHead(repo.id);
      expect(cached).toBe(first);

      // Expire TTL → fetches remote.
      now += 5 * 60_000;
      const fresh = await service2.getUpstreamHead(repo.id);
      expect(fresh).toBe(newer);

      // Force bypass.
      now = 0;
      const bareHead = await service2.getUpstreamHead(repo.id, { force: true });
      expect(bareHead).toBe(newer);
    });
  });
});
