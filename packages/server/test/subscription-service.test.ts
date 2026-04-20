/**
 * Tests for SubscriptionService.
 *
 * Covers ref resolution (3 forms), ambiguity errors, name-collision guard,
 * and manifest write-back (.astack.json).
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, SkillType } from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  manifestPath,
  readManifest
} from "../src/manifest.js";

import { createHarness, type Harness } from "./helpers/harness.js";

describe("SubscriptionService", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function seed(): Promise<{
    projectId: number;
    repoId: number;
    skillIdCommand: number;
    skillIdSkill: number;
  }> {
    // Bare repo with one command and one skill.
    await h.bare.addCommitPush(
      "commands/code_review.md",
      "# code review\n",
      "add code_review"
    );
    await h.bare.addCommitPush(
      "skills/office-hours/SKILL.md",
      "# office hours\n",
      "add office-hours"
    );

    const { repo } = await h.repoService.register({ git_url: h.bare.url });
    const project = h.projectService.register({ path: h.projectDir.path });

    const skills = h.repoService.listSkills(repo.id);
    const cmd = skills.find((s) => s.type === SkillType.Command)!;
    const skl = skills.find((s) => s.type === SkillType.Skill)!;

    return {
      projectId: project.id,
      repoId: repo.id,
      skillIdCommand: cmd.id,
      skillIdSkill: skl.id
    };
  }

  describe("resolveRef", () => {
    it("resolves short ref with single match", async () => {
      const { projectId } = await seed();
      expect(projectId).toBeGreaterThan(0);

      const r = h.subscriptionService.resolveRef("code_review");
      expect(r.skill.name).toBe("code_review");
      expect(r.skill.type).toBe(SkillType.Command);
    });

    it("resolves repo-qualified ref", async () => {
      await seed();
      const repoName = h.repoService
        .list({ offset: 0, limit: 10 })
        .repos[0]!.name;
      const r = h.subscriptionService.resolveRef(
        `${repoName}/code_review`
      );
      expect(r.skill.name).toBe("code_review");
    });

    it("resolves fully-qualified ref", async () => {
      await seed();
      const repoName = h.repoService
        .list({ offset: 0, limit: 10 })
        .repos[0]!.name;
      const r = h.subscriptionService.resolveRef(
        `${repoName}/skill/office-hours`
      );
      expect(r.skill.type).toBe(SkillType.Skill);
    });

    it("throws SKILL_NOT_FOUND for unknown short ref", async () => {
      await seed();
      expect(() =>
        h.subscriptionService.resolveRef("nonexistent")
      ).toThrowError(expect.objectContaining({ code: ErrorCode.SKILL_NOT_FOUND }));
    });

    it("throws REPO_NOT_FOUND for unknown repo prefix", async () => {
      await seed();
      expect(() =>
        h.subscriptionService.resolveRef("wrong-repo/code_review")
      ).toThrowError(expect.objectContaining({ code: ErrorCode.REPO_NOT_FOUND }));
    });

    it("throws SKILL_REF_AMBIGUOUS when short name exists in multiple repos", async () => {
      await h.bare.addCommitPush(
        "commands/shared.md",
        "repo1",
        "add shared"
      );
      await h.repoService.register({ git_url: h.bare.url });

      // Second bare with the same skill name.
      const { createBareRepo } = await import("./helpers/git-fixture.js");
      const bare2 = await createBareRepo();
      try {
        await bare2.addCommitPush("commands/shared.md", "repo2", "add shared");
        await h.repoService.register({
          git_url: bare2.url,
          name: "other-repo"
        });
        h.projectService.register({ path: h.projectDir.path });

        expect(() =>
          h.subscriptionService.resolveRef("shared")
        ).toThrowError(
          expect.objectContaining({ code: ErrorCode.SKILL_REF_AMBIGUOUS })
        );
      } finally {
        await bare2.dir.cleanup();
      }
    });

    it("throws SKILL_TYPE_AMBIGUOUS when command and skill share a name in one repo", async () => {
      await h.bare.addCommitPush(
        "commands/same_name.md",
        "x",
        "add command"
      );
      await h.bare.addCommitPush(
        "skills/same_name/SKILL.md",
        "y",
        "add skill with same name"
      );
      const { repo } = await h.repoService.register({ git_url: h.bare.url });
      h.projectService.register({ path: h.projectDir.path });

      expect(() =>
        h.subscriptionService.resolveRef("same_name")
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.SKILL_TYPE_AMBIGUOUS })
      );

      // With type hint, resolves.
      const r = h.subscriptionService.resolveRef("same_name", SkillType.Skill);
      expect(r.skill.type).toBe(SkillType.Skill);
      expect(r.repo.id).toBe(repo.id);
    });

    it("rejects malformed refs (too many segments)", async () => {
      await seed();
      expect(() =>
        h.subscriptionService.resolveRef("a/b/c/d")
      ).toThrowError(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }));
    });

    it("rejects invalid type in fully-qualified ref", async () => {
      await seed();
      const repoName = h.repoService
        .list({ offset: 0, limit: 10 })
        .repos[0]!.name;
      expect(() =>
        h.subscriptionService.resolveRef(`${repoName}/wrong/code_review`)
      ).toThrowError(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }));
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("creates a subscription row and writes the manifest", async () => {
      const { projectId, skillIdCommand } = await seed();
      const { subscription } = h.subscriptionService.subscribe(
        projectId,
        "code_review"
      );
      expect(subscription.skill_id).toBe(skillIdCommand);

      const manifest = readManifest(h.projectDir.path);
      expect(manifest).not.toBeNull();
      expect(manifest!.subscriptions).toHaveLength(1);
      expect(manifest!.subscriptions[0]).toMatchObject({
        type: SkillType.Command,
        name: "code_review"
      });
      expect(manifest!.project_id).toBe(projectId);
      expect(manifest!.server_url).toBe("http://127.0.0.1:7432");
    });

    it("upsert is idempotent on repeat subscribe", async () => {
      const { projectId } = await seed();
      h.subscriptionService.subscribe(projectId, "code_review");
      h.subscriptionService.subscribe(projectId, "code_review");
      const manifest = readManifest(h.projectDir.path);
      expect(manifest!.subscriptions).toHaveLength(1);
    });

    it("unsubscribe removes the row and rewrites manifest", async () => {
      const { projectId, skillIdCommand } = await seed();
      h.subscriptionService.subscribe(projectId, "code_review");
      const removed = h.subscriptionService.unsubscribe(
        projectId,
        skillIdCommand
      );
      expect(removed).toBe(true);
      const manifest = readManifest(h.projectDir.path);
      expect(manifest!.subscriptions).toEqual([]);
    });

    it("unsubscribe on missing row returns false (no manifest write)", async () => {
      const { projectId } = await seed();
      // Manifest doesn't exist yet.
      const removed = h.subscriptionService.unsubscribe(projectId, 9999);
      expect(removed).toBe(false);
    });

    it("rejects subscription that would collide with another repo's same-name skill", async () => {
      const { projectId } = await seed();
      h.subscriptionService.subscribe(projectId, "code_review");

      // Second repo with a code_review.
      const { createBareRepo } = await import("./helpers/git-fixture.js");
      const bare2 = await createBareRepo();
      try {
        await bare2.addCommitPush(
          "commands/code_review.md",
          "different",
          "init"
        );
        await h.repoService.register({
          git_url: bare2.url,
          name: "other-repo"
        });

        expect(() =>
          h.subscriptionService.subscribe(
            projectId,
            "other-repo/code_review"
          )
        ).toThrowError(
          expect.objectContaining({
            code: ErrorCode.SUBSCRIPTION_NAME_COLLISION
          })
        );
      } finally {
        await bare2.dir.cleanup();
      }
    });
  });

  describe("reconcileFromManifest", () => {
    it("is a no-op when the manifest file is missing", async () => {
      const { projectId } = await seed();
      expect(h.subscriptionService.reconcileFromManifest(projectId)).toBeNull();
    });

    it("syncs SQLite state from the manifest (file wins)", async () => {
      const { projectId } = await seed();
      // Write a manifest manually, then reconcile.
      const repoName = h.repoService
        .list({ offset: 0, limit: 10 })
        .repos[0]!.name;
      const manifest = {
        project_id: projectId,
        server_url: "http://127.0.0.1:7432",
        primary_tool: ".claude",
        linked_tools: [],
        subscriptions: [
          {
            repo: repoName,
            type: SkillType.Command,
            name: "code_review"
          }
        ],
        last_synced: null
      };
      const file = manifestPath(h.projectDir.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));

      h.subscriptionService.reconcileFromManifest(projectId);
      const rows = h.subscriptionService.listForProject(projectId);
      expect(rows).toHaveLength(1);
    });

    it("drops SQLite rows that aren't in the manifest", async () => {
      const { projectId, skillIdCommand } = await seed();
      h.subscriptionService.subscribe(projectId, "code_review");
      expect(h.subscriptionService.listForProject(projectId)).toHaveLength(1);

      // Rewrite manifest with an empty subscriptions list.
      const file = manifestPath(h.projectDir.path);
      const current = readManifest(h.projectDir.path);
      fs.writeFileSync(
        file,
        JSON.stringify({ ...current, subscriptions: [] }, null, 2)
      );

      h.subscriptionService.reconcileFromManifest(projectId);
      expect(h.subscriptionService.listForProject(projectId)).toEqual([]);
      expect(skillIdCommand).toBeGreaterThan(0);
    });
  });

  describe("touchLastSynced", () => {
    it("is a no-op when manifest does not exist", async () => {
      const { projectId } = await seed();
      h.subscriptionService.touchLastSynced(
        projectId,
        "2026-04-19T14:00:00.000Z"
      );
      expect(readManifest(h.projectDir.path)).toBeNull();
    });

    it("updates last_synced without touching other fields", async () => {
      const { projectId } = await seed();
      h.subscriptionService.subscribe(projectId, "code_review");
      h.subscriptionService.touchLastSynced(
        projectId,
        "2026-04-19T14:00:00.000Z"
      );
      const m = readManifest(h.projectDir.path);
      expect(m!.last_synced).toBe("2026-04-19T14:00:00.000Z");
      expect(m!.subscriptions).toHaveLength(1);
    });
  });

  // v0.3: partial-success batch subscribe
  describe("subscribeBatch", () => {
    it("all refs succeed → failures=[] + all rows present", async () => {
      const { projectId } = await seed();
      const result = h.subscriptionService.subscribeBatch(projectId, [
        "code_review",
        "office-hours"
      ]);
      expect(result.subscriptions).toHaveLength(2);
      expect(result.failures).toEqual([]);
      expect(readManifest(h.projectDir.path)!.subscriptions).toHaveLength(2);
    });

    it("REGRESSION: one ref fails → partial success, manifest has the good ones", async () => {
      const { projectId } = await seed();

      const result = h.subscriptionService.subscribeBatch(projectId, [
        "office-hours",
        "does-not-exist" // will fail with SKILL_NOT_FOUND
      ]);
      expect(result.subscriptions).toHaveLength(1);
      expect(result.subscriptions[0]?.skill_id).toBeDefined();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        ref: "does-not-exist",
        code: ErrorCode.SKILL_NOT_FOUND
      });
      // Manifest must reflect the success despite the failure — this is the
      // whole reason we introduced partial-success in v0.3.
      const m = readManifest(h.projectDir.path);
      expect(m!.subscriptions).toHaveLength(1);
      expect(m!.subscriptions[0]?.name).toBe("office-hours");
    });

    it("every ref fails → subscriptions=[], failures has full list", async () => {
      const { projectId } = await seed();
      const result = h.subscriptionService.subscribeBatch(projectId, [
        "does-not-exist",
        "also-nope"
      ]);
      expect(result.subscriptions).toEqual([]);
      expect(result.failures).toHaveLength(2);
      expect(result.failures.every((f) => f.code === ErrorCode.SKILL_NOT_FOUND)).toBe(
        true
      );
    });

    it("single-ref failure still returns 200-shaped output (not a throw)", async () => {
      const { projectId } = await seed();
      const result = h.subscriptionService.subscribeBatch(projectId, [
        "does-not-exist"
      ]);
      expect(result.subscriptions).toEqual([]);
      expect(result.failures).toHaveLength(1);
    });

    it("unknown project id throws PROJECT_NOT_FOUND (not a per-ref failure)", () => {
      expect(() =>
        h.subscriptionService.subscribeBatch(99999, ["code_review"])
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.PROJECT_NOT_FOUND })
      );
    });

    it("pinned_version only applied when exactly one ref (batch ignores it)", async () => {
      const { projectId } = await seed();
      h.subscriptionService.subscribeBatch(
        projectId,
        ["code_review", "office-hours"],
        { pinned_version: "abc1234" }
      );
      // Both rows should have pinned_version=null (batch mode discards it).
      const subs = h.subscriptionService.listForProject(projectId);
      expect(subs.every((s) => s.pinned_version === null)).toBe(true);
    });
  });
});
