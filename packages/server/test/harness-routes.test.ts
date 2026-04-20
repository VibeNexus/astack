/**
 * HTTP tests for /api/projects/:id/harness endpoints (PR3).
 *
 * Drives the Hono app directly via app.fetch() (same pattern as http.test.ts).
 * Covers:
 *   - GET returns ProjectHarnessState for each of the 4 statuses
 *   - POST install force-overwrites drift
 *   - GET is pure read (no SSE, no fs writes)
 *   - 404 for unknown project id
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, EventType, HarnessStatus } from "@astack/shared";

import type { ServerConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { createApp, type AppInstance } from "../src/http/app.js";
import type { EmittedEvent } from "../src/events.js";
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

describe("HTTP /api/projects/:id/harness", () => {
  let dataDir: tmp.DirectoryResult;
  let projectDir: tmp.DirectoryResult;
  let db: Db;
  let app: AppInstance;
  let projectId: number;
  let emitted: EmittedEvent[];

  beforeEach(async () => {
    dataDir = await tmp.dir({ unsafeCleanup: true });
    projectDir = await tmp.dir({ unsafeCleanup: true });
    db = openDatabase({ path: ":memory:" });
    app = createApp({
      config: buildConfig(dataDir.path),
      logger: nullLogger(),
      db
    });
    emitted = [];
    app.container.events.subscribe((e) => emitted.push(e));

    // Register — auto-seeds harness-init via event subscriber.
    const register = await request<{ project: { id: number } }>(
      app,
      "POST",
      "/api/projects",
      { path: projectDir.path, primary_tool: ".claude" }
    );
    projectId = register.json.project.id;
    await flushPromises();
  });

  afterEach(async () => {
    app.dispose();
    db.close();
    await Promise.all([dataDir.cleanup(), projectDir.cleanup()]);
  });

  describe("GET /api/projects/:id/harness", () => {
    it("returns status=installed for freshly-registered project", async () => {
      const res = await request<{ status: string; seeded_at: string | null }>(
        app,
        "GET",
        `/api/projects/${projectId}/harness`
      );
      expect(res.status).toBe(200);
      expect(res.json.status).toBe(HarnessStatus.Installed);
      expect(res.json.seeded_at).not.toBeNull();
    });

    it("returns status=drift when user modifies the seed dir", async () => {
      const skillMd = path.join(
        projectDir.path,
        ".claude",
        "skills",
        "harness-init",
        "SKILL.md"
      );
      fs.appendFileSync(skillMd, "\n// user edit\n");

      const res = await request<{ status: string; actual_hash: string }>(
        app,
        "GET",
        `/api/projects/${projectId}/harness`
      );
      expect(res.status).toBe(200);
      expect(res.json.status).toBe(HarnessStatus.Drift);
      expect(res.json.actual_hash).not.toBeNull();
    });

    it("returns status=missing when seed dir is deleted", async () => {
      const seedDir = path.join(
        projectDir.path,
        ".claude",
        "skills",
        "harness-init"
      );
      fs.rmSync(seedDir, { recursive: true, force: true });

      const res = await request<{ status: string }>(
        app,
        "GET",
        `/api/projects/${projectId}/harness`
      );
      expect(res.status).toBe(200);
      expect(res.json.status).toBe(HarnessStatus.Missing);
    });

    it("sets Cache-Control: no-store", async () => {
      const res = await request(
        app,
        "GET",
        `/api/projects/${projectId}/harness`
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("is a pure read: no fs mutation, no SSE emission", async () => {
      const stubPath = path.join(
        projectDir.path,
        ".astack",
        "system-skills.json"
      );
      const stubBefore = fs.readFileSync(stubPath, "utf8");
      const harnessEventsBefore = emitted.filter(
        (e) => e.event.type === EventType.HarnessChanged
      ).length;

      await request(app, "GET", `/api/projects/${projectId}/harness`);
      await request(app, "GET", `/api/projects/${projectId}/harness`);

      expect(fs.readFileSync(stubPath, "utf8")).toBe(stubBefore);
      const harnessEventsAfter = emitted.filter(
        (e) => e.event.type === EventType.HarnessChanged
      ).length;
      expect(harnessEventsAfter).toBe(harnessEventsBefore);
    });

    it("returns 404 for unknown project id", async () => {
      const res = await request<{ code: string }>(
        app,
        "GET",
        `/api/projects/99999/harness`
      );
      expect(res.status).toBe(404);
      expect(res.json.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    });
  });

  describe("POST /api/projects/:id/harness/install", () => {
    it("overwrites drift and returns installed state", async () => {
      const skillMd = path.join(
        projectDir.path,
        ".claude",
        "skills",
        "harness-init",
        "SKILL.md"
      );
      fs.appendFileSync(skillMd, "\n// drift\n");

      const res = await request<{ status: string }>(
        app,
        "POST",
        `/api/projects/${projectId}/harness/install`
      );
      expect(res.status).toBe(200);
      expect(res.json.status).toBe(HarnessStatus.Installed);
      expect(fs.readFileSync(skillMd, "utf8")).not.toContain("// drift");
    });

    it("emits harness.changed event", async () => {
      emitted.length = 0;

      await request(app, "POST", `/api/projects/${projectId}/harness/install`);

      const harnessEvents = emitted.filter(
        (e) => e.event.type === EventType.HarnessChanged
      );
      expect(harnessEvents.length).toBeGreaterThanOrEqual(1);
      const last = harnessEvents[harnessEvents.length - 1].event;
      if (last.type === EventType.HarnessChanged) {
        expect(last.payload.status).toBe(HarnessStatus.Installed);
        expect(last.payload.project_id).toBe(projectId);
      }
    });

    it("returns 404 for unknown project id", async () => {
      const res = await request<{ code: string }>(
        app,
        "POST",
        `/api/projects/99999/harness/install`
      );
      expect(res.status).toBe(404);
      expect(res.json.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    });
  });
});
