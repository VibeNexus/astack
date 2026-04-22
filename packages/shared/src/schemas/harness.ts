/**
 * Zod schemas for the Harness / system-skill endpoints (v0.4).
 *
 * Endpoints:
 *   GET  /api/projects/:id/harness          → ProjectHarnessStateSchema
 *   POST /api/projects/:id/harness/install  → ProjectHarnessStateSchema
 */

import { z } from "zod";

import { HarnessStatus } from "../domain.js";
import { IdSchema, IsoDateTimeSchema } from "./common.js";

// ---------- Core schemas ----------

export const HarnessStatusSchema = z.enum([
  HarnessStatus.Installed,
  HarnessStatus.ScaffoldIncomplete,
  HarnessStatus.Drift,
  HarnessStatus.Missing,
  HarnessStatus.SeedFailed
]);

export const SystemSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source_path: z.string(),
  content_hash: z.string()
});

export const ProjectHarnessScaffoldStateSchema = z.object({
  files: z.array(z.string()),
  missing: z.array(z.string()),
  complete: z.boolean()
});

export const ProjectHarnessStateSchema = z.object({
  project_id: IdSchema,
  skill: SystemSkillSchema,
  status: HarnessStatusSchema,
  seeded_at: IsoDateTimeSchema.nullable(),
  stub_built_in_hash: z.string().nullable(),
  actual_hash: z.string().nullable(),
  last_error: z.string().nullable(),
  scaffold: ProjectHarnessScaffoldStateSchema
});
