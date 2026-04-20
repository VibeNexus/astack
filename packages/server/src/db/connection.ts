/**
 * SQLite database initialization.
 *
 * Since v0.2 we use Node's built-in `node:sqlite` module (available
 * from Node 22.13+, non-flagged). The `Db` class below is a thin wrapper
 * whose call surface mirrors the subset of better-sqlite3 that astack
 * uses, so the ~15 call sites across db/*.ts and services/*.ts didn't
 * need to change when we swapped drivers.
 *
 * Pragma configuration (design.md § Eng Review decision 11):
 *   - WAL mode (concurrent reads alongside writes)
 *   - busy_timeout 5s (handle brief contention without SQLITE_BUSY)
 *   - foreign_keys ON (enforce referential integrity)
 *
 * Tests use `:memory:` for full isolation per-test.
 *
 * Schema evolution: single `SCHEMA_DDL` constant in schema.ts. No
 * version table, no migration machinery (pre-1.0, single user).
 */

import path from "node:path";
import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { SCHEMA_DDL } from "./schema.js";

export interface OpenDbOptions {
  /** Absolute path, or ":memory:" for in-memory (tests). */
  path: string;
  /** Set to false to skip schema DDL (tests may want a raw DB). */
  migrate?: boolean;
}

/**
 * Result of `stmt.run()`. Mirrors better-sqlite3's shape.
 * `lastInsertRowid` can be number or bigint depending on row size.
 */
export interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Typed prepared statement. `Params` is the positional-argument tuple;
 * `Row` is the expected return-row shape (asserted, not validated).
 */
export interface PreparedStatement<
  Params extends unknown[] = unknown[],
  Row = unknown
> {
  run(...params: Params): RunInfo;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
  iterate(...params: Params): IterableIterator<Row>;
}

/** Options accepted by our `Db.pragma()` helper (better-sqlite3 parity). */
export interface PragmaOptions {
  /**
   * When true, returns the *first column of the first row* only, instead
   * of the full row object. Useful for simple pragma reads like
   * `db.pragma('foreign_keys', { simple: true }) === 1`.
   */
  simple?: boolean;
}

/**
 * node:sqlite rejects `undefined` as a bound parameter with a runtime
 * TypeError; better-sqlite3 silently coerced undefined to NULL. We match
 * the old behavior at the wrapper level so call sites don't have to
 * sprinkle `?? null` everywhere for optional columns.
 */
function normalizeParams(params: unknown[]): unknown[] {
  for (let i = 0; i < params.length; i++) {
    if (params[i] === undefined) params[i] = null;
  }
  return params;
}

/**
 * Thin wrapper around `node:sqlite`'s `DatabaseSync`. Exists so the rest
 * of the codebase can keep writing `db.prepare<...>(sql).get(...)` with
 * typed params and typed row results, even though the underlying
 * `StatementSync` returns `unknown`.
 */
export class Db {
  constructor(private readonly raw: DatabaseSync) {}

  prepare<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string
  ): PreparedStatement<Params, Row> {
    const stmt: StatementSync = this.raw.prepare(sql);
    return {
      run(...params: Params): RunInfo {
        const info = stmt.run(...(normalizeParams(params) as never[]));
        return {
          changes: Number(info.changes),
          lastInsertRowid: info.lastInsertRowid as number | bigint
        };
      },
      get(...params: Params): Row | undefined {
        const row = stmt.get(...(normalizeParams(params) as never[]));
        return row === null || row === undefined ? undefined : (row as Row);
      },
      all(...params: Params): Row[] {
        return stmt.all(
          ...(normalizeParams(params) as never[])
        ) as Row[];
      },
      iterate(...params: Params): IterableIterator<Row> {
        return stmt.iterate(
          ...(normalizeParams(params) as never[])
        ) as IterableIterator<Row>;
      }
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }

  /**
   * Compatibility shim for better-sqlite3's `db.pragma(name)` /
   * `db.pragma('x = y')`. Supports:
   *   - write form: `db.pragma('journal_mode = WAL')`  (uses exec)
   *   - read form:  `db.pragma('foreign_keys')`        (returns { foreign_keys: 1 })
   *   - simple:     `db.pragma('foreign_keys', { simple: true })` → 1
   *
   * node:sqlite has no built-in `.pragma()` helper; everything goes
   * through `exec` / `prepare('PRAGMA x').get()`.
   */
  pragma(statement: string, opts: PragmaOptions = {}): unknown {
    // If the statement includes `=`, it's a write; exec and return nothing
    // meaningful (matches better-sqlite3's write-form behavior for our
    // call sites — we never inspect the return value of a write pragma).
    if (statement.includes("=")) {
      this.raw.exec(`PRAGMA ${statement}`);
      return undefined;
    }
    // Read form.
    const row = this.raw.prepare(`PRAGMA ${statement}`).get();
    if (!opts.simple) return row;
    if (row === null || row === undefined) return undefined;
    // Return the first column of the row.
    const obj = row as Record<string, unknown>;
    const keys = Object.keys(obj);
    return keys.length > 0 ? obj[keys[0]!] : undefined;
  }
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

  const raw = new DatabaseSync(opts.path);
  const db = new Db(raw);

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
