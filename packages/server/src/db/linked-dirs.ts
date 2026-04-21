/**
 * LinkedDir table access (.cursor/.codebuddy symlinks).
 *
 * DB row is a subset of the domain `LinkedDir` type: `target_path` and
 * `broken_reason` are derived at query time by SymlinkService (v0.3),
 * so they never round-trip through this table. Storing them would
 * introduce stale data the moment a user manually deletes a link on disk.
 */

import type { LinkedDir, LinkedDirStatus } from "@astack/shared";

import type { Db } from "./connection.js";

/**
 * Persisted subset of LinkedDir. The service layer enriches this into the
 * full domain type by reading the filesystem.
 */
export type LinkedDirRow = Omit<LinkedDir, "target_path" | "broken_reason">;

export class LinkedDirRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    project_id: number;
    tool_name: string;
    dir_name: string;
  }): LinkedDirRow {
    const row = this.db
      .prepare<[number, string, string], LinkedDirRow>(
        `INSERT INTO linked_dirs (project_id, tool_name, dir_name)
         VALUES (?, ?, ?)
         RETURNING id, project_id, tool_name, dir_name, status, created_at`
      )
      .get(input.project_id, input.tool_name, input.dir_name);
    if (!row) throw new Error("insert linked_dirs returned no row");
    return row;
  }

  findByProjectTool(
    project_id: number,
    tool_name: string
  ): LinkedDirRow | null {
    return (
      this.db
        .prepare<[number, string], LinkedDirRow>(
          `SELECT id, project_id, tool_name, dir_name, status, created_at
           FROM linked_dirs WHERE project_id = ? AND tool_name = ?`
        )
        .get(project_id, tool_name) ?? null
    );
  }

  listByProject(project_id: number): LinkedDirRow[] {
    return this.db
      .prepare<[number], LinkedDirRow>(
        `SELECT id, project_id, tool_name, dir_name, status, created_at
         FROM linked_dirs WHERE project_id = ? ORDER BY tool_name`
      )
      .all(project_id);
  }

  updateStatus(id: number, status: LinkedDirStatus): void {
    this.db
      .prepare<[LinkedDirStatus, number]>(
        "UPDATE linked_dirs SET status = ? WHERE id = ?"
      )
      .run(status, id);
  }

  deleteByProjectTool(project_id: number, tool_name: string): boolean {
    const info = this.db
      .prepare<[number, string]>(
        "DELETE FROM linked_dirs WHERE project_id = ? AND tool_name = ?"
      )
      .run(project_id, tool_name);
    return info.changes > 0;
  }
}
