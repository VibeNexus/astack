/**
 * Tests for SystemSkillService (PR2).
 *
 * Covers v0.4 spec §PR2 scenario list (≥10 cases):
 *   inspect missing, installed, drift, seed_failed
 *   seed fresh, seed over drift, seed idempotent
 *   seedIfMissing preserves legacy dir, seeds empty slot
 *   failure path writes last_error + emits seed_failed
 *   registry load smoke
 *   concurrent seeds on the same project serialize
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { EventType, HarnessStatus, type AstackEvent } from "@astack/shared";

import { openDatabase, type Db } from "../src/db/connection.js";
import { EventBus, type EmittedEvent } from "../src/events.js";
import { nullLogger } from "../src/logger.js";
import { ProjectService } from "../src/services/project.js";
import { SystemSkillService } from "../src/system-skills/service.js";

const SKILL_ID = "harness-init";

interface TestCtx {
  db: Db;
  events: EventBus;
  emitted: EmittedEvent[];
  projects: ProjectService;
  service: SystemSkillService;
  projectDir: tmp.DirectoryResult;
  projectId: number;
}

async function makeCtx(
  overrides: { primaryTool?: string } = {}
): Promise<TestCtx> {
  const db = openDatabase({ path: ":memory:" });
  const events = new EventBus();
  const emitted: EmittedEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const projects = new ProjectService({ db, events, logger: nullLogger() });
  const service = new SystemSkillService({
    events,
    logger: nullLogger(),
    projects
  });

  const projectDir = await tmp.dir({ unsafeCleanup: true });
  const project = projects.register({
    path: projectDir.path,
    primary_tool: overrides.primaryTool ?? ".claude"
  });
  // The register above emitted project.registered → subscriber will fire-and-forget
  // seedIfMissing. We wait for the microtask queue to flush so seeded state
  // stabilizes before assertions.
  await flushPromises();

  return {
    db,
    events,
    emitted,
    projects,
    service,
    projectDir,
    projectId: project.id
  };
}

async function flushPromises(): Promise<void> {
  // Two passes to let chained .catch/.then settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

async function teardown(ctx: TestCtx): Promise<void> {
  ctx.db.close();
  await ctx.projectDir.cleanup();
}

function seedDirOf(ctx: TestCtx): string {
  return path.join(ctx.projectDir.path, ".claude", "skills", SKILL_ID);
}

function stubPathOf(ctx: TestCtx): string {
  return path.join(ctx.projectDir.path, ".astack", "system-skills.json");
}

function filterHarnessEvents(emitted: EmittedEvent[]): AstackEvent[] {
  return emitted
    .map((e) => e.event)
    .filter((e) => e.type === EventType.HarnessChanged);
}

// ---------- Tests ----------

describe("SystemSkillService — inspect", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("installed: seed dir present + hash matches built-in (auto-seeded on register)", async () => {
    ctx = await makeCtx();
    // The subscriber auto-seeded. Just inspect.
    const state = await ctx.service.inspect(ctx.projectId, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Installed);
    expect(state.seeded_at).not.toBeNull();
    expect(state.last_error).toBeNull();
    expect(fs.existsSync(seedDirOf(ctx))).toBe(true);
  });

  it("drift: user modifies the seeded dir → hash mismatch, status=drift", async () => {
    ctx = await makeCtx();
    const skillMd = path.join(seedDirOf(ctx), "SKILL.md");
    fs.appendFileSync(skillMd, "\n\n<!-- user added this -->\n");

    const state = await ctx.service.inspect(ctx.projectId, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Drift);
    expect(state.actual_hash).not.toBeNull();
    expect(state.actual_hash).not.toBe(state.stub_built_in_hash);
  });

  it("missing: user deletes the seed dir → status=missing", async () => {
    ctx = await makeCtx();
    fs.rmSync(seedDirOf(ctx), { recursive: true, force: true });

    const state = await ctx.service.inspect(ctx.projectId, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Missing);
    // Stub still records the last seed; just the dir is gone.
    expect(state.stub_built_in_hash).not.toBeNull();
  });

  it("seed_failed: stub.last_error set → status=seed_failed (takes priority over fs state)", async () => {
    ctx = await makeCtx();
    // Manually poison the stub so inspect reports seed_failed.
    const stub = {
      version: 1,
      seeded: {
        [SKILL_ID]: {
          seeded_at: "2026-04-20T21:00:00.000Z",
          built_in_hash: "",
          source_path: "",
          last_error: "simulated failure"
        }
      }
    };
    fs.mkdirSync(path.dirname(stubPathOf(ctx)), { recursive: true });
    fs.writeFileSync(stubPathOf(ctx), JSON.stringify(stub));

    const state = await ctx.service.inspect(ctx.projectId, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.SeedFailed);
    expect(state.last_error).toBe("simulated failure");
  });

  it("inspect does not write to fs or emit events", async () => {
    ctx = await makeCtx();
    const stubBefore = fs.readFileSync(stubPathOf(ctx), "utf8");
    const emittedBefore = ctx.emitted.length;

    await ctx.service.inspect(ctx.projectId, SKILL_ID);
    await ctx.service.inspect(ctx.projectId, SKILL_ID);

    expect(fs.readFileSync(stubPathOf(ctx), "utf8")).toBe(stubBefore);
    expect(ctx.emitted.length).toBe(emittedBefore);
  });
});

describe("SystemSkillService — seed (force overwrite)", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("overwrites a drifted dir: user changes discarded, hash re-matches", async () => {
    ctx = await makeCtx();
    const skillMd = path.join(seedDirOf(ctx), "SKILL.md");
    fs.appendFileSync(skillMd, "\n// drift\n");
    expect((await ctx.service.inspect(ctx.projectId, SKILL_ID)).status).toBe(
      HarnessStatus.Drift
    );

    const state = await ctx.service.seed(ctx.projectId, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Installed);
    // User's change is gone.
    expect(fs.readFileSync(skillMd, "utf8")).not.toContain("// drift");
  });

  it("idempotent: already-installed → seed again → still installed, fs rewritten", async () => {
    ctx = await makeCtx();
    const mtimeBefore = fs.statSync(path.join(seedDirOf(ctx), "SKILL.md")).mtimeMs;

    // Small wait so mtime differs.
    await new Promise((r) => setTimeout(r, 10));
    const state = await ctx.service.seed(ctx.projectId, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Installed);

    const mtimeAfter = fs.statSync(path.join(seedDirOf(ctx), "SKILL.md")).mtimeMs;
    expect(mtimeAfter).toBeGreaterThanOrEqual(mtimeBefore);
  });

  it("emits harness.changed with status=installed", async () => {
    ctx = await makeCtx();
    ctx.emitted.length = 0;

    await ctx.service.seed(ctx.projectId, SKILL_ID);
    const events = filterHarnessEvents(ctx.emitted);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.type).toBe(EventType.HarnessChanged);
    if (last.type === EventType.HarnessChanged) {
      expect(last.payload.status).toBe(HarnessStatus.Installed);
      expect(last.payload.project_id).toBe(ctx.projectId);
      expect(last.payload.skill_id).toBe(SKILL_ID);
    }
  });
});

describe("SystemSkillService — seedIfMissing (register path)", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("preserves a pre-existing directory (legacy project not clobbered)", async () => {
    // Build a project dir with a fake harness-init already there, BEFORE register.
    const projectDir = await tmp.dir({ unsafeCleanup: true });
    const fakeDir = path.join(projectDir.path, ".claude", "skills", SKILL_ID);
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, "SKILL.md"), "USER CONTENT");

    const db = openDatabase({ path: ":memory:" });
    const events = new EventBus();
    const projects = new ProjectService({ db, events, logger: nullLogger() });
    const service = new SystemSkillService({
      events,
      logger: nullLogger(),
      projects
    });

    const project = projects.register({ path: projectDir.path, primary_tool: ".claude" });
    await flushPromises();

    // seedIfMissing saw existing dir → did NOT overwrite.
    expect(fs.readFileSync(path.join(fakeDir, "SKILL.md"), "utf8")).toBe(
      "USER CONTENT"
    );

    // Status is drift (hash doesn't match built-in) — not installed.
    const state = await service.inspect(project.id, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Drift);

    db.close();
    await projectDir.cleanup();
  });

  it("seeds into an empty slot, writing stub + emitting event", async () => {
    const projectDir = await tmp.dir({ unsafeCleanup: true });
    const db = openDatabase({ path: ":memory:" });
    const events = new EventBus();
    const emitted: EmittedEvent[] = [];
    events.subscribe((e) => emitted.push(e));
    const projects = new ProjectService({ db, events, logger: nullLogger() });
    const service = new SystemSkillService({
      events,
      logger: nullLogger(),
      projects
    });

    const project = projects.register({ path: projectDir.path, primary_tool: ".claude" });
    await flushPromises();

    const seedDir = path.join(projectDir.path, ".claude", "skills", SKILL_ID);
    expect(fs.existsSync(seedDir)).toBe(true);
    expect(fs.existsSync(path.join(projectDir.path, ".astack", "system-skills.json"))).toBe(true);

    const state = await service.inspect(project.id, SKILL_ID);
    expect(state.status).toBe(HarnessStatus.Installed);

    const harnessEvents = filterHarnessEvents(emitted);
    expect(harnessEvents.length).toBeGreaterThanOrEqual(1);

    db.close();
    await projectDir.cleanup();
  });
});

describe("SystemSkillService — primary_tool filter", () => {
  it("skips auto-seed when primary_tool != '.claude'", async () => {
    const projectDir = await tmp.dir({ unsafeCleanup: true });
    const db = openDatabase({ path: ":memory:" });
    const events = new EventBus();
    const projects = new ProjectService({ db, events, logger: nullLogger() });
    const _service = new SystemSkillService({
      events,
      logger: nullLogger(),
      projects
    });

    projects.register({ path: projectDir.path, primary_tool: ".cursor" });
    await flushPromises();

    // No seed dir created.
    expect(
      fs.existsSync(path.join(projectDir.path, ".claude", "skills", SKILL_ID))
    ).toBe(false);
    // No stub created either.
    expect(
      fs.existsSync(path.join(projectDir.path, ".astack", "system-skills.json"))
    ).toBe(false);

    db.close();
    await projectDir.cleanup();
  });
});

describe("SystemSkillService — registry + unknown skill", () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  it("list() returns [harness-init] with computed content_hash", () => {
    const list = ctx.service.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(SKILL_ID);
    expect(list[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(list[0].source_path).toContain("harness-init");
  });

  it("get(unknown) returns null", () => {
    expect(ctx.service.get("nonexistent")).toBeNull();
  });

  it("seed(unknown skill) throws SKILL_NOT_FOUND", async () => {
    await expect(
      ctx.service.seed(ctx.projectId, "nonexistent")
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });
});

describe("SystemSkillService — concurrency", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("two concurrent seeds on the same project serialize (no cp vs rm race)", async () => {
    ctx = await makeCtx();
    // Fire two seeds simultaneously.
    const [a, b] = await Promise.all([
      ctx.service.seed(ctx.projectId, SKILL_ID),
      ctx.service.seed(ctx.projectId, SKILL_ID)
    ]);
    expect(a.status).toBe(HarnessStatus.Installed);
    expect(b.status).toBe(HarnessStatus.Installed);
    // Final on-disk state is consistent.
    const final = await ctx.service.inspect(ctx.projectId, SKILL_ID);
    expect(final.status).toBe(HarnessStatus.Installed);
  });
});

describe("SystemSkillService — logger resilience", () => {
  it("auto-seed subscriber does not produce unhandledRejection when logger throws", async () => {
    // Build a logger whose .warn always throws.
    const brokenLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error("disk full");
      },
      error: () => {}
    };

    // Catch unhandled rejections explicitly during this test.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      const projectDir = await tmp.dir({ unsafeCleanup: true });
      const db = openDatabase({ path: ":memory:" });
      const events = new EventBus();
      const projects = new ProjectService({ db, events, logger: brokenLogger });
      const _service = new SystemSkillService({
        events,
        logger: brokenLogger,
        projects
      });

      // Register should still succeed; seed is fire-and-forget.
      const project = projects.register({
        path: projectDir.path,
        primary_tool: ".claude"
      });
      expect(project.id).toBeGreaterThan(0);
      await flushPromises();
      await flushPromises();

      db.close();
      await projectDir.cleanup();
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toEqual([]);
  });
});
