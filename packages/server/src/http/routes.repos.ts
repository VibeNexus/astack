/**
 * /api/repos routes.
 *
 * Mount: app.route("/api/repos", reposRoutes(container))
 */

import {
  ListReposQuerySchema,
  RegisterRepoRequestSchema,
  RepoParamsSchema,
  type ListReposResponse,
  type RegisterRepoResponse,
  type RefreshRepoResponse,
  type ListRepoSkillsResponse,
  type DeleteRepoResponse
} from "@astack/shared";
import { zValidator } from "./validator.js";
import { Hono } from "hono";

import type { ServiceContainer } from "./container.js";

export function reposRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  // POST /api/repos — register a skill repo.
  app.post("/", zValidator("json", RegisterRepoRequestSchema), async (ctx) => {
    const body = ctx.req.valid("json");
    const result = await c.repoService.register(body);
    const response: RegisterRepoResponse = result;
    return ctx.json(response, 201);
  });

  // GET /api/repos — list registered repos.
  app.get("/", zValidator("query", ListReposQuerySchema), (ctx) => {
    const q = ctx.req.valid("query");
    const { repos, total } = c.repoService.list(q);
    const response: ListReposResponse = { repos, total };
    return ctx.json(response);
  });

  // DELETE /api/repos/:id — unregister.
  app.delete("/:id", zValidator("param", RepoParamsSchema), (ctx) => {
    const { id } = ctx.req.valid("param");
    c.repoService.remove(id);
    const response: DeleteRepoResponse = { deleted: true, id };
    return ctx.json(response);
  });

  // POST /api/repos/:id/refresh — force pull + re-scan.
  app.post(
    "/:id/refresh",
    zValidator("param", RepoParamsSchema),
    async (ctx) => {
      const { id } = ctx.req.valid("param");
      const { repo, skills, changed } = await c.repoService.refresh(id);
      const response: RefreshRepoResponse = { repo, skills, changed };
      return ctx.json(response);
    }
  );

  // GET /api/repos/:id/skills — list skills in a repo.
  app.get("/:id/skills", zValidator("param", RepoParamsSchema), (ctx) => {
    const { id } = ctx.req.valid("param");
    const skills = c.repoService.listSkills(id);
    const response: ListRepoSkillsResponse = { skills };
    return ctx.json(response);
  });

  return app;
}
