/**
 * Tests for git.ts helpers that aren't fully covered by RepoService tests.
 *
 * Mostly exercises commit/push/isClean/attachGit against real bare repos.
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode } from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachGit,
  gitClone,
  gitCommitAndPush,
  gitGetHead,
  gitIsClean,
  gitPull,
  gitRemoteHead
} from "../src/git.js";

import { createBareRepo, type BareRepoHandle } from "./helpers/git-fixture.js";

describe("git helpers", () => {
  let bare: BareRepoHandle;

  beforeEach(async () => {
    bare = await createBareRepo();
    await bare.addCommitPush("README.md", "init", "init");
  });

  afterEach(async () => {
    await bare.dir.cleanup();
  });

  describe("gitCommitAndPush", () => {
    it("stages, commits, and pushes changes", async () => {
      // Write a file directly into the work dir (not via bare helper,
      // which does its own push).
      fs.writeFileSync(path.join(bare.workDir, "note.md"), "hello");
      const hash = await gitCommitAndPush(bare.workDir, "add note", {
        name: "Astack",
        email: "astack@test"
      });
      expect(hash).toMatch(/^[0-9a-f]{40}$/);

      // Verify upstream received it.
      const remoteHead = await gitRemoteHead(bare.workDir);
      expect(remoteHead).toBe(hash);
    });

    it("wraps failure as REPO_GIT_FAILED", async () => {
      await expect(
        gitCommitAndPush("/no/such/dir", "x", {
          name: "a",
          email: "a@b"
        })
      ).rejects.toMatchObject({ code: ErrorCode.REPO_GIT_FAILED });
    });
  });

  describe("gitIsClean", () => {
    it("returns true for a fresh clone", async () => {
      expect(await gitIsClean(bare.workDir)).toBe(true);
    });

    it("returns false after an uncommitted edit", async () => {
      fs.writeFileSync(path.join(bare.workDir, "dirty.md"), "x");
      expect(await gitIsClean(bare.workDir)).toBe(false);
    });

    it("wraps failure as REPO_GIT_FAILED", async () => {
      await expect(gitIsClean("/no/such/dir")).rejects.toMatchObject({
        code: ErrorCode.REPO_GIT_FAILED
      });
    });
  });

  describe("gitGetHead", () => {
    it("returns the HEAD hash and commit time", async () => {
      const info = await gitGetHead(bare.workDir);
      expect(info.head).toMatch(/^[0-9a-f]{40}$/);
      expect(new Date(info.head_time).toString()).not.toBe("Invalid Date");
    });
  });

  describe("gitPull", () => {
    it("wraps failure as REPO_GIT_FAILED for non-repo dir", async () => {
      await expect(gitPull("/no/such/dir")).rejects.toMatchObject({
        code: ErrorCode.REPO_GIT_FAILED
      });
    });
  });

  describe("gitClone", () => {
    it("wraps failure as REPO_GIT_FAILED for missing remote", async () => {
      await expect(
        gitClone("/no/such/remote.git", "/tmp/astack-clone-fail", {
          shallow: true
        })
      ).rejects.toMatchObject({ code: ErrorCode.REPO_GIT_FAILED });
    });
  });

  describe("attachGit", () => {
    it("returns a SimpleGit instance usable for ad-hoc commands", async () => {
      const git = attachGit(bare.workDir);
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      expect(branch.trim()).toBe("main");
    });
  });
});
