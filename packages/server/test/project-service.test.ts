/**
 * Tests for ProjectService.
 *
 * Focus: path validation, registration, removal, and status composition
 * (without subscriptions — those come from SubscriptionService).
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode, EventType } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Db } from "../src/db/connection.js";
import { EventBus, type EmittedEvent } from "../src/events.js";
import { nullLogger } from "../src/logger.js";
import { ProjectService } from "../src/services/project.js";

describe("ProjectService", () => {
  let db: Db;
  let events: EventBus;
  let emitted: EmittedEvent[];
  let service: ProjectService;
  let projectDir: tmp.DirectoryResult;

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    events = new EventBus();
    emitted = [];
    events.subscribe((e) => emitted.push(e));
    service = new ProjectService({ db, events, logger: nullLogger() });
    projectDir = await tmp.dir({ unsafeCleanup: true });
  });

  afterEach(async () => {
    db.close();
    await projectDir.cleanup();
  });

  describe("register", () => {
    it("registers a project and emits project.registered", () => {
      const project = service.register({ path: projectDir.path });
      expect(project.id).toBeGreaterThan(0);
      expect(project.path).toBe(projectDir.path);
      expect(project.name).toBe(path.basename(projectDir.path));
      expect(project.primary_tool).toBe(".claude");
      expect(
        emitted.some((e) => e.event.type === EventType.ProjectRegistered)
      ).toBe(true);
    });

    it("honors explicit name and primary_tool", () => {
      const project = service.register({
        path: projectDir.path,
        name: "my-app",
        primary_tool: ".custom"
      });
      expect(project.name).toBe("my-app");
      expect(project.primary_tool).toBe(".custom");
    });

    it("rejects relative paths", () => {
      expect(() => service.register({ path: "./relative" })).toThrowError(
        expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED })
      );
    });

    it("rejects missing paths", () => {
      expect(() =>
        service.register({ path: "/does/not/exist/astack-missing" })
      ).toThrowError(
        expect.objectContaining({ code: ErrorCode.PROJECT_PATH_MISSING })
      );
    });

    it("rejects duplicate path", () => {
      service.register({ path: projectDir.path });
      expect(() => service.register({ path: projectDir.path })).toThrowError(
        expect.objectContaining({ code: ErrorCode.PROJECT_ALREADY_REGISTERED })
      );
    });
  });

  describe("remove", () => {
    it("removes the project and emits project.removed", () => {
      const project = service.register({ path: projectDir.path });
      service.remove(project.id);
      expect(service.findById(project.id)).toBeNull();
      expect(
        emitted.some((e) => e.event.type === EventType.ProjectRemoved)
      ).toBe(true);
    });

    it("throws PROJECT_NOT_FOUND on unknown id", () => {
      expect(() => service.remove(9999)).toThrowError(
        expect.objectContaining({ code: ErrorCode.PROJECT_NOT_FOUND })
      );
    });
  });

  describe("list", () => {
    it("paginates and returns total", async () => {
      // Register 3 projects.
      for (let i = 0; i < 3; i++) {
        const sub = await tmp.dir({ unsafeCleanup: true });
        service.register({ path: sub.path });
      }
      const first = service.list({ offset: 0, limit: 2 });
      expect(first.total).toBe(3);
      expect(first.projects).toHaveLength(2);
      const second = service.list({ offset: 2, limit: 2 });
      expect(second.projects).toHaveLength(1);
    });
  });

  describe("composeStatus", () => {
    it("builds a ProjectStatus skeleton with zero subscriptions", () => {
      const project = service.register({ path: projectDir.path });
      const status = service.composeStatus(project.id, [], [], null);
      expect(status.project.id).toBe(project.id);
      expect(status.subscriptions).toEqual([]);
      expect(status.tool_links).toEqual([]);
      expect(status.last_synced).toBeNull();
    });
  });

  describe("findByPath", () => {
    it("returns null when unknown", () => {
      expect(service.findByPath("/nope")).toBeNull();
    });

    it("returns a registered project", () => {
      const project = service.register({ path: projectDir.path });
      expect(service.findByPath(projectDir.path)?.id).toBe(project.id);
    });
  });

  describe("mustFindById", () => {
    it("throws PROJECT_NOT_FOUND for unknown id", () => {
      expect(() => service.mustFindById(9999)).toThrowError(
        expect.objectContaining({ code: ErrorCode.PROJECT_NOT_FOUND })
      );
    });
  });

  describe("buildStatusSkeleton", () => {
    it("returns an empty tool_links list when none configured", () => {
      const project = service.register({ path: projectDir.path });
      const skeleton = service.buildStatusSkeleton(project.id, []);
      expect(skeleton.project.id).toBe(project.id);
      expect(skeleton.tool_links).toEqual([]);
    });
  });

  describe("listToolLinkRows", () => {
    it("returns [] initially", () => {
      const project = service.register({ path: projectDir.path });
      expect(service.listToolLinkRows(project.id)).toEqual([]);
    });
  });

  describe("fs side-effects", () => {
    it("does not modify the filesystem on register or remove", () => {
      const snapshotBefore = fs.readdirSync(projectDir.path).sort();
      const project = service.register({ path: projectDir.path });
      expect(fs.readdirSync(projectDir.path).sort()).toEqual(snapshotBefore);
      service.remove(project.id);
      expect(fs.readdirSync(projectDir.path).sort()).toEqual(snapshotBefore);
    });
  });

  // v0.3: primary_tool_status is derived at every read — never cached.
  describe("primary_tool_status", () => {
    it("is 'missing' when .claude/ does not exist", () => {
      const project = service.register({ path: projectDir.path });
      expect(project.primary_tool_status).toBe("missing");
    });

    it("is 'empty' when .claude/ exists but has no skills/ or commands/", () => {
      fs.mkdirSync(path.join(projectDir.path, ".claude"));
      const project = service.register({ path: projectDir.path });
      expect(project.primary_tool_status).toBe("empty");
    });

    it("is 'initialized' when .claude/skills/ exists", () => {
      fs.mkdirSync(path.join(projectDir.path, ".claude", "skills"), {
        recursive: true
      });
      const project = service.register({ path: projectDir.path });
      expect(project.primary_tool_status).toBe("initialized");
    });

    it("is 'initialized' when .claude/commands/ exists (skills/ missing is fine)", () => {
      fs.mkdirSync(path.join(projectDir.path, ".claude", "commands"), {
        recursive: true
      });
      const project = service.register({ path: projectDir.path });
      expect(project.primary_tool_status).toBe("initialized");
    });

    it("re-evaluates on every read — adding skills/ after register flips status", () => {
      const project = service.register({ path: projectDir.path });
      expect(project.primary_tool_status).toBe("missing");

      fs.mkdirSync(path.join(projectDir.path, ".claude", "skills"), {
        recursive: true
      });
      const refetched = service.mustFindById(project.id);
      expect(refetched.primary_tool_status).toBe("initialized");
    });

    it("list() returns enriched status for every project", async () => {
      const b = await tmp.dir({ unsafeCleanup: true });
      try {
        fs.mkdirSync(path.join(projectDir.path, ".claude", "skills"), {
          recursive: true
        });
        service.register({ path: projectDir.path });
        service.register({ path: b.path });

        const { projects } = service.list({ offset: 0, limit: 10 });
        expect(projects).toHaveLength(2);
        const byPath = new Map(projects.map((p) => [p.path, p]));
        expect(byPath.get(projectDir.path)!.primary_tool_status).toBe(
          "initialized"
        );
        expect(byPath.get(b.path)!.primary_tool_status).toBe("missing");
      } finally {
        await b.cleanup();
      }
    });
  });
});
