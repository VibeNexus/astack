/**
 * Common / primitive zod schemas reused across endpoint contracts.
 */

import { z } from "zod";

import {
  RepoKind,
  RepoStatus,
  ResolveStrategy,
  ScanRootKind,
  SkillType,
  SubscriptionState,
  SyncDirection,
  SyncStatus,
  ToolLinkStatus
} from "../domain.js";

// ---------- Primitives ----------

/** Auto-increment id from SQLite (positive integer). */
export const IdSchema = z.number().int().positive();

/** ISO 8601 datetime string. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Git commit hash: 7-40 hex chars.
 * Accepts both short (7) and full (40) forms.
 */
export const CommitHashSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "invalid commit hash");

/** Non-empty trimmed string. */
export const NonEmptyStringSchema = z.string().trim().min(1);

// ---------- Enums ----------

export const SkillTypeSchema = z.enum([
  SkillType.Command,
  SkillType.Skill,
  SkillType.Agent
]);
export const RepoKindSchema = z.enum([RepoKind.Custom, RepoKind.OpenSource]);
export const RepoStatusSchema = z.enum([
  RepoStatus.Ready,
  RepoStatus.Seeding,
  RepoStatus.Failed
]);
export const ScanRootKindSchema = z.enum([
  ScanRootKind.SkillDirs,
  ScanRootKind.CommandFiles,
  ScanRootKind.AgentFiles
]);
export const ScanRootSchema = z.object({
  path: z.string(),
  kind: ScanRootKindSchema
});
export const ScanConfigSchema = z.object({
  roots: z.array(ScanRootSchema).min(1)
});
export const SyncDirectionSchema = z.enum([SyncDirection.Pull, SyncDirection.Push]);
export const SyncStatusSchema = z.enum([
  SyncStatus.Success,
  SyncStatus.Conflict,
  SyncStatus.Error
]);
export const ToolLinkStatusSchema = z.enum([
  ToolLinkStatus.Active,
  ToolLinkStatus.Broken,
  ToolLinkStatus.Removed
]);
export const ResolveStrategySchema = z.enum([
  ResolveStrategy.KeepLocal,
  ResolveStrategy.UseRemote,
  ResolveStrategy.Manual
]);
export const SubscriptionStateSchema = z.enum([
  SubscriptionState.Synced,
  SubscriptionState.Behind,
  SubscriptionState.LocalAhead,
  SubscriptionState.Conflict,
  SubscriptionState.Pending
]);

// ---------- Composite primitives ----------

/**
 * Skill reference used in API paths and CLI args.
 *
 * Two accepted forms:
 *   - Short:  `code_review`                  (requires single-repo setup)
 *   - Full:   `my-skills/code_review`        (repo_name/skill_name)
 *   - Typed:  `my-skills/command/code_review`  (rare, explicit disambig)
 *
 * This schema validates only the string shape; resolution to a concrete
 * Skill entity happens server-side via SkillRef lookup.
 */
export const SkillRefStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,2}$/,
    "expected '<name>' or '<repo>/<name>' or '<repo>/<type>/<name>'"
  );

// ---------- Envelopes ----------

/**
 * Pagination params for list endpoints.
 * Defaults: offset=0, limit=50 (max 500 to protect SQLite).
 */
export const PaginationSchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(50)
});
export type Pagination = z.infer<typeof PaginationSchema>;

// ---------- Entity schemas (for response validation) ----------

export const SkillRepoSchema = z.object({
  id: IdSchema,
  name: NonEmptyStringSchema,
  git_url: NonEmptyStringSchema,
  kind: RepoKindSchema,
  status: RepoStatusSchema,
  scan_config: ScanConfigSchema.nullable(),
  local_path: z.string().nullable(),
  head_hash: CommitHashSchema.nullable(),
  last_synced: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema
});

export const ProjectSchema = z.object({
  id: IdSchema,
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  primary_tool: z.string().default(".claude"),
  created_at: IsoDateTimeSchema
});

export const SkillSchema = z.object({
  id: IdSchema,
  repo_id: IdSchema,
  type: SkillTypeSchema,
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  description: z.string().nullable(),
  version: CommitHashSchema.nullable(),
  updated_at: IsoDateTimeSchema.nullable()
});

export const SubscriptionSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  skill_id: IdSchema,
  pinned_version: CommitHashSchema.nullable()
});

export const SyncLogSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  skill_id: IdSchema,
  direction: SyncDirectionSchema,
  from_version: CommitHashSchema.nullable(),
  to_version: CommitHashSchema.nullable(),
  status: SyncStatusSchema,
  conflict_detail: z.string().nullable(),
  synced_at: IsoDateTimeSchema
});

export const ToolLinkSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  tool_name: NonEmptyStringSchema,
  dir_name: NonEmptyStringSchema,
  status: ToolLinkStatusSchema,
  created_at: IsoDateTimeSchema
});

export const SubscriptionWithStateSchema = z.object({
  subscription: SubscriptionSchema,
  skill: SkillSchema,
  repo: SkillRepoSchema,
  state: SubscriptionStateSchema,
  state_detail: z.string().optional()
});

export const ProjectStatusSchema = z.object({
  project: ProjectSchema,
  subscriptions: z.array(SubscriptionWithStateSchema),
  tool_links: z.array(ToolLinkSchema),
  last_synced: IsoDateTimeSchema.nullable()
});
