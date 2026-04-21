/**
 * /api/projects routes.
 *
 * Covers project registration, status view, and diff reads.
 * Subscription / sync / resolve / links live in their own route files.
 */

import {
  IgnoreBootstrapRequestSchema,
  ListProjectsQuerySchema,
  ListSyncLogsQuerySchema,
  ProjectParamsSchema,
  ProjectSkillParamsSchema,
  RegisterProjectRequestSchema,
  ResolveBootstrapRequestSchema,
  SubscriptionState,
  type ApplyResolutionsResult,
  type DeleteProjectResponse,
  type GetProjectStatusResponse,
  type GetSkillDiffResponse,
  type ListProjectsResponse,
  type ListSyncLogsResponse,
  type ProjectBootstrapResult,
  type RegisterProjectResponse,
  type ScanAndAutoSubscribeResult,
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
    // reconcile also returns the enriched linked_dirs (target_path +
    // broken_reason) that the response type requires.
    const linked_dirs = c.symlinkService.reconcile(id);
    const { subscriptions, last_synced } = c.syncService.listWithState(id);
    const response: GetProjectStatusResponse = c.projectService.composeStatus(
      id,
      subscriptions,
      linked_dirs,
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

  // GET /api/projects/:id/harness — inspect harness-init skill state (v0.4).
  // Pure read: no fs writes, no SSE emission, no db changes.
  app.get(
    "/:id/harness",
    zValidator("param", ProjectParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      // mustFindById on 404 before touching SystemSkillService so the
      // error comes from the project domain, not harness domain.
      c.projectService.mustFindById(id);
      const state = await c.systemSkillService.inspect(id, "harness-init");
      ctx.header("Cache-Control", "no-store");
      return ctx.json(state);
    }
  );

  // POST /api/projects/:id/harness/install — force re-seed (v0.4).
  // Overwrites any local modifications. Emits harness.changed.
  app.post(
    "/:id/harness/install",
    zValidator("param", ProjectParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      c.projectService.mustFindById(id);
      const state = await c.systemSkillService.seed(id, "harness-init");
      return ctx.json(state);
    }
  );

  // ---------- v0.5 bootstrap endpoints (PR3) ----------

  // GET /api/projects/:id/bootstrap — pure scan, no side effects.
  // The 4 endpoints all serialise via projectBootstrapLockKey; see §A8/A9.
  app.get(
    "/:id/bootstrap",
    zValidator("param", ProjectParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      c.projectService.mustFindById(id);
      const result: ProjectBootstrapResult =
        await c.projectBootstrapService.scan(id);
      ctx.header("Cache-Control", "no-store");
      return ctx.json(result);
    }
  );

  // POST /api/projects/:id/bootstrap/scan — scan + auto-subscribe matched.
  // Writes subscriptions for matched skills and emits the bootstrap_*
  // SSE event chosen per §A7.
  app.post(
    "/:id/bootstrap/scan",
    zValidator("param", ProjectParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      c.projectService.mustFindById(id);
      const result: ScanAndAutoSubscribeResult =
        await c.projectBootstrapService.scanAndAutoSubscribe(id);
      return ctx.json(result);
    }
  );

  // POST /api/projects/:id/bootstrap/resolve — apply user resolutions.
  // Per-resolution failures are returned as `failed[]` inside a 200 body
  // (partial success), aligned with v0.3 subscribeBatch semantics.
  app.post(
    "/:id/bootstrap/resolve",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", ResolveBootstrapRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      c.projectService.mustFindById(id);
      const result: ApplyResolutionsResult =
        await c.projectBootstrapService.applyResolutions(
          id,
          body.resolutions
        );
      return ctx.json(result);
    }
  );

  // POST /api/projects/:id/bootstrap/ignore — explicit ignore batch.
  app.post(
    "/:id/bootstrap/ignore",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", IgnoreBootstrapRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      c.projectService.mustFindById(id);
      const result: ApplyResolutionsResult =
        await c.projectBootstrapService.ignore(id, body.entries);
      return ctx.json(result);
    }
  );

  // Silence unused import warning — SubscriptionState is re-exported for
  // consumers who want to narrow on SubscriptionWithState.state values.
  void SubscriptionState;
  void (null as unknown as SubscriptionWithState);

  return app;
}
