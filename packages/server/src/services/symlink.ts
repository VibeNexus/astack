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
 *
 * v0.3: every returned `ToolLink` is enriched via `enrichLink()` with
 *   - `target_path`: the resolved absolute target of the first subdir's
 *     symlink (we pick `commands/` because it's always present; `skills/`
 *     would be equivalent). The dashboard needs ONE target to show; we
 *     don't need the per-subdir breakdown at the row level.
 *   - `broken_reason`: categorical reason the link is broken, so the UI
 *     can say "target missing" vs "not a symlink" vs "permission denied"
 *     instead of a useless "broken" status dot.
 *
 * These fields are never persisted. Every `listByProject` / `findByProjectTool`
 * call returns fresh values derived from the filesystem right now — if the
 * user deletes `.claude/` out of band, the next read reflects that.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  ToolLinkBrokenReason,
  ToolLinkStatus,
  type Project,
  type ToolLink,
  type ToolLinkBrokenReason as ToolLinkBrokenReasonT
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { ToolLinkRepository, type ToolLinkRow } from "../db/tool-links.js";
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

/**
 * What one subdirectory symlink looks like on disk.
 * Combines the health check with the enriched state the UI wants.
 */
interface SubdirInspection {
  /** Absolute path to the symlink entry on disk. */
  linkPath: string;
  /**
   * Absolute resolved target, if this is a symlink. `null` if the entry
   * is missing or isn't a symlink at all.
   */
  target: string | null;
  health: "active" | "broken" | "missing";
  /** Populated when we can say WHY the health check failed. */
  brokenReason: ToolLinkBrokenReasonT | null;
}

/**
 * Inspect a single subdirectory symlink. Derives everything the UI needs
 * (target, health, reason) from a single lstat + readlink + stat pass.
 */
function inspectSubdir(linkPath: string): SubdirInspection {
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
        brokenReason: ToolLinkBrokenReason.PermissionDenied
      };
    }
    // Any other fs error: treat as broken (best we can do).
    return {
      linkPath,
      target: null,
      health: "broken",
      brokenReason: ToolLinkBrokenReason.PermissionDenied
    };
  }

  if (!lst.isSymbolicLink()) {
    // Regular file/dir at the path where a symlink should be.
    return {
      linkPath,
      target: null,
      health: "broken",
      brokenReason: ToolLinkBrokenReason.NotASymlink
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
      brokenReason: ToolLinkBrokenReason.PermissionDenied
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
      brokenReason: ToolLinkBrokenReason.TargetMissing
    };
  }
}

/**
 * Combine per-subdir inspections into a single ToolLink-level status
 * + the fields the UI wants.
 */
function rollupInspections(
  subs: SubdirInspection[]
): {
  status: ToolLinkStatus;
  target_path: string | null;
  broken_reason: ToolLinkBrokenReasonT | null;
} {
  // Status: active only if every subdir is active; removed only if every
  // subdir is missing; broken otherwise.
  let status: ToolLinkStatus;
  if (subs.every((s) => s.health === "active")) {
    status = ToolLinkStatus.Active;
  } else if (subs.every((s) => s.health === "missing")) {
    status = ToolLinkStatus.Removed;
  } else {
    status = ToolLinkStatus.Broken;
  }

  // target_path: pick the first subdir that has a target. The two subdirs
  // always point at sibling directories under the same primary tool dir,
  // so showing one is enough for the "→ .claude" hint in the UI.
  const firstWithTarget = subs.find((s) => s.target !== null);
  const target_path = firstWithTarget?.target ?? null;

  // broken_reason: pick the first subdir's reason when we're broken. If
  // subdirs disagree (one missing, one wrong type), the first one wins —
  // rare in practice since both subs are created in the same addLink call.
  let broken_reason: ToolLinkBrokenReasonT | null = null;
  if (status === ToolLinkStatus.Broken) {
    const firstBroken = subs.find((s) => s.brokenReason !== null);
    broken_reason = firstBroken?.brokenReason ?? null;
  }

  return { status, target_path, broken_reason };
}

export class SymlinkService {
  private readonly links: ToolLinkRepository;

  constructor(private readonly deps: SymlinkServiceDeps) {
    this.links = new ToolLinkRepository(deps.db);
  }

  /**
   * Read the filesystem state of a single tool_link row and return the
   * enriched domain ToolLink. Every public API that exposes a ToolLink
   * goes through this helper to guarantee target_path + broken_reason
   * are always populated.
   */
  private enrichLink(project: Project, row: ToolLinkRow): ToolLink {
    const toolDirAbs = path.join(project.path, row.dir_name);
    const subs = LINKED_SUBDIRS.map((sub) =>
      inspectSubdir(path.join(toolDirAbs, sub))
    );
    const { status, target_path, broken_reason } = rollupInspections(subs);
    return {
      ...row,
      status,
      target_path,
      broken_reason
    };
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

    const enriched = this.enrichLink(project, row);

    this.deps.events.emit({
      type: EventType.ToolLinkCreated,
      payload: { link: enriched }
    });

    return enriched;
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
   * the actual filesystem state. Returns the post-reconcile rows, fully
   * enriched with target_path + broken_reason.
   */
  reconcile(projectId: number): ToolLink[] {
    const project = this.deps.projects.mustFindById(projectId);
    const rows = this.links.listByProject(projectId);
    const out: ToolLink[] = [];

    for (const row of rows) {
      const enriched = this.enrichLink(project, row);

      if (enriched.status !== row.status) {
        this.links.updateStatus(row.id, enriched.status);
        if (enriched.status === ToolLinkStatus.Broken) {
          this.deps.events.emit({
            type: EventType.ToolLinkBroken,
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
  list(projectId: number): ToolLink[] {
    const project = this.deps.projects.mustFindById(projectId);
    const rows = this.links.listByProject(projectId);
    return rows.map((r) => this.enrichLink(project, r));
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

// Silence unused-import warning for the legacy `inspectSymlink` helper —
// kept exported from fs-util for other callers, but SymlinkService now
// uses the richer `inspectSubdir` defined in this file.
void inspectSymlink;