/**
 * SyncLog table access.
 *
 * sync_logs is [SOURCE] — lives only in SQLite. Append-only.
 */

import type { SyncDirection, SyncLog, SyncStatus } from "@astack/shared";

import type { Db } from "./connection.js";

/**
 * Extended SyncLog row that also holds the content_hash column.
 *
 * The public SyncLog domain type is wire-visible (see @astack/shared).
 * content_hash is an internal server-side field used to distinguish
 * Behind (local unchanged) from Conflict (local diverged) on the next sync.
 */
export interface SyncLogRow extends SyncLog {
  content_hash: string | null;
}

export class SyncLogRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    project_id: number;
    skill_id: number;
    direction: SyncDirection;
    from_version: string | null;
    to_version: string | null;
    status: SyncStatus;
    conflict_detail: string | null;
    content_hash: string | null;
  }): SyncLogRow {
    const row = this.db
      .prepare<
        [
          number,
          number,
          SyncDirection,
          string | null,
          string | null,
          SyncStatus,
          string | null,
          string | null
        ],
        SyncLogRow
      >(
        `INSERT INTO sync_logs
           (project_id, skill_id, direction, from_version, to_version,
            status, conflict_detail, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, project_id, skill_id, direction, from_version,
                   to_version, status, conflict_detail, content_hash, synced_at`
      )
      .get(
        input.project_id,
        input.skill_id,
        input.direction,
        input.from_version,
        input.to_version,
        input.status,
        input.conflict_detail,
        input.content_hash
      );
    if (!row) throw new Error("insert sync_logs returned no row");
    return row;
  }

  /** Most recent log for a (project, skill). Returns null if none. */
  latestForProjectSkill(
    project_id: number,
    skill_id: number
  ): SyncLogRow | null {
    return (
      this.db
        .prepare<[number, number], SyncLogRow>(
          `SELECT id, project_id, skill_id, direction, from_version,
                  to_version, status, conflict_detail, content_hash, synced_at
           FROM sync_logs
           WHERE project_id = ? AND skill_id = ?
           ORDER BY synced_at DESC, id DESC
           LIMIT 1`
        )
        .get(project_id, skill_id) ?? null
    );
  }

  /** Most recent successful log for a (project, skill). Used for 'base' lookup. */
  latestSuccessForProjectSkill(
    project_id: number,
    skill_id: number
  ): SyncLogRow | null {
    return (
      this.db
        .prepare<[number, number], SyncLogRow>(
          `SELECT id, project_id, skill_id, direction, from_version,
                  to_version, status, conflict_detail, content_hash, synced_at
           FROM sync_logs
           WHERE project_id = ? AND skill_id = ? AND status = 'success'
           ORDER BY synced_at DESC, id DESC
           LIMIT 1`
        )
        .get(project_id, skill_id) ?? null
    );
  }

  /** Most recent sync_at across all logs for a project. */
  latestSyncAtForProject(project_id: number): string | null {
    const row = this.db
      .prepare<[number], { synced_at: string }>(
        `SELECT synced_at FROM sync_logs
         WHERE project_id = ?
         ORDER BY synced_at DESC, id DESC
         LIMIT 1`
      )
      .get(project_id);
    return row?.synced_at ?? null;
  }
}
