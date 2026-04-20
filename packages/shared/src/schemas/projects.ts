/**
 * Endpoint contracts for /api/projects/*.
 *
 * Endpoints (see design.md § Eng Review § 8):
 *   POST   /api/projects                   — register project
 *   GET    /api/projects                   — list projects
 *   DELETE /api/projects/:id               — unregister
 *   GET    /api/projects/:id/status        — sync state view
 *   GET    /api/projects/:id/diff/:skill_id — local vs upstream diff
 *   GET    /api/projects/:id/sync-logs     — history feed (v0.3)
 */

import { z } from "zod";

import {
  IdSchema,
  NonEmptyStringSchema,
  PaginationSchema,
  ProjectSchema,
  ProjectStatusSchema,
  SyncDirectionSchema,
  SyncLogSchema,
  SyncStatusSchema
} from "./common.js";

// ---------- POST /api/projects ----------

export const RegisterProjectRequestSchema = z.object({
  /** Absolute filesystem path to the project root. */
  path: NonEmptyStringSchema,
  /** Human name; default = basename of path. */
  name: NonEmptyStringSchema.optional(),
  /** Primary tool directory name. Default ".claude". */
  primary_tool: NonEmptyStringSchema.optional()
});
export type RegisterProjectRequest = z.infer<typeof RegisterProjectRequestSchema>;

export const RegisterProjectResponseSchema = z.object({
  project: ProjectSchema
});
export type RegisterProjectResponse = z.infer<typeof RegisterProjectResponseSchema>;

// ---------- GET /api/projects ----------

export const ListProjectsQuerySchema = PaginationSchema;
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  total: z.number().int().nonnegative()
});
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

// ---------- DELETE /api/projects/:id ----------

export const ProjectParamsSchema = z.object({
  id: z.coerce.number().pipe(IdSchema)
});
export type ProjectParams = z.infer<typeof ProjectParamsSchema>;

export const DeleteProjectResponseSchema = z.object({
  deleted: z.literal(true),
  id: IdSchema
});
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;

// ---------- GET /api/projects/:id/status ----------

export const GetProjectStatusResponseSchema = ProjectStatusSchema;
export type GetProjectStatusResponse = z.infer<typeof GetProjectStatusResponseSchema>;

// ---------- GET /api/projects/:id/diff/:skill_id ----------

export const ProjectSkillParamsSchema = z.object({
  id: z.coerce.number().pipe(IdSchema),
  skill_id: z.coerce.number().pipe(IdSchema)
});
export type ProjectSkillParams = z.infer<typeof ProjectSkillParamsSchema>;

export const GetSkillDiffResponseSchema = z.object({
  /** `true` if there is no difference. */
  identical: z.boolean(),
  /** Unified diff text; empty when identical. */
  diff: z.string(),
  /** HEAD hash of upstream mirror at diff time. */
  upstream_version: z.string().nullable(),
  /**
   * Hash-equivalent of working copy (computed on-the-fly).
   * null if file does not exist in working copy.
   */
  working_version: z.string().nullable()
});
export type GetSkillDiffResponse = z.infer<typeof GetSkillDiffResponseSchema>;

// ---------- GET /api/projects/:id/sync-logs (v0.3) ----------

/**
 * Query params for the sync history feed.
 *
 * All filters optional; unfiltered call returns last 50 logs across all
 * skills in the project. `limit` capped at 200 to protect SQLite (much
 * higher than the default 50 because users may want a 30-day audit and
 * a busy project sees ~10 logs/day → 300+ rows).
 */
export const ListSyncLogsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  skill_id: z.coerce.number().int().positive().optional(),
  direction: SyncDirectionSchema.optional(),
  status: SyncStatusSchema.optional()
});
export type ListSyncLogsQuery = z.infer<typeof ListSyncLogsQuerySchema>;

export const ListSyncLogsResponseSchema = z.object({
  logs: z.array(SyncLogSchema),
  total: z.number().int().nonnegative(),
  /** True when (offset + logs.length) < total — there are older logs. */
  has_more: z.boolean()
});
export type ListSyncLogsResponse = z.infer<typeof ListSyncLogsResponseSchema>;
