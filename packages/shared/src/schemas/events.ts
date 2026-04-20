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
  ToolLinkSchema
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

  // Project lifecycle
  ProjectRegistered: "project.registered",
  ProjectRemoved: "project.removed",

  // Sync pipeline (the hot path)
  SyncStarted: "sync.started",
  SkillUpdated: "skill.updated",
  ConflictDetected: "conflict.detected",
  SyncCompleted: "sync.completed",

  // Tool link lifecycle
  ToolLinkCreated: "tool_link.created",
  ToolLinkRemoved: "tool_link.removed",
  ToolLinkBroken: "tool_link.broken",

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
  HarnessChanged: "harness.changed"
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

export const ToolLinkCreatedPayloadSchema = z.object({
  link: ToolLinkSchema
});

export const ToolLinkRemovedPayloadSchema = z.object({
  project_id: z.number().int().positive(),
  tool_name: z.string()
});

export const ToolLinkBrokenPayloadSchema = z.object({
  link: ToolLinkSchema
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
    type: z.literal(EventType.ToolLinkCreated),
    payload: ToolLinkCreatedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.ToolLinkRemoved),
    payload: ToolLinkRemovedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.ToolLinkBroken),
    payload: ToolLinkBrokenPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.SeedCompleted),
    payload: SeedCompletedPayloadSchema
  }),
  z.object({
    type: z.literal(EventType.HarnessChanged),
    payload: HarnessChangedPayloadSchema
  })
]);
export type AstackEvent = z.infer<typeof AstackEventSchema>;
