/**
 * Zod schemas for the v0.7 local-skill endpoints.
 *
 * Endpoints:
 *   GET  /api/projects/:id/local-skills             → ListLocalSkillsResponse (200)
 *   POST /api/projects/:id/local-skills/adopt       → ApplyLocalSkillsResult  (200)
 *   POST /api/projects/:id/local-skills/unadopt     → UnadoptLocalSkillsResult (200)
 *   POST /api/projects/:id/local-skills/rescan      → ListLocalSkillsResponse (200)
 *   GET  /api/projects/:id/local-skills/suggestions → ListLocalSkillSuggestionsResponse (200)
 *
 * Response shapes live as TypeScript types in `domain.ts` (same pattern
 * as `bootstrap.ts`). This file only validates inbound request bodies.
 */

import { z } from "zod";

import { SkillType } from "../domain.js";

const SkillTypeEnum = z.enum([
  SkillType.Command,
  SkillType.Skill,
  SkillType.Agent
]);

/** Shared tuple `{ type, name }` used by both adopt and unadopt. */
const LocalSkillRefSchema = z.object({
  type: SkillTypeEnum,
  name: z.string().min(1)
});

/**
 * Body of POST /api/projects/:id/local-skills/adopt.
 *
 * `entries` must carry at least one ref — empty arrays are a client
 * bug (nothing to adopt).
 */
export const AdoptLocalSkillsRequestSchema = z.object({
  entries: z.array(LocalSkillRefSchema).min(1)
});
export type AdoptLocalSkillsRequest = z.infer<
  typeof AdoptLocalSkillsRequestSchema
>;

/**
 * Body of POST /api/projects/:id/local-skills/unadopt.
 *
 * `delete_files` defaults to `false` — the UI default is to preserve
 * the on-disk file when unadopting (spec §A4).
 */
export const UnadoptLocalSkillsRequestSchema = z.object({
  entries: z.array(LocalSkillRefSchema).min(1),
  delete_files: z.boolean().optional().default(false)
});
export type UnadoptLocalSkillsRequest = z.infer<
  typeof UnadoptLocalSkillsRequestSchema
>;
