/**
 * Repository table access.
 *
 * Thin layer over SQLite `skill_repos` table. Returns strongly-typed
 * rows matching the `SkillRepo` domain type.
 */

import type { RepoKind, SkillRepo } from "@astack/shared";

import type { Db } from "./connection.js";

/** Shape as stored in SQLite (matches SkillRepo exactly). */
type SkillRepoRow = SkillRepo;

const SELECT_COLS =
  "id, name, git_url, kind, local_path, head_hash, last_synced, created_at";

export class RepoRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    name: string;
    git_url: string;
    kind: RepoKind;
    local_path: string | null;
  }): SkillRepo {
    const stmt = this.db.prepare<
      [string, string, RepoKind, string | null],
      SkillRepoRow
    >(
      `INSERT INTO skill_repos (name, git_url, kind, local_path)
       VALUES (?, ?, ?, ?)
       RETURNING ${SELECT_COLS}`
    );
    const row = stmt.get(input.name, input.git_url, input.kind, input.local_path);
    if (!row) {
      throw new Error("insert skill_repos returned no row");
    }
    return row;
  }

  findById(id: number): SkillRepo | null {
    const row = this.db
      .prepare<[number], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE id = ?`
      )
      .get(id);
    return row ?? null;
  }

  findByName(name: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE name = ?`
      )
      .get(name);
    return row ?? null;
  }

  findByGitUrl(url: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRow>(
        `SELECT ${SELECT_COLS} FROM skill_repos WHERE git_url = ?`
      )
      .get(url);
    return row ?? null;
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
    return { rows, total };
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
