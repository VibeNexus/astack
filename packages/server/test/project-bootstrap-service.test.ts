/**
 * PR2 tests for ProjectBootstrapService.
 *
 * Covers v0.5 spec §PR2 scenario list (≥15 cases). Tests use real DB
 * (in-memory SQLite), real filesystem (tmp dirs), and real services.
 * Repos and skills are inserted directly into SQLite so we don't need
 * full git fixtures (the unit under test never reaches git).
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EventType,
  RepoKind,
  SkillType,
  type AstackEvent
} from "@astack/shared";

import { openDatabase, type Db } from "../src/db/connection.js";
import { RepoRepository } from "../src/db/repos.js";
import { SkillRepository } from "../src/db/skills.js";
import { EventBus, type EmittedEvent } from "../src/events.js";
import { LockManager, projectBootstrapLockKey } from "../src/lock.js";
import { nullLogger } from "../src/logger.js";
import {
  manifestPath,
  readManifest,
  writeManifest,
  type AstackManifest
} from "../src/manifest.js";
import { ProjectBootstrapService } from "../src/services/project-bootstrap.js";
import { ProjectService } from "../src/services/project.js";
import { SubscriptionService } from "../src/services/subscription.js";
import { SystemSkillService } from "../src/system-skills/service.js";

interface Ctx {
  db: Db;
  events: EventBus;
  emitted: EmittedEvent[];
  locks: LockManager;
  projects: ProjectService;
  subs: SubscriptionService;
  systemSkills: SystemSkillService;
  bootstrap: ProjectBootstrapService;
  projectDir: tmp.DirectoryResult;
  projectId: number;
}

async function makeCtx(
  overrides: { primaryTool?: string; preCreatePrimaryDir?: boolean } = {}
): Promise<Ctx> {
  const db = openDatabase({ path: ":memory:" });
  const events = new EventBus();
  const emitted: EmittedEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const locks = new LockManager({ timeoutMs: 5000 });

  const projects = new ProjectService({ db, events, logger: nullLogger() });
  const subs = new SubscriptionService({
    db,
    events,
    logger: nullLogger(),
    projects,
    serverUrl: "http://127.0.0.1:7432"
  });
  const systemSkills = new SystemSkillService({
    events,
    logger: nullLogger(),
    projects
  });
  const bootstrap = new ProjectBootstrapService({
    db,
    events,
    logger: nullLogger(),
    locks,
    projects,
    subscriptions: subs,
    systemSkills
  });

  const projectDir = await tmp.dir({ unsafeCleanup: true });
  const primaryTool = overrides.primaryTool ?? ".claude";
  if (overrides.preCreatePrimaryDir !== false) {
    fs.mkdirSync(path.join(projectDir.path, primaryTool), { recursive: true });
  }

  const project = projects.register({
    path: projectDir.path,
    primary_tool: primaryTool
  });

  // Wait for the SystemSkillService auto-seed (event subscriber) to finish
  // so any subsequent scan sees its writes.
  await flushPromises();

  return {
    db,
    events,
    emitted,
    locks,
    projects,
    subs,
    systemSkills,
    bootstrap,
    projectDir,
    projectId: project.id
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  ctx.db.close();
  await ctx.projectDir.cleanup();
}

async function flushPromises(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** Insert a fake repo + skill row directly via repositories. Returns ids. */
function insertRepoSkill(
  ctx: Ctx,
  args: { repoName: string; type: SkillType; name: string }
): { repoId: number; skillId: number } {
  const repoRepo = new RepoRepository(ctx.db);
  const skillRepo = new SkillRepository(ctx.db);

  // Avoid UNIQUE collision when called multiple times with same repoName.
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

/** Materialise a local skill dir under <projectDir>/.claude/skills/<name>/. */
function makeLocalSkillDir(ctx: Ctx, name: string, content = "# local\n"): void {
  const dir = path.join(ctx.projectDir.path, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

/** Materialise a local command file under <projectDir>/.claude/commands/<name>.md. */
function makeLocalCommandFile(ctx: Ctx, name: string, body = "# cmd\n"): void {
  const dir = path.join(ctx.projectDir.path, ".claude", "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

/** Materialise a local agent file under <projectDir>/.claude/agents/<name>.md. */
function makeLocalAgentFile(ctx: Ctx, name: string, body = "# agent\n"): void {
  const dir = path.join(ctx.projectDir.path, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

function bootstrapEvents(emitted: EmittedEvent[]): AstackEvent[] {
  return emitted
    .map((e) => e.event)
    .filter(
      (e) =>
        e.type === EventType.SubscriptionsBootstrapNeedsResolution ||
        e.type === EventType.SubscriptionsBootstrapResolved
    );
}

// ---------- Tests ----------

describe("ProjectBootstrapService — scan (pure)", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 1: empty .claude → all three buckets empty", async () => {
    ctx = await makeCtx();
    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.scanned_at).toMatch(/^\d{4}-/);
  });

  it("test 2: local abc + 1 repo provides abc → matched", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "abc"
    });
    makeLocalSkillDir(ctx, "abc");

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toMatchObject({
      type: SkillType.Skill,
      name: "abc",
      local_path: "skills/abc",
      repo: expect.objectContaining({ name: "repoA" })
    });
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("test 3: local abc + 2 repos → ambiguous with 2 candidates", async () => {
    ctx = await makeCtx();
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

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.candidates).toHaveLength(2);
    expect(
      result.ambiguous[0]!.candidates.map((c) => c.repo.name).sort()
    ).toEqual(["repoA", "repoB"]);
  });

  it("test 4: local foo + no repo provides foo → unmatched", async () => {
    ctx = await makeCtx();
    makeLocalSkillDir(ctx, "foo");

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]).toMatchObject({
      type: SkillType.Skill,
      name: "foo",
      local_path: "skills/foo"
    });
  });

  it("test 5 (P0 #1): local agent file + repo agent → matched (proves BOOTSTRAP_SCAN_CONFIG agents root)", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Agent,
      name: "myagent"
    });
    makeLocalAgentFile(ctx, "myagent");

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.type).toBe(SkillType.Agent);
    expect(result.matched[0]!.name).toBe("myagent");
  });

  it("test 6: already-subscribed skill is skipped from all buckets", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "abc"
    });
    makeLocalSkillDir(ctx, "abc");

    // First subscribe via SubscriptionService.
    ctx.subs.subscribe(ctx.projectId, "repoA/skill/abc");

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("test 7: ignored_local entry filters the matching local skill", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "abc"
    });
    makeLocalSkillDir(ctx, "abc");

    // Pre-seed manifest with an ignored entry for skill/abc.
    const seed: AstackManifest = {
      project_id: ctx.projectId,
      server_url: "http://127.0.0.1:7432",
      primary_tool: ".claude",
      linked_tools: [],
      subscriptions: [],
      ignored_local: [
        {
          type: SkillType.Skill,
          name: "abc",
          ignored_at: "2026-04-21T00:00:00Z"
        }
      ],
      last_synced: null
    };
    writeManifest(ctx.projectDir.path, seed, ".claude");

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("test 8: harness-init system-skill dir does not surface (systemSkillIds filter)", async () => {
    ctx = await makeCtx();
    // The auto-seed already wrote .claude/skills/harness-init/. A repo
    // also providing a 'harness-init' skill should still be filtered
    // out by scanRepo's blacklist.
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "harness-init"
    });

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(
      [...result.matched, ...result.ambiguous, ...result.unmatched].some(
        (e) => e.name === "harness-init"
      )
    ).toBe(false);
  });
});

describe("ProjectBootstrapService — scanAndAutoSubscribe", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 9: matched=1, ambiguous=0 → subscribe + Resolved event", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Command,
      name: "code_review"
    });
    makeLocalCommandFile(ctx, "code_review");
    ctx.emitted.length = 0;

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    expect(r.subscribed).toHaveLength(1);
    expect(r.failed).toHaveLength(0);
    expect(r.remaining_ambiguous).toEqual([]);

    const events = bootstrapEvents(ctx.emitted);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe(EventType.SubscriptionsBootstrapResolved);
    if (e.type === EventType.SubscriptionsBootstrapResolved) {
      expect(e.payload).toMatchObject({
        project_id: ctx.projectId,
        remaining_ambiguous_count: 0,
        subscribed_count: 1,
        ignored_count: 0
      });
    }
  });

  it("test 10: matched=1, ambiguous=1 → subscribe + NeedsResolution event with auto_subscribed_count=1", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Command,
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
    makeLocalCommandFile(ctx, "alpha");
    makeLocalSkillDir(ctx, "beta");
    ctx.emitted.length = 0;

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    expect(r.subscribed).toHaveLength(1);
    expect(r.subscribed[0]!.name).toBe("alpha");
    expect(r.remaining_ambiguous).toHaveLength(1);
    expect(r.remaining_ambiguous[0]!.name).toBe("beta");

    const events = bootstrapEvents(ctx.emitted);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe(EventType.SubscriptionsBootstrapNeedsResolution);
    if (e.type === EventType.SubscriptionsBootstrapNeedsResolution) {
      expect(e.payload).toMatchObject({
        ambiguous_count: 1,
        auto_subscribed_count: 1
      });
    }
  });

  it("test 11: matched=0 ambiguous=0 unmatched=0 → no event", async () => {
    ctx = await makeCtx();
    ctx.emitted.length = 0;

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    expect(r.subscribed).toEqual([]);
    expect(r.remaining_ambiguous).toEqual([]);

    const events = bootstrapEvents(ctx.emitted);
    expect(events).toEqual([]);
  });
});

describe("ProjectBootstrapService — applyResolutions / ignore", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 12: applyResolutions {repo_id: <valid>} → subscribe, remaining-1, Resolved emitted", async () => {
    ctx = await makeCtx();
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
    ctx.emitted.length = 0;

    const r = await ctx.bootstrap.applyResolutions(ctx.projectId, [
      { type: SkillType.Skill, name: "abc", repo_id: a.repoId }
    ]);
    expect(r.subscribed).toHaveLength(1);
    expect(r.ignored).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.remaining_ambiguous).toEqual([]);

    const events = bootstrapEvents(ctx.emitted);
    expect(events.some((e) => e.type === EventType.SubscriptionsBootstrapResolved)).toBe(true);
  });

  it("test 13: applyResolutions {repo_id: null} → ignored_local appended, manifest written", async () => {
    ctx = await makeCtx();
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

    const r = await ctx.bootstrap.applyResolutions(ctx.projectId, [
      { type: SkillType.Skill, name: "abc", repo_id: null }
    ]);
    expect(r.subscribed).toEqual([]);
    expect(r.ignored).toEqual([{ type: SkillType.Skill, name: "abc" }]);
    expect(r.remaining_ambiguous).toEqual([]);

    const m = readManifest(ctx.projectDir.path, ".claude");
    expect(m?.ignored_local).toHaveLength(1);
    expect(m?.ignored_local[0]).toMatchObject({
      type: SkillType.Skill,
      name: "abc"
    });
  });

  it("test 14 (P1 #7): applyResolutions with invalid repo_id → failed[REPO_NOT_FOUND], others succeed", async () => {
    ctx = await makeCtx();
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

    const r = await ctx.bootstrap.applyResolutions(ctx.projectId, [
      { type: SkillType.Skill, name: "alpha", repo_id: a.repoId },
      { type: SkillType.Skill, name: "beta", repo_id: 99999 }
    ]);
    expect(r.subscribed).toHaveLength(1);
    expect(r.subscribed[0]!.name).toBe("alpha");
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({
      name: "beta",
      code: "REPO_NOT_FOUND"
    });
    // Failed entry should remain in ambiguous so the drawer re-shows it.
    expect(r.remaining_ambiguous.map((a) => a.name).sort()).toEqual(["beta"]);
  });

  it("test 15: ignore() dedupes (type, name) against existing ignored_local", async () => {
    ctx = await makeCtx();
    // Pre-seed manifest with skill/abc already ignored.
    const seed: AstackManifest = {
      project_id: ctx.projectId,
      server_url: "http://127.0.0.1:7432",
      primary_tool: ".claude",
      linked_tools: [],
      subscriptions: [],
      ignored_local: [
        {
          type: SkillType.Skill,
          name: "abc",
          ignored_at: "2026-04-21T00:00:00Z"
        }
      ],
      last_synced: null
    };
    writeManifest(ctx.projectDir.path, seed, ".claude");

    await ctx.bootstrap.ignore(ctx.projectId, [
      { type: SkillType.Skill, name: "abc" },
      { type: SkillType.Skill, name: "xyz" }
    ]);

    const m = readManifest(ctx.projectDir.path, ".claude");
    // Only +1 net (abc was already there).
    expect(m?.ignored_local).toHaveLength(2);
    const names = m?.ignored_local.map((e) => e.name).sort() ?? [];
    expect(names).toEqual(["abc", "xyz"]);
  });
});

describe("ProjectBootstrapService — concurrency", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 16 (A8/A9): two concurrent scan() calls serialise and both succeed", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "abc"
    });
    makeLocalSkillDir(ctx, "abc");

    const [a, b] = await Promise.all([
      ctx.bootstrap.scan(ctx.projectId),
      ctx.bootstrap.scan(ctx.projectId)
    ]);
    // Both calls return the same matched-list shape — A9 (LockManager)
    // serialises them and A8 (inflight Map) avoids duplicating in-flight
    // work when two callers share the lock window. We don't assert
    // scanned_at equality because A9 releases between calls; we just
    // confirm neither call crashed and both saw consistent state.
    expect(a.matched).toHaveLength(1);
    expect(b.matched).toHaveLength(1);
    expect(a.matched[0]!.name).toBe("abc");
    expect(b.matched[0]!.name).toBe("abc");
  });

  it("test 17 (A9): bootstrap waits when sync holds projectBootstrapLockKey", async () => {
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "abc"
    });
    makeLocalSkillDir(ctx, "abc");

    // Manually grab the bootstrap lock to simulate sync holding it.
    const release = await ctx.locks.acquire(
      projectBootstrapLockKey(ctx.projectId)
    );

    let bootstrapResolved = false;
    const bootstrapP = ctx.bootstrap
      .scanAndAutoSubscribe(ctx.projectId)
      .then((r) => {
        bootstrapResolved = true;
        return r;
      });

    // Give it a tick — bootstrap should still be waiting.
    await new Promise((r) => setTimeout(r, 30));
    expect(bootstrapResolved).toBe(false);

    release();
    const r = await bootstrapP;
    expect(bootstrapResolved).toBe(true);
    expect(r.subscribed).toHaveLength(1);
  });
});

describe("ProjectBootstrapService — primary_tool != '.claude'", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 20: scan returns empty result when primary_tool != .claude", async () => {
    ctx = await makeCtx({ primaryTool: ".cursor", preCreatePrimaryDir: true });
    // Even with a .cursor/skills/abc dir, scan should short-circuit.
    fs.mkdirSync(
      path.join(ctx.projectDir.path, ".cursor", "skills", "abc"),
      { recursive: true }
    );
    fs.writeFileSync(
      path.join(ctx.projectDir.path, ".cursor", "skills", "abc", "SKILL.md"),
      "# x\n"
    );
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Skill,
      name: "abc"
    });

    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });
});

describe("ProjectBootstrapService — manifest path", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("listIgnored returns the manifest's ignored_local field", async () => {
    ctx = await makeCtx();
    expect(ctx.bootstrap.listIgnored(ctx.projectId)).toEqual([]);

    await ctx.bootstrap.ignore(ctx.projectId, [
      { type: SkillType.Skill, name: "x" }
    ]);

    const list = ctx.bootstrap.listIgnored(ctx.projectId);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("x");
    expect(fs.existsSync(manifestPath(ctx.projectDir.path, ".claude"))).toBe(
      true
    );
  });
});
