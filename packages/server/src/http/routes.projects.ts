/**
 * /api/projects routes.
 *
 * Covers project registration, status view, and diff reads.
 * Subscription / sync / resolve / links live in their own route files.
 */

import {
  ListProjectsQuerySchema,
  ListSyncLogsQuerySchema,
  ProjectParamsSchema,
  ProjectSkillParamsSchema,
  RegisterProjectRequestSchema,
  SubscriptionState,
  type DeleteProjectResponse,
  type GetProjectStatusResponse,
  type GetSkillDiffResponse,
  type ListProjectsResponse,
  type ListSyncLogsResponse,
  type RegisterProjectResponse,
  type SubscriptionWithState
} from "@astack/shared";
import { zValidator } from "./validator.js";
import { Hono } from "hono";

import { SyncLogRepository } from "../db/sync-logs.js";

import type { ServiceContainer } from "./container.js";

export function projectsRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  // POST /api/projects — register project.
  app.post("/", zValidator("json", RegisterProjectRequestSchema), (ctx) => {
    const body = ctx.req.valid("json");
    const project = c.projectService.register(body);
    const response: RegisterProjectResponse = { project };
    return ctx.json(response, 201);
  });

  // GET /api/projects — list.
  app.get("/", zValidator("query", ListProjectsQuerySchema), (ctx) => {
    const q = ctx.req.valid("query");
    const { projects, total } = c.projectService.list(q);
    const response: ListProjectsResponse = { projects, total };
    return ctx.json(response);
  });

  // DELETE /api/projects/:id — unregister.
  app.delete("/:id", zValidator("param", ProjectParamsSchema), (ctx) => {
    const { id } = ctx.req.valid("param");
    c.projectService.remove(id);
    const response: DeleteProjectResponse = { deleted: true, id };
    return ctx.json(response);
  });

  // GET /api/projects/:id/status — aggregated Sync Status view.
  app.get("/:id/status", zValidator("param", ProjectParamsSchema), (ctx) => {
    const { id } = ctx.req.valid("param");
    // Reconcile symlink health first so broken-link rows surface accurately;
    // reconcile also returns the enriched tool_links (target_path +
    // broken_reason) that the response type requires.
    const tool_links = c.symlinkService.reconcile(id);
    const { subscriptions, last_synced } = c.syncService.listWithState(id);
    const response: GetProjectStatusResponse = c.projectService.composeStatus(
      id,
      subscriptions,
      tool_links,
      last_synced
    );
    return ctx.json(response);
  });

  // GET /api/projects/:id/diff/:skill_id — local vs upstream diff.
  app.get(
    "/:id/diff/:skill_id",
    zValidator("param", ProjectSkillParamsSchema),
    (ctx) => {
      const { id, skill_id } = ctx.req.valid("param");
      const info = c.syncService.readDiff(id, skill_id);
      const response: GetSkillDiffResponse = {
        identical: info.identical,
        // v1 returns empty diff text; a proper unified diff can be added later.
        diff: "",
        upstream_version: info.upstream_version,
        working_version: info.working_version
      };
      return ctx.json(response);
    }
  );

  // GET /api/projects/:id/sync-logs — history feed (v0.3).
  //
  // Raw sync_logs are stripped of the server-internal `content_hash` column
  // before serialization — content_hash is how the server distinguishes
  // Behind vs. Conflict across pulls, not something clients care about.
  const syncLogs = new SyncLogRepository(c.db);
  app.get(
    "/:id/sync-logs",
    zValidator("param", ProjectParamsSchema),
    zValidator("query", ListSyncLogsQuerySchema),
    (ctx) => {
      const { id } = ctx.req.valid("param");
      const q = ctx.req.valid("query");
      // Verify project exists; throws PROJECT_NOT_FOUND otherwise.
      c.projectService.mustFindById(id);

      const { logs, total } = syncLogs.listForProject(id, {
        limit: q.limit,
        offset: q.offset,
        skill_id: q.skill_id,
        direction: q.direction,
        status: q.status
      });

      const response: ListSyncLogsResponse = {
        // Strip content_hash (internal) before sending to clients.
        logs: logs.map(({ content_hash: _ch, ...rest }) => rest),
        total,
        has_more: q.offset + logs.length < total
      };
      return ctx.json(response);
    }
  );

  // Silence unused import warning — SubscriptionState is re-exported for
  // consumers who want to narrow on SubscriptionWithState.state values.
  void SubscriptionState;
  void (null as unknown as SubscriptionWithState);

  return app;
}
