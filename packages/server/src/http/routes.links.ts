/**
 * /api/projects/:id/links routes — tool symlink management.
 */

import {
  CreateToolLinkRequestSchema,
  DeleteToolLinkParamsSchema,
  ProjectParamsSchema,
  type CreateToolLinkResponse,
  type DeleteToolLinkResponse
} from "@astack/shared";
import { zValidator } from "./validator.js";
import { Hono } from "hono";

import type { ServiceContainer } from "./container.js";

export function linksRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  // POST /api/projects/:id/links — create a tool link.
  app.post(
    "/:id/links",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", CreateToolLinkRequestSchema),
    (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      const link = c.symlinkService.addLink({
        project_id: id,
        tool_name: body.tool_name,
        dir_name: body.dir_name
      });
      const response: CreateToolLinkResponse = { link };
      return ctx.json(response, 201);
    }
  );

  // DELETE /api/projects/:id/links/:tool — remove a tool link.
  app.delete(
    "/:id/links/:tool",
    zValidator("param", DeleteToolLinkParamsSchema),
    (ctx) => {
      const { id, tool } = ctx.req.valid("param");
      c.symlinkService.removeLink(id, tool);
      const response: DeleteToolLinkResponse = {
        deleted: true,
        tool_name: tool
      };
      return ctx.json(response);
    }
  );

  return app;
}
