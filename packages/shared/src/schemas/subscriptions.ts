/**
 * Endpoint contracts for subscription / sync / push / resolve.
 *
 * Endpoints (see design.md § Eng Review § 8):
 *   POST   /api/projects/:id/subscriptions          — subscribe to skills
 *   DELETE /api/projects/:id/subscriptions/:skill_id — unsubscribe
 *   POST   /api/projects/:id/sync                   — pull all subscribed
 *   POST   /api/projects/:id/push                   — push local edits
 *   POST   /api/projects/:id/resolve                — resolve a conflict
 */

import { z } from "zod";

import {
  CommitHashSchema,
  IdSchema,
  ResolveStrategySchema,
  SkillRefStringSchema,
  SkillSchema,
  SkillTypeSchema,
  SubscriptionSchema,
  SubscriptionStateSchema,
  SubscriptionWithStateSchema,
  SyncLogSchema
} from "./common.js";

// ---------- POST /api/projects/:id/subscriptions ----------

export const SubscribeRequestSchema = z.object({
  /** One or more skill refs (see SkillRefStringSchema for accepted forms). */
  skills: z.array(SkillRefStringSchema).min(1),
  /**
   * Explicit type when both a command and skill share a name in the
   * same repo. Optional; server returns SKILL_TYPE_AMBIGUOUS otherwise.
   */
  type: SkillTypeSchema.optional(),
  /**
   * Pin to a specific commit hash. If omitted, subscription tracks latest.
   * Only valid when `skills` has exactly one entry.
   */
  pinned_version: CommitHashSchema.optional(),
  /**
   * If true, server performs the initial pull immediately after subscribing.
   * Default: true.
   */
  sync_now: z.boolean().default(true)
});
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

export const SubscribeResponseSchema = z.object({
  subscriptions: z.array(SubscriptionSchema),
  /**
   * Per-skill failures from a batch subscribe. Empty when all refs succeeded.
   *
   * v0.3 behavior change: a batch with partial failures returns HTTP 200
   * with this array populated, NOT a 4xx for the whole request. The server
   * attempts every ref, manifests the successful ones, and collects the
   * rest here so the client can surface each failure individually
   * (Browse Skills drawer shows per-row error). A single-skill request
   * that fails also returns 200 with `subscriptions: []` + this array
   * populated — clients key off `failures.length > 0`, not HTTP status.
   *
   * Each entry names the exact skill ref that failed plus the structured
   * error code so the UI can branch (NAME_COLLISION vs NOT_FOUND vs
   * AMBIGUOUS each get different visual treatment).
   */
  failures: z.array(
    z.object({
      /** The skill ref string that was requested (unchanged from input). */
      ref: z.string(),
      /** AstackError code, e.g. "SUBSCRIPTION_NAME_COLLISION". */
      code: z.string(),
      /** Human-readable message; safe to surface in UI. */
      message: z.string()
    })
  ),
  /** Sync logs produced by the initial sync (empty if sync_now=false). */
  sync_logs: z.array(SyncLogSchema)
});
export type SubscribeResponse = z.infer<typeof SubscribeResponseSchema>;
export type SubscribeFailure = SubscribeResponse["failures"][number];

// ---------- DELETE /api/projects/:id/subscriptions/:skill_id ----------

export const UnsubscribeParamsSchema = z.object({
  id: z.coerce.number().pipe(IdSchema),
  skill_id: z.coerce.number().pipe(IdSchema)
});
export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;

export const UnsubscribeResponseSchema = z.object({
  deleted: z.literal(true),
  /**
   * Whether the local skill file was also removed from the project's
   * .claude/ working copy (default true; user can override via query).
   */
  file_removed: z.boolean()
});
export type UnsubscribeResponse = z.infer<typeof UnsubscribeResponseSchema>;

// ---------- POST /api/projects/:id/sync ----------

export const SyncRequestSchema = z
  .object({
    /**
     * Specific skill ids to sync. Omit to sync all subscriptions.
     */
    skill_ids: z.array(IdSchema).optional(),
    /**
     * If true, bypass the upstream cache TTL and fetch from remote.
     * See design.md § Eng Review decision 11 (5-minute TTL).
     */
    force: z.boolean().default(false)
  })
  .default({ force: false });
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

/** Per-skill outcome for a sync batch. */
export const SyncOutcomeSchema = z.object({
  skill_id: IdSchema,
  skill: SkillSchema,
  state: SubscriptionStateSchema,
  /** Log row for audit; also persisted server-side. */
  log: SyncLogSchema
});
export type SyncOutcome = z.infer<typeof SyncOutcomeSchema>;

export const SyncResponseSchema = z.object({
  outcomes: z.array(SyncOutcomeSchema),
  /**
   * Aggregate counts for CLI summary output / UI toast.
   * `conflicts` > 0 means user must call /resolve before push.
   */
  synced: z.number().int().nonnegative(),
  up_to_date: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative()
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// ---------- POST /api/projects/:id/push ----------

export const PushRequestSchema = z.object({
  /**
   * Skill ids to push. Omit to push all subscriptions with local edits.
   */
  skill_ids: z.array(IdSchema).optional(),
  /** Override default commit message template. */
  commit_message: z.string().max(2048).optional()
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

export const PushOutcomeSchema = z.object({
  skill_id: IdSchema,
  skill: SkillSchema,
  state: SubscriptionStateSchema,
  log: SyncLogSchema,
  /**
   * Commit hash produced by this push. null if skill had no changes.
   */
  new_version: CommitHashSchema.nullable()
});
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

export const PushResponseSchema = z.object({
  outcomes: z.array(PushOutcomeSchema),
  pushed: z.number().int().nonnegative(),
  no_changes: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  /** Number of skills skipped because their repo is open-source. */
  readonly_skipped: z.number().int().nonnegative().default(0),
  errors: z.number().int().nonnegative()
});
export type PushResponse = z.infer<typeof PushResponseSchema>;

// ---------- POST /api/projects/:id/resolve ----------

export const ResolveRequestSchema = z.object({
  skill_id: IdSchema,
  strategy: ResolveStrategySchema,
  /**
   * When strategy = "manual", indicates the user has finished manual editing
   * of the conflict-marked file. Server verifies no `<<<<<<<` markers remain.
   */
  manual_done: z.boolean().default(false)
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const ResolveResponseSchema = z.object({
  subscription: SubscriptionWithStateSchema,
  log: SyncLogSchema
});
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
