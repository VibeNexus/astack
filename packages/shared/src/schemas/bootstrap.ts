/**
 * Zod schemas for the v0.5 bootstrap endpoints.
 *
 * Endpoints:
 *   GET  /api/projects/:id/bootstrap         → ProjectBootstrapResult (200)
 *   POST /api/projects/:id/bootstrap/scan    → ScanAndAutoSubscribeResult (200)
 *   POST /api/projects/:id/bootstrap/resolve → ApplyResolutionsResult (200)
 *   POST /api/projects/:id/bootstrap/ignore  → ApplyResolutionsResult (200)
 *
 * Response shapes are TypeScript types in `domain.ts` (§A4 single-source) —
 * we don't re-validate outbound bodies; this file only validates inbound
 * request bodies.
 */

import { z } from "zod";

import { SkillType } from "../domain.js";

const SkillTypeEnum = z.enum([
  SkillType.Command,
  SkillType.Skill,
  SkillType.Agent
]);

/**
 * Body of POST /api/projects/:id/bootstrap/resolve.
 *
 * Each entry is either a "subscribe to repo X" (repo_id != null) or a
 * "don't subscribe, ignore" decision (repo_id === null). At least one
 * resolution must be supplied — empty arrays are rejected because they
 * carry no intent.
 */
export const ResolveBootstrapRequestSchema = z.object({
  resolutions: z
    .array(
      z.object({
        type: SkillTypeEnum,
        name: z.string().min(1),
        repo_id: z.number().int().positive().nullable()
      })
    )
    .min(1)
});

export type ResolveBootstrapRequest = z.infer<
  typeof ResolveBootstrapRequestSchema
>;

/**
 * Body of POST /api/projects/:id/bootstrap/ignore.
 *
 * Equivalent to `/resolve` with all `repo_id: null`, but exposed as a
 * dedicated endpoint so the client can express intent clearly.
 */
export const IgnoreBootstrapRequestSchema = z.object({
  entries: z
    .array(
      z.object({
        type: SkillTypeEnum,
        name: z.string().min(1)
      })
    )
    .min(1)
});

export type IgnoreBootstrapRequest = z.infer<
  typeof IgnoreBootstrapRequestSchema
>;
