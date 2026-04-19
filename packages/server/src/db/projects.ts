/**
 * Project table access.
 *
 * projects is [SOURCE] — the authoritative local registry of target projects.
 */

import type { Project } from "@astack/shared";

import type { Db } from "./connection.js";

type ProjectRow = Project;

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    name: string;
    path: string;
    primary_tool: string;
  }): Project {
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

  findById(id: number): Project | null {
    return (
      this.db
        .prepare<[number], ProjectRow>(
          `SELECT id, name, path, primary_tool, created_at
           FROM projects WHERE id = ?`
        )
        .get(id) ?? null
    );
  }

  findByPath(p: string): Project | null {
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
  ): { rows: Project[]; total: number } {
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
