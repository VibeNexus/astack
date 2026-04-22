/**
 * /api/projects/:id/local-skills routes (v0.7).
 *
 * All 5 endpoints live here (co-located by domain to match the existing
 * file layout: `routes.subscriptions.ts`, `routes.links.ts`, etc.).
 *
 *   GET   /:id/local-skills              → LocalSkill[]          (pure read)
 *   POST  /:id/local-skills/adopt        → ApplyLocalSkillsResult
 *   POST  /:id/local-skills/unadopt      → UnadoptLocalSkillsResult
 *   POST  /:id/local-skills/rescan       → LocalSkill[]          (post-rescan view)
 *   GET   /:id/local-skills/suggestions  → BootstrapUnmatched[]
 *
 * Writer endpoints all return 200 with a partial-success shape (failed[]
 * inside body); only the project-404 case produces a 4xx error. Same
 * contract as /bootstrap/* (see docs/version/v0.5-subscription-bootstrap.md).
 */

import {
  AdoptLocalSkillsRequestSchema,
  ProjectParamsSchema,
  UnadoptLocalSkillsRequestSchema,
  type ApplyLocalSkillsResult,
  type BootstrapUnmatched,
  type LocalSkill,
  type UnadoptLocalSkillsResult
} from "@astack/shared";
import { Hono } from "hono";

import type { ServiceContainer } from "./container.js";
import { zValidator } from "./validator.js";

export function localSkillsRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  // GET /:id/local-skills — pure read + fs drift probe (see list()).
  app.get(
    "/:id/local-skills",
    zValidator("param", ProjectParamsSchema),
    (ctx) => {
      const { id } = ctx.req.valid("param");
      c.projectService.mustFindById(id);
      const items: LocalSkill[] = c.localSkillService.list(id);
      ctx.header("Cache-Control", "no-store");
      return ctx.json({ items });
    }
  );

  // GET /:id/local-skills/suggestions — adoption candidates.
  app.get(
    "/:id/local-skills/suggestions",
    zValidator("param", ProjectParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      c.projectService.mustFindById(id);
      const suggestions: BootstrapUnmatched[] =
        await c.localSkillService.suggestFromUnmatched(id);
      ctx.header("Cache-Control", "no-store");
      return ctx.json({ suggestions });
    }
  );

  // POST /:id/local-skills/adopt — batch adopt (origin='adopted').
  // Partial success: returns 200 with failed[] inside the body. Only
  // project-404 and request-validation errors are 4xx.
  app.post(
    "/:id/local-skills/adopt",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", AdoptLocalSkillsRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      c.projectService.mustFindById(id);
      const result: ApplyLocalSkillsResult = await c.localSkillService.adopt(
        id,
        body.entries
      );
      return ctx.json(result);
    }
  );

  // POST /:id/local-skills/unadopt — batch unadopt, optional fs rm.
  app.post(
    "/:id/local-skills/unadopt",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", UnadoptLocalSkillsRequestSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      c.projectService.mustFindById(id);
      const result: UnadoptLocalSkillsResult =
        await c.localSkillService.unadopt(id, body.entries, {
          delete_files: body.delete_files
        });
      return ctx.json(result);
    }
  );

  // POST /:id/local-skills/rescan — re-evaluate hashes + statuses.
  // Always emits LocalSkillsChanged (even zero-delta) so the UI gets a
  // "done" signal after the user hits [Rescan]. Returns the refreshed view.
  app.post(
    "/:id/local-skills/rescan",
    zValidator("param", ProjectParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      c.projectService.mustFindById(id);
      const items: LocalSkill[] = await c.localSkillService.rescan(id);
      return ctx.json({ items });
    }
  );

  return app;
}
