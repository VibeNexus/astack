/**
 * SQLite database initialization.
 *
 * Configuration (design.md § Eng Review decision 11):
 *   - WAL mode (concurrent reads alongside writes)
 *   - busy_timeout 5s (handle brief contention without SQLITE_BUSY)
 *   - foreign_keys ON (enforce referential integrity)
 *
 * Tests use `:memory:` for full isolation per-test.
 *
 * No schema migrations during the pre-1.0 development phase: see
 * `schema.ts` — the DDL is idempotent (CREATE TABLE IF NOT EXISTS), and
 * when the shape changes, the developer deletes the local DB and restarts.
 */

import path from "node:path";
import fs from "node:fs";

import Database, { type Database as Db } from "better-sqlite3";

import { SCHEMA_DDL } from "./schema.js";

export type { Db };

export interface OpenDbOptions {
  /** Absolute path, or ":memory:" for in-memory (tests). */
  path: string;
  /** Set to false to skip schema DDL (tests may want a raw DB). */
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
    db.exec(SCHEMA_DDL);
  }

  return db;
}
