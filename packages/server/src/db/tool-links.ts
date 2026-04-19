/**
 * ToolLink table access (.cursor/.codebuddy symlinks).
 */

import type { ToolLink, ToolLinkStatus } from "@astack/shared";

import type { Db } from "./connection.js";

type ToolLinkRow = ToolLink;

export class ToolLinkRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    project_id: number;
    tool_name: string;
    dir_name: string;
  }): ToolLink {
    const row = this.db
      .prepare<[number, string, string], ToolLinkRow>(
        `INSERT INTO tool_links (project_id, tool_name, dir_name)
         VALUES (?, ?, ?)
         RETURNING id, project_id, tool_name, dir_name, status, created_at`
      )
      .get(input.project_id, input.tool_name, input.dir_name);
    if (!row) throw new Error("insert tool_links returned no row");
    return row;
  }

  findByProjectTool(
    project_id: number,
    tool_name: string
  ): ToolLink | null {
    return (
      this.db
        .prepare<[number, string], ToolLinkRow>(
          `SELECT id, project_id, tool_name, dir_name, status, created_at
           FROM tool_links WHERE project_id = ? AND tool_name = ?`
        )
        .get(project_id, tool_name) ?? null
    );
  }

  listByProject(project_id: number): ToolLink[] {
    return this.db
      .prepare<[number], ToolLinkRow>(
        `SELECT id, project_id, tool_name, dir_name, status, created_at
         FROM tool_links WHERE project_id = ? ORDER BY tool_name`
      )
      .all(project_id);
  }

  updateStatus(id: number, status: ToolLinkStatus): void {
    this.db
      .prepare<[ToolLinkStatus, number]>(
        "UPDATE tool_links SET status = ? WHERE id = ?"
      )
      .run(status, id);
  }

  deleteByProjectTool(project_id: number, tool_name: string): boolean {
    const info = this.db
      .prepare<[number, string]>(
        "DELETE FROM tool_links WHERE project_id = ? AND tool_name = ?"
      )
      .run(project_id, tool_name);
    return info.changes > 0;
  }
}
