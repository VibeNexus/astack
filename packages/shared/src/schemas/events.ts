/**
 * Server-Sent Events (SSE) contract for /api/events.
 *
 * Architecture (see design.md § Eng Review decision 11):
 *   - Backend pushes events on state changes; clients never poll.
 *   - CLI write operations trigger server to broadcast corresponding events.
 *   - Web dashboard subscribes once on mount, stays connected.
 *
 * Wire format: text/event-stream
 *   Each event is encoded as:
 *     event: <type>
 *     data: <JSON payload matching AstackEventSchema[type]>
 *     id: <monotonic seq>
 *     \n
 *
 * Clients MUST tolerate unknown event types (server may add new ones).
 */

import { z } from "zod";

import {
  ProjectSchema,
  SkillRepoSchema,
  SkillSchema,
  SubscriptionWithStateSchema,
  SyncLogSchema,
  LinkedDirSchema
} from "./common.js";

// ---------- Event type registry ----------

export const EventType = {
  // Connection lifecycle
  Hello: "hello",
  Heartbeat: "heartbeat",

  // Repo lifecycle
  RepoRegistered: "repo.registered",
  RepoRefreshed: "repo.refreshed",
  RepoRemoved: "repo.removed",
  /**
   * Astack auto-healed a dirty open-source mirror by resetting it to
   * `origin/HEAD` (v0.6). Emitted from `SyncService.ensureMirrorClean`
   * only when an actual reset was performed — no event for clean mirrors.
   *
   * Payload carries `repo_id`, `repo_name`, `repo_kind` ("open-source"),
   * and `reason` (currently only "dirty_working_tree"). Reserved for a
   * future "mirror health" dashboard; not directly consumed by the current
   * Web UI (the reset is already surfaced via warn log + batch outcome
   * `error_detail` when reset fails).
   */
  RepoMirrorReset: "repo.mirror_reset",

  // Project lifecycle
  ProjectRegistered: "project.registered",
  ProjectRemoved: "project.removed",

  // Sync pipeline (the hot path)
  SyncStarted: "sync.started",
  SkillUpdated: "skill.updated",
  ConflictDetected: "conflict.detected",
  SyncCompleted: "sync.completed",

  // Linked Dir lifecycle
  LinkedDirCreated: "linked_dir.created",
  LinkedDirRemoved: "linked_dir.removed",
  LinkedDirBroken: "linked_dir.broken",

  /**
   * Builtin-seed bootstrap finished.
   * Emitted once on daemon start after SeedService.seedBuiltinRepos()
   * returns (success OR failure for each seed). Web dashboard uses this
   * to show a dismissable banner when failed > 0.
   */
  SeedCompleted: "seed.completed",

  /**
   * System-skill installation state changed for a project (v0.4).
   *
   * Emitted by SystemSkillService when it actually writes to the filesystem
   * (seed / seedIfMissing wrote new content) or when a seed attempt failed.
   * Pure inspect (GET /api/projects/:id/harness) does NOT emit this event.
   *
   * The payload carries the new status so clients can update state without
   * re-fetching. See v0.4 spec §A5.
   */
  HarnessChanged: "harness.changed",

  /**
   * Subscription bootstrap finished and at least one ambiguous local skill
   * needs the user to pick a repo (v0.5).
   *
   * Emitted by `ProjectBootstrapService.scanAndAutoSubscribe` when
   * `ambiguous.length > 0` AFTER auto-subscribing the unambiguous matches.
   * The Web SubscriptionsPanel reacts by refetching `/bootstrap` and
   * showing the resolve banner.
   */
  SubscriptionsBootstrapNeedsResolution:
    "subscriptions.bootstrap_needs_resolution",

  /**
   * Subscription bootstrap had a write side-effect that does NOT need user
   * resolution (v0.5):
   *   - auto-subscribe succeeded for ≥ 1 entry with no ambiguous remaining
   *   - applyResolutions / ignore completed
   *
   * Web clients use this to invalidate both `['status', projectId]` and
   * `['bootstrap', projectId]` query keys. See v0.5 spec §A7.
   */
  SubscriptionsBootstrapResolved: "subscriptions.bootstrap_resolved"
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

// ---------- Event payloads ----------

/** First event sent after connection; announces server version + seq start. */
export const HelloPayloadSchema = z.object({
  server_version: z.string(),
  /** Current monotonic seq; subsequent events use seq > this value. */
  seq: z.number().int().nonnegative()
});

/** Sent every 15s to keep connection alive through proxies. */
export const HeartbeatPayloadSchema = z.object({
  ts: z.string()
});

export const RepoRegisteredPayloadSchema = z.object({
  repo: SkillRepoSchema
});

export const RepoRefreshedPayloadSchema = z.object({
  repo: SkillRepoSchema,
  changed: z.boolean()
});

export const RepoRemovedPayloadSchema = z.object({
  repo_id: z.number().int().positive()
});

/**
 * RepoMirrorReset: an open-source mirror was dirty and Astack reset it
 * back to `origin/HEAD` to unblock the pending pull/resolve (v0.6).
 *
 * Only `kind=open-source` mirrors are auto-healed; `custom` repos never
 * emit this event because dirty working trees there may be legitimate
 * push-flow intermediate state. The reason enum leaves room for future
 * triggers (e.g. `"detached_head"`) without a schema bump.
 */
export const RepoMirrorResetPayloadSchema = z.object({
  repo_id: z.number().int().positive(),
  repo_name: z.string().min(1),
  /** Only open-source mirrors are auto-healed; reserved as literal. */
  repo_kind: z.literal("open-source"),
  /** Future-proof enum; today only `dirty_working_tree` fires. */
  reason: z.enum(["dirty_working_tree"])
});

export const ProjectRegisteredPayloadSchema = z.object({
  project: ProjectSchema
});

export const ProjectRemovedPayloadSchema = z.object({
  project_id: z.number().int().positive()
});

export const SyncStartedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  /** Total number of skills being synced in this batch. */
  total: z.number().int().positive()
});

export const SkillUpdatedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  subscription: SubscriptionWithStateSchema,
  log: SyncLogSchema
});

export const ConflictDetectedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  skill: SkillSchema,
  log: SyncLogSchema,
  /** Ready-to-open URL like "/resolve/<project_id>/<skill_id>". */
  resolve_url: z.string()
});

export const SyncCompletedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  synced: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative()
});

export const LinkedDirCreatedPayloadSchema = z.object({
  link: LinkedDirSchema
});

export const LinkedDirRemovedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  tool_name: z.string()
});

export const LinkedDirBrokenPayloadSchema = z.object({
  link: LinkedDirSchema
});

/**
 * SeedCompleted: summary of the initial seed bootstrap.
 *
 * succeeded + failed + skipped === total number of builtin seeds
 * (currently 3). `failed` names lets the Web dashboard name which
 * repos didn't make it without re-fetching the state.
 */
export const SeedCompletedPayloadSchema = z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Short names of the seeds that failed to clone or scan. */
  failed_names: z.array(z.string())
});

/**
 * HarnessChanged: a system skill's on-disk state transitioned (v0.4).
 *
 * `status` is the new HarnessStatus. Web clients map this to tab-badge
 * color + panel content without hitting `GET /harness` again.
 *
 * - `seeded_at` present for `installed` / `drift` (optional for failed)
 * - `last_error` present only for `seed_failed`
 */
export const HarnessChangedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  skill_id: z.string(),
  status: z.enum(["installed", "drift", "missing", "seed_failed"]),
  seeded_at: z.string().nullable().optional(),
  last_error: z.string().nullable().optional()
});

/**
 * SubscriptionsBootstrapNeedsResolution: bootstrap auto-subscribed what it
 * could and ≥ 1 ambiguous local skill needs the user to pick a repo (v0.5).
 *
 * `ambiguous_count` is positive by construction — emitter only fires when
 * ambiguous.length > 0. `auto_subscribed_count` is the number of matched
 * skills that were auto-subscribed BEFORE this event fires.
 */
export const SubscriptionsBootstrapNeedsResolutionPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  matched_count: z.number().int().nonnegative(),
  ambiguous_count: z.number().int().positive(),
  unmatched_count: z.number().int().nonnegative(),
  auto_subscribed_count: z.number().int().nonnegative()
});

/**
 * SubscriptionsBootstrapResolved: bootstrap had a write side-effect that
 * does NOT need further user input (v0.5).
 *
 * Sent in three scenarios (see spec §A7):
 *   1. scanAndAutoSubscribe with subscribed > 0 AND ambiguous === 0
 *   2. applyResolutions completed (any combination of subscribe / ignore)
 *   3. ignore completed
 */
export const SubscriptionsBootstrapResolvedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  remaining_ambiguous_count: z.number().int().nonnegative(),
  subscribed_count: z.number().int().nonnegative(),
  ignored_count: z.number().int().nonnegative()
});

// ---------- Discriminated union ----------

/**
 * One event message (decoded from SSE `data: <json>`).
 *
 * Use the top-level `type` field to discriminate; each branch has a
 * matching `payload` shape validated by the corresponding schema above.
 */
export const AstackEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(EventType.Hello), payload: HelloPayloadSchema }),
  z.object({ type: z.literal(EventType.Heartbeat), payload: HeartbeatPayloadSchema }),
  z.object({
    type: z.literal(EventType.RepoRegistered),
    payload: RepoRegisteredPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.RepoRefreshed),
    payload: RepoRefreshedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.RepoRemoved),
    payload: RepoRemovedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.RepoMirrorReset),
    payload: RepoMirrorResetPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.ProjectRegistered),
    payload: ProjectRegisteredPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.ProjectRemoved),
    payload: ProjectRemovedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SyncStarted),
    payload: SyncStartedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SkillUpdated),
    payload: SkillUpdatedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.ConflictDetected),
    payload: ConflictDetectedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SyncCompleted),
    payload: SyncCompletedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.LinkedDirCreated),
    payload: LinkedDirCreatedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.LinkedDirRemoved),
    payload: LinkedDirRemovedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.LinkedDirBroken),
    payload: LinkedDirBrokenPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SeedCompleted),
    payload: SeedCompletedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.HarnessChanged),
    payload: HarnessChangedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SubscriptionsBootstrapNeedsResolution),
    payload: SubscriptionsBootstrapNeedsResolutionPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SubscriptionsBootstrapResolved),
    payload: SubscriptionsBootstrapResolvedPayloadSchema
  })
]);
export type AstackEvent = z.infer<typeof AstackEventSchema>;
