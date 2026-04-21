/**
 * PR4 tests for ProjectBootstrapService event-driven auto-bootstrap.
 *
 * Covers v0.5 spec §PR4 test list:
 *   1. register returns 201 immediately (not blocked by bootstrap)
 *   2. SubscriptionsBootstrapNeedsResolution SSE fires after register
 *      when ambiguous > 0
 *   3. broken bootstrap does not produce unhandledRejection (logger
 *      resilience parallel of v0.4 §A4)
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, describe, expect, it } from "vitest";

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
import { LockManager } from "../src/lock.js";
import { nullLogger } from "../src/logger.js";
import { ProjectBootstrapService } from "../src/services/project-bootstrap.js";
import { ProjectService } from "../src/services/project.js";
import { SubscriptionService } from "../src/services/subscription.js";
import { SystemSkillService } from "../src/system-skills/service.js";

interface Ctx {
  db: Db;
  events: EventBus;
  emitted: EmittedEvent[];
  projects: ProjectService;
  bootstrap: ProjectBootstrapService;
  projectDir: tmp.DirectoryResult;
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

async function flushPromises(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

async function setupCtx(args: {
  primaryTool?: string;
  /** Pre-seed repo + skill so bootstrap has work to do. */
  preSeed?: (ctx: { db: Db; projectDir: tmp.DirectoryResult }) => void;
  loggerOverride?: ConstructorParameters<typeof ProjectBootstrapService>[0]["logger"];
}): Promise<Ctx> {
  const db = openDatabase({ path: ":memory:" });
  const events = new EventBus();
  const emitted: EmittedEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const locks = new LockManager({ timeoutMs: 5000 });

  const projects = new ProjectService({
    db,
    events,
    logger: nullLogger()
  });
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
    logger: args.loggerOverride ?? nullLogger(),
    locks,
    projects,
    subscriptions: subs,
    systemSkills
  });

  const projectDir = await tmp.dir({ unsafeCleanup: true });
  fs.mkdirSync(path.join(projectDir.path, args.primaryTool ?? ".claude"), {
    recursive: true
  });
  if (args.preSeed) args.preSeed({ db, projectDir });

  return {
    db,
    events,
    emitted,
    projects,
    bootstrap,
    projectDir
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  ctx.db.close();
  await ctx.projectDir.cleanup();
}

function insertRepoSkill(
  db: Db,
  args: { repoName: string; type: SkillType; name: string }
): void {
  const repoRepo = new RepoRepository(db);
  const skillRepo = new SkillRepository(db);
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
  skillRepo.upsert({
    repo_id: repo.id,
    type: args.type,
    name: args.name,
    path: relPath,
    description: null,
    version: null,
    updated_at: null
  });
}

function makeLocalSkillDir(projectDir: string, name: string): void {
  const dir = path.join(projectDir, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "# x\n");
}

// ---------- Tests ----------

describe("ProjectBootstrapService — event-driven auto-bootstrap (PR4)", () => {
  let ctx: Ctx;
  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it("test 1: register returns synchronously even though bootstrap runs async", async () => {
    ctx = await setupCtx({
      preSeed: ({ db, projectDir }) => {
        insertRepoSkill(db, {
          repoName: "repoA",
          type: SkillType.Skill,
          name: "abc"
        });
        makeLocalSkillDir(projectDir.path, "abc");
      }
    });

    const start = Date.now();
    const project = ctx.projects.register({
      path: ctx.projectDir.path,
      primary_tool: ".claude"
    });
    const elapsed = Date.now() - start;

    // register is synchronous; bootstrap is fire-and-forget. The call
    // should return well under any reasonable scan latency.
    expect(project.id).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);

    // Wait for the auto-bootstrap to complete and assert it actually ran.
    await flushPromises();
    const events = bootstrapEvents(ctx.emitted);
    // matched=1 ambiguous=0 → expect a Resolved event.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(
      events.some((e) => e.type === EventType.SubscriptionsBootstrapResolved)
    ).toBe(true);
  });

  it("test 2: NeedsResolution SSE fires when ambiguous > 0", async () => {
    ctx = await setupCtx({
      preSeed: ({ db, projectDir }) => {
        insertRepoSkill(db, {
          repoName: "repoA",
          type: SkillType.Skill,
          name: "abc"
        });
        insertRepoSkill(db, {
          repoName: "repoB",
          type: SkillType.Skill,
          name: "abc"
        });
        makeLocalSkillDir(projectDir.path, "abc");
      }
    });

    ctx.projects.register({
      path: ctx.projectDir.path,
      primary_tool: ".claude"
    });
    await flushPromises();

    const events = bootstrapEvents(ctx.emitted);
    expect(
      events.some(
        (e) => e.type === EventType.SubscriptionsBootstrapNeedsResolution
      )
    ).toBe(true);
  });

  it("test 3: bootstrap subscriber failure does not produce unhandledRejection", async () => {
    // Logger that throws on .warn — exercises both the inner safeLog (in
    // handleProjectRegistered) and the outer .catch's safeLog.
    const brokenLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error("disk full");
      },
      error: () => {}
    };

    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      ctx = await setupCtx({
        loggerOverride: brokenLogger,
        preSeed: ({ db, projectDir }) => {
          // Pre-seed enough to trigger bootstrap work.
          insertRepoSkill(db, {
            repoName: "repoA",
            type: SkillType.Skill,
            name: "abc"
          });
          makeLocalSkillDir(projectDir.path, "abc");
        }
      });

      ctx.projects.register({
        path: ctx.projectDir.path,
        primary_tool: ".claude"
      });
      await flushPromises();
      await flushPromises();
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toEqual([]);
  });

  it("test 4: skips bootstrap when primary_tool != '.claude'", async () => {
    ctx = await setupCtx({
      primaryTool: ".cursor",
      preSeed: ({ db }) => {
        insertRepoSkill(db, {
          repoName: "repoA",
          type: SkillType.Skill,
          name: "abc"
        });
      }
    });

    ctx.projects.register({
      path: ctx.projectDir.path,
      primary_tool: ".cursor"
    });
    await flushPromises();

    const events = bootstrapEvents(ctx.emitted);
    expect(events).toEqual([]);
  });
});
