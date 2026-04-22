/**
 * Tests for SyncService — the two-copy shuttle.
 *
 * Covers pull/push paths, conflict detection, resolve strategies, and state
 * computation. Uses real git bare repos and real filesystem working copies.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  ResolveStrategy,
  SkillType,
  SubscriptionState
} from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nullLogger } from "../src/logger.js";
import { SyncService, type SyncServiceDeps } from "../src/services/sync.js";

import { createHarness, type Harness } from "./helpers/harness.js";

describe("SyncService", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function seedCommand(): Promise<{
    projectId: number;
    repoId: number;
    skillId: number;
    projectPath: string;
  }> {
    await h.bare.addCommitPush(
      "commands/code_review.md",
      "v1 content\n",
      "init"
    );
    const { repo } = await h.repoService.register({ git_url: h.bare.url });
    const project = h.projectService.register({ path: h.projectDir.path });
    const skill = h.repoService
      .listSkills(repo.id)
      .find((s) => s.name === "code_review")!;
    // Subscribe (manifest is written).
    h.subscriptionService.subscribe(project.id, "code_review");
    return {
      projectId: project.id,
      repoId: repo.id,
      skillId: skill.id,
      projectPath: h.projectDir.path
    };
  }

  function readWorking(projectPath: string, rel: string): string {
    return fs.readFileSync(path.join(projectPath, ".claude", rel), "utf8");
  }

  function writeWorking(projectPath: string, rel: string, content: string): void {
    const p = path.join(projectPath, ".claude", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  // ---------- pullOne ----------

  describe("pullOne", () => {
    it("materializes the working copy on first sync (Pending → Synced)", async () => {
      const s = await seedCommand();
      const outcome = await h.syncService.pullOne(s.projectId, s.skillId);
      expect(outcome.state).toBe(SubscriptionState.Synced);
      expect(outcome.log.status).toBe("success");
      expect(readWorking(s.projectPath, "commands/code_review.md")).toBe(
        "v1 content\n"
      );
      expect(
        h.emitted.some((e) => e.event.type === EventType.SkillUpdated)
      ).toBe(true);
    });

    it("no-ops when already synced (Synced → Synced)", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      h.emitted.length = 0;
      const outcome = await h.syncService.pullOne(s.projectId, s.skillId);
      expect(outcome.state).toBe(SubscriptionState.Synced);
      // No skill.updated event on a pure no-op.
      expect(
        h.emitted.some((e) => e.event.type === EventType.SkillUpdated)
      ).toBe(false);
    });

    it("pulls new upstream into working copy (Behind → Synced)", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      // Upstream changes v1 → v2.
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "v2 content\n",
        "bump"
      );

      const outcome = await h.syncService.pullOne(s.projectId, s.skillId);
      expect(outcome.state).toBe(SubscriptionState.Synced);
      expect(readWorking(s.projectPath, "commands/code_review.md")).toBe(
        "v2 content\n"
      );
    });

    it("skips pull when local-ahead (preserves local edits)", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      writeWorking(s.projectPath, "commands/code_review.md", "local edit\n");

      const outcome = await h.syncService.pullOne(s.projectId, s.skillId);
      expect(outcome.state).toBe(SubscriptionState.LocalAhead);
      expect(readWorking(s.projectPath, "commands/code_review.md")).toBe(
        "local edit\n"
      );
    });

    it("reports CONFLICT_DETECTED when both sides diverged", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      // Both sides edit.
      writeWorking(s.projectPath, "commands/code_review.md", "local edit\n");
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "remote edit\n",
        "remote bump"
      );

      await expect(
        h.syncService.pullOne(s.projectId, s.skillId)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });

      expect(
        h.emitted.some((e) => e.event.type === EventType.ConflictDetected)
      ).toBe(true);
    });

    it("handles skill-type (directory) skills", async () => {
      await h.bare.addCommitPush(
        "skills/office-hours/SKILL.md",
        "v1\n",
        "init"
      );
      const { repo } = await h.repoService.register({ git_url: h.bare.url });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skill = h.repoService
        .listSkills(repo.id)
        .find((s) => s.type === SkillType.Skill)!;
      h.subscriptionService.subscribe(project.id, "office-hours");

      const outcome = await h.syncService.pullOne(project.id, skill.id);
      expect(outcome.state).toBe(SubscriptionState.Synced);
      expect(
        fs.existsSync(
          path.join(h.projectDir.path, ".claude/skills/office-hours/SKILL.md")
        )
      ).toBe(true);
    });
  });

  // ---------- pullBatch ----------

  describe("pullBatch", () => {
    it("syncs all subscribed skills, updates last_synced, emits sync.completed", async () => {
      await h.bare.addCommitPush("commands/a.md", "A\n", "init a");
      await h.bare.addCommitPush("commands/b.md", "B\n", "init b");
      const { repo } = await h.repoService.register({ git_url: h.bare.url });
      const project = h.projectService.register({ path: h.projectDir.path });

      const skillA = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "a")!;
      const skillB = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "b")!;

      h.subscriptionService.subscribe(project.id, "a");
      h.subscriptionService.subscribe(project.id, "b");

      const result = await h.syncService.pullBatch(project.id);
      expect(result.synced + result.up_to_date).toBe(2);
      expect(result.conflicts).toBe(0);
      expect(result.errors).toBe(0);
      expect(
        h.emitted.some((e) => e.event.type === EventType.SyncStarted)
      ).toBe(true);
      expect(
        h.emitted.some((e) => e.event.type === EventType.SyncCompleted)
      ).toBe(true);
      expect(skillA.id).toBeGreaterThan(0);
      expect(skillB.id).toBeGreaterThan(0);
    });

    it("continues on conflict (best-effort batch)", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      // Induce a conflict on this skill.
      writeWorking(s.projectPath, "commands/code_review.md", "L\n");
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "R\n",
        "remote"
      );

      const result = await h.syncService.pullBatch(s.projectId);
      expect(result.conflicts).toBe(1);
    });
  });

  // ---------- pushOne ----------

  describe("pushOne", () => {
    it("no-ops when no local changes", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      const outcome = await h.syncService.pushOne(s.projectId, s.skillId);
      expect(outcome.new_version).toBeNull();
      expect(outcome.log.conflict_detail).toBe("no local changes");
    });

    it("pushes local changes to upstream, emits skill.updated", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      writeWorking(s.projectPath, "commands/code_review.md", "local v2\n");

      const outcome = await h.syncService.pushOne(s.projectId, s.skillId);
      expect(outcome.new_version).toMatch(/^[0-9a-f]{40}$/);
      expect(outcome.state).toBe(SubscriptionState.Synced);
      expect(
        h.emitted.some((e) => e.event.type === EventType.SkillUpdated)
      ).toBe(true);

      // Verify bare received the commit.
      const { gitRemoteHead } = await import("../src/git.js");
      const remoteHead = await gitRemoteHead(h.bare.workDir);
      expect(remoteHead).toBe(outcome.new_version);
    });

    it("detects conflict when upstream diverged before push", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);

      writeWorking(s.projectPath, "commands/code_review.md", "L\n");
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "R\n",
        "remote"
      );

      await expect(
        h.syncService.pushOne(s.projectId, s.skillId)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });
    });

    it("uses a custom commit message when provided", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "v2\n");

      await h.syncService.pushOne(s.projectId, s.skillId, {
        commit_message: "custom: update code_review"
      });

      // bare.workDir hasn't pulled our push; go read from the upstream mirror.
      const mirrorPath = h.repoService.list({ offset: 0, limit: 1 }).repos[0]!
        .local_path!;
      const { simpleGit } = await import("simple-git");
      const log = await simpleGit(mirrorPath).log({ maxCount: 1 });
      expect(log.latest?.message).toContain("custom: update code_review");
    });
  });

  // ---------- resolve ----------

  describe("resolve", () => {
    async function buildConflict(): Promise<{
      projectId: number;
      skillId: number;
      projectPath: string;
    }> {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "L\n");
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "R\n",
        "remote"
      );
      await expect(
        h.syncService.pullOne(s.projectId, s.skillId)
      ).rejects.toBeDefined();
      return s;
    }

    it("use-remote strategy overwrites working copy with upstream", async () => {
      const s = await buildConflict();
      const res = await h.syncService.resolve(
        s.projectId,
        s.skillId,
        ResolveStrategy.UseRemote
      );
      expect(res.log.status).toBe("success");
      expect(readWorking(s.projectPath, "commands/code_review.md")).toBe("R\n");
    });

    it("keep-local strategy pushes local to upstream", async () => {
      const s = await buildConflict();
      const res = await h.syncService.resolve(
        s.projectId,
        s.skillId,
        ResolveStrategy.KeepLocal
      );
      expect(res.log.status).toBe("success");
      // Upstream now has "L".
      const { gitPull } = await import("../src/git.js");
      await gitPull(h.bare.workDir);
      const content = fs.readFileSync(
        path.join(h.bare.workDir, "commands/code_review.md"),
        "utf8"
      );
      expect(content).toBe("L\n");
    });

    it("manual strategy requires manual_done and no conflict markers", async () => {
      const s = await buildConflict();

      // manual without manual_done → VALIDATION_FAILED.
      await expect(
        h.syncService.resolve(
          s.projectId,
          s.skillId,
          ResolveStrategy.Manual,
          { manual_done: false }
        )
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

      // User leaves conflict markers → MERGE_INCOMPLETE.
      writeWorking(
        s.projectPath,
        "commands/code_review.md",
        "<<<<<<< HEAD\nL\n=======\nR\n>>>>>>> upstream\n"
      );
      await expect(
        h.syncService.resolve(
          s.projectId,
          s.skillId,
          ResolveStrategy.Manual,
          { manual_done: true }
        )
      ).rejects.toMatchObject({ code: ErrorCode.MERGE_INCOMPLETE });

      // Clean merge → success.
      writeWorking(s.projectPath, "commands/code_review.md", "merged\n");
      const res = await h.syncService.resolve(
        s.projectId,
        s.skillId,
        ResolveStrategy.Manual,
        { manual_done: true }
      );
      expect(res.log.status).toBe("success");
    });

    it("rejects resolve when there is no active conflict", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      await expect(
        h.syncService.resolve(
          s.projectId,
          s.skillId,
          ResolveStrategy.UseRemote
        )
      ).rejects.toMatchObject({ code: ErrorCode.NO_ACTIVE_CONFLICT });
    });
  });

  // ---------- readDiff / listWithState ----------

  describe("readDiff", () => {
    it("reports identical=true when in sync", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      const d = h.syncService.readDiff(s.projectId, s.skillId);
      expect(d.identical).toBe(true);
    });

    it("reports identical=false when local edited", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "edit\n");
      const d = h.syncService.readDiff(s.projectId, s.skillId);
      expect(d.identical).toBe(false);
      expect(d.upstream_version).not.toBe(d.working_version);
    });
  });

  describe("listWithState", () => {
    it("returns Synced after pullOne", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      const { subscriptions } = h.syncService.listWithState(s.projectId);
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].state).toBe(SubscriptionState.Synced);
    });

    it("returns Pending before any pull", async () => {
      const s = await seedCommand();
      const { subscriptions } = h.syncService.listWithState(s.projectId);
      expect(subscriptions[0].state).toBe(SubscriptionState.Pending);
    });

    it("returns LocalAhead after local edit", async () => {
      const s = await seedCommand();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "edit\n");
      const { subscriptions } = h.syncService.listWithState(s.projectId);
      expect(subscriptions[0].state).toBe(SubscriptionState.LocalAhead);
    });

    // v0.5 bootstrap-adopted skills: subscription exists, working copy
    // exists on disk with user content, but sync_logs has no prior success.
    // Pre-v0.5 this fell into the base=null branch → Pending ("awaiting
    // initial sync"), which is wrong — the project IS already initialised,
    // the content is just drifted. Classify as Synced/Conflict so the UI
    // routes the user into the resolve flow.
    it("v0.5 bootstrap-adopted: local matches upstream → Synced (no sync history)", async () => {
      const s = await seedCommand();
      // Simulate bootstrap: working copy materialised with identical
      // content to upstream, but no pullOne was ever run → no sync_log.
      writeWorking(s.projectPath, "commands/code_review.md", "v1 content\n");
      const { subscriptions } = h.syncService.listWithState(s.projectId);
      expect(subscriptions[0].state).toBe(SubscriptionState.Synced);
    });

    it("v0.5 bootstrap-adopted: local drifts from upstream → Conflict (no sync history)", async () => {
      const s = await seedCommand();
      // Simulate bootstrap adopting a legacy project: working copy
      // exists but user had edited it before astack took over.
      writeWorking(
        s.projectPath,
        "commands/code_review.md",
        "user's pre-astack edits\n"
      );
      const { subscriptions } = h.syncService.listWithState(s.projectId);
      expect(subscriptions[0].state).toBe(SubscriptionState.Conflict);
      expect(subscriptions[0].state_detail).toMatch(/resolve/i);
    });
  });

  // ---------- open-source (read-only) repo gate ----------

  describe("open-source repos (readonly)", () => {
    async function seedReadonly(): Promise<{
      projectId: number;
      skillId: number;
      projectPath: string;
    }> {
      await h.bare.addCommitPush("commands/code_review.md", "v1\n", "init");
      const { repo } = await h.repoService.register({
        git_url: h.bare.url,
        kind: "open-source"
      });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skill = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "code_review")!;
      h.subscriptionService.subscribe(project.id, "code_review");
      return {
        projectId: project.id,
        skillId: skill.id,
        projectPath: h.projectDir.path
      };
    }

    it("pullOne still works on open-source repos", async () => {
      const s = await seedReadonly();
      const outcome = await h.syncService.pullOne(s.projectId, s.skillId);
      expect(outcome.state).toBe(SubscriptionState.Synced);
      expect(readWorking(s.projectPath, "commands/code_review.md")).toBe("v1\n");
    });

    it("pushOne rejects with REPO_READONLY before acquiring the lock", async () => {
      const s = await seedReadonly();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "edited\n");

      await expect(
        h.syncService.pushOne(s.projectId, s.skillId)
      ).rejects.toMatchObject({
        code: ErrorCode.REPO_READONLY
      });
    });

    it("resolve with use-remote works on open-source repos", async () => {
      const s = await seedReadonly();
      // Create a conflict: local edit + remote edit.
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "local\n");
      await h.bare.addCommitPush("commands/code_review.md", "remote\n", "remote edit");

      await expect(
        h.syncService.pullOne(s.projectId, s.skillId)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });

      // use-remote only reads upstream into working; it's allowed.
      const { subscription } = await h.syncService.resolve(
        s.projectId,
        s.skillId,
        ResolveStrategy.UseRemote
      );
      expect(subscription.state).toBe(SubscriptionState.Synced);
      expect(readWorking(s.projectPath, "commands/code_review.md")).toBe("remote\n");
    });

    it("resolve with keep-local rejects with REPO_READONLY", async () => {
      const s = await seedReadonly();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "local\n");
      await h.bare.addCommitPush("commands/code_review.md", "remote\n", "remote edit");

      await expect(
        h.syncService.pullOne(s.projectId, s.skillId)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });

      await expect(
        h.syncService.resolve(s.projectId, s.skillId, ResolveStrategy.KeepLocal)
      ).rejects.toMatchObject({
        code: ErrorCode.REPO_READONLY
      });
    });

    it("resolve with manual rejects with REPO_READONLY", async () => {
      const s = await seedReadonly();
      await h.syncService.pullOne(s.projectId, s.skillId);
      writeWorking(s.projectPath, "commands/code_review.md", "local\n");
      await h.bare.addCommitPush("commands/code_review.md", "remote\n", "remote edit");

      await expect(
        h.syncService.pullOne(s.projectId, s.skillId)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });

      await expect(
        h.syncService.resolve(s.projectId, s.skillId, ResolveStrategy.Manual, {
          manual_done: true
        })
      ).rejects.toMatchObject({
        code: ErrorCode.REPO_READONLY
      });
    });
  });

  // ---------- v0.6 ensureMirrorClean (open-source mirror self-heal) ----------
  //
  // These tests drive SyncService via a mocked gitImpl so we can precisely
  // control `isClean` / `resetHard` / `pull` / `remoteHead` return values
  // without spinning up a dirty git working tree. Repo + project + skill
  // rows are still created via the real harness so the subscription /
  // sync-log machinery exercises the real code path.

  describe("ensureMirrorClean (v0.6)", () => {
    /**
     * Build a SyncService whose gitImpl is fully mocked, sharing the
     * harness's DB / events / subscriptions / project services so SQLite
     * rows & conflict-state reads behave normally.
     */
    function makeSyncWithMock(
      gitImpl: NonNullable<SyncServiceDeps["gitImpl"]>
    ): SyncService {
      return new SyncService({
        db: h.db,
        events: h.events,
        logger: nullLogger(),
        locks: h.locks,
        projects: h.projectService,
        subscriptions: h.subscriptionService,
        gitAuthor: { name: "Test", email: "test@example.com" },
        gitImpl
      });
    }

    async function seedOpenSourceConflict(): Promise<{
      projectId: number;
      skillId: number;
      projectPath: string;
    }> {
      await h.bare.addCommitPush("commands/code_review.md", "v1\n", "init");
      const { repo } = await h.repoService.register({
        git_url: h.bare.url,
        kind: "open-source"
      });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skill = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "code_review")!;
      h.subscriptionService.subscribe(project.id, "code_review");

      // Materialise working copy, then induce a conflict so resolve() has
      // something legitimate to resolve.
      await h.syncService.pullOne(project.id, skill.id);
      writeWorking(s(project.id), "commands/code_review.md", "local edit\n");
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "remote edit\n",
        "remote bump"
      );
      await expect(
        h.syncService.pullOne(project.id, skill.id)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });

      return {
        projectId: project.id,
        skillId: skill.id,
        projectPath: h.projectDir.path
      };
    }

    /** Project path is constant across the harness; helper to satisfy writeWorking. */
    function s(_projectId: number): string {
      return h.projectDir.path;
    }

    async function seedOpenSourceNoConflict(): Promise<{
      projectId: number;
      skillId: number;
    }> {
      await h.bare.addCommitPush("commands/code_review.md", "v1\n", "init");
      const { repo } = await h.repoService.register({
        git_url: h.bare.url,
        kind: "open-source"
      });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skill = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "code_review")!;
      h.subscriptionService.subscribe(project.id, "code_review");
      return { projectId: project.id, skillId: skill.id };
    }

    async function seedCustomConflict(): Promise<{
      projectId: number;
      skillId: number;
      projectPath: string;
    }> {
      await h.bare.addCommitPush("commands/code_review.md", "v1\n", "init");
      // Default kind = custom.
      const { repo } = await h.repoService.register({ git_url: h.bare.url });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skill = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "code_review")!;
      h.subscriptionService.subscribe(project.id, "code_review");
      await h.syncService.pullOne(project.id, skill.id);
      writeWorking(s(project.id), "commands/code_review.md", "local edit\n");
      await h.bare.addCommitPush(
        "commands/code_review.md",
        "remote edit\n",
        "remote bump"
      );
      await expect(
        h.syncService.pullOne(project.id, skill.id)
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT_DETECTED });
      return {
        projectId: project.id,
        skillId: skill.id,
        projectPath: h.projectDir.path
      };
    }

    it("resets dirty open-source mirror and emits repo.mirror_reset (use-remote resolve)", async () => {
      const seed = await seedOpenSourceConflict();

      const isClean = vi.fn().mockResolvedValue(false);
      const remoteHead = vi
        .fn()
        .mockResolvedValue("abcdef0123456789abcdef0123456789abcdef01");
      const resetHard = vi.fn().mockResolvedValue(undefined);
      const pull = vi.fn().mockResolvedValue(undefined);
      const commitAndPush = vi.fn().mockResolvedValue("deadbeef");

      const sync = makeSyncWithMock({
        pull,
        commitAndPush,
        isClean,
        remoteHead,
        resetHard
      });

      h.emitted.length = 0;
      const res = await sync.resolve(
        seed.projectId,
        seed.skillId,
        ResolveStrategy.UseRemote
      );

      expect(res.subscription.state).toBe(SubscriptionState.Synced);
      expect(isClean).toHaveBeenCalledTimes(1);
      expect(remoteHead).toHaveBeenCalledTimes(1);
      expect(resetHard).toHaveBeenCalledTimes(1);
      expect(resetHard).toHaveBeenCalledWith(expect.any(String), "origin/HEAD");
      expect(pull).toHaveBeenCalledTimes(1);

      // Mirror reset SSE + payload shape sanity.
      const resetEvents = h.emitted.filter(
        (e) => e.event.type === EventType.RepoMirrorReset
      );
      expect(resetEvents).toHaveLength(1);
      expect(resetEvents[0]?.event.payload).toMatchObject({
        repo_kind: "open-source",
        reason: "dirty_working_tree"
      });
    });

    it("custom repo: ensureMirrorClean is a no-op — git.pull sees dirty state raw", async () => {
      const seed = await seedCustomConflict();

      const isClean = vi.fn().mockResolvedValue(false);
      const remoteHead = vi.fn().mockResolvedValue("");
      const resetHard = vi.fn().mockResolvedValue(undefined);
      const pull = vi.fn().mockRejectedValue(
        new AstackError(ErrorCode.REPO_GIT_FAILED, "git pull failed", {
          git_stderr:
            "Your local changes would be overwritten by merge: commands/code_review.md"
        })
      );
      const commitAndPush = vi.fn().mockResolvedValue("deadbeef");

      const sync = makeSyncWithMock({
        pull,
        commitAndPush,
        isClean,
        remoteHead,
        resetHard
      });

      // Assert on what resolve() actually throws — not on the mock's own
      // rejected value. Covers two invariants in one assertion:
      //   1. the error code bubbles unwrapped (REPO_GIT_FAILED)
      //   2. git_stderr is preserved through the custom-repo no-op path
      //      (ensureMirrorClean didn't swallow or rewrap it)
      await expect(
        sync.resolve(seed.projectId, seed.skillId, ResolveStrategy.UseRemote)
      ).rejects.toMatchObject({
        code: ErrorCode.REPO_GIT_FAILED,
        details: {
          git_stderr: expect.stringContaining("local changes would be overwritten")
        }
      });

      // Key invariants: custom early-returns in ensureMirrorClean, so none
      // of the heal-path mocks were invoked; git.pull ran exactly once and
      // its raw error bubbled intact.
      expect(isClean).not.toHaveBeenCalled();
      expect(remoteHead).not.toHaveBeenCalled();
      expect(resetHard).not.toHaveBeenCalled();
      expect(pull).toHaveBeenCalledTimes(1);
    });

    it("clean open-source mirror: isClean=true → no reset, no SSE, no warn", async () => {
      const seed = await seedOpenSourceConflict();

      const isClean = vi.fn().mockResolvedValue(true);
      const remoteHead = vi.fn().mockResolvedValue("unused");
      const resetHard = vi.fn().mockResolvedValue(undefined);
      const pull = vi.fn().mockResolvedValue(undefined);
      const commitAndPush = vi.fn().mockResolvedValue("deadbeef");

      const sync = makeSyncWithMock({
        pull,
        commitAndPush,
        isClean,
        remoteHead,
        resetHard
      });

      h.emitted.length = 0;
      await sync.resolve(
        seed.projectId,
        seed.skillId,
        ResolveStrategy.UseRemote
      );

      expect(isClean).toHaveBeenCalledTimes(1);
      expect(remoteHead).not.toHaveBeenCalled();
      expect(resetHard).not.toHaveBeenCalled();
      expect(pull).toHaveBeenCalledTimes(1);
      expect(
        h.emitted.some((e) => e.event.type === EventType.RepoMirrorReset)
      ).toBe(false);
    });

    it("resetHard throw bubbles as REPO_GIT_FAILED with git_stderr intact", async () => {
      const seed = await seedOpenSourceConflict();

      const isClean = vi.fn().mockResolvedValue(false);
      const remoteHead = vi
        .fn()
        .mockResolvedValue("abcdef0123456789abcdef0123456789abcdef01");
      const resetHard = vi.fn().mockRejectedValue(
        new AstackError(ErrorCode.REPO_GIT_FAILED, "git reset --hard failed", {
          local_path: "/tmp/fake",
          ref: "origin/HEAD",
          git_stderr: "fatal: ambiguous argument 'origin/HEAD'"
        })
      );
      const pull = vi.fn().mockResolvedValue(undefined);
      const commitAndPush = vi.fn().mockResolvedValue("deadbeef");

      const sync = makeSyncWithMock({
        pull,
        commitAndPush,
        isClean,
        remoteHead,
        resetHard
      });

      await expect(
        sync.resolve(seed.projectId, seed.skillId, ResolveStrategy.UseRemote)
      ).rejects.toMatchObject({
        code: ErrorCode.REPO_GIT_FAILED,
        details: {
          git_stderr: expect.stringContaining("ambiguous argument")
        }
      });
      // pull NEVER runs when the reset itself fails.
      expect(pull).not.toHaveBeenCalled();
    });

    it("isClean throw bubbles (simulates .git corruption) — no resetHard attempted", async () => {
      const seed = await seedOpenSourceConflict();

      const isClean = vi.fn().mockRejectedValue(
        new AstackError(ErrorCode.REPO_GIT_FAILED, "git status failed", {
          local_path: "/tmp/fake",
          git_stderr: "fatal: not a git repository"
        })
      );
      const remoteHead = vi.fn().mockResolvedValue("unused");
      const resetHard = vi.fn().mockResolvedValue(undefined);
      const pull = vi.fn().mockResolvedValue(undefined);
      const commitAndPush = vi.fn().mockResolvedValue("deadbeef");

      const sync = makeSyncWithMock({
        pull,
        commitAndPush,
        isClean,
        remoteHead,
        resetHard
      });

      await expect(
        sync.resolve(seed.projectId, seed.skillId, ResolveStrategy.UseRemote)
      ).rejects.toMatchObject({
        code: ErrorCode.REPO_GIT_FAILED,
        details: {
          git_stderr: expect.stringContaining("not a git repository")
        }
      });
      expect(resetHard).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
    });

    it("pullOne batch dedupe: multiple skills in one repo trigger at most ONE ensureMirrorClean + git.pull", async () => {
      // Seed two commands in the same open-source repo.
      await h.bare.addCommitPush("commands/a.md", "A\n", "init a");
      await h.bare.addCommitPush("commands/b.md", "B\n", "init b");
      const { repo } = await h.repoService.register({
        git_url: h.bare.url,
        kind: "open-source"
      });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skillA = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "a")!;
      const skillB = h.repoService
        .listSkills(repo.id)
        .find((s) => s.name === "b")!;
      h.subscriptionService.subscribe(project.id, "a");
      h.subscriptionService.subscribe(project.id, "b");

      const isClean = vi.fn().mockResolvedValue(false);
      const remoteHead = vi
        .fn()
        .mockResolvedValue("abcdef0123456789abcdef0123456789abcdef01");
      const resetHard = vi.fn().mockResolvedValue(undefined);
      // Pull must be real-ish so the subsequent readRepoHead + file-copy
      // path still works — delegate to the real gitPull here.
      const { gitPull } = await import("../src/git.js");
      const pull = vi.fn(gitPull);
      const commitAndPush = vi.fn().mockResolvedValue("deadbeef");

      const sync = makeSyncWithMock({
        pull,
        commitAndPush,
        isClean,
        remoteHead,
        resetHard
      });

      const repoPulled = new Set<number>();
      await sync.pullOne(project.id, skillA.id, { repoPulled });
      await sync.pullOne(project.id, skillB.id, { repoPulled });

      expect(isClean).toHaveBeenCalledTimes(1);
      expect(resetHard).toHaveBeenCalledTimes(1);
      expect(pull).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- resolveBatch outcome error_code / error_detail (v0.6) ----------

  describe("resolveBatch outcomes (v0.6)", () => {
    function makeSyncWithMock(
      gitImpl: NonNullable<SyncServiceDeps["gitImpl"]>
    ): SyncService {
      return new SyncService({
        db: h.db,
        events: h.events,
        logger: nullLogger(),
        locks: h.locks,
        projects: h.projectService,
        subscriptions: h.subscriptionService,
        gitAuthor: { name: "Test", email: "test@example.com" },
        gitImpl
      });
    }

    /**
     * Drives two skills (in the same repo) into genuine Conflict state —
     * identical pattern to the `describe("resolve")` buildConflict() helper,
     * but for a pair of skills so resolveBatch has > 1 outcome to iterate.
     */
    async function buildPairConflict(): Promise<{
      project: { id: number; path: string };
      skillAId: number;
      skillBId: number;
    }> {
      await h.bare.addCommitPush("commands/a.md", "v1 a\n", "init-a");
      await h.bare.addCommitPush("commands/b.md", "v1 b\n", "init-b");
      const { repo } = await h.repoService.register({ git_url: h.bare.url });
      const project = h.projectService.register({ path: h.projectDir.path });
      const skills = h.repoService.listSkills(repo.id);
      const skillA = skills.find((s) => s.name === "a")!;
      const skillB = skills.find((s) => s.name === "b")!;
      h.subscriptionService.subscribe(project.id, "a");
      h.subscriptionService.subscribe(project.id, "b");

      // Materialize both.
      await h.syncService.pullOne(project.id, skillA.id);
      await h.syncService.pullOne(project.id, skillB.id);

      // Drift: local + remote diverge on both files.
      writeWorking(project.path, "commands/a.md", "local a\n");
      writeWorking(project.path, "commands/b.md", "local b\n");
      await h.bare.addCommitPush("commands/a.md", "remote a\n", "remote-a");
      await h.bare.addCommitPush("commands/b.md", "remote b\n", "remote-b");

      // One failed pull per skill records CONFLICT_DETECTED in sync_logs,
      // which is what `computeState` needs to classify the row as Conflict.
      await expect(
        h.syncService.pullOne(project.id, skillA.id)
      ).rejects.toBeDefined();
      await expect(
        h.syncService.pullOne(project.id, skillB.id)
      ).rejects.toBeDefined();

      return {
        project: { id: project.id, path: project.path },
        skillAId: skillA.id,
        skillBId: skillB.id
      };
    }

    it("per-skill outcome carries error_code + error_detail from AstackError", async () => {
      const { project, skillAId, skillBId } = await buildPairConflict();

      // Now inject a gitImpl that fails `pull` (inside resolve after
      // ensureMirrorClean) with a known AstackError carrying git_stderr.
      const pull = vi.fn().mockRejectedValue(
        new AstackError(
          ErrorCode.REPO_GIT_FAILED,
          "git pull failed",
          {
            git_stderr:
              "Your local changes would be overwritten by merge: commands/a.md",
            local_path: "/tmp/fake"
          }
        )
      );
      // isClean=true keeps ensureMirrorClean as a no-op so the AstackError
      // clearly comes from the pull step (not the reset step).
      const isClean = vi.fn().mockResolvedValue(true);

      const sync = makeSyncWithMock({ pull, isClean });
      const out = await sync.resolveBatch(
        project.id,
        [skillAId, skillBId],
        ResolveStrategy.UseRemote
      );

      expect(out.errors).toBe(2);
      expect(out.resolved).toBe(0);
      expect(out.outcomes).toHaveLength(2);
      for (const oc of out.outcomes) {
        expect(oc.success).toBe(false);
        expect(oc.error).toBe("git pull failed");
        expect(oc.error_code).toBe(ErrorCode.REPO_GIT_FAILED);
        expect(oc.error_detail).toContain(
          "Your local changes would be overwritten by merge"
        );
      }
    });

    it("non-AstackError failure: outcome has error but error_code/error_detail are undefined", async () => {
      const { project, skillAId } = await buildPairConflict();

      // A plain Error (not AstackError) — writer must fall back to
      // error: msg with both error_code and error_detail undefined.
      const pull = vi.fn().mockRejectedValue(new Error("network unreachable"));
      const isClean = vi.fn().mockResolvedValue(true);

      const sync = makeSyncWithMock({ pull, isClean });
      const out = await sync.resolveBatch(
        project.id,
        [skillAId],
        ResolveStrategy.UseRemote
      );

      expect(out.errors).toBe(1);
      expect(out.outcomes).toHaveLength(1);
      const oc = out.outcomes[0]!;
      expect(oc.success).toBe(false);
      expect(oc.error).toBe("network unreachable");
      expect(oc.error_code).toBeUndefined();
      expect(oc.error_detail).toBeUndefined();
    });
  });
});
