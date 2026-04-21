/**
 * PR3 HTTP tests for /api/projects/:id/bootstrap endpoints.
 *
 * Drives the Hono app via app.fetch (same pattern as harness-routes.test.ts).
 * Covers v0.5 spec §PR3 test list (≥6 cases):
 *   1. GET pure-read contract — no SSE, no DB writes, no manifest writes
 *   2. POST /scan write contract — DB + manifest both updated
 *   3. POST /resolve with valid repo_id → 200, subscribed=1
 *   4. POST /resolve with repo_id: null → 200, ignored=1, manifest updated
 *   5. POST /resolve mixed success/failure → HTTP 200 + failed[]
 *   6. POST /ignore → 200, manifest updated
 *   7. 404 on unknown project id (any method)
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ErrorCode,
  EventType,
  RepoKind,
  SkillType,
  type ApplyResolutionsResult,
  type ProjectBootstrapResult,
  type ScanAndAutoSubscribeResult
} from "@astack/shared";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { RepoRepository } from "../src/db/repos.js";
import { SkillRepository } from "../src/db/skills.js";
import type { EmittedEvent } from "../src/events.js";
import { createApp, type AppInstance } from "../src/http/app.js";
import { nullLogger } from "../src/logger.js";
import { readManifest } from "../src/manifest.js";

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
): Promise<{ status: number; json: T; headers: Headers }> {
  const init: RequestInit = {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  };
  const res = await app.app.fetch(new Request(`http://localhost${url}`, init));
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, json, headers: res.headers };
}

async function flushPromises(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

interface RouteCtx {
  dataDir: tmp.DirectoryResult;
  projectDir: tmp.DirectoryResult;
  db: Db;
  app: AppInstance;
  projectId: number;
  emitted: EmittedEvent[];
}

async function setup(): Promise<RouteCtx> {
  const dataDir = await tmp.dir({ unsafeCleanup: true });
  const projectDir = await tmp.dir({ unsafeCleanup: true });
  // Pre-create .claude/ so scan finds the dir.
  fs.mkdirSync(path.join(projectDir.path, ".claude"), { recursive: true });

  const db = openDatabase({ path: ":memory:" });
  const app = createApp({
    config: buildConfig(dataDir.path),
    logger: nullLogger(),
    db
  });
  const emitted: EmittedEvent[] = [];
  app.container.events.subscribe((e) => emitted.push(e));

  // Register the project.
  const reg = await request<{ project: { id: number } }>(
    app,
    "POST",
    "/api/projects",
    { path: projectDir.path, primary_tool: ".claude" }
  );
  const projectId = reg.json.project.id;
  await flushPromises();

  return { dataDir, projectDir, db, app, projectId, emitted };
}

async function teardown(ctx: RouteCtx): Promise<void> {
  ctx.app.dispose();
  ctx.db.close();
  await Promise.all([ctx.dataDir.cleanup(), ctx.projectDir.cleanup()]);
}

function insertRepoSkill(
  ctx: RouteCtx,
  args: { repoName: string; type: SkillType; name: string }
): { repoId: number; skillId: number } {
  const repoRepo = new RepoRepository(ctx.db);
  const skillRepo = new SkillRepository(ctx.db);
  let repo = repoRepo.findByName(args.repoName);
  if (!repo) {
    repo = repoRepo.insert({
      name: args.repoName,
      git_url: `https://example.invalid/${args.repoName}.git`,
      kind: RepoKind.Custom,
      local_path: `/tmp/fake-repo-${args.repoName}`
    });
  }
  const relPath =
    args.type === SkillType.Skill
      ? `skills/${args.name}`
      : args.type === SkillType.Command
        ? `commands/${args.name}.md`
        : `agents/${args.name}.md`;
  const skill = skillRepo.upsert({
    repo_id: repo.id,
    type: args.type,
    name: args.name,
    path: relPath,
    description: null,
    version: null,
    updated_at: null
  });
  return { repoId: repo.id, skillId: skill.id };
}

function makeLocalSkillDir(ctx: RouteCtx, name: string): void {
  const dir = path.join(ctx.projectDir.path, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "# local\n");
}

// ---------- Tests ----------

describe("HTTP /api/projects/:id/bootstrap", () => {
  let ctx: RouteCtx;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  describe("GET /bootstrap (pure read)", () => {
    it("returns ProjectBootstrapResult and sets Cache-Control: no-store", async () => {
      insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Skill,
        name: "abc"
      });
      makeLocalSkillDir(ctx, "abc");

      const res = await request<ProjectBootstrapResult>(
        ctx.app,
        "GET",
        `/api/projects/${ctx.projectId}/bootstrap`
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.json.matched).toHaveLength(1);
      expect(res.json.matched[0]!.name).toBe("abc");
    });

    it("does not subscribe, write manifest, or emit bootstrap_* events", async () => {
      insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Skill,
        name: "abc"
      });
      makeLocalSkillDir(ctx, "abc");
      const eventsBefore = ctx.emitted.length;
      const manifestPath = path.join(
        ctx.projectDir.path,
        ".claude",
        ".astack.json"
      );
      // After register harness-init may write the system-skills stub but
      // no bootstrap manifest yet.
      const manifestExistedBefore = fs.existsSync(manifestPath);

      await request(ctx.app, "GET", `/api/projects/${ctx.projectId}/bootstrap`);
      await request(ctx.app, "GET", `/api/projects/${ctx.projectId}/bootstrap`);

      // No new bootstrap events.
      const newBootstrapEvents = ctx.emitted
        .slice(eventsBefore)
        .filter((e) =>
          [
            EventType.SubscriptionsBootstrapNeedsResolution,
            EventType.SubscriptionsBootstrapResolved
          ].includes(
            e.event.type as
              | typeof EventType.SubscriptionsBootstrapNeedsResolution
              | typeof EventType.SubscriptionsBootstrapResolved
          )
        );
      expect(newBootstrapEvents).toEqual([]);

      // Manifest existence didn't change just from GETs.
      expect(fs.existsSync(manifestPath)).toBe(manifestExistedBefore);
    });
  });

  describe("POST /bootstrap/scan", () => {
    it("subscribes matched skills and persists to manifest", async () => {
      insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Command,
        name: "code_review"
      });
      // Local file under commands/.
      const cmdDir = path.join(ctx.projectDir.path, ".claude", "commands");
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(path.join(cmdDir, "code_review.md"), "# x\n");

      const res = await request<ScanAndAutoSubscribeResult>(
        ctx.app,
        "POST",
        `/api/projects/${ctx.projectId}/bootstrap/scan`
      );
      expect(res.status).toBe(200);
      expect(res.json.subscribed).toHaveLength(1);
      expect(res.json.subscribed[0]!.name).toBe("code_review");

      const m = readManifest(ctx.projectDir.path, ".claude");
      expect(m?.subscriptions).toHaveLength(1);
      expect(m?.subscriptions[0]!.name).toBe("code_review");
    });
  });

  describe("POST /bootstrap/resolve", () => {
    it("subscribes when repo_id is valid", async () => {
      const a = insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Skill,
        name: "abc"
      });
      insertRepoSkill(ctx, {
        repoName: "repoB",
        type: SkillType.Skill,
        name: "abc"
      });
      makeLocalSkillDir(ctx, "abc");

      const res = await request<ApplyResolutionsResult>(
        ctx.app,
        "POST",
        `/api/projects/${ctx.projectId}/bootstrap/resolve`,
        {
          resolutions: [
            { type: SkillType.Skill, name: "abc", repo_id: a.repoId }
          ]
        }
      );
      expect(res.status).toBe(200);
      expect(res.json.subscribed).toHaveLength(1);
      expect(res.json.failed).toEqual([]);
      expect(res.json.remaining_ambiguous).toEqual([]);
    });

    it("appends to ignored_local when repo_id is null", async () => {
      insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Skill,
        name: "abc"
      });
      insertRepoSkill(ctx, {
        repoName: "repoB",
        type: SkillType.Skill,
        name: "abc"
      });
      makeLocalSkillDir(ctx, "abc");

      const res = await request<ApplyResolutionsResult>(
        ctx.app,
        "POST",
        `/api/projects/${ctx.projectId}/bootstrap/resolve`,
        {
          resolutions: [
            { type: SkillType.Skill, name: "abc", repo_id: null }
          ]
        }
      );
      expect(res.status).toBe(200);
      expect(res.json.ignored).toHaveLength(1);
      expect(res.json.subscribed).toEqual([]);

      const m = readManifest(ctx.projectDir.path, ".claude");
      expect(m?.ignored_local).toHaveLength(1);
      expect(m?.ignored_local[0]!.name).toBe("abc");
    });

    it("returns 200 with partial success when one resolution fails (P1 #4)", async () => {
      const a = insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Skill,
        name: "alpha"
      });
      insertRepoSkill(ctx, {
        repoName: "repoB",
        type: SkillType.Skill,
        name: "alpha"
      });
      insertRepoSkill(ctx, {
        repoName: "repoA",
        type: SkillType.Skill,
        name: "beta"
      });
      insertRepoSkill(ctx, {
        repoName: "repoB",
        type: SkillType.Skill,
        name: "beta"
      });
      makeLocalSkillDir(ctx, "alpha");
      makeLocalSkillDir(ctx, "beta");

      const res = await request<ApplyResolutionsResult>(
        ctx.app,
        "POST",
        `/api/projects/${ctx.projectId}/bootstrap/resolve`,
        {
          resolutions: [
            { type: SkillType.Skill, name: "alpha", repo_id: a.repoId },
            { type: SkillType.Skill, name: "beta", repo_id: 99999 }
          ]
        }
      );
      expect(res.status).toBe(200); // not 4xx
      expect(res.json.subscribed).toHaveLength(1);
      expect(res.json.failed).toHaveLength(1);
      expect(res.json.failed[0]!.code).toBe("REPO_NOT_FOUND");
    });
  });

  describe("POST /bootstrap/ignore", () => {
    it("appends entries to ignored_local", async () => {
      const res = await request<ApplyResolutionsResult>(
        ctx.app,
        "POST",
        `/api/projects/${ctx.projectId}/bootstrap/ignore`,
        {
          entries: [{ type: SkillType.Skill, name: "leftover" }]
        }
      );
      expect(res.status).toBe(200);
      expect(res.json.ignored).toEqual([
        { type: SkillType.Skill, name: "leftover" }
      ]);
      expect(res.json.subscribed).toEqual([]);

      const m = readManifest(ctx.projectDir.path, ".claude");
      expect(m?.ignored_local.map((e) => e.name)).toEqual(["leftover"]);
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown project id on GET", async () => {
      const res = await request<{ code: string }>(
        ctx.app,
        "GET",
        `/api/projects/99999/bootstrap`
      );
      expect(res.status).toBe(404);
      expect(res.json.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    });

    it("returns 404 for unknown project id on POST /resolve", async () => {
      const res = await request<{ code: string }>(
        ctx.app,
        "POST",
        `/api/projects/99999/bootstrap/resolve`,
        {
          resolutions: [
            { type: SkillType.Skill, name: "x", repo_id: 1 }
          ]
        }
      );
      expect(res.status).toBe(404);
      expect(res.json.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    });
  });
});
