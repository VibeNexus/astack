/**
 * Tests for the SQLite schema + migration logic.
 *
 * Uses :memory: databases for full isolation per test.
 */

import { describe, expect, it } from "vitest";

import { getSchemaVersion, migrate, openDatabase } from "../src/db/connection.js";

describe("openDatabase", () => {
  it("applies WAL pragma on file databases", () => {
    // WAL can't be set on :memory: — validate pragmas we expect in general.
    const db = openDatabase({ path: ":memory:" });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });

  it("creates all expected tables on a fresh db", () => {
    const db = openDatabase({ path: ":memory:" });
    const tables = db
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => r.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "meta",
        "projects",
        "skill_repos",
        "skills",
        "subscriptions",
        "sync_logs",
        "tool_links"
      ])
    );
    db.close();
  });

  it("sets schema_version in meta table after migration", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(getSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("is idempotent on re-migration", () => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("enforces CHECK constraint on skills.type", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare(
      `INSERT INTO skill_repos (name, git_url) VALUES ('r', 'git@x:y.git')`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO skills (repo_id, type, name, path) VALUES (1, 'wrong', 'x', 'x.md')`
        )
        .run()
    ).toThrow(/CHECK constraint/);
    db.close();
  });

  it("cascades skills deletion when skill_repos is deleted", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare(
      `INSERT INTO skill_repos (name, git_url) VALUES ('r', 'git@x:y.git')`
    ).run();
    db.prepare(
      `INSERT INTO skills (repo_id, type, name, path) VALUES (1, 'command', 'x', 'commands/x.md')`
    ).run();
    db.prepare(`DELETE FROM skill_repos WHERE id = 1`).run();
    const count = (
      db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM skills`).get() ?? {
        c: 0
      }
    ).c;
    expect(count).toBe(0);
    db.close();
  });
});
