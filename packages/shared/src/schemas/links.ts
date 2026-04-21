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

import { IdSchema, NonEmptyStringSchema, LinkedDirSchema } from "./common.js";

// ---------- POST /api/projects/:id/links ----------

export const CreateLinkedDirRequestSchema = z.object({
  /** Short tool name, e.g. "cursor", "codebuddy". */
  tool_name: NonEmptyStringSchema,
  /**
   * Dir name under project root. Default = "." + tool_name
   * (e.g. tool_name="cursor" → dir_name=".cursor").
   */
  dir_name: NonEmptyStringSchema.optional()
});
export type CreateLinkedDirRequest = z.infer<typeof CreateLinkedDirRequestSchema>;

export const CreateLinkedDirResponseSchema = z.object({
  link: LinkedDirSchema
});
export type CreateLinkedDirResponse = z.infer<typeof CreateLinkedDirResponseSchema>;

// ---------- DELETE /api/projects/:id/links/:tool ----------

export const DeleteLinkedDirParamsSchema = z.object({
  id: z.coerce.number().pipe(IdSchema),
  tool: NonEmptyStringSchema
});
export type DeleteLinkedDirParams = z.infer<typeof DeleteLinkedDirParamsSchema>;

export const DeleteLinkedDirResponseSchema = z.object({
  deleted: z.literal(true),
  tool_name: NonEmptyStringSchema
});
export type DeleteLinkedDirResponse = z.infer<typeof DeleteLinkedDirResponseSchema>;
