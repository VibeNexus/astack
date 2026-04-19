/**
 * Tests for loadProjectContext — walks up from cwd looking for .astack.json.
 */

import fs from "node:fs";
import path from "node:path";

import { ErrorCode } from "@astack/shared";
import tmp from "tmp-promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectContext } from "../src/context.js";

describe("loadProjectContext", () => {
  let dir: tmp.DirectoryResult;

  beforeEach(async () => {
    dir = await tmp.dir({ unsafeCleanup: true });
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  function writeManifest(root: string, body: unknown): void {
    const mp = path.join(root, ".claude", ".astack.json");
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, JSON.stringify(body, null, 2));
  }

  it("loads context from cwd", () => {
    writeManifest(dir.path, {
      project_id: 7,
      server_url: "http://127.0.0.1:9000",
      primary_tool: ".claude"
    });
    const ctx = loadProjectContext(dir.path);
    expect(ctx.projectId).toBe(7);
    expect(ctx.rootPath).toBe(dir.path);
    expect(ctx.serverUrl).toBe("http://127.0.0.1:9000");
    expect(ctx.primaryTool).toBe(".claude");
  });

  it("walks up to find the manifest when started from a nested dir", () => {
    writeManifest(dir.path, { project_id: 1, server_url: "http://x" });
    const nested = path.join(dir.path, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    const ctx = loadProjectContext(nested);
    expect(ctx.rootPath).toBe(dir.path);
  });

  it("throws PROJECT_NOT_FOUND when no manifest is found anywhere", () => {
    expect(() => loadProjectContext(dir.path)).toThrowError(
      expect.objectContaining({ code: ErrorCode.PROJECT_NOT_FOUND })
    );
  });

  it("throws VALIDATION_FAILED when manifest is not valid JSON", () => {
    const mp = path.join(dir.path, ".claude", ".astack.json");
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, "{not json");
    expect(() => loadProjectContext(dir.path)).toThrowError(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED })
    );
  });

  it("throws VALIDATION_FAILED when project_id is missing", () => {
    writeManifest(dir.path, { server_url: "x" });
    expect(() => loadProjectContext(dir.path)).toThrowError(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED })
    );
  });

  it("defaults server_url and primary_tool when absent from file", () => {
    writeManifest(dir.path, { project_id: 1 });
    const ctx = loadProjectContext(dir.path);
    expect(ctx.serverUrl).toBe("http://127.0.0.1:7432");
    expect(ctx.primaryTool).toBe(".claude");
  });
});
