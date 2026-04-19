/**
 * Subscription table access.
 *
 * subscriptions is [SOURCE] but MIRROR — file-authoritative over SQLite
 * (design.md § Eng Review decision 2/7). SubscriptionService is responsible
 * for keeping this table in sync with each project's `.astack.json`.
 */

import type { Subscription } from "@astack/shared";

import type { Db } from "./connection.js";

type SubscriptionRow = Subscription;

export class SubscriptionRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    project_id: number;
    skill_id: number;
    pinned_version: string | null;
  }): Subscription {
    const row = this.db
      .prepare<[number, number, string | null], SubscriptionRow>(
        `INSERT INTO subscriptions (project_id, skill_id, pinned_version)
         VALUES (?, ?, ?)
         RETURNING id, project_id, skill_id, pinned_version`
      )
      .get(input.project_id, input.skill_id, input.pinned_version);
    if (!row) throw new Error("insert subscriptions returned no row");
    return row;
  }

  upsert(input: {
    project_id: number;
    skill_id: number;
    pinned_version: string | null;
  }): Subscription {
    const row = this.db
      .prepare<[number, number, string | null], SubscriptionRow>(
        `INSERT INTO subscriptions (project_id, skill_id, pinned_version)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, skill_id) DO UPDATE SET
           pinned_version = excluded.pinned_version
         RETURNING id, project_id, skill_id, pinned_version`
      )
      .get(input.project_id, input.skill_id, input.pinned_version);
    if (!row) throw new Error("upsert subscriptions returned no row");
    return row;
  }

  findById(id: number): Subscription | null {
    return (
      this.db
        .prepare<[number], SubscriptionRow>(
          `SELECT id, project_id, skill_id, pinned_version
           FROM subscriptions WHERE id = ?`
        )
        .get(id) ?? null
    );
  }

  findByProjectSkill(
    project_id: number,
    skill_id: number
  ): Subscription | null {
    return (
      this.db
        .prepare<[number, number], SubscriptionRow>(
          `SELECT id, project_id, skill_id, pinned_version
           FROM subscriptions WHERE project_id = ? AND skill_id = ?`
        )
        .get(project_id, skill_id) ?? null
    );
  }

  listByProject(project_id: number): Subscription[] {
    return this.db
      .prepare<[number], SubscriptionRow>(
        `SELECT id, project_id, skill_id, pinned_version
         FROM subscriptions WHERE project_id = ? ORDER BY id`
      )
      .all(project_id);
  }

  deleteByProjectSkill(project_id: number, skill_id: number): boolean {
    const info = this.db
      .prepare<[number, number]>(
        "DELETE FROM subscriptions WHERE project_id = ? AND skill_id = ?"
      )
      .run(project_id, skill_id);
    return info.changes > 0;
  }

  deleteByProject(project_id: number): number {
    return this.db
      .prepare<[number]>("DELETE FROM subscriptions WHERE project_id = ?")
      .run(project_id).changes;
  }
}
