/**
 * Tests for SymlinkService.
 *
 * Symlinks are real, not mocked. macOS supports POSIX symlinks out of the box.
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, EventType, ToolLinkStatus } from "@astack/shared";
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
      expect(link.status).toBe(ToolLinkStatus.Active);

      assertLinksActive("cursor");

      expect(
        h.emitted.some((e) => e.event.type === EventType.ToolLinkCreated)
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
        expect.objectContaining({ code: ErrorCode.TOOL_LINK_ALREADY_EXISTS })
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
        h.emitted.some((e) => e.event.type === EventType.ToolLinkRemoved)
      ).toBe(true);
    });

    it("throws TOOL_LINK_NOT_FOUND when link is unknown", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      expect(() => h.symlinkService.removeLink(project.id, "nope")).toThrowError(
        expect.objectContaining({ code: ErrorCode.TOOL_LINK_NOT_FOUND })
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
      expect(links[0].status).toBe(ToolLinkStatus.Broken);
      expect(
        h.emitted.some((e) => e.event.type === EventType.ToolLinkBroken)
      ).toBe(true);
    });

    it("returns active status unchanged when links are healthy", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      h.symlinkService.addLink({ project_id: project.id, tool_name: "cursor" });
      const before = h.emitted.length;
      const links = h.symlinkService.reconcile(project.id);
      expect(links[0].status).toBe(ToolLinkStatus.Active);
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

    it("throws TOOL_LINK_NOT_FOUND for unknown tool", () => {
      const project = h.projectService.register({ path: h.projectDir.path });
      expect(() =>
        h.symlinkService.readLinkTargets(project.id, "nope")
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.TOOL_LINK_NOT_FOUND })
      );
    });
  });
});
