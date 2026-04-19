/**
 * Endpoint contracts for /api/projects/:id/links/*.
 *
 * Endpoints (see design.md § Eng Review § 8):
 *   POST   /api/projects/:id/links                 — create tool symlink
 *   DELETE /api/projects/:id/links/:tool           — remove tool symlink
 *
 * Implements multi-tool compatibility via symlinks (decision 3):
 * `.cursor/` and `.codebuddy/` are symlinked to subdirectories of `.claude/`.
 * Link is at the `commands/` and `skills/` subdir level, not the root dir.
 */

import { z } from "zod";

import { IdSchema, NonEmptyStringSchema, ToolLinkSchema } from "./common.js";

// ---------- POST /api/projects/:id/links ----------

export const CreateToolLinkRequestSchema = z.object({
  /** Short tool name, e.g. "cursor", "codebuddy". */
  tool_name: NonEmptyStringSchema,
  /**
   * Dir name under project root. Default = "." + tool_name
   * (e.g. tool_name="cursor" → dir_name=".cursor").
   */
  dir_name: NonEmptyStringSchema.optional()
});
export type CreateToolLinkRequest = z.infer<typeof CreateToolLinkRequestSchema>;

export const CreateToolLinkResponseSchema = z.object({
  link: ToolLinkSchema
});
export type CreateToolLinkResponse = z.infer<typeof CreateToolLinkResponseSchema>;

// ---------- DELETE /api/projects/:id/links/:tool ----------

export const DeleteToolLinkParamsSchema = z.object({
  id: z.coerce.number().pipe(IdSchema),
  tool: NonEmptyStringSchema
});
export type DeleteToolLinkParams = z.infer<typeof DeleteToolLinkParamsSchema>;

export const DeleteToolLinkResponseSchema = z.object({
  deleted: z.literal(true),
  tool_name: NonEmptyStringSchema
});
export type DeleteToolLinkResponse = z.infer<typeof DeleteToolLinkResponseSchema>;
