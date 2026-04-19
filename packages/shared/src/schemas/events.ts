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
  ToolLinkBroken: "tool_link.broken"
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
  })
]);
export type AstackEvent = z.infer<typeof AstackEventSchema>;
