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
import { LocalSkillService } from "../src/services/local-skill.js";
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
  localSkills: LocalSkillService;
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
  // Mirror http/app.ts wiring: bootstrap constructed first with
  // late-bound getLocalSkillService, LocalSkillService constructed
  // second, then the ref is assigned so auto-adopt flows work in tests.
  let localSkillsRef: LocalSkillService | null = null;
  const bootstrap = new ProjectBootstrapService({
    db,
    events,
    logger: nullLogger(),
    locks,
    projects,
    subscriptions: subs,
    systemSkills,
    getLocalSkillService: () => localSkillsRef
  });
  const localSkills = new LocalSkillService({
    db,
    events,
    logger: nullLogger(),
    locks,
    projects,
    subscriptions: subs,
    getBootstrapService: () => bootstrap
  });
  localSkillsRef = localSkills;

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
    localSkills,
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

  it("test 8b (v0.7 A1): seeded harness-init never appears as `unmatched` even when no repo ships it", async () => {
    // Regression guard for the A1 rule: "Subscriptions UI must never
    // show system-level skills". The scanner blacklist covers the
    // polluted-repo case (test 8); this case covers the *natural* case
    // where the seed dir is the only on-disk evidence. Without the
    // blacklist, scanRepo would classify `.claude/skills/harness-init/`
    // as unmatched and the UI would invite the user to "register a
    // repo for this", which is wrong — it is an internal seed.
    ctx = await makeCtx();
    // No repo registration, no polluted skill insertion. Auto-seed
    // ran during makeCtx() because SystemSkillService subscribed to
    // project.registered, so .claude/skills/harness-init/ exists on disk.
    expect(
      fs.existsSync(
        path.join(ctx.projectDir.path, ".claude/skills/harness-init")
      )
    ).toBe(true);

    const result = await ctx.bootstrap.scan(ctx.projectId);

    // The seed dir is tangible but must be invisible to bootstrap.
    const allBuckets = [
      ...result.matched,
      ...result.ambiguous,
      ...result.unmatched
    ];
    expect(allBuckets.some((e) => e.name === "harness-init")).toBe(false);
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

// ---------- v0.7 PR4 regression tests ----------

describe("ProjectBootstrapService — v0.7 LocalSkill integration (PR4)", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("PR4 test 1: scanRaw filters out entries that are already adopted as LocalSkills", async () => {
    // Setup: a local command file with no repo match → would normally
    // appear in `unmatched`. Adopt it manually first, then scan again
    // and verify it disappears from all three buckets.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");

    // Pre-adopt manually (origin='adopted').
    const adoptResult = await ctx.localSkills.adopt(ctx.projectId, [
      { type: SkillType.Command, name: "dev" }
    ]);
    expect(adoptResult.succeeded).toHaveLength(1);
    expect(adoptResult.succeeded[0]!.origin).toBe("adopted");

    // Now scan: the adopted entry must not re-appear anywhere.
    const result = await ctx.bootstrap.scan(ctx.projectId);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("PR4 test 2: scanAndAutoSubscribe auto-adopts unmatched entries as origin='auto'", async () => {
    // Legacy-project flow: the project has private commands/skills not
    // tied to any registered repo. scanAndAutoSubscribe should
    // auto-adopt them as LocalSkills with origin='auto'.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");
    makeLocalCommandFile(ctx, "mr");
    makeLocalSkillDir(ctx, "iwiki");

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    // The unmatched list was populated by scanRaw BEFORE auto-adopt; we
    // just verify auto-adopt wrote LocalSkill rows for each.
    expect(r.subscribed).toHaveLength(0);

    const tracked = ctx.localSkills.list(ctx.projectId);
    const byKey = new Map(tracked.map((t) => [`${t.type}/${t.name}`, t]));
    expect(byKey.size).toBe(3);
    expect(byKey.get("command/dev")?.origin).toBe("auto");
    expect(byKey.get("command/mr")?.origin).toBe("auto");
    expect(byKey.get("skill/iwiki")?.origin).toBe("auto");
    // Status should be 'present' immediately after auto-adopt.
    for (const t of tracked) {
      expect(t.status).toBe("present");
    }
  });

  it("PR4 test 3: auto-adopt on second scan is idempotent (already-adopted entries re-filtered out of unmatched)", async () => {
    // Run scanAndAutoSubscribe twice. Second run must NOT re-adopt
    // (autoAdoptFromUnmatched skips rows already present in local_skills)
    // and must NOT churn last_seen_at in a way that breaks idempotency.
    //
    // v0.8 note: scanRaw now lets `origin='auto'` rows back into
    // unmatched/matched so repos registered AFTER an auto-adopt can
    // reclassify the row. Idempotency is preserved one layer in:
    // autoAdoptFromUnmatched filters entries that already exist in
    // local_skills, so second-call upserts are suppressed.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");

    await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    const first = ctx.localSkills.list(ctx.projectId);
    expect(first).toHaveLength(1);
    const firstRow = first[0]!;

    // Second call — scanRaw reports unmatched=[dev] again (since there is
    // still no matching repo), but autoAdoptFromUnmatched's existing-row
    // filter keeps the DB row untouched.
    await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    const second = ctx.localSkills.list(ctx.projectId);
    expect(second).toHaveLength(1);
    // Origin and id should be stable; last_seen_at only changes via
    // rescan or a fresh adopt call.
    expect(second[0]!.id).toBe(firstRow.id);
    expect(second[0]!.origin).toBe("auto");
    expect(second[0]!.last_seen_at).toBe(firstRow.last_seen_at);
  });

  it("PR4 test 4: scanAndAutoSubscribe still matches + subscribes legitimate repo matches alongside auto-adopting unmatched", async () => {
    // Mixed scenario: one local command maps to a registered repo
    // (matched → subscribe), two others don't (unmatched → auto-adopt).
    ctx = await makeCtx();
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Command,
      name: "code_review"
    });
    makeLocalCommandFile(ctx, "code_review");
    makeLocalCommandFile(ctx, "dev");
    makeLocalCommandFile(ctx, "mr");

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    expect(r.subscribed).toHaveLength(1);
    expect(r.subscribed[0]!.name).toBe("code_review");

    const tracked = ctx.localSkills.list(ctx.projectId);
    expect(tracked).toHaveLength(2);
    const names = tracked.map((t) => t.name).sort();
    expect(names).toEqual(["dev", "mr"]);
    for (const t of tracked) expect(t.origin).toBe("auto");
  });

  it("PR4 test 5: bootstrap without LocalSkillService wired (getLocalSkillService returns null) still runs subscribe path safely", async () => {
    // Construct a bootstrap service with NO getLocalSkillService —
    // simulating the v0.5 / v0.6 code path where LocalSkill does not
    // exist. Auto-adopt must silently skip without crashing.
    ctx = await makeCtx();
    const barebone = new ProjectBootstrapService({
      db: ctx.db,
      events: ctx.events,
      logger: nullLogger(),
      locks: ctx.locks,
      projects: ctx.projects,
      subscriptions: ctx.subs,
      systemSkills: ctx.systemSkills
      // Intentionally omit getLocalSkillService.
    });
    makeLocalCommandFile(ctx, "dev");

    // Should not throw.
    const r = await barebone.scanAndAutoSubscribe(ctx.projectId);
    expect(r.subscribed).toHaveLength(0);
    // And no LocalSkill rows should have been written via the barebone
    // service (LocalSkillService isn't wired to it).
    expect(ctx.localSkills.list(ctx.projectId)).toEqual([]);
  });

  it("PR4 test 6: bootstrap emits no event when matched=0 ambiguous=0 unmatched=3 (all auto-adopted)", async () => {
    // Per emitPostScanEvent: no Resolved event when only unmatched
    // existed pre-auto-adopt AND subscribeMatched was empty. Confirm
    // v0.7 auto-adopt doesn't accidentally trigger a Resolved event.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");
    makeLocalCommandFile(ctx, "mr");
    makeLocalCommandFile(ctx, "spec");
    ctx.emitted.length = 0;

    await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    const bootstrapEvts = bootstrapEvents(ctx.emitted);
    expect(bootstrapEvts).toHaveLength(0);

    // But LocalSkillsChanged WAS emitted (by LocalSkillService's
    // emitChanged inside autoAdoptFromUnmatched).
    const localChanged = ctx.emitted
      .map((e) => e.event)
      .filter((e) => e.type === EventType.LocalSkillsChanged);
    expect(localChanged).toHaveLength(1);
    if (localChanged[0]!.type === EventType.LocalSkillsChanged) {
      expect(localChanged[0]!.payload.summary.added).toBe(3);
    }
  });

  it("v0.8 test 7: auto-adopted row is reclassified + name_collision when matching repo registered later", async () => {
    // Reproduces the bug reported 2026-04-23: user registers a project
    // with local `.claude/commands/dev.md`, scanAndAutoSubscribe adopts
    // it as origin='auto'. User later registers a repo that provides
    // command/dev. A subsequent scanAndAutoSubscribe MUST:
    //   1. classify `dev` as `matched` (origin='auto' rows no longer
    //      short-circuit out of scanRaw)
    //   2. subscribe to repoA/command/dev
    //   3. flip the LocalSkill row to status='name_collision'
    //      (spec §A6, reverse order) — origin stays 'auto'.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");

    await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    const firstLocal = ctx.localSkills.list(ctx.projectId);
    expect(firstLocal).toHaveLength(1);
    expect(firstLocal[0]!.origin).toBe("auto");
    expect(firstLocal[0]!.status).toBe("present");

    // Simulate the user adding a repo that provides command/dev AFTER
    // the initial bootstrap.
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Command,
      name: "dev"
    });

    const r2 = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    expect(r2.subscribed).toHaveLength(1);
    expect(r2.subscribed[0]!.name).toBe("dev");

    // LocalSkill row is preserved and flipped to name_collision.
    const secondLocal = ctx.localSkills.list(ctx.projectId);
    expect(secondLocal).toHaveLength(1);
    expect(secondLocal[0]!.id).toBe(firstLocal[0]!.id);
    expect(secondLocal[0]!.origin).toBe("auto");
    expect(secondLocal[0]!.status).toBe("name_collision");
  });

  it("v0.8 test 8: origin='adopted' rows are NOT reclassified even if a repo later matches", async () => {
    // Contract inverse of test 7: users who explicitly adopted a skill
    // (origin='adopted') have signalled "this is mine, don't treat it
    // as a repo subscription candidate". Adding a matching repo later
    // must NOT auto-subscribe on their behalf.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");

    // User manually adopts `dev` (origin='adopted').
    const adopt = await ctx.localSkills.adopt(ctx.projectId, [
      { type: SkillType.Command, name: "dev" }
    ]);
    expect(adopt.succeeded).toHaveLength(1);
    expect(adopt.succeeded[0]!.origin).toBe("adopted");

    // Now a repo providing command/dev is registered.
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Command,
      name: "dev"
    });

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    // No subscribe happened — adopted rows short-circuit scanRaw.
    expect(r.subscribed).toHaveLength(0);

    const rows = ctx.localSkills.list(ctx.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("adopted");
    // Status stays 'present' — user owns this, no collision marker.
    expect(rows[0]!.status).toBe("present");
  });

  it("v0.8 test 7b: markNameCollisionUnderLock only flips auto-adopted matches, not every subscribed entry", async () => {
    // Guards the intersection algorithm in
    // scanAndAutoSubscribe: `autoAdoptedMatchKeys ∩ succeededKeys`.
    // Scenario — at second scan, two entries reach `matched`:
    //   - `command/dev` → had a pre-existing LocalSkill row with
    //     origin='auto' (auto-adopted before repoA existed). MUST flip
    //     to name_collision after subscribe succeeds.
    //   - `command/release` → no pre-existing LocalSkill row (repoB
    //     already exists at time of the second scan's first look; but
    //     since local file is only created here and we scan once, it
    //     goes straight to matched). MUST NOT produce a LocalSkill row
    //     and MUST NOT fabricate a name_collision flip.
    ctx = await makeCtx();
    makeLocalCommandFile(ctx, "dev");

    // Phase 1 — no repos yet, auto-adopt dev as origin='auto'.
    await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);
    const phase1 = ctx.localSkills.list(ctx.projectId);
    expect(phase1).toHaveLength(1);
    expect(phase1[0]!.name).toBe("dev");
    expect(phase1[0]!.origin).toBe("auto");
    expect(phase1[0]!.status).toBe("present");
    const devRowId = phase1[0]!.id;

    // Phase 2 — register both repos AND add a brand-new local file
    // `release.md`. The second scan sees both `dev` and `release` in
    // `matched`, but only `dev` is in the auto-adopted snapshot.
    insertRepoSkill(ctx, {
      repoName: "repoA",
      type: SkillType.Command,
      name: "dev"
    });
    insertRepoSkill(ctx, {
      repoName: "repoB",
      type: SkillType.Command,
      name: "release"
    });
    makeLocalCommandFile(ctx, "release");

    const r = await ctx.bootstrap.scanAndAutoSubscribe(ctx.projectId);

    // Both matched entries were subscribed.
    expect(r.subscribed).toHaveLength(2);
    const subscribedNames = r.subscribed.map((s) => s.name).sort();
    expect(subscribedNames).toEqual(["dev", "release"]);

    // Only the pre-existing auto-adopted row was flipped. `release`
    // must not have spawned a LocalSkill row (it hit the subscribe
    // path without ever sitting in `unmatched`).
    const phase2 = ctx.localSkills.list(ctx.projectId);
    expect(phase2).toHaveLength(1);
    const devRow = phase2[0]!;
    expect(devRow.id).toBe(devRowId);
    expect(devRow.name).toBe("dev");
    expect(devRow.origin).toBe("auto");
    expect(devRow.status).toBe("name_collision");
  });
});
