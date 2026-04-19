/**
 * Tests for SyncService — the two-copy shuttle.
 *
 * Covers pull/push paths, conflict detection, resolve strategies, and state
 * computation. Uses real git bare repos and real filesystem working copies.
 */

import fs from "node:fs";
import path from "node:path";

import {
  ErrorCode,
  EventType,
  ResolveStrategy,
  SkillType,
  SubscriptionState
} from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});
