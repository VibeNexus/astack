/**
 * Project table access.
 *
 * projects is [SOURCE] — the authoritative local registry of target projects.
 *
 * DB row is a subset of the domain `Project`: `primary_tool_status` is
 * derived at query time from the filesystem (v0.3), so it never
 * round-trips through this table. Storing it would create stale data
 * the moment a user removes `.claude/` out of band.
 */

import type { Project } from "@astack/shared";

import type { Db } from "./connection.js";

/**
 * Persisted subset of Project. The service layer enriches this into the
 * full domain type by inspecting the filesystem.
 */
export type ProjectRow = Omit<Project, "primary_tool_status">;

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    name: string;
    path: string;
    primary_tool: string;
  }): ProjectRow {
    const row = this.db
      .prepare<[string, string, string], ProjectRow>(
        `INSERT INTO projects (name, path, primary_tool)
         VALUES (?, ?, ?)
         RETURNING id, name, path, primary_tool, created_at`
      )
      .get(input.name, input.path, input.primary_tool);
    if (!row) throw new Error("insert projects returned no row");
    return row;
  }

  findById(id: number): ProjectRow | null {
    return (
      this.db
        .prepare<[number], ProjectRow>(
          `SELECT id, name, path, primary_tool, created_at
           FROM projects WHERE id = ?`
        )
        .get(id) ?? null
    );
  }

  findByPath(p: string): ProjectRow | null {
    return (
      this.db
        .prepare<[string], ProjectRow>(
          `SELECT id, name, path, primary_tool, created_at
           FROM projects WHERE path = ?`
        )
        .get(p) ?? null
    );
  }

  list(
    opts: { offset: number; limit: number } = { offset: 0, limit: 50 }
  ): { rows: ProjectRow[]; total: number } {
    const rows = this.db
      .prepare<[number, number], ProjectRow>(
        `SELECT id, name, path, primary_tool, created_at
         FROM projects ORDER BY id LIMIT ? OFFSET ?`
      )
      .all(opts.limit, opts.offset);
    const total = (
      this.db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM projects")
        .get() ?? { c: 0 }
    ).c;
    return { rows, total };
  }

  delete(id: number): boolean {
    const info = this.db
      .prepare<[number]>("DELETE FROM projects WHERE id = ?")
      .run(id);
    return info.changes > 0;
  }
}
