/**
 * Endpoint contracts for /api/repos/*.
 *
 * Endpoints (see design.md § Eng Review § 8):
 *   POST   /api/repos                      — register skill repo
 *   GET    /api/repos                      — list registered repos
 *   DELETE /api/repos/:id                  — remove repo
 *   POST   /api/repos/:id/refresh          — force pull latest
 *   GET    /api/repos/:id/skills           — list skills in a repo
 */

import { z } from "zod";

import {
  IdSchema,
  NonEmptyStringSchema,
  PaginationSchema,
  RepoKindSchema,
  ScanConfigSchema,
  SkillRepoSchema,
  SkillSchema
} from "./common.js";

// ---------- POST /api/repos ----------

export const RegisterRepoRequestSchema = z.object({
  /** Remote git URL, e.g. "git@github.com:alexjhwen/my-skills.git". */
  git_url: NonEmptyStringSchema,
  /** Optional override; default = last segment of git_url without .git. */
  name: NonEmptyStringSchema.optional(),
  /**
   * Ownership model.
   * - "custom"      — default; two-way sync (pull + push)
   * - "open-source" — pull-only; push returns REPO_READONLY
   */
  kind: RepoKindSchema.default("custom"),
  /**
   * Override scan layout. Null / omitted = use `DEFAULT_SCAN_CONFIG`
   * (skills/<n>/SKILL.md + commands/*.md). Added in v0.2.
   */
  scan_config: ScanConfigSchema.nullish()
});
export type RegisterRepoRequest = z.infer<typeof RegisterRepoRequestSchema>;

/** Returns the newly-created repo plus initial scan result. */
export const RegisterRepoResponseSchema = z.object({
  repo: SkillRepoSchema,
  skills: z.array(SkillSchema),
  /** Convenience counts to show in UI toast / CLI output. */
  command_count: z.number().int().nonnegative(),
  skill_count: z.number().int().nonnegative()
});
export type RegisterRepoResponse = z.infer<typeof RegisterRepoResponseSchema>;

// ---------- GET /api/repos ----------

export const ListReposQuerySchema = PaginationSchema;
export type ListReposQuery = z.infer<typeof ListReposQuerySchema>;

export const ListReposResponseSchema = z.object({
  repos: z.array(SkillRepoSchema),
  total: z.number().int().nonnegative()
});
export type ListReposResponse = z.infer<typeof ListReposResponseSchema>;

// ---------- DELETE /api/repos/:id ----------

export const RepoParamsSchema = z.object({
  id: z.coerce.number().pipe(IdSchema)
});
export type RepoParams = z.infer<typeof RepoParamsSchema>;

export const DeleteRepoResponseSchema = z.object({
  deleted: z.literal(true),
  id: IdSchema
});
export type DeleteRepoResponse = z.infer<typeof DeleteRepoResponseSchema>;

// ---------- POST /api/repos/:id/refresh ----------

/** Returns the repo after forced pull, plus freshly scanned skills. */
export const RefreshRepoResponseSchema = z.object({
  repo: SkillRepoSchema,
  skills: z.array(SkillSchema),
  /** True if HEAD moved during this refresh. */
  changed: z.boolean()
});
export type RefreshRepoResponse = z.infer<typeof RefreshRepoResponseSchema>;

// ---------- GET /api/repos/:id/skills ----------

export const ListRepoSkillsResponseSchema = z.object({
  skills: z.array(SkillSchema)
});
export type ListRepoSkillsResponse = z.infer<typeof ListRepoSkillsResponseSchema>;
