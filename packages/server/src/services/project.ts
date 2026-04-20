/**
 * ProjectService — business logic for target project registration.
 *
 * Projects are [SOURCE] rows — SQLite is authoritative for the registry.
 * Paths must be absolute; service does not auto-resolve relative paths.
 */

import fs from "node:fs";
import path from "node:path";

import {
  AstackError,
  ErrorCode,
  EventType,
  PrimaryToolStatus,
  type PrimaryToolStatus as PrimaryToolStatusT,
  type Project,
  type ProjectStatus,
  type SubscriptionWithState,
  type ToolLink
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { ProjectRepository, type ProjectRow } from "../db/projects.js";
import { ToolLinkRepository } from "../db/tool-links.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";

export interface ProjectServiceDeps {
  db: Db;
  events: EventBus;
  logger: Logger;
}

export interface RegisterProjectInput {
  path: string;
  name?: string;
  primary_tool?: string;
}

/**
 * Inspect `<project_path>/<primary_tool>/` and derive an initialization
 * state for the Projects-list badge (v0.3).
 *
 * Heuristic matches what the `.claude/` convention uses — having one of
 * `skills/` or `commands/` = meaningfully initialized, not just "someone
 * mkdir'd the dir". This mirrors how scanner treats the project: an
 * empty `.claude/` is indistinguishable from "never initialized" for
 * our purposes.
 */
function derivePrimaryToolStatus(
  projectPath: string,
  primaryTool: string
): PrimaryToolStatusT {
  const dir = path.join(projectPath, primaryTool);
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return PrimaryToolStatus.Missing;
  } catch {
    return PrimaryToolStatus.Missing;
  }
  const skillsExists = fs.existsSync(path.join(dir, "skills"));
  const commandsExists = fs.existsSync(path.join(dir, "commands"));
  return skillsExists || commandsExists
    ? PrimaryToolStatus.Initialized
    : PrimaryToolStatus.Empty;
}

export class ProjectService {
  private readonly projects: ProjectRepository;
  private readonly toolLinks: ToolLinkRepository;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.projects = new ProjectRepository(deps.db);
    this.toolLinks = new ToolLinkRepository(deps.db);
  }

  /**
   * Inflate a repo row (no primary_tool_status) into a full domain
   * Project by probing the filesystem. Called at every outbound point —
   * insert/find/list — so the wire shape is always self-consistent.
   */
  private enrich(row: ProjectRow): Project {
    return {
      ...row,
      primary_tool_status: derivePrimaryToolStatus(row.path, row.primary_tool)
    };
  }

  register(input: RegisterProjectInput): Project {
    if (!path.isAbsolute(input.path)) {
      throw new AstackError(
        ErrorCode.VALIDATION_FAILED,
        "project path must be absolute",
        { path: input.path }
      );
    }
    if (!fs.existsSync(input.path)) {
      throw new AstackError(
        ErrorCode.PROJECT_PATH_MISSING,
        "project path does not exist",
        { path: input.path }
      );
    }
    if (this.projects.findByPath(input.path)) {
      throw new AstackError(
        ErrorCode.PROJECT_ALREADY_REGISTERED,
        "project path already registered",
        { path: input.path }
      );
    }

    const name = (input.name ?? path.basename(input.path)).trim();
    if (!name) {
      throw new AstackError(
        ErrorCode.VALIDATION_FAILED,
        "could not derive project name from path",
        { path: input.path }
      );
    }

    const project = this.enrich(
      this.projects.insert({
        name,
        path: input.path,
        primary_tool: input.primary_tool ?? ".claude"
      })
    );

    this.deps.events.emit({
      type: EventType.ProjectRegistered,
      payload: { project }
    });

    return project;
  }

  /**
   * Unregister a project. Cascades to subscriptions / sync_logs / tool_links
   * via FK ON DELETE CASCADE. Does NOT touch the filesystem.
   */
  remove(projectId: number): void {
    const project = this.mustFindById(projectId);
    const deleted = this.projects.delete(projectId);
    if (!deleted) {
      throw new AstackError(ErrorCode.PROJECT_NOT_FOUND, "project not found", {
        project_id: projectId
      });
    }
    this.deps.events.emit({
      type: EventType.ProjectRemoved,
      payload: { project_id: project.id }
    });
  }

  findById(projectId: number): Project | null {
    const row = this.projects.findById(projectId);
    return row ? this.enrich(row) : null;
  }

  findByPath(p: string): Project | null {
    const row = this.projects.findByPath(p);
    return row ? this.enrich(row) : null;
  }

  list(opts: { offset: number; limit: number }): {
    projects: Project[];
    total: number;
  } {
    const { rows, total } = this.projects.list(opts);
    return { projects: rows.map((r) => this.enrich(r)), total };
  }

  mustFindById(projectId: number): Project {
    const row = this.projects.findById(projectId);
    if (!row) {
      throw new AstackError(ErrorCode.PROJECT_NOT_FOUND, "project not found", {
        project_id: projectId
      });
    }
    return this.enrich(row);
  }

  /**
   * Build the aggregate view used by `GET /api/projects/:id/status` and the
   * Dashboard's Sync Status page.
   *
   * Returns a skeleton ProjectStatus; SubscriptionService fills in the
   * `subscriptions` array, and SymlinkService provides enriched
   * `tool_links` (with target_path + broken_reason) via the route layer.
   *
   * v0.3: callers pass `tool_links` because SymlinkService owns the
   * filesystem-derived fields (target_path, broken_reason) that the repo
   * layer alone can't produce.
   */
  buildStatusSkeleton(
    projectId: number,
    tool_links: ToolLink[]
  ): Omit<ProjectStatus, "subscriptions"> {
    const project = this.mustFindById(projectId);
    return {
      project,
      tool_links,
      last_synced: null
    };
  }

  /**
   * Raw tool_link rows straight from the DB. Callers who only need
   * identity (id, tool_name, dir_name) can use this; anything that wants
   * the live filesystem state (`target_path`, `broken_reason`, accurate
   * `status`) must go through SymlinkService.list() instead.
   */
  listToolLinkRows(projectId: number): Array<{
    id: number;
    project_id: number;
    tool_name: string;
    dir_name: string;
    status: ToolLink["status"];
    created_at: ToolLink["created_at"];
  }> {
    return this.toolLinks.listByProject(projectId);
  }

  /**
   * Exposed so callers (e.g. status endpoint) can compose complete
   * ProjectStatus without re-fetching. Service caller is responsible for
   * computing the sync state per subscription and for supplying
   * filesystem-enriched tool_links (via SymlinkService).
   */
  composeStatus(
    projectId: number,
    subscriptions: SubscriptionWithState[],
    tool_links: ToolLink[],
    last_synced: string | null
  ): ProjectStatus {
    const skeleton = this.buildStatusSkeleton(projectId, tool_links);
    return {
      project: skeleton.project,
      tool_links: skeleton.tool_links,
      subscriptions,
      last_synced
    };
  }
}
