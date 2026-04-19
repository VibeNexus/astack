/**
 * Skill table access.
 *
 * Skills are [CACHE] — fully derived from scanning git repos.
 * `astack sync --refresh` can DELETE + re-INSERT any row here.
 *
 * Schema v2 (planned in PR2 of v0.2) adds `description` column read from
 * SKILL.md frontmatter, and extends `type` CHECK to include 'agent'. PR1
 * extends the domain type; the DB schema is upgraded in PR2. Until then,
 * this file injects `description = null` on read.
 */

import type { Skill, SkillType } from "@astack/shared";

import type { Db } from "./connection.js";

/** v1 row shape (no description). */
interface SkillRowV1 {
  id: number;
  repo_id: number;
  type: SkillType;
  name: string;
  path: string;
  version: string | null;
  updated_at: string | null;
}

/** v1 SELECT columns. */
const SELECT_COLS = "id, repo_id, type, name, path, version, updated_at";

/** Lift v1 row into v2 Skill domain by defaulting `description` to null. */
function liftRow(row: SkillRowV1): Skill {
  return { ...row, description: null };
}

export class SkillRepository {
  constructor(private readonly db: Db) {}

  /**
   * Upsert a skill record keyed by (repo_id, type, name).
   * Returns the resulting row (new or updated).
   *
   * `description` is accepted but not yet persisted (PR2 adds the column).
   */
  upsert(input: {
    repo_id: number;
    type: SkillType;
    name: string;
    path: string;
    description?: string | null;
    version: string | null;
    updated_at: string | null;
  }): Skill {
    const row = this.db
      .prepare<
        [number, SkillType, string, string, string | null, string | null],
        SkillRowV1
      >(
        `INSERT INTO skills (repo_id, type, name, path, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, type, name) DO UPDATE SET
           path = excluded.path,
           version = excluded.version,
           updated_at = excluded.updated_at
         RETURNING ${SELECT_COLS}`
      )
      .get(
        input.repo_id,
        input.type,
        input.name,
        input.path,
        input.version,
        input.updated_at
      );

    if (!row) throw new Error("upsert skills returned no row");
    const lifted = liftRow(row);
    if (input.description !== undefined) {
      lifted.description = input.description;
    }
    return lifted;
  }

  findById(id: number): Skill | null {
    const row = this.db
      .prepare<[number], SkillRowV1>(
        `SELECT ${SELECT_COLS} FROM skills WHERE id = ?`
      )
      .get(id);
    return row ? liftRow(row) : null;
  }

  findByRef(
    repo_id: number,
    type: SkillType,
    name: string
  ): Skill | null {
    const row = this.db
      .prepare<[number, SkillType, string], SkillRowV1>(
        `SELECT ${SELECT_COLS} FROM skills
         WHERE repo_id = ? AND type = ? AND name = ?`
      )
      .get(repo_id, type, name);
    return row ? liftRow(row) : null;
  }

  /**
   * Find skill by short name across all repos (for CLI `astack subscribe <name>`
   * in single-repo setups). Returns all matches so caller can detect ambiguity.
   */
  findByShortName(name: string): Skill[] {
    return this.db
      .prepare<[string], SkillRowV1>(
        `SELECT ${SELECT_COLS} FROM skills WHERE name = ?`
      )
      .all(name)
      .map(liftRow);
  }

  listByRepo(repo_id: number): Skill[] {
    return this.db
      .prepare<[number], SkillRowV1>(
        `SELECT ${SELECT_COLS} FROM skills WHERE repo_id = ? ORDER BY type, name`
      )
      .all(repo_id)
      .map(liftRow);
  }

  /** Delete all skills of a repo (used by `astack sync --refresh`). */
  deleteByRepo(repo_id: number): number {
    const info = this.db
      .prepare<[number]>("DELETE FROM skills WHERE repo_id = ?")
      .run(repo_id);
    return info.changes;
  }

  /**
   * After a scan, remove rows for this repo that weren't seen.
   * Takes the list of (type, name) pairs that ARE present; anything else goes.
   */
  deleteMissing(
    repo_id: number,
    present: ReadonlyArray<{ type: SkillType; name: string }>
  ): number {
    if (present.length === 0) {
      return this.deleteByRepo(repo_id);
    }

    // Build a temp table of keys to keep; DELETE rows not in it.
    // SQLite supports VALUES (...) table expression.
    const placeholders = present
      .map(() => "(?,?)")
      .join(",");
    const params: (string | SkillType)[] = [];
    for (const p of present) {
      params.push(p.type, p.name);
    }

    const info = this.db
      .prepare<(string | SkillType | number)[]>(
        `DELETE FROM skills
         WHERE repo_id = ?
           AND (type, name) NOT IN (VALUES ${placeholders})`
      )
      .run(repo_id, ...params);
    return info.changes;
  }
}
