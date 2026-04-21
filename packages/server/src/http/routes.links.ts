/**
 * /api/projects/:id/links routes — tool symlink management.
 */

import {
  CreateLinkedDirRequestSchema,
  DeleteLinkedDirParamsSchema,
  ProjectParamsSchema,
  type CreateLinkedDirResponse,
  type DeleteLinkedDirResponse
} from "@astack/shared";
import { zValidator } from "./validator.js";
import { Hono } from "hono";

import type { ServiceContainer } from "./container.js";

export function linksRoutes(c: ServiceContainer): Hono {
  const app = new Hono();

  // POST /api/projects/:id/links — create a linked dir.
  app.post(
    "/:id/links",
    zValidator("param", ProjectParamsSchema),
    zValidator("json", CreateLinkedDirRequestSchema),
    (ctx) => {
      const { id } = ctx.req.valid("param");
      const body = ctx.req.valid("json");
      const link = c.symlinkService.addLink({
        project_id: id,
        tool_name: body.tool_name,
        dir_name: body.dir_name
      });
      const response: CreateLinkedDirResponse = { link };
      return ctx.json(response, 201);
    }
  );

  // DELETE /api/projects/:id/links/:tool — remove a linked dir.
  app.delete(
    "/:id/links/:tool",
    zValidator("param", DeleteLinkedDirParamsSchema),
    (ctx) => {
      const { id, tool } = ctx.req.valid("param");
      c.symlinkService.removeLink(id, tool);
      const response: DeleteLinkedDirResponse = {
        deleted: true,
        tool_name: tool
      };
      return ctx.json(response);
    }
  );

  return app;
}
