/**
 * local_skills table access — v0.7.
 *
 * LocalSkill is a SOURCE table (per-machine, does NOT mirror .astack.json).
 * All writes go through LocalSkillService; the repository is deliberately
 * thin (prepared statements + row → domain mapping) to keep business
 * logic (hash computation, collision detection, lock acquisition) out of
 * the persistence layer.
 *
 * See docs/version/v0.7-local-skills.md §A1 / §1.4.
 */

import type {
  Id,
  LocalSkill,
  LocalSkillOrigin,
  LocalSkillStatus,
  SkillType
} from "@astack/shared";

import type { Db } from "./connection.js";

/**
 * Raw row shape returned by `SELECT * FROM local_skills` — SQLite stores
 * enums as TEXT so we widen to `string` at the repo boundary and narrow
 * back to the domain enums when mapping.
 */
interface LocalSkillRow {
  id: string;
  project_id: number;
  type: string;
  name: string;
  rel_path: string;
  description: string | null;
  origin: string;
  status: string;
  content_hash: string | null;
  adopted_at: string;
  last_seen_at: string;
}

function toDomain(row: LocalSkillRow): LocalSkill {
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type as SkillType,
    name: row.name,
    rel_path: row.rel_path,
    description: row.description,
    origin: row.origin as LocalSkillOrigin,
    status: row.status as LocalSkillStatus,
    content_hash: row.content_hash,
    adopted_at: row.adopted_at,
    last_seen_at: row.last_seen_at
  };
}

export interface UpsertLocalSkillInput {
  id: string;
  project_id: Id;
  type: SkillType;
  name: string;
  rel_path: string;
  description: string | null;
  origin: LocalSkillOrigin;
  status: LocalSkillStatus;
  content_hash: string | null;
  adopted_at: string;
  last_seen_at: string;
}

export class LocalSkillRepository {
  constructor(private readonly db: Db) {}

  /** All LocalSkills for a project, ordered by (type, name) for stable UI. */
  listByProject(project_id: Id): LocalSkill[] {
    return this.db
      .prepare<[number], LocalSkillRow>(
        `SELECT id, project_id, type, name, rel_path, description, origin,
                status, content_hash, adopted_at, last_seen_at
         FROM local_skills
         WHERE project_id = ?
         ORDER BY type, name`
      )
      .all(project_id)
      .map(toDomain);
  }

  findByRef(
    project_id: Id,
    type: SkillType,
    name: string
  ): LocalSkill | null {
    const row = this.db
      .prepare<[number, string, string], LocalSkillRow>(
        `SELECT id, project_id, type, name, rel_path, description, origin,
                status, content_hash, adopted_at, last_seen_at
         FROM local_skills
         WHERE project_id = ? AND type = ? AND name = ?`
      )
      .get(project_id, type, name);
    return row ? toDomain(row) : null;
  }

  findById(id: string): LocalSkill | null {
    const row = this.db
      .prepare<[string], LocalSkillRow>(
        `SELECT id, project_id, type, name, rel_path, description, origin,
                status, content_hash, adopted_at, last_seen_at
         FROM local_skills
         WHERE id = ?`
      )
      .get(id);
    return row ? toDomain(row) : null;
  }

  /**
   * Insert-or-update by (project_id, type, name). `origin` is explicitly
   * preserved on conflict: callers that want to overwrite origin must
   * do so via `setOrigin` (e.g. UI adopt replacing an auto-adopt).
   */
  upsert(input: UpsertLocalSkillInput): LocalSkill {
    const row = this.db
      .prepare<
        [
          string,
          number,
          string,
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          string,
          string
        ],
        LocalSkillRow
      >(
        `INSERT INTO local_skills
           (id, project_id, type, name, rel_path, description, origin,
            status, content_hash, adopted_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, type, name) DO UPDATE SET
           rel_path      = excluded.rel_path,
           description   = excluded.description,
           status        = excluded.status,
           content_hash  = excluded.content_hash,
           last_seen_at  = excluded.last_seen_at
         RETURNING id, project_id, type, name, rel_path, description, origin,
                   status, content_hash, adopted_at, last_seen_at`
      )
      .get(
        input.id,
        input.project_id,
        input.type,
        input.name,
        input.rel_path,
        input.description,
        input.origin,
        input.status,
        input.content_hash,
        input.adopted_at,
        input.last_seen_at
      );
    if (!row) throw new Error("upsert local_skills returned no row");
    return toDomain(row);
  }

  /** Update only mutable status fields for rescan. */
  updateStatus(
    id: string,
    patch: {
      status: LocalSkillStatus;
      content_hash: string | null;
      last_seen_at: string;
    }
  ): void {
    this.db
      .prepare<[string, string | null, string, string]>(
        `UPDATE local_skills
         SET status = ?, content_hash = ?, last_seen_at = ?
         WHERE id = ?`
      )
      .run(patch.status, patch.content_hash, patch.last_seen_at, id);
  }

  /**
   * Promote an existing row's origin — used when the user manually adopts
   * a row that was previously auto-adopted; the inverse transition
   * (adopted → auto) is never performed.
   */
  setOrigin(id: string, origin: LocalSkillOrigin): void {
    this.db
      .prepare<[string, string]>(
        `UPDATE local_skills SET origin = ? WHERE id = ?`
      )
      .run(origin, id);
  }

  deleteByRef(project_id: Id, type: SkillType, name: string): boolean {
    const info = this.db
      .prepare<[number, string, string]>(
        `DELETE FROM local_skills
         WHERE project_id = ? AND type = ? AND name = ?`
      )
      .run(project_id, type, name);
    return info.changes > 0;
  }

  deleteByProject(project_id: Id): number {
    return this.db
      .prepare<[number]>(`DELETE FROM local_skills WHERE project_id = ?`)
      .run(project_id).changes;
  }
}
