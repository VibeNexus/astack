/**
 * SQLite database initialization.
 *
 * Configuration (design.md § Eng Review decision 11):
 *   - WAL mode (concurrent reads alongside writes)
 *   - busy_timeout 5s (handle brief contention without SQLITE_BUSY)
 *   - foreign_keys ON (enforce referential integrity)
 *
 * Tests use `:memory:` for full isolation per-test.
 */

import path from "node:path";
import fs from "node:fs";

import Database, { type Database as Db } from "better-sqlite3";

import { SCHEMA_DDL, SCHEMA_VERSION } from "./schema.js";

export type { Db };

export interface OpenDbOptions {
  /** Absolute path, or ":memory:" for in-memory (tests). */
  path: string;
  /** Set to false to skip schema migrations (tests may want raw DB). */
  migrate?: boolean;
}

/**
 * Open a SQLite database with Astack's standard pragmas and schema.
 *
 * On a fresh file, this creates the schema. On an existing file, it's
 * a no-op thanks to `CREATE TABLE IF NOT EXISTS`.
 */
export function openDatabase(opts: OpenDbOptions): Db {
  if (opts.path !== ":memory:") {
    fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  }

  const db = new Database(opts.path);

  // Pragmas — order matters for WAL on fresh files.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  if (opts.migrate !== false) {
    migrate(db);
  }

  return db;
}

/**
 * Apply schema migrations.
 *
 * v1: initial schema. Future migrations add here, each gated by
 * `currentVersion < N` and bumping `meta.schema_version` at the end.
 */
export function migrate(db: Db): void {
  db.exec(SCHEMA_DDL);

  const row = db
    .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion < SCHEMA_VERSION) {
    // Future: apply v(currentVersion+1 ... SCHEMA_VERSION) migrations here.
    db.prepare<[string, string]>(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    ).run("schema_version", String(SCHEMA_VERSION));
  }
}

/** Read the current schema version. Returns 0 if meta table is empty. */
export function getSchemaVersion(db: Db): number {
  const row = db
    .prepare<[], { value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )
    .get();
  return row ? parseInt(row.value, 10) : 0;
}
