/**
 * Project context loader.
 *
 * Every CLI command (except `init` and `server`) needs to know which
 * project it's operating on. We resolve that from the project's
 * `.claude/.astack.json` by walking up from cwd.
 */

import fs from "node:fs";
import path from "node:path";

import { AstackError, ErrorCode } from "@astack/shared";

export interface ProjectContext {
  /** Absolute path to the project root. */
  rootPath: string;
  /** ID assigned by the daemon at `astack init` time. */
  projectId: number;
  /** Primary tool directory (default ".claude"). */
  primaryTool: string;
  /** Server URL stored in the manifest. */
  serverUrl: string;
}

/**
 * Walk up from `startDir` looking for a `.claude/.astack.json` file.
 * Stops at filesystem root. Throws if not found.
 */
export function loadProjectContext(startDir: string = process.cwd()): ProjectContext {
  let dir = path.resolve(startDir);
  while (true) {
    const manifestPath = path.join(dir, ".claude", ".astack.json");
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AstackError(
          ErrorCode.VALIDATION_FAILED,
          `invalid .astack.json at ${manifestPath}`,
          { file: manifestPath }
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { project_id?: unknown }).project_id !== "number"
      ) {
        throw new AstackError(
          ErrorCode.VALIDATION_FAILED,
          `.astack.json is missing required fields (project_id)`,
          { file: manifestPath }
        );
      }
      const obj = parsed as {
        project_id: number;
        server_url?: string;
        primary_tool?: string;
      };
      return {
        rootPath: dir,
        projectId: obj.project_id,
        primaryTool: obj.primary_tool ?? ".claude",
        serverUrl: obj.server_url ?? "http://127.0.0.1:7432"
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new AstackError(
    ErrorCode.PROJECT_NOT_FOUND,
    "no .astack.json found; run `astack init` in your project root first",
    { searched_from: startDir }
  );
}

/** Default daemon URL when no project context exists. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7432";
