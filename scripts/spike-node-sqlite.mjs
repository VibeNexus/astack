#!/usr/bin/env node
/**
 * PR0 Spike: node:sqlite 契约验证。
 *
 * 目标：验证 node:sqlite 在 astack PR2/PR3 实际使用路径上的行为契约。
 *
 * 验证项（按 Spec docs/version/v0.2-sqlite-and-multi-repo.md § 4 PR0）：
 *   1. WAL pragma 读写返回值形态稳定
 *   2. 完整迁移流程：
 *      PRAGMA foreign_keys = OFF (事务外)
 *      BEGIN IMMEDIATE
 *        CREATE / INSERT SELECT / DROP / RENAME
 *      COMMIT
 *      PRAGMA foreign_keys = ON (事务外)
 *      PRAGMA foreign_key_check (应返回 0 行)
 *   3. prepare / run / get / all / iterate 行为与 better-sqlite3 兼容
 *   4. BigInt、Uint8Array 行为符合预期
 *   5. FK CASCADE 在 FK OFF 下不触发（关键：保护 sync_logs / subscriptions 不被级联删）
 *
 * 用法：
 *   node scripts/spike-node-sqlite.mjs
 *
 * 输出：每个断言的结果 + 版本信息 + 最终 PASS/FAIL。
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

console.log(`node:sqlite SPIKE on Node.js ${process.versions.node}`);
console.log(`Platform: ${os.platform()}-${os.arch()}`);

// ---- Setup ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-spike-"));
const dbPath = path.join(tmpDir, "spike.db");
console.log(`DB path: ${dbPath}\n`);

let db;

try {
  // ============================================================
  section("1. Database open + pragma contract");
  // ============================================================

  db = new DatabaseSync(dbPath);
  check("DatabaseSync opens file-backed DB", db instanceof DatabaseSync);

  // WAL pragma via exec (write form)
  db.exec("PRAGMA journal_mode = WAL");
  // WAL pragma via prepare().get() (read form)
  const walRow = db.prepare("PRAGMA journal_mode").get();
  check(
    "PRAGMA journal_mode returns { journal_mode: 'wal' } object shape",
    walRow && typeof walRow === "object" && walRow.journal_mode === "wal",
    `got: ${JSON.stringify(walRow)}`
  );

  db.exec("PRAGMA foreign_keys = ON");
  const fkRow = db.prepare("PRAGMA foreign_keys").get();
  check(
    "PRAGMA foreign_keys returns { foreign_keys: 1 } (shape compatible with Db wrapper)",
    fkRow && typeof fkRow === "object" && fkRow.foreign_keys === 1,
    `got: ${JSON.stringify(fkRow)}`
  );

  db.exec("PRAGMA busy_timeout = 5000");
  const btRow = db.prepare("PRAGMA busy_timeout").get();
  check(
    "PRAGMA busy_timeout returns { timeout: 5000 } or { busy_timeout: 5000 }",
    btRow && typeof btRow === "object" &&
      (btRow.timeout === 5000 || btRow.busy_timeout === 5000),
    `got: ${JSON.stringify(btRow)}`
  );

  // ============================================================
  section("2. prepare / run / get / all / iterate API compatibility");
  // ============================================================

  db.exec(`
    CREATE TABLE skill_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      git_url TEXT NOT NULL UNIQUE
    );
    CREATE TABLE skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES skill_repos(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('command', 'skill')),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      UNIQUE(repo_id, type, name)
    );
    CREATE TABLE sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      direction TEXT NOT NULL
    );
  `);

  // INSERT RETURNING (astack 大量使用)
  const insertRepo = db.prepare(
    "INSERT INTO skill_repos (name, git_url) VALUES (?, ?) RETURNING id, name, git_url"
  );
  const repoRow = insertRepo.get("test-repo", "https://example.com/repo.git");
  check(
    "INSERT ... RETURNING works with .get()",
    repoRow && repoRow.id === 1 && repoRow.name === "test-repo"
  );

  // run() returns { changes, lastInsertRowid }
  const insertSkill = db.prepare(
    "INSERT INTO skills (repo_id, type, name, path) VALUES (?, ?, ?, ?)"
  );
  const runInfo = insertSkill.run(1, "command", "code_review", "commands/code_review.md");
  check(
    "stmt.run() returns { changes: 1, lastInsertRowid: bigint|number }",
    runInfo.changes === 1 &&
      (typeof runInfo.lastInsertRowid === "bigint" || typeof runInfo.lastInsertRowid === "number"),
    `got: ${JSON.stringify({ changes: runInfo.changes, lastInsertRowid: String(runInfo.lastInsertRowid) })}`
  );

  insertSkill.run(1, "skill", "office-hours", "skills/office-hours");
  insertSkill.run(1, "command", "spec", "commands/spec.md");

  // all() returns array
  const all = db.prepare("SELECT id, name FROM skills ORDER BY id").all();
  check("stmt.all() returns array of row objects", Array.isArray(all) && all.length === 3);
  check(
    "all() rows are accessible by column name",
    all[0].name === "code_review" && all[1].name === "office-hours"
  );

  // iterate()
  const iter = db.prepare("SELECT id FROM skills ORDER BY id").iterate();
  const collected = [];
  for (const row of iter) collected.push(row.id);
  check("stmt.iterate() yields row objects", collected.length === 3);

  // parameter binding (named via ? positional)
  const getByType = db.prepare("SELECT COUNT(*) AS c FROM skills WHERE type = ?");
  const countCmd = getByType.get("command");
  check("parameterized SELECT works", countCmd.c === 2);

  // INSERT OR CONFLICT ... ON CONFLICT DO UPDATE (astack upsert)
  const upsert = db.prepare(`
    INSERT INTO skills (repo_id, type, name, path)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repo_id, type, name) DO UPDATE SET path = excluded.path
    RETURNING id, path
  `);
  const upserted = upsert.get(1, "command", "code_review", "commands/code_review_v2.md");
  check(
    "ON CONFLICT DO UPDATE RETURNING works",
    upserted && upserted.path === "commands/code_review_v2.md"
  );

  // ============================================================
  section("3. Transaction + FK OFF migration flow (THE CRITICAL TEST)");
  // ============================================================

  // 前置：添加 sync_logs 行指向 skills（测试 FK 级联）
  db.prepare("INSERT INTO sync_logs (skill_id, direction) VALUES (?, ?)").run(1, "pull");
  db.prepare("INSERT INTO sync_logs (skill_id, direction) VALUES (?, ?)").run(2, "pull");
  const syncLogsBefore = db.prepare("SELECT COUNT(*) AS c FROM sync_logs").get().c;
  check("sync_logs seeded before migration", syncLogsBefore === 2);

  const skillsBefore = db.prepare("SELECT COUNT(*) AS c FROM skills").get().c;
  const skillsAllBefore = db.prepare("SELECT id, name, path FROM skills ORDER BY id").all();

  // === 关键：FK OFF 必须在事务外 ===
  db.exec("PRAGMA foreign_keys = OFF");
  const fkOffRow = db.prepare("PRAGMA foreign_keys").get();
  check(
    "PRAGMA foreign_keys = OFF (outside transaction) takes effect",
    fkOffRow.foreign_keys === 0
  );

  let migrationError = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ALTER TABLE skills ADD COLUMN description TEXT");
    db.exec(`
      CREATE TABLE skills_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES skill_repos(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('command', 'skill', 'agent')),
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        description TEXT,
        UNIQUE(repo_id, type, name)
      );
      INSERT INTO skills_new (id, repo_id, type, name, path, description)
        SELECT id, repo_id, type, name, path, description FROM skills;
      DROP TABLE skills;
      ALTER TABLE skills_new RENAME TO skills;
    `);
    db.exec("COMMIT");
  } catch (err) {
    migrationError = err;
    try { db.exec("ROLLBACK"); } catch {}
  }
  check("Migration transaction completes without error",
    migrationError === null,
    migrationError ? `threw: ${migrationError.message}` : "");

  // === 关键：FK ON 必须在事务外 ===
  db.exec("PRAGMA foreign_keys = ON");
  const fkOnRow = db.prepare("PRAGMA foreign_keys").get();
  check(
    "PRAGMA foreign_keys = ON restored (outside transaction)",
    fkOnRow.foreign_keys === 1
  );

  // 验证：skills 表行没丢
  const skillsAfter = db.prepare("SELECT COUNT(*) AS c FROM skills").get().c;
  check(
    "skills row count preserved after rebuild",
    skillsAfter === skillsBefore,
    `before=${skillsBefore}, after=${skillsAfter}`
  );

  const skillsAllAfter = db.prepare("SELECT id, name, path FROM skills ORDER BY id").all();
  check(
    "skills row content (id+name+path) preserved after rebuild",
    skillsAllAfter.every((r, i) =>
      r.id === skillsAllBefore[i].id &&
      r.name === skillsAllBefore[i].name &&
      r.path === skillsAllBefore[i].path)
  );

  // 验证：sync_logs 没有被级联删除（因为重建 skills 期间 FK 是 OFF）
  const syncLogsAfter = db.prepare("SELECT COUNT(*) AS c FROM sync_logs").get().c;
  check(
    "sync_logs NOT cascade-deleted during skills rebuild (FK OFF protection)",
    syncLogsAfter === syncLogsBefore,
    `before=${syncLogsBefore}, after=${syncLogsAfter} ← CRITICAL if fails`
  );

  // 验证：foreign_key_check 返回 0 行（一致性校验）
  const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
  check(
    "PRAGMA foreign_key_check returns 0 rows (no dangling FK)",
    fkViolations.length === 0,
    `got: ${JSON.stringify(fkViolations)}`
  );

  // 验证：新 CHECK 接受 'agent'
  const insertAgent = db.prepare(
    "INSERT INTO skills (repo_id, type, name, path) VALUES (?, ?, ?, ?)"
  );
  let agentInsertError = null;
  try {
    insertAgent.run(1, "agent", "my-agent", "agents/my-agent.md");
  } catch (err) {
    agentInsertError = err;
  }
  check("New CHECK constraint accepts 'agent' type",
    agentInsertError === null,
    agentInsertError ? `threw: ${agentInsertError.message}` : "");

  // 验证：新 CHECK 拒绝非法值
  let badTypeError = null;
  try {
    insertAgent.run(1, "wrong-type", "bad", "x");
  } catch (err) {
    badTypeError = err;
  }
  check("New CHECK constraint rejects unknown type",
    badTypeError !== null && /CHECK constraint/i.test(badTypeError.message));

  // ============================================================
  section("4. BigInt + Uint8Array handling");
  // ============================================================

  // BigInt: 默认应该用 Number，但可以 opt-in
  const bigSelect = db.prepare("SELECT id FROM skills WHERE id = ?");
  const smallId = bigSelect.get(1);
  check(
    "Small integer returned as number (not BigInt) by default",
    typeof smallId.id === "number" && smallId.id === 1
  );

  // BLOB binding + reading
  db.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)");
  const blobBuf = Uint8Array.from([0x01, 0x02, 0x03, 0xff]);
  db.prepare("INSERT INTO blobs (data) VALUES (?)").run(blobBuf);
  const blobRow = db.prepare("SELECT data FROM blobs").get();
  check(
    "BLOB returned as Uint8Array",
    blobRow.data instanceof Uint8Array &&
      blobRow.data.length === 4 &&
      blobRow.data[0] === 0x01 && blobRow.data[3] === 0xff
  );

  // ============================================================
  section("5. Edge cases specific to astack migration");
  // ============================================================

  // :memory: DB
  const memDb = new DatabaseSync(":memory:");
  memDb.exec("CREATE TABLE t (x INTEGER)");
  memDb.prepare("INSERT INTO t VALUES (?)").run(42);
  const memVal = memDb.prepare("SELECT x FROM t").get();
  check(":memory: DB works (used extensively in tests)", memVal.x === 42);
  memDb.close();

  // Prepare + parametrized, 多次调用同一 stmt
  const reused = db.prepare("SELECT name FROM skills WHERE type = ?");
  const r1 = reused.all("command");
  const r2 = reused.all("skill");
  check(
    "Prepared stmt can be reused with different params",
    r1.length > 0 && r2.length > 0 && r1[0].name !== r2[0].name
  );

  // ============================================================
  section("Summary");
  // ============================================================

  console.log(`\nPASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);

  if (failed > 0) {
    console.log("\nFailure details:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ ALL CHECKS PASSED — node:sqlite contract suitable for astack PR2/PR3");
  }
} finally {
  if (db) {
    try { db.close(); } catch {}
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
