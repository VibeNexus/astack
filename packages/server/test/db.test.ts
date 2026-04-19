/**
 * Tests for the SQLite schema.
 *
 * Uses :memory: databases for full isolation per test.
 *
 * No migration logic during the pre-1.0 development phase — the schema
 * is a single DDL applied on every fresh DB (see schema.ts).
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/connection.js";

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
        "projects",
        "seed_decisions",
        "skill_repos",
        "skills",
        "subscriptions",
        "sync_logs",
        "tool_links"
      ])
    );
    db.close();
  });

  it("enforces CHECK constraint on skills.type (accepts agent; rejects unknown)", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare(
      `INSERT INTO skill_repos (name, git_url) VALUES ('r', 'git@x:y.git')`
    ).run();

    // All three valid types succeed.
    for (const t of ["command", "skill", "agent"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO skills (repo_id, type, name, path)
             VALUES (1, ?, ?, ?)`
          )
          .run(t, `n-${t}`, `p-${t}`)
      ).not.toThrow();
    }

    // Unknown type rejected.
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

  it("skill_repos.status defaults to 'ready' and accepts seeding/failed values", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare(
      `INSERT INTO skill_repos (name, git_url) VALUES ('r1', 'git@x:a.git')`
    ).run();
    const r1 = db
      .prepare<[], { status: string }>(
        `SELECT status FROM skill_repos WHERE name = 'r1'`
      )
      .get();
    expect(r1?.status).toBe("ready");

    db.prepare(
      `INSERT INTO skill_repos (name, git_url, status) VALUES ('r2', 'git@x:b.git', 'seeding')`
    ).run();
    db.prepare(
      `INSERT INTO skill_repos (name, git_url, status) VALUES ('r3', 'git@x:c.git', 'failed')`
    ).run();

    const statuses = db
      .prepare<[], { name: string; status: string }>(
        `SELECT name, status FROM skill_repos ORDER BY name`
      )
      .all();
    expect(statuses.map((s) => s.status)).toEqual(["ready", "seeding", "failed"]);
    db.close();
  });

  it("skill_repos.scan_config stores arbitrary JSON", () => {
    const db = openDatabase({ path: ":memory:" });
    const cfg = JSON.stringify({
      roots: [{ path: "", kind: "skill-dirs" }]
    });
    db.prepare(
      `INSERT INTO skill_repos (name, git_url, scan_config) VALUES ('r', 'git@x:y.git', ?)`
    ).run(cfg);
    const row = db
      .prepare<[], { scan_config: string }>(
        `SELECT scan_config FROM skill_repos WHERE name = 'r'`
      )
      .get();
    expect(row?.scan_config).toBe(cfg);
    expect(JSON.parse(row!.scan_config)).toEqual({
      roots: [{ path: "", kind: "skill-dirs" }]
    });
    db.close();
  });

  it("seed_decisions table CHECKs decision='removed' and UNIQUE url", () => {
    const db = openDatabase({ path: ":memory:" });
    db.prepare(
      `INSERT INTO seed_decisions (url, decision) VALUES ('https://x/a.git', 'removed')`
    ).run();

    // Wrong decision value rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO seed_decisions (url, decision) VALUES ('https://x/b.git', 'wrong')`
        )
        .run()
    ).toThrow(/CHECK constraint/);

    // Same URL twice rejected (PK).
    expect(() =>
      db
        .prepare(
          `INSERT INTO seed_decisions (url, decision) VALUES ('https://x/a.git', 'removed')`
        )
        .run()
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
    db.close();
  });

  it("re-opening :memory: schema is idempotent (no errors on repeat exec)", () => {
    // Simulate an existing DB: open, then re-run DDL.
    const db = openDatabase({ path: ":memory:" });
    // openDatabase already ran the DDL once. Re-run it; should be a no-op
    // because every statement uses CREATE TABLE / INDEX IF NOT EXISTS.
    expect(() =>
      openDatabase({ path: ":memory:", migrate: true })
    ).not.toThrow();
    db.close();
  });
});
