/**
 * Repository table access.
 *
 * Thin layer over SQLite `skill_repos` table. Returns strongly-typed
 * rows matching the `SkillRepo` domain type.
 */

import {
  RepoStatus,
  type RepoKind,
  type ScanConfig,
  type SkillRepo
} from "@astack/shared";

import type { Db } from "./connection.js";

/** Columns selected to hydrate a `SkillRepo`. */
const SELECT_COLS =
  "id, name, git_url, kind, status, scan_config, local_path, head_hash, last_synced, created_at";

/**
 * Row as returned by SELECT: `scan_config` is a raw JSON string (or NULL)
 * because SQLite has no JSON column type. We deserialize on the way out.
 */
interface SkillRepoRow {
  id: number;
  name: string;
  git_url: string;
  kind: RepoKind;
  status: string;
  scan_config: string | null;
  local_path: string | null;
  head_hash: string | null;
  last_synced: string | null;
  created_at: string;
}

function hydrate(row: SkillRepoRow): SkillRepo {
  return {
    id: row.id,
    name: row.name,
    git_url: row.git_url,
    kind: row.kind,
    status: normalizeStatus(row.status),
    scan_config: row.scan_config ? (JSON.parse(row.scan_config) as ScanConfig) : null,
    local_path: row.local_path,
    head_hash: row.head_hash,
    last_synced: row.last_synced,
    created_at: row.created_at
  };
}

function normalizeStatus(raw: string): SkillRepo["status"] {
  // The DB column has no CHECK constraint (zod owns enum validation);
  // fall back to Ready for any unexpected value.
  if (
    raw === RepoStatus.Ready ||
    raw === RepoStatus.Seeding ||
    raw === RepoStatus.Failed
  ) {
    return raw;
  }
  return RepoStatus.Ready;
}

export class RepoRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    name: string;
    git_url: string;
    kind: RepoKind;
    local_path: string | null;
    /** Null / undefined = use DEFAULT_SCAN_CONFIG at scan time. */
    scan_config?: ScanConfig | null;
    /** Defaults to 'ready'. SeedService passes 'seeding' while cloning. */
    status?: SkillRepo["status"];
  }): SkillRepo {
    const scanJson =
      input.scan_config == null ? null : JSON.stringify(input.scan_config);
    const status = input.status ?? RepoStatus.Ready;

    const row = this.db
      .prepare<
        [string, string, RepoKind, string, string | null, string | null],
        SkillRepoRow
      >(
        `INSERT INTO skill_repos (name, git_url, kind, status, scan_config, local_path)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING ${SELECT_COLS}`
      )
      .get(
        input.name,
        input.git_url,
        input.kind,
        status,
        scanJson,
        input.local_path
      );
    if (!row) {
      throw new Error("insert skill_repos returned no row");
    }
    return hydrate(row);
  }

  findById(id: number): SkillRepo | null {
    const row = this.db
      .prepare<[number], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE id = ?`
      )
      .get(id);
    return row ? hydrate(row) : null;
  }

  findByName(name: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE name = ?`
      )
      .get(name);
    return row ? hydrate(row) : null;
  }

  findByGitUrl(url: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE git_url = ?`
      )
      .get(url);
    return row ? hydrate(row) : null;
  }

  list(
    opts: { offset: number; limit: number } = { offset: 0, limit: 50 }
  ): { rows: SkillRepo[]; total: number } {
    const rows = this.db
      .prepare<[number, number], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos ORDER BY id LIMIT ? OFFSET ?`
      )
      .all(opts.limit, opts.offset);
    const total = (
      this.db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM skill_repos")
        .get() ?? { c: 0 }
    ).c;
    return { rows: rows.map(hydrate), total };
  }

  updateSyncState(
    id: number,
    fields: { head_hash: string | null; last_synced: string | null }
  ): void {
    this.db
      .prepare<[string | null, string | null, number]>(
        `UPDATE skill_repos SET head_hash = ?, last_synced = ? WHERE id = ?`
      )
      .run(fields.head_hash, fields.last_synced, id);
  }

  /** Used by SeedService to flip 'seeding' → 'ready' or 'failed'. */
  updateStatus(id: number, status: SkillRepo["status"]): void {
    this.db
      .prepare<[string, number]>(
        `UPDATE skill_repos SET status = ? WHERE id = ?`
      )
      .run(status, id);
  }

  delete(id: number): boolean {
    const info = this.db
      .prepare<[number]>("DELETE FROM skill_repos WHERE id = ?")
      .run(id);
    return info.changes > 0;
  }
}
