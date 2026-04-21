/**
 * HTTP integration tests.
 *
 * Drives the Hono app directly via app.fetch() — no TCP listener, no
 * real HTTP. Verifies route/validation wiring, error mapping, and the
 * full create-project → register-repo → subscribe → sync flow.
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, SkillType } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { createApp, type AppInstance } from "../src/http/app.js";
import { nullLogger } from "../src/logger.js";

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

async function request<T>(
  app: AppInstance,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; json: T }> {
  const init: RequestInit = {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  };
  const res = await app.app.fetch(new Request(`http://localhost${url}`, init));
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, json };
}

describe("HTTP API", () => {
  let dataDir: tmp.DirectoryResult;
  let projectDir: tmp.DirectoryResult;
  let bare: BareRepoHandle;
  let db: Db;
  let app: AppInstance;

  beforeEach(async () => {
    dataDir = await tmp.dir({ unsafeCleanup: true });
    projectDir = await tmp.dir({ unsafeCleanup: true });
    bare = await createBareRepo();
    db = openDatabase({ path: ":memory:" });
    app = createApp({
      config: buildConfig(dataDir.path),
      logger: nullLogger(),
      db
    });
  });

  afterEach(async () => {
    app.dispose();
    db.close();
    await Promise.all([
      dataDir.cleanup(),
      projectDir.cleanup(),
      bare.dir.cleanup()
    ]);
  });

  describe("GET /health", () => {
    it("returns status=ok", async () => {
      const { status, json } = await request<{
        status: string;
        version: string;
      }>(app, "GET", "/health");
      expect(status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("validation errors", () => {
    it("returns 400 + VALIDATION_FAILED on malformed repo registration", async () => {
      const { status, json } = await request<{ code: string }>(
        app,
        "POST",
        "/api/repos",
        { not_git_url: "bad" }
      );
      expect(status).toBe(400);
      expect(json.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it("returns 404 + PROJECT_NOT_FOUND on unknown project", async () => {
      const { status, json } = await request<{ code: string }>(
        app,
        "GET",
        "/api/projects/9999/status"
      );
      expect(status).toBe(404);
      expect(json.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    });
  });

  describe("repos CRUD", () => {
    it("registers a repo and lists it back", async () => {
      await bare.addCommitPush(
        "commands/code_review.md",
        "# cr\n",
        "init"
      );

      const reg = await request<{
        repo: { id: number; name: string };
        command_count: number;
        skill_count: number;
      }>(app, "POST", "/api/repos", { git_url: bare.url });
      expect(reg.status).toBe(201);
      expect(reg.json.command_count).toBe(1);

      const list = await request<{ repos: unknown[]; total: number }>(
        app,
        "GET",
        "/api/repos"
      );
      expect(list.status).toBe(200);
      expect(list.json.total).toBe(1);
      expect(list.json.repos).toHaveLength(1);
    });

    it("rejects duplicate git_url with REPO_ALREADY_REGISTERED", async () => {
      await bare.addCommitPush("commands/x.md", "x", "init");
      await request(app, "POST", "/api/repos", { git_url: bare.url });
      const dup = await request<{ code: string }>(app, "POST", "/api/repos", {
        git_url: bare.url
      });
      expect(dup.status).toBe(409);
      expect(dup.json.code).toBe(ErrorCode.REPO_ALREADY_REGISTERED);
    });

    it("lists skills for a repo", async () => {
      await bare.addCommitPush("commands/a.md", "A", "init");
      await bare.addCommitPush(
        "skills/office-hours/SKILL.md",
        "sk",
        "add skill"
      );
      const reg = await request<{ repo: { id: number } }>(
        app,
        "POST",
        "/api/repos",
        { git_url: bare.url }
      );
      const skills = await request<{ skills: unknown[] }>(
        app,
        "GET",
        `/api/repos/${reg.json.repo.id}/skills`
      );
      expect(skills.json.skills).toHaveLength(2);
    });

    it("refreshes and reports changed=true when upstream moved", async () => {
      await bare.addCommitPush("commands/v1.md", "v1", "init");
      const reg = await request<{ repo: { id: number } }>(
        app,
        "POST",
        "/api/repos",
        { git_url: bare.url }
      );
      await bare.addCommitPush("commands/v2.md", "v2", "add v2");
      const refreshed = await request<{ changed: boolean; skills: unknown[] }>(
        app,
        "POST",
        `/api/repos/${reg.json.repo.id}/refresh`
      );
      expect(refreshed.json.changed).toBe(true);
      expect(refreshed.json.skills).toHaveLength(2);
    });

    it("deletes a repo", async () => {
      await bare.addCommitPush("commands/x.md", "x", "init");
      const reg = await request<{ repo: { id: number } }>(
        app,
        "POST",
        "/api/repos",
        { git_url: bare.url }
      );
      const del = await request<{ deleted: boolean }>(
        app,
        "DELETE",
        `/api/repos/${reg.json.repo.id}`
      );
      expect(del.status).toBe(200);
      expect(del.json.deleted).toBe(true);
    });
  });

  describe("projects CRUD", () => {
    it("registers and lists projects", async () => {
      const reg = await request<{ project: { id: number; name: string } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );
      expect(reg.status).toBe(201);
      expect(reg.json.project.id).toBeGreaterThan(0);

      const list = await request<{ projects: unknown[]; total: number }>(
        app,
        "GET",
        "/api/projects"
      );
      expect(list.json.total).toBe(1);
    });

    it("returns status with subscriptions and linked_dirs arrays", async () => {
      const reg = await request<{ project: { id: number } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );
      const status = await request<{
        project: { id: number };
        subscriptions: unknown[];
        linked_dirs: unknown[];
      }>(app, "GET", `/api/projects/${reg.json.project.id}/status`);
      expect(status.status).toBe(200);
      expect(status.json.subscriptions).toEqual([]);
      expect(status.json.linked_dirs).toEqual([]);
    });
  });

  describe("subscribe → sync → push flow", () => {
    it("walks the complete flow end-to-end", async () => {
      await bare.addCommitPush(
        "commands/code_review.md",
        "v1\n",
        "init"
      );

      const repoReg = await request<{ repo: { id: number } }>(
        app,
        "POST",
        "/api/repos",
        { git_url: bare.url }
      );
      const projReg = await request<{ project: { id: number } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );

      // Subscribe with sync_now=true — should write working copy.
      const sub = await request<{
        subscriptions: Array<{ skill_id: number }>;
        sync_logs: unknown[];
      }>(
        app,
        "POST",
        `/api/projects/${projReg.json.project.id}/subscriptions`,
        {
          skills: ["code_review"],
          sync_now: true
        }
      );
      expect(sub.status).toBe(201);
      expect(sub.json.subscriptions).toHaveLength(1);

      // Working copy should exist now.
      const workingPath = path.join(
        projectDir.path,
        ".claude",
        "commands",
        "code_review.md"
      );
      expect(fs.readFileSync(workingPath, "utf8")).toBe("v1\n");

      // Edit locally, then push.
      fs.writeFileSync(workingPath, "v2\n");
      const push = await request<{ pushed: number; conflicts: number }>(
        app,
        "POST",
        `/api/projects/${projReg.json.project.id}/push`,
        {}
      );
      expect(push.status).toBe(200);
      expect(push.json.pushed).toBe(1);

      // status should now show Synced for the skill.
      const status = await request<{
        subscriptions: Array<{ state: string }>;
      }>(app, "GET", `/api/projects/${projReg.json.project.id}/status`);
      expect(status.json.subscriptions[0]!.state).toBe("synced");

      void repoReg;
    });

    it("reports conflicts in sync batch (best-effort)", async () => {
      await bare.addCommitPush(
        "commands/code_review.md",
        "v1\n",
        "init"
      );
      const repoReg = await request<{ repo: { id: number } }>(
        app,
        "POST",
        "/api/repos",
        { git_url: bare.url }
      );
      const projReg = await request<{ project: { id: number } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );
      await request(
        app,
        "POST",
        `/api/projects/${projReg.json.project.id}/subscriptions`,
        { skills: ["code_review"], sync_now: true }
      );

      // Diverge both sides.
      fs.writeFileSync(
        path.join(projectDir.path, ".claude/commands/code_review.md"),
        "L\n"
      );
      await bare.addCommitPush(
        "commands/code_review.md",
        "R\n",
        "remote bump"
      );

      const sync = await request<{ conflicts: number }>(
        app,
        "POST",
        `/api/projects/${projReg.json.project.id}/sync`,
        {}
      );
      expect(sync.json.conflicts).toBe(1);
      void repoReg;
    });
  });

  describe("linked dirs", () => {
    it("creates and removes a symlink for cursor", async () => {
      const proj = await request<{ project: { id: number } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );
      const add = await request<{ link: { tool_name: string } }>(
        app,
        "POST",
        `/api/projects/${proj.json.project.id}/links`,
        { tool_name: "cursor" }
      );
      expect(add.status).toBe(201);
      expect(add.json.link.tool_name).toBe("cursor");
      expect(
        fs
          .lstatSync(path.join(projectDir.path, ".cursor/commands"))
          .isSymbolicLink()
      ).toBe(true);

      const del = await request<{ deleted: boolean }>(
        app,
        "DELETE",
        `/api/projects/${proj.json.project.id}/links/cursor`
      );
      expect(del.status).toBe(200);
      expect(del.json.deleted).toBe(true);
    });
  });

  describe("unsubscribe", () => {
    it("returns SUBSCRIPTION_NOT_FOUND when deleting unknown subscription", async () => {
      await bare.addCommitPush("commands/x.md", "x", "init");
      await request(app, "POST", "/api/repos", { git_url: bare.url });
      const proj = await request<{ project: { id: number } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );

      const res = await request<{ code: string }>(
        app,
        "DELETE",
        `/api/projects/${proj.json.project.id}/subscriptions/9999`
      );
      expect(res.status).toBe(404);
      expect(res.json.code).toBe(ErrorCode.SUBSCRIPTION_NOT_FOUND);
    });
  });

  // v0.3 PR4 — batch subscribe partial-success contract
  describe("POST /subscriptions (batch partial success)", () => {
    it("mixed success/failure → HTTP 201 with failures[] populated", async () => {
      await bare.addCommitPush("commands/code_review.md", "v1", "init");
      await request(app, "POST", "/api/repos", { git_url: bare.url });
      const proj = await request<{ project: { id: number } }>(
        app,
        "POST",
        "/api/projects",
        { path: projectDir.path }
      );

      const res = await request<{
        subscriptions: unknown[];
        failures: Array<{ ref: string; code: string; message: string }>;
        sync_logs: unknown[];
      }>(app, "POST", `/api/projects/${proj.json.project.id}/subscriptions`, {
        skills: ["code_review", "does-not-exist"],
        sync_now: false
      });

      // 201 because at least one subscription was created.
      expect(res.status).toBe(201);
      expect(res.json.subscriptions).toHaveLength(1);
      expect(res.json.failures).toHaveLength(1);
      expect(res.json.failures[0]).toMatchObject({
        ref: "does-not-exist",
        code: ErrorCode.SKILL_NOT_FOUND
      });
    });

    it("all refs fail → HTTP 200 with subscriptions=[], failures has all", async () => {
      await request(app, "POST", "/api/projects", { path: projectDir.path });

      const res = await request<{
        subscriptions: unknown[];
        failures: Array<{ ref: string; code: string }>;
      }>(app, "POST", `/api/projects/1/subscriptions`, {
        skills: ["nope-1", "nope-2"],
        sync_now: false
      });

      // 200 — not a protocol error, just zero successful subs.
      expect(res.status).toBe(200);
      expect(res.json.subscriptions).toEqual([]);
      expect(res.json.failures).toHaveLength(2);
    });
  });

  describe("skill type enum sanity", () => {
    it("SkillType.Skill matches what the scanner returns", async () => {
      await bare.addCommitPush(
        "skills/office-hours/SKILL.md",
        "x",
        "init"
      );
      const reg = await request<{
        skills: Array<{ type: string }>;
      }>(app, "POST", "/api/repos", { git_url: bare.url });
      expect(reg.json.skills.some((s) => s.type === SkillType.Skill)).toBe(
        true
      );
    });
  });
});
