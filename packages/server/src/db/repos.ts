/**
 * Repository table access.
 *
 * Thin layer over SQLite `skill_repos` table. Returns strongly-typed
 * rows matching the `SkillRepo` domain type.
 *
 * Schema v2 (planned in PR2 of the v0.2 iteration) adds two columns:
 * `status` and `scan_config`. PR1 extends the domain type but leaves the
 * DB schema untouched; this file compensates by injecting default values
 * for those fields on read. PR2 will swap `SELECT_COLS` and `INSERT` to
 * use the real columns.
 */

import {
  DEFAULT_SCAN_CONFIG,
  RepoStatus,
  type RepoKind,
  type ScanConfig,
  type SkillRepo
} from "@astack/shared";

import type { Db } from "./connection.js";

/** Shape of the row actually returned by SELECT (v1 schema). */
interface SkillRepoRowV1 {
  id: number;
  name: string;
  git_url: string;
  kind: RepoKind;
  local_path: string | null;
  head_hash: string | null;
  last_synced: string | null;
  created_at: string;
}

/** Columns to SELECT on the v1 schema. */
const SELECT_COLS =
  "id, name, git_url, kind, local_path, head_hash, last_synced, created_at";

/**
 * Lift a v1 row into the v2 `SkillRepo` domain shape by supplying defaults
 * for columns that don't yet exist in the DB (PR2 adds them).
 */
function liftRow(row: SkillRepoRowV1): SkillRepo {
  return {
    ...row,
    status: RepoStatus.Ready,
    scan_config: null
  };
}

export class RepoRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    name: string;
    git_url: string;
    kind: RepoKind;
    local_path: string | null;
    /**
     * Accepted but not yet persisted (PR2 adds the column). Callers may
     * pass a value today; it is a no-op at the DB layer.
     */
    scan_config?: ScanConfig | null;
  }): SkillRepo {
    const stmt = this.db.prepare<
      [string, string, RepoKind, string | null],
      SkillRepoRowV1
    >(
      `INSERT INTO skill_repos (name, git_url, kind, local_path)
       VALUES (?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`
    );
    const row = stmt.get(input.name, input.git_url, input.kind, input.local_path);
    if (!row) {
      throw new Error("insert skill_repos returned no row");
    }
    // PR2 will persist scan_config; for now we return the caller's value
    // without a round-trip so tests asserting scan_config on register see
    // what they passed in.
    const lifted = liftRow(row);
    if (input.scan_config !== undefined) {
      lifted.scan_config = input.scan_config;
    }
    return lifted;
  }

  findById(id: number): SkillRepo | null {
    const row = this.db
      .prepare<[number], SkillRepoRowV1>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE id = ?`
      )
      .get(id);
    return row ? liftRow(row) : null;
  }

  findByName(name: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRowV1>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE name = ?`
      )
      .get(name);
    return row ? liftRow(row) : null;
  }

  findByGitUrl(url: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRowV1>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE git_url = ?`
      )
      .get(url);
    return row ? liftRow(row) : null;
  }

  list(
    opts: { offset: number; limit: number } = { offset: 0, limit: 50 }
  ): { rows: SkillRepo[]; total: number } {
    const rows = this.db
      .prepare<[number, number], SkillRepoRowV1>(
        `SELECT ${SELECT_COLS} FROM skill_repos ORDER BY id LIMIT ? OFFSET ?`
      )
      .all(opts.limit, opts.offset);
    const total = (
      this.db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM skill_repos")
        .get() ?? { c: 0 }
    ).c;
    return { rows: rows.map(liftRow), total };
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

  delete(id: number): boolean {
    const info = this.db
      .prepare<[number]>("DELETE FROM skill_repos WHERE id = ?")
      .run(id);
    return info.changes > 0;
  }
}

/** Re-export for tests that want to craft expected rows. */
export { DEFAULT_SCAN_CONFIG };
