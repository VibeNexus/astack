/**
 * Tests for GitignoreGuardService.
 *
 * Covers:
 *   1. New project with no .gitignore → file is created with both entries
 *   2. Existing .gitignore without the entries → entries are appended,
 *      user's prior lines are preserved verbatim
 *   3. Existing .gitignore that already mentions one entry (with trailing
 *      slash toggle) → only the missing entry is appended (idempotency)
 *   4. Subsequent register after success → no-op (no rewrite)
 *   5. Handler never throws into the event bus (broken filesystem parent
 *      dir is swallowed, register stays 201-equivalent)
 *   6. entryAlreadyIgnored handles negations + root-anchored + comments
 */

import fs from "node:fs";
import path from "node:path";

import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventType } from "@astack/shared";

import { openDatabase, type Db } from "../src/db/connection.js";
import { EventBus } from "../src/events.js";
import { nullLogger } from "../src/logger.js";
import {
  ASTACK_GITIGNORE_ENTRIES,
  GitignoreGuardService,
  entryAlreadyIgnored
} from "../src/services/gitignore-guard.js";
import { ProjectService } from "../src/services/project.js";

interface Ctx {
  db: Db;
  events: EventBus;
  projects: ProjectService;
  guard: GitignoreGuardService;
  projectDir: tmp.DirectoryResult;
}

async function setupCtx(): Promise<Ctx> {
  const db = openDatabase({ path: ":memory:" });
  const events = new EventBus();
  const projects = new ProjectService({
    db,
    events,
    logger: nullLogger()
  });
  const guard = new GitignoreGuardService({
    events,
    logger: nullLogger()
  });
  const projectDir = await tmp.dir({ unsafeCleanup: true });
  return { db, events, projects, guard, projectDir };
}

async function teardown(ctx: Ctx | undefined): Promise<void> {
  if (!ctx) return;
  ctx.db.close();
  await ctx.projectDir.cleanup();
}

function readGitignore(projectPath: string): string | null {
  const p = path.join(projectPath, ".gitignore");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

describe("GitignoreGuardService", () => {
  let ctx: Ctx | undefined;

  beforeEach(() => {
    ctx = undefined;
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it("creates .gitignore with both astack entries when project had none", async () => {
    ctx = await setupCtx();
    ctx.projects.register({ path: ctx.projectDir.path });

    const contents = readGitignore(ctx.projectDir.path);
    expect(contents).not.toBeNull();
    for (const entry of ASTACK_GITIGNORE_ENTRIES) {
      expect(contents!).toContain(entry);
    }
    // Trailing newline convention preserved.
    expect(contents!.endsWith("\n")).toBe(true);
  });

  it("appends to an existing .gitignore without corrupting prior lines", async () => {
    ctx = await setupCtx();
    const existing = "node_modules/\ndist/\n.env\n";
    fs.writeFileSync(
      path.join(ctx.projectDir.path, ".gitignore"),
      existing,
      "utf8"
    );

    ctx.projects.register({ path: ctx.projectDir.path });

    const contents = readGitignore(ctx.projectDir.path)!;
    // Prior lines survive verbatim at the top.
    expect(contents.startsWith(existing)).toBe(true);
    // New entries appended after the user's content.
    for (const entry of ASTACK_GITIGNORE_ENTRIES) {
      expect(contents).toContain(entry);
    }
  });

  it("is idempotent when one entry is already present (trailing-slash toggled)", async () => {
    ctx = await setupCtx();
    // User wrote `.astack` without trailing slash — treat as covered.
    const existing = "node_modules/\n.astack\n";
    fs.writeFileSync(
      path.join(ctx.projectDir.path, ".gitignore"),
      existing,
      "utf8"
    );

    ctx.projects.register({ path: ctx.projectDir.path });

    const contents = readGitignore(ctx.projectDir.path)!;
    // Should not introduce a duplicate `.astack/` line — the `.astack`
    // variant already covers it. Only `.astack.json` needs appending.
    const astackDirMatches = contents.match(/^\.astack\/?$/gm) ?? [];
    expect(astackDirMatches.length).toBe(1);
    expect(contents).toContain(".astack.json");
  });

  it("does not rewrite .gitignore when it already contains both entries", async () => {
    ctx = await setupCtx();
    const gitignorePath = path.join(ctx.projectDir.path, ".gitignore");
    const existing = "# user block\nnode_modules/\n.astack/\n.astack.json\n";
    fs.writeFileSync(gitignorePath, existing, "utf8");
    const mtimeBefore = fs.statSync(gitignorePath).mtimeMs;

    // Register a project — should be a no-op on the file.
    // (Sleep a microtask so mtime comparison is meaningful on fast FSes.)
    ctx.projects.register({ path: ctx.projectDir.path });

    const contents = readGitignore(ctx.projectDir.path)!;
    expect(contents).toBe(existing);
    const mtimeAfter = fs.statSync(gitignorePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("never produces an unhandledRejection even if .gitignore write is impossible", async () => {
    // Simulate a failure path: make the project path itself a file, not
    // a directory, so any write into it fails. (ProjectService.register
    // checks existsSync but not isDirectory, so this is reachable.)
    ctx = await setupCtx();
    const fakeFile = path.join(ctx.projectDir.path, "looks_like_a_project");
    fs.writeFileSync(fakeFile, "not a dir", "utf8");

    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      expect(() => {
        ctx!.projects.register({ path: fakeFile });
      }).not.toThrow();
      // Flush microtasks just in case (subscriber is sync here, but
      // defence-in-depth).
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", handler);
    }
    expect(unhandled).toEqual([]);
  });

  it("ensureProjectGitignore is callable directly (not only via event)", async () => {
    ctx = await setupCtx();
    const result = ctx.guard.ensureProjectGitignore(ctx.projectDir.path);
    expect(result.existed_before).toBe(false);
    expect(result.added.sort()).toEqual([...ASTACK_GITIGNORE_ENTRIES].sort());
    // Re-run: no additions.
    const second = ctx.guard.ensureProjectGitignore(ctx.projectDir.path);
    expect(second.added).toEqual([]);
  });

  it("bootstraps only once per registration event", async () => {
    ctx = await setupCtx();
    ctx.projects.register({ path: ctx.projectDir.path });
    const firstContents = readGitignore(ctx.projectDir.path)!;

    // Emit an unrelated event — should not re-trigger.
    ctx.events.emit({
      type: EventType.ProjectRemoved,
      payload: { project_id: 9999 }
    });
    const secondContents = readGitignore(ctx.projectDir.path)!;
    expect(secondContents).toBe(firstContents);
  });

  describe("entryAlreadyIgnored", () => {
    it("treats comments and negations as not covering", () => {
      const lines = ["# .astack/ used to be here", "!.astack/keep.txt"];
      expect(entryAlreadyIgnored(lines, ".astack/")).toBe(false);
      expect(entryAlreadyIgnored(lines, ".astack.json")).toBe(false);
    });

    it("recognizes root-anchored + slash-toggled variants", () => {
      expect(entryAlreadyIgnored(["/.astack/"], ".astack/")).toBe(true);
      expect(entryAlreadyIgnored(["/.astack"], ".astack/")).toBe(true);
      expect(entryAlreadyIgnored([".astack"], ".astack/")).toBe(true);
      expect(entryAlreadyIgnored([".astack/"], ".astack")).toBe(true);
      expect(entryAlreadyIgnored(["/.astack.json"], ".astack.json")).toBe(
        true
      );
    });

    it("returns false for unrelated lines", () => {
      expect(entryAlreadyIgnored(["node_modules/", "dist/"], ".astack/")).toBe(
        false
      );
    });

    it("ignores whitespace-only and blank lines", () => {
      expect(entryAlreadyIgnored(["   ", "", ".astack/"], ".astack/")).toBe(
        true
      );
    });
  });

  // ------------------------------------------------------------------
  // Backfill — daemon-boot catch-up for projects registered before the
  // GitignoreGuardService subscriber existed. Takes a curated list
  // (typically ProjectService.list().projects) and runs
  // ensureProjectGitignore for each, tallying outcomes without ever
  // throwing.
  // ------------------------------------------------------------------
  describe("backfillExisting", () => {
    it("returns zero counts for an empty project list", async () => {
      ctx = await setupCtx();
      const summary = ctx.guard.backfillExisting([]);
      expect(summary).toEqual({ updated: 0, unchanged: 0, failed: 0 });
    });

    it("tallies updated vs unchanged vs failed across a mixed batch", async () => {
      ctx = await setupCtx();

      // Project A — no .gitignore yet → will be "updated".
      const aDir = await tmp.dir({ unsafeCleanup: true });

      // Project B — both entries already present → will be "unchanged".
      const bDir = await tmp.dir({ unsafeCleanup: true });
      fs.writeFileSync(
        path.join(bDir.path, ".gitignore"),
        "node_modules/\n.astack/\n.astack.json\n",
        "utf8"
      );

      // Project C — path points at a regular file, so mkdirSync in the
      // atomic write will throw (ENOTDIR) → will be "failed".
      const cHost = await tmp.dir({ unsafeCleanup: true });
      const cFile = path.join(cHost.path, "not_a_directory");
      fs.writeFileSync(cFile, "oops", "utf8");

      try {
        const summary = ctx.guard.backfillExisting([
          { id: 1, path: aDir.path },
          { id: 2, path: bDir.path },
          { id: 3, path: cFile }
        ]);
        expect(summary).toEqual({ updated: 1, unchanged: 1, failed: 1 });

        // Happy-path side effect really landed on disk for A.
        const aContents = fs.readFileSync(
          path.join(aDir.path, ".gitignore"),
          "utf8"
        );
        for (const entry of ASTACK_GITIGNORE_ENTRIES) {
          expect(aContents).toContain(entry);
        }
        // B untouched — exact bytes preserved.
        expect(
          fs.readFileSync(path.join(bDir.path, ".gitignore"), "utf8")
        ).toBe("node_modules/\n.astack/\n.astack.json\n");
      } finally {
        await aDir.cleanup();
        await bDir.cleanup();
        await cHost.cleanup();
      }
    });

    it("continues past a per-project failure (one bad apple doesn't abort the batch)", async () => {
      ctx = await setupCtx();
      const goodDir = await tmp.dir({ unsafeCleanup: true });
      const badHost = await tmp.dir({ unsafeCleanup: true });
      const badFile = path.join(badHost.path, "not_a_directory");
      fs.writeFileSync(badFile, "oops", "utf8");

      try {
        // Bad first, good second — if the loop bailed on throw, good
        // would never be written. Assert the good one was processed.
        const summary = ctx.guard.backfillExisting([
          { id: 1, path: badFile },
          { id: 2, path: goodDir.path }
        ]);
        expect(summary.failed).toBe(1);
        expect(summary.updated).toBe(1);
        expect(
          fs.existsSync(path.join(goodDir.path, ".gitignore"))
        ).toBe(true);
      } finally {
        await goodDir.cleanup();
        await badHost.cleanup();
      }
    });

    it("is idempotent — running twice in a row updates on the first call and is unchanged on the second", async () => {
      ctx = await setupCtx();
      const d = await tmp.dir({ unsafeCleanup: true });
      try {
        const first = ctx.guard.backfillExisting([
          { id: 1, path: d.path }
        ]);
        expect(first).toEqual({ updated: 1, unchanged: 0, failed: 0 });

        const second = ctx.guard.backfillExisting([
          { id: 1, path: d.path }
        ]);
        expect(second).toEqual({ updated: 0, unchanged: 1, failed: 0 });
      } finally {
        await d.cleanup();
      }
    });
  });
});
