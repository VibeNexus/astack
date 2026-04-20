/**
 * /api/projects/:id/sync-logs tests (v0.3 PR2).
 *
 * Exercises the new history feed endpoint end-to-end via app.fetch so we
 * catch zod validation, the Repository SQL, and the content_hash stripping
 * in one pass. Seeds sync_logs directly via SQL to keep tests fast and
 * deterministic (we don't want to drive real pull/push just to produce
 * log rows).
 */

import path from "node:path";

import type {
  ListSyncLogsResponse,
  SkillType,
  SyncDirection,
  SyncStatus
} from "@astack/shared";
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

/**
 * Seed repos/projects/skills/sync_logs straight into the DB. Bypasses
 * service layer validation because we're testing the read path, not
 * registration flows.
 */
function seed(
  db: Db,
  opts: {
    project_path: string;
    repo_name?: string;
    skills: Array<{ name: string; type?: SkillType }>;
    logs: Array<{
      project_id: number;
      skill_id: number;
      direction: SyncDirection;
      status: SyncStatus;
      synced_at?: string;
      from_version?: string | null;
      to_version?: string | null;
      content_hash?: string | null;
    }>;
  }
): { projectId: number; skillIds: number[] } {
  // Repo
  db.prepare<[string, string]>(
    `INSERT INTO skill_repos (name, git_url, kind, status)
     VALUES (?, ?, 'custom', 'ready')`
  ).run(opts.repo_name ?? "test-repo", "git@example.com:test/repo.git");
  const repoRow = db
    .prepare<[], { id: number }>(`SELECT last_insert_rowid() AS id`)
    .get();
  const repoId = repoRow!.id;

  // Project
  db.prepare<[string, string]>(
    `INSERT INTO projects (name, path, primary_tool)
     VALUES (?, ?, '.claude')`
  ).run(path.basename(opts.project_path), opts.project_path);
  const projRow = db
    .prepare<[], { id: number }>(`SELECT last_insert_rowid() AS id`)
    .get();
  const projectId = projRow!.id;

  // Skills
  const skillIds: number[] = [];
  for (const s of opts.skills) {
    db.prepare<[number, string, string, string]>(
      `INSERT INTO skills (repo_id, type, name, path, version)
       VALUES (?, ?, ?, ?, 'abc1234')`
    ).run(
      repoId,
      s.type ?? "skill",
      s.name,
      `skills/${s.name}/SKILL.md`
    );
    const row = db
      .prepare<[], { id: number }>(`SELECT last_insert_rowid() AS id`)
      .get();
    skillIds.push(row!.id);
  }

  // Sync logs
  for (const log of opts.logs) {
    db.prepare<
      [number, number, SyncDirection, string | null, string | null, SyncStatus, string | null, string | null, string]
    >(
      `INSERT INTO sync_logs
         (project_id, skill_id, direction, from_version, to_version,
          status, conflict_detail, content_hash, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.project_id,
      log.skill_id,
      log.direction,
      log.from_version ?? null,
      log.to_version ?? null,
      log.status,
      null,
      log.content_hash ?? null,
      log.synced_at ?? new Date().toISOString()
    );
  }

  return { projectId, skillIds };
}

describe("GET /api/projects/:id/sync-logs", () => {
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
  });

  afterEach(async () => {
    app.dispose();
    await dataDir.cleanup();
    await workdir.cleanup();
  });

  it("404s for a project that does not exist", async () => {
    const { status, json } = await getJson<{ code: string }>(
      app,
      "/api/projects/9999/sync-logs"
    );
    expect(status).toBe(404);
    expect(json.code).toBe("PROJECT_NOT_FOUND");
  });

  it("returns empty list + has_more=false for a project with no logs", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "office-hours" }],
      logs: []
    });
    const { status, json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs`
    );
    expect(status).toBe(200);
    expect(json.logs).toEqual([]);
    expect(json.total).toBe(0);
    expect(json.has_more).toBe(false);
  });

  it("returns logs newest-first", async () => {
    const { projectId, skillIds } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "office-hours" }],
      logs: [
        {
          project_id: 0, // rewritten below
          skill_id: 0,
          direction: "pull",
          status: "success",
          synced_at: "2026-04-15T10:00:00.000Z"
        },
        {
          project_id: 0,
          skill_id: 0,
          direction: "pull",
          status: "success",
          synced_at: "2026-04-20T10:00:00.000Z"
        },
        {
          project_id: 0,
          skill_id: 0,
          direction: "push",
          status: "conflict",
          synced_at: "2026-04-18T10:00:00.000Z"
        }
      ].map((l) => ({ ...l, project_id: 1, skill_id: 1 }))
    });
    // Rewrite IDs post-seed since we don't know them until seed runs.
    // Seed above gives project_id=1, skill_id=1 because it's a fresh DB.
    expect(projectId).toBe(1);
    expect(skillIds).toEqual([1]);

    const { json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs`
    );
    expect(json.total).toBe(3);
    expect(json.logs.map((l) => l.synced_at)).toEqual([
      "2026-04-20T10:00:00.000Z",
      "2026-04-18T10:00:00.000Z",
      "2026-04-15T10:00:00.000Z"
    ]);
  });

  it("strips internal content_hash field before sending to clients", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "office-hours" }],
      logs: [
        {
          project_id: 1,
          skill_id: 1,
          direction: "pull",
          status: "success",
          content_hash: "deadbeef"
        }
      ]
    });
    const { json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs`
    );
    expect(json.logs).toHaveLength(1);
    expect(
      (json.logs[0] as unknown as { content_hash?: string }).content_hash
    ).toBeUndefined();
  });

  it("filters by skill_id", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "a" }, { name: "b" }],
      logs: [
        { project_id: 1, skill_id: 1, direction: "pull", status: "success" },
        { project_id: 1, skill_id: 2, direction: "pull", status: "success" },
        { project_id: 1, skill_id: 2, direction: "push", status: "success" }
      ]
    });
    const { json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?skill_id=2`
    );
    expect(json.total).toBe(2);
    expect(json.logs.every((l) => l.skill_id === 2)).toBe(true);
  });

  it("filters by direction", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "a" }],
      logs: [
        { project_id: 1, skill_id: 1, direction: "pull", status: "success" },
        { project_id: 1, skill_id: 1, direction: "push", status: "success" },
        { project_id: 1, skill_id: 1, direction: "push", status: "conflict" }
      ]
    });
    const { json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?direction=push`
    );
    expect(json.total).toBe(2);
    expect(json.logs.every((l) => l.direction === "push")).toBe(true);
  });

  it("filters by status", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "a" }],
      logs: [
        { project_id: 1, skill_id: 1, direction: "pull", status: "success" },
        { project_id: 1, skill_id: 1, direction: "pull", status: "conflict" },
        { project_id: 1, skill_id: 1, direction: "push", status: "error" }
      ]
    });
    const { json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?status=conflict`
    );
    expect(json.total).toBe(1);
    expect(json.logs[0]?.status).toBe("conflict");
  });

  it("respects limit + offset pagination and reports has_more", async () => {
    const logs = Array.from({ length: 7 }, (_, i) => ({
      project_id: 1,
      skill_id: 1,
      direction: "pull" as const,
      status: "success" as const,
      // 7 logs, newest first index 0 when listing
      synced_at: new Date(Date.now() - i * 60_000).toISOString()
    }));
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "a" }],
      logs
    });

    const page1 = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?limit=3&offset=0`
    );
    expect(page1.json.total).toBe(7);
    expect(page1.json.logs).toHaveLength(3);
    expect(page1.json.has_more).toBe(true);

    const page2 = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?limit=3&offset=3`
    );
    expect(page2.json.logs).toHaveLength(3);
    expect(page2.json.has_more).toBe(true);

    const page3 = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?limit=3&offset=6`
    );
    expect(page3.json.logs).toHaveLength(1);
    expect(page3.json.has_more).toBe(false);
  });

  it("rejects limit > 200 with 400 validation error", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "a" }],
      logs: []
    });
    const { status } = await getJson<unknown>(
      app,
      `/api/projects/${projectId}/sync-logs?limit=201`
    );
    expect(status).toBe(400);
  });

  it("combines multiple filters (skill_id + direction)", async () => {
    const { projectId } = seed(db, {
      project_path: workdir.path,
      skills: [{ name: "a" }, { name: "b" }],
      logs: [
        { project_id: 1, skill_id: 1, direction: "pull", status: "success" },
        { project_id: 1, skill_id: 1, direction: "push", status: "success" },
        { project_id: 1, skill_id: 2, direction: "pull", status: "success" },
        { project_id: 1, skill_id: 2, direction: "push", status: "success" }
      ]
    });
    const { json } = await getJson<ListSyncLogsResponse>(
      app,
      `/api/projects/${projectId}/sync-logs?skill_id=2&direction=push`
    );
    expect(json.total).toBe(1);
    expect(json.logs[0]?.skill_id).toBe(2);
    expect(json.logs[0]?.direction).toBe("push");
  });
});
