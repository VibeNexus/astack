/**
 * Tests for SymlinkService.
 *
 * Symlinks are real, not mocked. macOS supports POSIX symlinks out of the box.
 *
 * v0.5 semantics: whole-dir symlinks (<project>/.cursor → ../.claude),
 * NOT subdirectory-level (used to be .cursor/commands + .cursor/skills).
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, EventType, LinkedDirStatus } from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./helpers/harness.js";

describe("SymlinkService", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  /** Assert <project>/.{toolName} is a symlink pointing at the primary dir. */
  function assertLinkActive(toolName: string): void {
    const linkPath = path.join(h.projectDir.path, `.${toolName}`);
    const stat = fs.lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(linkPath);
    // Relative target so the link is portable across machines.
    expect(target).toBe(".claude");
    // Target resolves via followSymlinks.
    expect(fs.existsSync(linkPath)).toBe(true);
  }

  describe("addLink", () => {
    it("creates a whole-dir symlink from .<tool> to ../<primary_tool>", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      const link = h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor"
      });

      expect(link.tool_name).toBe("cursor");
      expect(link.dir_name).toBe(".cursor");
      expect(link.status).toBe(LinkedDirStatus.Active);

      assertLinkActive("cursor");

      expect(
        h.emitted.some((e) => e.event.type === EventType.LinkedDirCreated)
      ).toBe(true);
    });

    it("supports .codex and .gemini (new v0.5 tools)", () => {
      const project = h.projectService.register({ path: h.projectDir.path });

      h.symlinkService.addLink({ project_id: project.id, tool_name: "codex" });
      assertLinkActive("codex");

      h.symlinkService.addLink({ project_id: project.id, tool_name: "gemini" });
      assertLinkActive("gemini");
    });

    it("honors explicit dir_name override", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor",
        dir_name: ".cursor-custom"
      });
      const linkPath = path.join(h.projectDir.path, ".cursor-custom");
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe(".claude");
    });

    it("rejects empty tool_name", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      expect(() =>
        h.symlinkService.addLink({ project_id: project.id, tool_name: "   " })
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED })
      );
    });

    it("rejects duplicate tool_name", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      expect(() =>
        h.symlinkService.addLink({
          project_id: project.id,
          tool_name: "cursor"
        })
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.LINKED_DIR_ALREADY_EXISTS })
      );
    });

    it("refuses to overwrite a real directory at the link path", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      // Pre-create a real .cursor/ directory (e.g. user already has
      // cursor-specific config there).
      fs.mkdirSync(path.join(h.projectDir.path, ".cursor"), { recursive: true });
      expect(() =>
        h.symlinkService.addLink({
          project_id: project.id,
          tool_name: "cursor"
        })
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.SYMLINK_TARGET_OCCUPIED })
      );
    });

    it("creates the primary tool dir if it doesn't exist, so the link is not born broken", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      // Sanity: make sure .claude doesn't exist yet.
      const primary = path.join(h.projectDir.path, ".claude");
      if (fs.existsSync(primary)) fs.rmSync(primary, { recursive: true });

      const link = h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor"
      });
      expect(link.status).toBe(LinkedDirStatus.Active);
      expect(fs.existsSync(primary)).toBe(true);
    });
  });

  describe("removeLink", () => {
    it("removes the symlink and the DB row", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });

      h.symlinkService.removeLink(project.id, "cursor");

      expect(fs.existsSync(path.join(h.projectDir.path, ".cursor"))).toBe(false);
      expect(h.symlinkService.list(project.id)).toEqual([]);
      expect(
        h.emitted.some((e) => e.event.type === EventType.LinkedDirRemoved)
      ).toBe(true);
    });

    it("throws LINKED_DIR_NOT_FOUND when link is unknown", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      expect(() => h.symlinkService.removeLink(project.id, "nope")).toThrowError(
        expect.objectContaining({ code: ErrorCode.LINKED_DIR_NOT_FOUND })
      );
    });
  });

  describe("reconcile", () => {
    it("marks status=broken when the symlink is replaced by a real dir externally", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });

      // User breaks the link: replace the symlink with a real empty dir.
      const linkPath = path.join(h.projectDir.path, ".cursor");
      fs.unlinkSync(linkPath);
      fs.mkdirSync(linkPath);

      const links = h.symlinkService.reconcile(project.id);
      expect(links[0]?.status).toBe(LinkedDirStatus.Broken);
      expect(links[0]?.broken_reason).toBe("not_a_symlink");
      expect(
        h.emitted.some((e) => e.event.type === EventType.LinkedDirBroken)
      ).toBe(true);
    });

    it("returns active status unchanged when link is healthy", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      const before = h.emitted.length;
      const links = h.symlinkService.reconcile(project.id);
      expect(links[0]?.status).toBe(LinkedDirStatus.Active);
      // No new events when status didn't change.
      expect(h.emitted.length).toBe(before);
    });
  });

  describe("readLinkTargets", () => {
    it("returns the symlink target keyed by dir_name", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      const targets = h.symlinkService.readLinkTargets(project.id, "cursor");
      expect(targets).toEqual({ ".cursor": ".claude" });
    });

    it("throws LINKED_DIR_NOT_FOUND for unknown tool", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      expect(() =>
        h.symlinkService.readLinkTargets(project.id, "nope")
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.LINKED_DIR_NOT_FOUND })
      );
    });
  });

  describe("LinkedDir enrichment", () => {
    it("active link exposes absolute target_path and null broken_reason", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      const link = h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor"
      });
      expect(link.status).toBe(LinkedDirStatus.Active);
      expect(link.broken_reason).toBeNull();
      // target_path resolves the relative readlink against the link's
      // parent, yielding an absolute path to the primary tool dir.
      expect(link.target_path).toBe(path.join(h.projectDir.path, ".claude"));
    });

    it("broken_reason=target_missing when the primary dir vanishes", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // Delete the primary .claude/ dir the symlink points at.
      fs.rmSync(path.join(h.projectDir.path, ".claude"), {
        recursive: true,
        force: true
      });

      const links = h.symlinkService.list(project.id);
      expect(links[0]?.status).toBe(LinkedDirStatus.Broken);
      expect(links[0]?.broken_reason).toBe("target_missing");
      // target_path still reports where the link WANTED to go — helps UX
      // (we can say "→ <path> (missing!)").
      expect(links[0]?.target_path).toBe(
        path.join(h.projectDir.path, ".claude")
      );
    });

    it("broken_reason=not_a_symlink when the entry is a real directory", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // Replace the symlink with a real dir.
      const linkPath = path.join(h.projectDir.path, ".cursor");
      fs.unlinkSync(linkPath);
      fs.mkdirSync(linkPath);

      const links = h.symlinkService.list(project.id);
      expect(links[0]?.status).toBe(LinkedDirStatus.Broken);
      expect(links[0]?.broken_reason).toBe("not_a_symlink");
      // No target to report for a plain directory — it's not a symlink.
      expect(links[0]?.target_path).toBeNull();
    });

    it("status=removed + broken_reason=null when the link is gone", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // Remove the symlink entirely.
      fs.unlinkSync(path.join(h.projectDir.path, ".cursor"));

      const links = h.symlinkService.list(project.id);
      expect(links[0]?.status).toBe(LinkedDirStatus.Removed);
      expect(links[0]?.broken_reason).toBeNull();
      expect(links[0]?.target_path).toBeNull();
    });

    it("reconcile emits LinkedDirBroken event with enriched payload", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      fs.rmSync(path.join(h.projectDir.path, ".claude"), {
        recursive: true,
        force: true
      });

      const before = h.emitted.length;
      h.symlinkService.reconcile(project.id);
      const brokenEvent = h.emitted
        .slice(before)
        .find((e) => e.event.type === EventType.LinkedDirBroken);
      expect(brokenEvent).toBeDefined();
      const link = (
        brokenEvent!.event.payload as unknown as {
          link: { broken_reason: string | null; target_path: string | null };
        }
      ).link;
      expect(link.broken_reason).toBe("target_missing");
      expect(link.target_path).toBe(path.join(h.projectDir.path, ".claude"));
    });
  });
});
