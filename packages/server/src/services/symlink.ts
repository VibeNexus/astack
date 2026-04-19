/**
 * SymlinkService — manages symlinks from derived tool dirs (.cursor, .codebuddy)
 * to the project's primary tool dir (.claude).
 *
 * Per design.md § Eng Review decision 3:
 *   - Link grain is SUBDIRECTORY level:
 *       <project>/.cursor/commands  → ../.claude/commands
 *       <project>/.cursor/skills    → ../.claude/skills
 *     (not the whole .cursor directory — each AI tool may have its own
 *     root-level config files we must not clobber.)
 *
 *   - Only POSIX-style symlinks. Windows must run in Developer Mode; we
 *     surface SYMLINK_UNSUPPORTED and let the user turn it on.
 *
 *   - We do NOT cleanup the link's parent dir on remove — it may contain
 *     other tool-specific files.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  ToolLinkStatus,
  type ToolLink
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { ToolLinkRepository } from "../db/tool-links.js";
import type { EventBus } from "../events.js";
import {
  createSymlink,
  inspectSymlink,
  isSymlink,
  readSymlink
} from "../fs-util.js";
import type { Logger } from "../logger.js";

import type { ProjectService } from "./project.js";

/** Subdirectories we link for each tool. */
export const LINKED_SUBDIRS = ["commands", "skills"] as const;

export interface SymlinkServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
  projects: ProjectService;
}

export class SymlinkService {
  private readonly links: ToolLinkRepository;

  constructor(private readonly deps: SymlinkServiceDeps) {
    this.links = new ToolLinkRepository(deps.db);
  }

  /**
   * Create symlinks from `<project>/<dir_name>/commands` → `../.claude/commands`
   * and the same for `skills`.
   *
   * If a previous tool_link row exists (even if marked broken), it's replaced.
   */
  addLink(input: {
    project_id: number;
    tool_name: string;
    dir_name?: string;
  }): ToolLink {
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
        ErrorCode.TOOL_LINK_ALREADY_EXISTS,
        `tool '${tool_name}' already linked`,
        { project_id: project.id, tool_name }
      );
    }

    const toolDirAbs = path.join(project.path, dir_name);

    // Ensure parent tool dir exists.
    fs.mkdirSync(toolDirAbs, { recursive: true });

    // Create one symlink per subdir.
    for (const sub of LINKED_SUBDIRS) {
      const linkPath = path.join(toolDirAbs, sub);
      // Relative target makes the link portable across machines.
      const relativeTarget = path.join("..", project.primary_tool, sub);

      // Ensure the target exists (so the link isn't created broken).
      const primarySubAbs = path.join(project.path, project.primary_tool, sub);
      fs.mkdirSync(primarySubAbs, { recursive: true });

      createSymlink(linkPath, relativeTarget);
    }

    const row = this.links.insert({
      project_id: project.id,
      tool_name,
      dir_name
    });

    this.deps.events.emit({
      type: EventType.ToolLinkCreated,
      payload: { link: row }
    });

    return row;
  }

  /**
   * Remove the symlinks for a tool. Fails if no DB row exists.
   * Leaves the parent `dir_name` directory alone.
   */
  removeLink(projectId: number, tool_name: string): void {
    const project = this.deps.projects.mustFindById(projectId);
    const row = this.links.findByProjectTool(projectId, tool_name);
    if (!row) {
      throw new AstackError(
        ErrorCode.TOOL_LINK_NOT_FOUND,
        `no link for tool '${tool_name}'`,
        { project_id: projectId, tool_name }
      );
    }

    const toolDirAbs = path.join(project.path, row.dir_name);
    for (const sub of LINKED_SUBDIRS) {
      const linkPath = path.join(toolDirAbs, sub);
      if (isSymlink(linkPath)) {
        fs.unlinkSync(linkPath);
      }
    }

    this.links.deleteByProjectTool(projectId, tool_name);

    this.deps.events.emit({
      type: EventType.ToolLinkRemoved,
      payload: { project_id: projectId, tool_name }
    });
  }

  /**
   * Walk all tool_links for a project and reconcile the `status` column with
   * the actual filesystem state. Returns the post-reconcile rows.
   *
   * Status values:
   *   - active  : both subdirs symlink, both resolve
   *   - broken  : at least one subdir is a broken/missing symlink
   *   - removed : all subdirs are gone AND the dir_name itself is gone
   */
  reconcile(projectId: number): ToolLink[] {
    const project = this.deps.projects.mustFindById(projectId);
    const rows = this.links.listByProject(projectId);
    const out: ToolLink[] = [];

    for (const row of rows) {
      const toolDirAbs = path.join(project.path, row.dir_name);

      const subStates = LINKED_SUBDIRS.map((sub) => {
        const linkPath = path.join(toolDirAbs, sub);
        return inspectSymlink(linkPath);
      });

      let status: ToolLinkStatus;
      if (subStates.every((s) => s === "active")) {
        status = ToolLinkStatus.Active;
      } else if (subStates.every((s) => s === "missing")) {
        status = ToolLinkStatus.Removed;
      } else {
        status = ToolLinkStatus.Broken;
      }

      if (status !== row.status) {
        this.links.updateStatus(row.id, status);
        const updated: ToolLink = { ...row, status };
        if (status === ToolLinkStatus.Broken) {
          this.deps.events.emit({
            type: EventType.ToolLinkBroken,
            payload: { link: updated }
          });
        }
        out.push(updated);
      } else {
        out.push(row);
      }
    }

    return out;
  }

  list(projectId: number): ToolLink[] {
    return this.links.listByProject(projectId);
  }

  /**
   * Diagnostic: read the current on-disk target of a symlink, if present.
   * Used by `astack link list` to show users where each symlink points.
   */
  readLinkTargets(projectId: number, toolName: string): Record<string, string | null> {
    const project = this.deps.projects.mustFindById(projectId);
    const row = this.links.findByProjectTool(projectId, toolName);
    if (!row) {
      throw new AstackError(
        ErrorCode.TOOL_LINK_NOT_FOUND,
        `no link for tool '${toolName}'`,
        { project_id: projectId, tool_name: toolName }
      );
    }
    const out: Record<string, string | null> = {};
    for (const sub of LINKED_SUBDIRS) {
      out[sub] = readSymlink(path.join(project.path, row.dir_name, sub));
    }
    return out;
  }
}
