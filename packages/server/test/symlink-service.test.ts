/**
 * Tests for SymlinkService.
 *
 * Symlinks are real, not mocked. macOS supports POSIX symlinks out of the box.
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, EventType, LinkedDirStatus } from "@astack/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LINKED_SUBDIRS } from "../src/services/symlink.js";

import { createHarness, type Harness } from "./helpers/harness.js";

describe("SymlinkService", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  function assertLinksActive(toolName: string): void {
    const dir = path.join(h.projectDir.path, `.${toolName}`);
    for (const sub of LINKED_SUBDIRS) {
      const linkPath = path.join(dir, sub);
      const stat = fs.lstatSync(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = fs.readlinkSync(linkPath);
      expect(target).toBe(path.join("..", ".claude", sub));
      // target resolves (followSymlinks should work).
      expect(fs.existsSync(linkPath)).toBe(true);
    }
  }

  describe("addLink", () => {
    it("creates symlinks at commands/ and skills/ subdirs", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      const link = h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor"
      });

      expect(link.tool_name).toBe("cursor");
      expect(link.dir_name).toBe(".cursor");
      expect(link.status).toBe(LinkedDirStatus.Active);

      assertLinksActive("cursor");

      expect(
        h.emitted.some((e) => e.event.type === EventType.LinkedDirCreated)
      ).toBe(true);
    });

    it("honors explicit dir_name override", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor",
        dir_name: ".cursor-custom"
      });
      expect(
        fs.lstatSync(
          path.join(h.projectDir.path, ".cursor-custom/commands")
        ).isSymbolicLink()
      ).toBe(true);
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
      // Pre-create a real commands/ directory under .cursor.
      fs.mkdirSync(path.join(h.projectDir.path, ".cursor", "commands"), {
        recursive: true
      });
      expect(() =>
        h.symlinkService.addLink({
          project_id: project.id,
          tool_name: "cursor"
        })
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.SYMLINK_TARGET_OCCUPIED })
      );
    });
  });

  describe("removeLink", () => {
    it("removes symlinks and the DB row", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });

      h.symlinkService.removeLink(project.id, "cursor");

      expect(
        fs.existsSync(path.join(h.projectDir.path, ".cursor/commands"))
      ).toBe(false);
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

    it("leaves the parent tool dir in place (may contain other config)", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // User drops a settings.json in .cursor/.
      fs.writeFileSync(
        path.join(h.projectDir.path, ".cursor/settings.json"),
        "{}"
      );
      h.symlinkService.removeLink(project.id, "cursor");
      expect(
        fs.existsSync(path.join(h.projectDir.path, ".cursor/settings.json"))
      ).toBe(true);
    });
  });

  describe("reconcile", () => {
    it("marks status=broken when a link subdir is deleted externally", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });

      // User breaks the link.
      fs.unlinkSync(path.join(h.projectDir.path, ".cursor/commands"));
      fs.mkdirSync(
        path.join(h.projectDir.path, ".cursor/commands"),
        { recursive: true }
      );
      // Now commands/ is a real empty dir — not a symlink (broken in our terms).

      const links = h.symlinkService.reconcile(project.id);
      expect(links[0].status).toBe(LinkedDirStatus.Broken);
      expect(
        h.emitted.some((e) => e.event.type === EventType.LinkedDirBroken)
      ).toBe(true);
    });

    it("returns active status unchanged when links are healthy", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      const before = h.emitted.length;
      const links = h.symlinkService.reconcile(project.id);
      expect(links[0].status).toBe(LinkedDirStatus.Active);
      // No new events when status didn't change.
      expect(h.emitted.length).toBe(before);
    });
  });

  describe("readLinkTargets", () => {
    it("returns the symlink targets for each subdir", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      const targets = h.symlinkService.readLinkTargets(project.id, "cursor");
      expect(targets.commands).toBe(path.join("..", ".claude", "commands"));
      expect(targets.skills).toBe(path.join("..", ".claude", "skills"));
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

  // v0.3: target_path + broken_reason enrichment
  describe("LinkedDir enrichment", () => {
    it("active link exposes absolute target_path and null broken_reason", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      const link = h.symlinkService.addLink({
        project_id: project.id,
        tool_name: "cursor"
      });
      expect(link.status).toBe(LinkedDirStatus.Active);
      expect(link.broken_reason).toBeNull();
      // target_path is derived from `commands/` (first subdir). readlink
      // returned `../.claude/commands`; we resolve relative to the symlink's
      // parent so the consumer sees an absolute path.
      expect(link.target_path).toBe(
        path.join(h.projectDir.path, ".claude", "commands")
      );
    });

    it("broken_reason=target_missing when the target dir vanishes", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // Delete the primary .claude/ dir (both subdirs).
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
        path.join(h.projectDir.path, ".claude", "commands")
      );
    });

    it("broken_reason=not_a_symlink when the entry is a real directory", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // Replace the commands symlink with a real dir.
      fs.unlinkSync(path.join(h.projectDir.path, ".cursor/commands"));
      fs.mkdirSync(path.join(h.projectDir.path, ".cursor/commands"));

      const links = h.symlinkService.list(project.id);
      expect(links[0]?.status).toBe(LinkedDirStatus.Broken);
      expect(links[0]?.broken_reason).toBe("not_a_symlink");
      // target_path falls back to the OTHER subdir (skills/) which is
      // still a healthy symlink — showing users *something* is better
      // than null when one side works.
      expect(links[0]?.target_path).toBe(
        path.join(h.projectDir.path, ".claude", "skills")
      );
    });

    it("status=removed + broken_reason=null when both subdirs are gone", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      // Remove the whole .cursor dir — both subdirs now missing.
      fs.rmSync(path.join(h.projectDir.path, ".cursor"), {
        recursive: true,
        force: true
      });

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
      expect(link.target_path).toBe(
        path.join(h.projectDir.path, ".claude", "commands")
      );
    });
  });
});
