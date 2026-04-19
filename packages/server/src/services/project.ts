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
  type Project,
  type ProjectStatus,
  type SubscriptionWithState,
  type ToolLink
} from "@astack/shared";

import type { Db } from "../db/connection.js";
import { ProjectRepository } from "../db/projects.js";
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

export class ProjectService {
  private readonly projects: ProjectRepository;
  private readonly toolLinks: ToolLinkRepository;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.projects = new ProjectRepository(deps.db);
    this.toolLinks = new ToolLinkRepository(deps.db);
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

    const project = this.projects.insert({
      name,
      path: input.path,
      primary_tool: input.primary_tool ?? ".claude"
    });

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
    return this.projects.findById(projectId);
  }

  findByPath(p: string): Project | null {
    return this.projects.findByPath(p);
  }

  list(opts: { offset: number; limit: number }): {
    projects: Project[];
    total: number;
  } {
    const { rows, total } = this.projects.list(opts);
    return { projects: rows, total };
  }

  mustFindById(projectId: number): Project {
    const row = this.projects.findById(projectId);
    if (!row) {
      throw new AstackError(ErrorCode.PROJECT_NOT_FOUND, "project not found", {
        project_id: projectId
      });
    }
    return row;
  }

  /**
   * Build the aggregate view used by `GET /api/projects/:id/status` and the
   * Dashboard's Sync Status page.
   *
   * Returns a skeleton ProjectStatus; SubscriptionService fills in the
   * `subscriptions` array (this service can't compute sync state alone).
   */
  buildStatusSkeleton(projectId: number): Omit<ProjectStatus, "subscriptions"> {
    const project = this.mustFindById(projectId);
    const tool_links = this.toolLinks.listByProject(projectId);
    return {
      project,
      tool_links,
      last_synced: null
    };
  }

  /** Helper for services that need raw tool links list. */
  listToolLinks(projectId: number): ToolLink[] {
    return this.toolLinks.listByProject(projectId);
  }

  /**
   * Exposed so callers (e.g. status endpoint) can compose complete
   * ProjectStatus without re-fetching. Service caller is responsible for
   * computing the sync state per subscription.
   */
  composeStatus(
    projectId: number,
    subscriptions: SubscriptionWithState[],
    last_synced: string | null
  ): ProjectStatus {
    const skeleton = this.buildStatusSkeleton(projectId);
    return {
      project: skeleton.project,
      tool_links: skeleton.tool_links,
      subscriptions,
      last_synced
    };
  }
}
