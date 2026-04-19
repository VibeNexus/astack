/**
 * Repository table access.
 *
 * Thin layer over SQLite `skill_repos` table. Returns strongly-typed
 * rows matching the `SkillRepo` domain type.
 */

import type { SkillRepo } from "@astack/shared";

import type { Db } from "./connection.js";

/** Shape as stored in SQLite (matches SkillRepo exactly). */
type SkillRepoRow = SkillRepo;

export class RepoRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    name: string;
    git_url: string;
    local_path: string | null;
  }): SkillRepo {
    const stmt = this.db.prepare<
      [string, string, string | null],
      SkillRepoRow
    >(
      `INSERT INTO skill_repos (name, git_url, local_path)
       VALUES (?, ?, ?)
       RETURNING id, name, git_url, local_path, head_hash, last_synced, created_at`
    );
    const row = stmt.get(input.name, input.git_url, input.local_path);
    if (!row) {
      // RETURNING should always produce a row on successful insert.
      throw new Error("insert skill_repos returned no row");
    }
    return row;
  }

  findById(id: number): SkillRepo | null {
    const row = this.db
      .prepare<[number], SkillRepoRow>(
        `SELECT id, name, git_url, local_path, head_hash, last_synced, created_at
         FROM skill_repos WHERE id = ?`
      )
      .get(id);
    return row ?? null;
  }

  findByName(name: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRow>(
        `SELECT id, name, git_url, local_path, head_hash, last_synced, created_at
         FROM skill_repos WHERE name = ?`
      )
      .get(name);
    return row ?? null;
  }

  findByGitUrl(url: string): SkillRepo | null {
    const row = this.db
      .prepare<[string], SkillRepoRow>(
        `SELECT id, name, git_url, local_path, head_hash, last_synced, created_at
         FROM skill_repos WHERE git_url = ?`
      )
      .get(url);
    return row ?? null;
  }

  list(
    opts: { offset: number; limit: number } = { offset: 0, limit: 50 }
  ): { rows: SkillRepo[]; total: number } {
    const rows = this.db
      .prepare<[number, number], SkillRepoRow>(
        `SELECT id, name, git_url, local_path, head_hash, last_synced, created_at
         FROM skill_repos ORDER BY id LIMIT ? OFFSET ?`
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
