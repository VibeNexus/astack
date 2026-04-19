/**
 * Core domain types for Astack.
 *
 * These types describe the business entities: Repo, Project, Skill,
 * Subscription, ToolLink, SyncLog. They are the stable shape exchanged
 * between server, cli, and web.
 *
 * SOURCE OF TRUTH hierarchy (see design.md § Eng Review decision 2):
 *   - Skill file contents      → remote git repo (never stored server-side)
 *   - Skill current version    → upstream-mirror git HEAD (SQLite caches it)
 *   - Project subscriptions    → <project>/.claude/.astack.json (SQLite mirrors)
 *   - Sync history             → SQLite only (sync_logs)
 *   - Symlink state            → filesystem (SQLite caches in tool_links)
 */

// ---------- Primitives ----------

/** Entity primary key (auto-increment integer from SQLite). */
export type Id = number;

/** ISO 8601 timestamp string, e.g. "2026-04-19T11:30:00Z". */
export type IsoDateTime = string;

/** Git commit hash (40-char hex or short 7-char). */
export type CommitHash = string;

// ---------- Enums ----------

/** A skill can be a single-file "command" or a directory "skill". */
export const SkillType = {
  Command: "command",
  Skill: "skill"
} as const;
export type SkillType = (typeof SkillType)[keyof typeof SkillType];

/** Direction of a sync operation. */
export const SyncDirection = {
  Pull: "pull",
  Push: "push"
} as const;
export type SyncDirection = (typeof SyncDirection)[keyof typeof SyncDirection];

/** Outcome of a sync operation. */
export const SyncStatus = {
  Success: "success",
  Conflict: "conflict",
  Error: "error"
} as const;
export type SyncStatus = (typeof SyncStatus)[keyof typeof SyncStatus];

/**
 * Repository ownership model.
 *
 * - "custom"      — user's own git repo; supports two-way sync (pull + push).
 *                   Default for 'astack repos register'.
 * - "open-source" — third-party / read-only repo; supports pull only.
 *                   Attempts to push return REPO_READONLY.
 */
export const RepoKind = {
  Custom: "custom",
  OpenSource: "open-source"
} as const;
export type RepoKind = (typeof RepoKind)[keyof typeof RepoKind];

/** Liveness of a symlink on disk. */
export const ToolLinkStatus = {
  Active: "active",
  Broken: "broken",
  Removed: "removed"
} as const;
export type ToolLinkStatus = (typeof ToolLinkStatus)[keyof typeof ToolLinkStatus];

/** Conflict resolution strategy (see design.md Implementation TODO #1). */
export const ResolveStrategy = {
  KeepLocal: "keep-local",
  UseRemote: "use-remote",
  Manual: "manual"
} as const;
export type ResolveStrategy = (typeof ResolveStrategy)[keyof typeof ResolveStrategy];

/** Subscription sync state for a given (project, skill). */
export const SubscriptionState = {
  /** Local version matches upstream, no local edits. */
  Synced: "synced",
  /** Upstream has new commits that local hasn't pulled. */
  Behind: "behind",
  /** Local has edits not yet pushed. */
  LocalAhead: "local-ahead",
  /** Both sides diverged — needs resolve. */
  Conflict: "conflict",
  /** Skill has never been synced to this project yet. */
  Pending: "pending"
} as const;
export type SubscriptionState = (typeof SubscriptionState)[keyof typeof SubscriptionState];

// ---------- Entities ----------

/** A registered skill git repository (the "upstream mirror" source). */
export interface SkillRepo {
  id: Id;
  /** Human-readable name, usually derived from git URL's last segment. */
  name: string;
  /** Remote git URL. Source of truth for this entity. */
  git_url: string;
  /**
   * Ownership model.
   *  - "custom"      two-way sync (pull + push)
   *  - "open-source" pull only; push returns REPO_READONLY
   */
  kind: RepoKind;
  /** Local clone path (~/.astack/repos/<name>/). [CACHE] */
  local_path: string | null;
  /** Current HEAD commit hash of the local clone. [CACHE] */
  head_hash: CommitHash | null;
  /** Last successful pull time. [CACHE] */
  last_synced: IsoDateTime | null;
  created_at: IsoDateTime;
}

/** A target project that consumes skills. */
export interface Project {
  id: Id;
  name: string;
  /** Absolute path on the user's filesystem. */
  path: string;
  /** Primary tool directory (default ".claude"). */
  primary_tool: string;
  created_at: IsoDateTime;
}

/** A meta-skill scanned from a SkillRepo. [CACHE] */
export interface Skill {
  id: Id;
  repo_id: Id;
  type: SkillType;
  /** Skill name, e.g. "code_review" or "office-hours". */
  name: string;
  /** Path relative to repo root, e.g. "commands/code_review.md". */
  path: string;
  /** Git commit hash that last touched this skill. */
  version: CommitHash | null;
  /** Git commit time of `version`. */
  updated_at: IsoDateTime | null;
}

/** Project's subscription to a specific skill. */
export interface Subscription {
  id: Id;
  project_id: Id;
  skill_id: Id;
  /** null = track latest; non-null = pinned to this commit hash. */
  pinned_version: CommitHash | null;
}

/** Record of a sync operation between a project and a skill. */
export interface SyncLog {
  id: Id;
  project_id: Id;
  skill_id: Id;
  direction: SyncDirection;
  from_version: CommitHash | null;
  to_version: CommitHash | null;
  status: SyncStatus;
  conflict_detail: string | null;
  synced_at: IsoDateTime;
}

/** Symlink from a derived tool dir (.cursor, .codebuddy) to .claude. */
export interface ToolLink {
  id: Id;
  project_id: Id;
  /** Short name, e.g. "cursor". */
  tool_name: string;
  /** Dir name under project root, e.g. ".cursor". */
  dir_name: string;
  status: ToolLinkStatus;
  created_at: IsoDateTime;
}

// ---------- Composite / view types ----------

/**
 * Fully-qualified reference to a skill across repos.
 *
 * Written as `<repo_name>/<skill_name>` in CLI args when disambiguation is
 * needed, e.g. `astack subscribe my-skills/code_review`. For single-repo
 * setups, users can use the short form `code_review`.
 */
export interface SkillRef {
  repo: string;
  type: SkillType;
  name: string;
}

/** Denormalized subscription row with live state for UI rendering. */
export interface SubscriptionWithState {
  subscription: Subscription;
  skill: Skill;
  repo: SkillRepo;
  /** Computed sync state. */
  state: SubscriptionState;
  /** Short description of the diff, e.g. "v2 → v3" or "1 conflict". */
  state_detail?: string;
}

/** Aggregated project status, used by Dashboard Sync Status page. */
export interface ProjectStatus {
  project: Project;
  subscriptions: SubscriptionWithState[];
  /** Links from derived tool dirs (.cursor, .codebuddy) to .claude. */
  tool_links: ToolLink[];
  /** Timestamp of last successful sync of any skill in this project. */
  last_synced: IsoDateTime | null;
}
