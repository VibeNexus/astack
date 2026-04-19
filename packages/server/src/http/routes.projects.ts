/**
 * /api/projects routes.
 *
 * Covers project registration, status view, and diff reads.
 * Subscription / sync / resolve / links live in their own route files.
 */

import {
  ListProjectsQuerySchema,
  ProjectParamsSchema,
  ProjectSkillParamsSchema,
  RegisterProjectRequestSchema,
  SubscriptionState,
  type DeleteProjectResponse,
  type GetProjectStatusResponse,
  type GetSkillDiffResponse,
  type ListProjectsResponse,
  type RegisterProjectResponse,
  type SubscriptionWithState
} from "@astack/shared";
import { zValidator } from "./validator.js";
import { Hono } from "hono";

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
    // Reconcile symlink health first so broken-link rows surface accurately.
    c.symlinkService.reconcile(id);
    const { subscriptions, last_synced } = c.syncService.listWithState(id);
    const response: GetProjectStatusResponse = c.projectService.composeStatus(
      id,
      subscriptions,
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

  // Silence unused import warning — SubscriptionState is re-exported for
  // consumers who want to narrow on SubscriptionWithState.state values.
  void SubscriptionState;
  void (null as unknown as SubscriptionWithState);

  return app;
}
