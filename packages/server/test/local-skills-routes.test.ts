/**
 * PR3 HTTP tests for /api/projects/:id/local-skills endpoints (v0.7).
 *
 * Drives the real Hono app via app.fetch (same pattern as
 * bootstrap-routes.test.ts / harness-routes.test.ts). Covers spec §PR3
 * test list (≥5 cases):
 *   1. GET list — empty on fresh project
 *   2. POST adopt → 200 + succeeded; list reflects it
 *   3. POST adopt mixed → 200 with failed[] populated (partial success)
 *   4. POST unadopt delete_files=false → DB row gone, file survives
 *   5. POST rescan → 200 + items refreshed
 *   6. GET suggestions → returns unmatched minus adopted
 *   7. 404 on unknown project id
 *   8. POST adopt with malformed body → VALIDATION_FAILED (400)
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, describe, expect, it } from "vitest";

import {
  ErrorCode,
  EventType,
  SkillType,
  type ApplyLocalSkillsResult,
  type BootstrapUnmatched,
  type LocalSkill,
  type UnadoptLocalSkillsResult
} from "@astack/shared";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import type { EmittedEvent } from "../src/events.js";
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
  fs.mkdirSync(path.join(projectDir.path, ".claude"), { recursive: true });

  const db = openDatabase({ path: ":memory:" });
  const app = createApp({
    config: buildConfig(dataDir.path),
    logger: nullLogger(),
    db
  });
  const emitted: EmittedEvent[] = [];
  app.container.events.subscribe((e) => emitted.push(e));

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

function makeCommandFile(ctx: RouteCtx, name: string, body = "# cmd\n"): string {
  const dir = path.join(ctx.projectDir.path, ".claude", "commands");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${name}.md`);
  fs.writeFileSync(p, body);
  return p;
}

function makeSkillDir(ctx: RouteCtx, name: string): string {
  const dir = path.join(ctx.projectDir.path, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "# local\n");
  return dir;
}

// ---------- Tests ----------

describe("GET /api/projects/:id/local-skills", () => {
  let ctx: RouteCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 1: empty list for a fresh project", async () => {
    ctx = await setup();
    const res = await request<{ items: LocalSkill[] }>(
      ctx.app,
      "GET",
      `/api/projects/${ctx.projectId}/local-skills`
    );
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([]);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("test 7: 404 PROJECT_NOT_FOUND on unknown id", async () => {
    ctx = await setup();
    const res = await request<{ code: string }>(
      ctx.app,
      "GET",
      "/api/projects/9999/local-skills"
    );
    expect(res.status).toBe(404);
    expect(res.json.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
  });
});

describe("POST /api/projects/:id/local-skills/adopt", () => {
  let ctx: RouteCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 2: adopt happy path → 200 + list shows row", async () => {
    ctx = await setup();
    makeCommandFile(ctx, "dev");
    makeSkillDir(ctx, "iwiki");

    const res = await request<ApplyLocalSkillsResult>(
      ctx.app,
      "POST",
      `/api/projects/${ctx.projectId}/local-skills/adopt`,
      {
        entries: [
          { type: SkillType.Command, name: "dev" },
          { type: SkillType.Skill, name: "iwiki" }
        ]
      }
    );
    expect(res.status).toBe(200);
    expect(res.json.failed).toEqual([]);
    expect(res.json.succeeded).toHaveLength(2);
    const origins = res.json.succeeded.map((r) => r.origin);
    expect(origins).toEqual(["adopted", "adopted"]);

    // SSE fired
    const sseCount = ctx.emitted.filter(
      (e) => e.event.type === EventType.LocalSkillsChanged
    ).length;
    expect(sseCount).toBe(1);

    // GET reflects the new rows
    const list = await request<{ items: LocalSkill[] }>(
      ctx.app,
      "GET",
      `/api/projects/${ctx.projectId}/local-skills`
    );
    expect(list.json.items).toHaveLength(2);
  });

  it("test 3: partial success — one valid + one missing-on-disk → 200 with failed[] populated", async () => {
    ctx = await setup();
    makeCommandFile(ctx, "dev");

    const res = await request<ApplyLocalSkillsResult>(
      ctx.app,
      "POST",
      `/api/projects/${ctx.projectId}/local-skills/adopt`,
      {
        entries: [
          { type: SkillType.Command, name: "dev" },
          { type: SkillType.Command, name: "ghost" }
        ]
      }
    );
    expect(res.status).toBe(200);
    expect(res.json.succeeded).toHaveLength(1);
    expect(res.json.failed).toHaveLength(1);
    expect(res.json.failed[0]).toMatchObject({
      code: ErrorCode.LOCAL_SKILL_NOT_ON_DISK,
      name: "ghost"
    });
  });

  it("test 8: malformed body → 400 VALIDATION_FAILED", async () => {
    ctx = await setup();
    const res = await request<{ code: string }>(
      ctx.app,
      "POST",
      `/api/projects/${ctx.projectId}/local-skills/adopt`,
      { entries: [] } // min(1) violated
    );
    expect(res.status).toBe(400);
    expect(res.json.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

describe("POST /api/projects/:id/local-skills/unadopt + /rescan", () => {
  let ctx: RouteCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 4: unadopt default (delete_files omitted) → DB row gone, file survives", async () => {
    ctx = await setup();
    const file = makeCommandFile(ctx, "dev");
    await request(ctx.app, "POST", `/api/projects/${ctx.projectId}/local-skills/adopt`, {
      entries: [{ type: SkillType.Command, name: "dev" }]
    });

    const res = await request<UnadoptLocalSkillsResult>(
      ctx.app,
      "POST",
      `/api/projects/${ctx.projectId}/local-skills/unadopt`,
      { entries: [{ type: SkillType.Command, name: "dev" }] }
    );
    expect(res.status).toBe(200);
    expect(res.json.unadopted).toHaveLength(1);
    expect(res.json.files_deleted).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);

    const list = await request<{ items: LocalSkill[] }>(
      ctx.app,
      "GET",
      `/api/projects/${ctx.projectId}/local-skills`
    );
    expect(list.json.items).toEqual([]);
  });

  it("test 5: rescan returns refreshed view + emits SSE", async () => {
    ctx = await setup();
    makeCommandFile(ctx, "dev", "# v1\n");
    await request(ctx.app, "POST", `/api/projects/${ctx.projectId}/local-skills/adopt`, {
      entries: [{ type: SkillType.Command, name: "dev" }]
    });
    // Mutate content → rescan should flip status to 'modified'
    fs.writeFileSync(
      path.join(ctx.projectDir.path, ".claude", "commands", "dev.md"),
      "# v2 changed\n"
    );

    ctx.emitted.length = 0;
    const res = await request<{ items: LocalSkill[] }>(
      ctx.app,
      "POST",
      `/api/projects/${ctx.projectId}/local-skills/rescan`
    );
    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0]!.status).toBe("modified");

    const sseCount = ctx.emitted.filter(
      (e) => e.event.type === EventType.LocalSkillsChanged
    ).length;
    expect(sseCount).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/projects/:id/local-skills/suggestions", () => {
  let ctx: RouteCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 6: returns unmatched entries minus adopted", async () => {
    ctx = await setup();
    makeCommandFile(ctx, "dev");
    makeCommandFile(ctx, "review");
    // adopt only `dev`
    await request(ctx.app, "POST", `/api/projects/${ctx.projectId}/local-skills/adopt`, {
      entries: [{ type: SkillType.Command, name: "dev" }]
    });

    const res = await request<{ suggestions: BootstrapUnmatched[] }>(
      ctx.app,
      "GET",
      `/api/projects/${ctx.projectId}/local-skills/suggestions`
    );
    expect(res.status).toBe(200);
    const keys = res.json.suggestions.map((s) => `${s.type}/${s.name}`);
    expect(keys).toContain("command/review");
    expect(keys).not.toContain("command/dev");
  });
});
