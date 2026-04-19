/**
 * SQLite schema DDL for Astack.
 *
 * Tables classified per design.md § Eng Review decision 7:
 *   [CACHE]   Rebuildable from git/files via `astack sync --refresh`.
 *   [SOURCE]  Authoritative data; only lives in SQLite (or mirrored with files).
 *
 *   skill_repos      [CACHE]   — git_url is source; rest is cached clone state
 *   skills           [CACHE]   — fully derived from scanning git repos
 *   projects         [SOURCE]  — local registration
 *   subscriptions    [SOURCE]  — mirror of .astack.json (file-authoritative;
 *                                SQLite kept in sync on every CLI operation)
 *   sync_logs        [SOURCE]  — only lives in SQLite
 *   tool_links       [SOURCE]  — filesystem is source but we cache "last known"
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
-- ============================================================
-- [CACHE] skill_repos — registered meta-skill git repos
-- ============================================================
CREATE TABLE IF NOT EXISTS skill_repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  git_url     TEXT NOT NULL UNIQUE,
  local_path  TEXT,
  head_hash   TEXT,
  last_synced TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- [SOURCE] projects — registered target projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,
  primary_tool TEXT NOT NULL DEFAULT '.claude',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- [CACHE] skills — meta-skills discovered in repos
-- ============================================================
CREATE TABLE IF NOT EXISTS skills (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES skill_repos(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('command', 'skill')),
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  version    TEXT,
  updated_at TEXT,
  UNIQUE(repo_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_skills_repo ON skills(repo_id);

-- ============================================================
-- [SOURCE] subscriptions — project subscribed to skill
-- (mirror of .astack.json; file wins on divergence)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id       INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  pinned_version TEXT,
  UNIQUE(project_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_subs_project ON subscriptions(project_id);
CREATE INDEX IF NOT EXISTS idx_subs_skill   ON subscriptions(skill_id);

-- ============================================================
-- [SOURCE] sync_logs — history of sync operations
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id        INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('pull', 'push')),
  from_version    TEXT,
  to_version      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('success', 'conflict', 'error')),
  conflict_detail TEXT,
  synced_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_project ON sync_logs(project_id, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_logs_skill   ON sync_logs(skill_id, synced_at DESC);

-- ============================================================
-- [SOURCE] tool_links — symlinks from derived tool dirs to .claude
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  dir_name   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','broken','removed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(project_id, tool_name)
);

-- ============================================================
-- meta — schema version tracking for future migrations
-- ============================================================
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
