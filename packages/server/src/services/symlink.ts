/**
 * SymlinkService — manages symlinks from derived tool dirs (.cursor, .codebuddy, .codex, .gemini, .windsurf)
 * to the project's primary tool dir (.claude).
 *
 * v0.5 semantic change: link grain is **WHOLE DIRECTORY** (not subdirectory):
 *     <project>/.cursor      → ../.claude
 *     <project>/.codebuddy   → ../.claude
 *     <project>/.codex       → ../.claude
 *     <project>/.gemini      → ../.claude
 *
 * Rationale: users expect `.cursor` (or any linked tool) to behave as a
 * full alias of `.claude` — every skill, every command, every config
 * under `.claude/` shows up. The previous v0.3 subdirectory-level link
 * (only `commands/` + `skills/`) surfaced as a confusing "→ .claude/commands"
 * target in the UI and hid the fact that two subdir symlinks existed.
 *
 * Trade-off accepted (per user decision): if a tool has its own
 * root-level config files (settings.json, rules, etc.), linking the
 * whole dir means those settings must live inside `.claude` too.
 * `addLink` refuses to overwrite a pre-existing real `<dir_name>`
 * directory with `SYMLINK_TARGET_OCCUPIED`; users clean up manually
 * before linking.
 *
 * Design notes retained from v0.3:
 *   - POSIX-style symlinks only. Windows must run in Developer Mode;
 *     we surface SYMLINK_UNSUPPORTED and let the user turn it on.
 *   - Every returned `LinkedDir` is enriched via `enrichLink()` with
 *     `target_path` + `broken_reason` derived from the filesystem at
 *     read time — never persisted.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  LinkedDirBrokenReason,
  LinkedDirStatus,
  type Project,
  type LinkedDir,
  type LinkedDirBrokenReason as LinkedDirBrokenReasonT
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { LinkedDirRepository, type LinkedDirRow } from "../db/linked-dirs.js";
import type { EventBus } from "../events.js";
import {
  createSymlink,
  inspectSymlink,
  isSymlink,
  readSymlink
} from "../fs-util.js";
import type { Logger } from "../logger.js";

import type { ProjectService } from "./project.js";

export interface SymlinkServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  projects: ProjectService;
}

/**
 * Inspection of the single whole-dir symlink.
 */
interface LinkInspection {
  /** Absolute path to the entry on disk (e.g. <project>/.cursor). */
  linkPath: string;
  /**
   * Absolute resolved target, if this is a symlink. `null` if the entry
   * is missing or isn't a symlink at all.
   */
  target: string | null;
  health: "active" | "broken" | "missing";
  /** Populated when we can say WHY the health check failed. */
  brokenReason: LinkedDirBrokenReasonT | null;
}

/**
 * Inspect the tool-dir symlink. Derives everything the UI needs
 * (target, health, reason) from a single lstat + readlink + stat pass.
 */
function inspectLink(linkPath: string): LinkInspection {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(linkPath);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      return { linkPath, target: null, health: "missing", brokenReason: null };
    }
    if (errno === "EACCES" || errno === "EPERM") {
      return {
        linkPath,
        target: null,
        health: "broken",
        brokenReason: LinkedDirBrokenReason.PermissionDenied
      };
    }
    // Any other fs error: treat as broken (best we can do).
    return {
      linkPath,
      target: null,
      health: "broken",
      brokenReason: LinkedDirBrokenReason.PermissionDenied
    };
  }

  if (!lst.isSymbolicLink()) {
    // Regular file/dir at the path where a symlink should be.
    return {
      linkPath,
      target: null,
      health: "broken",
      brokenReason: LinkedDirBrokenReason.NotASymlink
    };
  }

  // It's a symlink — read it and check the target.
  let target: string;
  try {
    target = fs.readlinkSync(linkPath);
  } catch {
    return {
      linkPath,
      target: null,
      health: "broken",
      brokenReason: LinkedDirBrokenReason.PermissionDenied
    };
  }
  // readlink may return relative; resolve against the link's parent dir.
  const resolved = path.isAbsolute(target)
    ? target
    : path.resolve(path.dirname(linkPath), target);

  try {
    fs.statSync(resolved); // follows chain; throws if target gone
    return { linkPath, target: resolved, health: "active", brokenReason: null };
  } catch {
    return {
      linkPath,
      target: resolved,
      health: "broken",
      brokenReason: LinkedDirBrokenReason.TargetMissing
    };
  }
}

/**
 * Map the inspection into LinkedDir-level status.
 */
function rollupInspection(inspection: LinkInspection): {
  status: LinkedDirStatus;
  target_path: string | null;
  broken_reason: LinkedDirBrokenReasonT | null;
} {
  switch (inspection.health) {
    case "active":
      return {
        status: LinkedDirStatus.Active,
        target_path: inspection.target,
        broken_reason: null
      };
    case "missing":
      return {
        status: LinkedDirStatus.Removed,
        target_path: null,
        broken_reason: null
      };
    case "broken":
      return {
        status: LinkedDirStatus.Broken,
        target_path: inspection.target,
        broken_reason: inspection.brokenReason
      };
  }
}

export class SymlinkService {
  private readonly links: LinkedDirRepository;

  constructor(private readonly deps: SymlinkServiceDeps) {
    this.links = new LinkedDirRepository(deps.db);
  }

  /**
   * Read the filesystem state of a single linked_dir row and return the
   * enriched domain LinkedDir. Every public API that exposes a LinkedDir
   * goes through this helper to guarantee target_path + broken_reason
   * are always populated.
   */
  private enrichLink(project: Project, row: LinkedDirRow): LinkedDir {
    const linkPath = path.join(project.path, row.dir_name);
    const inspection = inspectLink(linkPath);
    const { status, target_path, broken_reason } = rollupInspection(inspection);
    return {
      ...row,
      status,
      target_path,
      broken_reason
    };
  }

  /**
   * Create the whole-dir symlink: `<project>/<dir_name>` → `<primary_tool>`.
   *
   * Refuses to overwrite a pre-existing real directory or file at the
   * link path (SYMLINK_TARGET_OCCUPIED) — users must clean up first
   * to avoid silent data loss of tool-specific root-level config.
   *
   * If the target `<project>/<primary_tool>` does not exist, it's
   * created (so the link isn't broken from the moment it's made).
   */
  addLink(input: {
    project_id: number;
    tool_name: string;
    dir_name?: string;
  }): LinkedDir {
    const project = this.deps.projects.mustFindById(input.project_id);
    const tool_name = input.tool_name.trim();
    if (!tool_name) {
      throw new AstackError(
        ErrorCode.VALIDATION_FAILED,
        "tool_name must be non-empty",
        { tool_name: input.tool_name }
      );
    }
    const dir_name = (input.dir_name ?? `.${tool_name}`).trim();

    const existing = this.links.findByProjectTool(project.id, tool_name);
    if (existing) {
      throw new AstackError(
        ErrorCode.LINKED_DIR_ALREADY_EXISTS,
        `tool '${tool_name}' already linked`,
        { project_id: project.id, tool_name }
      );
    }

    const linkPath = path.join(project.path, dir_name);
    const relativeTarget = project.primary_tool; // sibling → ".claude"

    // Ensure the primary tool dir itself exists, so the link isn't
    // born broken. We don't create skills/commands subdirs anymore —
    // the whole-dir link resolves regardless of what's inside.
    const primaryAbs = path.join(project.path, project.primary_tool);
    fs.mkdirSync(primaryAbs, { recursive: true });

    // createSymlink() refuses to overwrite a real dir/file — that's
    // what we want. It DOES replace a stale symlink, which is fine
    // (legacy subdir-link layouts leave a parent real dir, not a
    // symlink, so they'll correctly hit SYMLINK_TARGET_OCCUPIED and
    // force the user to delete .cursor/ before re-linking with new
    // semantics).
    createSymlink(linkPath, relativeTarget);

    const row = this.links.insert({
      project_id: project.id,
      tool_name,
      dir_name
    });

    const enriched = this.enrichLink(project, row);

    this.deps.events.emit({
      type: EventType.LinkedDirCreated,
      payload: { link: enriched }
    });

    return enriched;
  }

  /**
   * Remove the tool-dir symlink. Only unlinks the symlink entry itself;
   * any real file/dir at that path is left alone (shouldn't be there in
   * the v0.5 model, but we're defensive).
   */
  removeLink(projectId: number, tool_name: string): void {
    const project = this.deps.projects.mustFindById(projectId);
    const row = this.links.findByProjectTool(projectId, tool_name);
    if (!row) {
      throw new AstackError(
        ErrorCode.LINKED_DIR_NOT_FOUND,
        `no link for tool '${tool_name}'`,
        { project_id: projectId, tool_name }
      );
    }

    const linkPath = path.join(project.path, row.dir_name);
    if (isSymlink(linkPath)) {
      fs.unlinkSync(linkPath);
    }

    this.links.deleteByProjectTool(projectId, tool_name);

    this.deps.events.emit({
      type: EventType.LinkedDirRemoved,
      payload: { project_id: projectId, tool_name }
    });
  }

  /**
   * Walk all linked_dirs for a project and reconcile the `status` column with
   * the actual filesystem state. Returns the post-reconcile rows, fully
   * enriched with target_path + broken_reason.
   */
  reconcile(projectId: number): LinkedDir[] {
    const project = this.deps.projects.mustFindById(projectId);
    const rows = this.links.listByProject(projectId);
    const out: LinkedDir[] = [];

    for (const row of rows) {
      const enriched = this.enrichLink(project, row);

      if (enriched.status !== row.status) {
        this.links.updateStatus(row.id, enriched.status);
        if (enriched.status === LinkedDirStatus.Broken) {
          this.deps.events.emit({
            type: EventType.LinkedDirBroken,
            payload: { link: enriched }
          });
        }
      }
      out.push(enriched);
    }

    return out;
  }

  /**
   * Read-only variant of reconcile() — no DB writes, no events. Used by
   * endpoints that just want a snapshot (e.g. project status before any
   * write action).
   */
  list(projectId: number): LinkedDir[] {
    const project = this.deps.projects.mustFindById(projectId);
    const rows = this.links.listByProject(projectId);
    return rows.map((r) => this.enrichLink(project, r));
  }

  /**
   * Diagnostic: read the current on-disk target of the symlink, if present.
   * Used by `astack link list` to show users where the symlink points.
   *
   * Returns a single-entry record keyed by the dir_name (e.g. ".cursor")
   * for shape compatibility with older callers that expected a Record.
   */
  readLinkTargets(projectId: number, toolName: string): Record<string, string | null> {
    const project = this.deps.projects.mustFindById(projectId);
    const row = this.links.findByProjectTool(projectId, toolName);
    if (!row) {
      throw new AstackError(
        ErrorCode.LINKED_DIR_NOT_FOUND,
        `no link for tool '${toolName}'`,
        { project_id: projectId, tool_name: toolName }
      );
    }
    const linkPath = path.join(project.path, row.dir_name);
    return { [row.dir_name]: readSymlink(linkPath) };
  }
}

// Silence unused-import warning for the legacy `inspectSymlink` helper —
// kept exported from fs-util for other callers, but SymlinkService now
// uses the richer `inspectLink` defined in this file.
void inspectSymlink;
