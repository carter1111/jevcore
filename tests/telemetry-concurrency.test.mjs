// Local Guard Evidence — multi-process concurrency tests.
//
// Multiple Cursor windows produce multiple MCP server processes sharing one
// database. These tests prove:
//   - concurrent writers do not corrupt data or lose the documented budget
//   - a report read during active writes succeeds
//   - maintenance (purge/reset) refuses safely while a writer holds the lock
//
// Storage is always a per-run tmpdir; the real ~/.cursor path is never used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";

import { buildReport } from "../dist/telemetry/report.js";
import { purgeEvidence } from "../dist/telemetry/maintenance.js";

const cleanups = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "jev-conc-"));
  cleanups.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function openDb(path) {
  return new DatabaseSync(path);
}

/**
 * Create the schema via the built sink so the writer children can rely on it.
 * Done in-process to avoid depending on module loading order in children.
 */
async function seedSchema(dbPath) {
  const { SqliteTelemetrySink } = await import("../dist/telemetry/sqlite-sink.js");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  await sink.flush();
  await sink.close();
  assert.ok(existsSync(dbPath), "schema seeded");
}

/** A child process that writes N rows concurrently. */
const WRITER_SOURCE = `
import { DatabaseSync } from "node:sqlite";
const [dbPath, tag, count] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
const ins = db.prepare(\`INSERT OR IGNORE INTO decisions (
  decision_id, occurred_at, tool, source, execution_mode, task_domain,
  risk_score, confidence, requires_security_review,
  provider_call_attempted, provider_call_succeeded, provider_failed,
  fell_back, failure_code, guard_latency_ms, provider_latency_ms,
  jev_input_tokens, jev_output_tokens, guard_version, policy_version
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\`);
let ok = 0, err = 0;
for (let i = 0; i < Number(count); i++) {
  try {
    ins.run(\`\${tag}-\${i}\`, new Date().toISOString(), "jev_assess_task", "jev", "execute", "backend",
      0.1, 0.9, 0, 0, 0, 0, 0, null, 1, null, null, null, "0.1.0", "t");
    ok++;
  } catch { err++; }
}
console.log(JSON.stringify({ ok, err }));
db.close();
`;

function runWriter(dbPath, tag, count, scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, dbPath, tag, String(count)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        resolve({ ok: 0, err: count });
      }
    });
  });
}

test("concurrency: 4 concurrent writers persist all rows without corruption", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const scriptPath = join(dir, "writer.mjs");
  writeFileSync(scriptPath, WRITER_SOURCE);
  await seedSchema(dbPath);

  const writers = ["p1", "p2", "p3", "p4"].map((tag) => runWriter(dbPath, tag, 50, scriptPath));
  const results = await Promise.all(writers);

  const totalOk = results.reduce((n, r) => n + (r.ok ?? 0), 0);
  assert.equal(totalOk, 200, `all 200 writes succeeded (got ${JSON.stringify(results)})`);

  const db = openDb(dbPath);
  try {
    const count = db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n;
    assert.equal(count, 200, "no rows lost or duplicated");

    const byTag = db
      .prepare("SELECT substr(decision_id, 1, 2) AS tag, COUNT(*) AS n FROM decisions GROUP BY tag ORDER BY tag")
      .all();
    assert.equal(byTag.length, 4, "all four writers contributed");
    for (const row of byTag) assert.equal(row.n, 50);
  } finally {
    db.close();
  }
});

test("concurrency: report read during active writes succeeds", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const scriptPath = join(dir, "writer.mjs");
  writeFileSync(scriptPath, WRITER_SOURCE);
  await seedSchema(dbPath);

  // Start writers, then read the report while they run.
  const writers = ["w1", "w2", "w3"].map((tag) => runWriter(dbPath, tag, 40, scriptPath));

  // Give the writers a moment to begin, then read.
  await new Promise((r) => setTimeout(r, 40));

  const db = openDb(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const model = buildReport(db, {
      period: "all",
      databasePath: dbPath,
      advisoryBytes: 50 * 1024 * 1024,
      telemetryWriteErrors: 0,
    });
    assert.ok(model.guardDecisions >= 0, "report read succeeded during writes");
  } finally {
    db.close();
  }

  await Promise.all(writers);
});

test("concurrency: purge refuses safely while a writer holds the maintenance lock", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const lockPath = join(dir, "telemetry.lock");
  await seedSchema(dbPath);

  // Simulate a live owner: this process is alive.
  writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

  const result = purgeEvidence({
    databasePath: dbPath,
    lockPath,
    period: "all",
    dryRun: false,
    openDatabase: openDb,
  });

  assert.equal(result.ok, false, "purge must refuse while the lock is held");
  assert.equal(result.reason, "lock_held");
  rmSync(lockPath, { force: true });
});

test("concurrency: reset refuses safely while a writer holds the maintenance lock", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const lockPath = join(dir, "telemetry.lock");
  await seedSchema(dbPath);

  const { resetEvidence } = await import("../dist/telemetry/maintenance.js");
  writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

  const result = resetEvidence({ databasePath: dbPath, lockPath, openDatabase: openDb });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lock_held");
  assert.ok(existsSync(dbPath), "database file untouched");
  rmSync(lockPath, { force: true });
});

test("concurrency: a stale lock from a dead process is reclaimed", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const lockPath = join(dir, "telemetry.lock");
  await seedSchema(dbPath);

  // PID 999999 is not running; the lock should be treated as stale.
  writeFileSync(lockPath, "999999", { mode: 0o600 });

  const result = purgeEvidence({
    databasePath: dbPath,
    lockPath,
    period: "all",
    dryRun: false,
    openDatabase: openDb,
  });
  assert.equal(result.ok, true, "stale lock is reclaimed and purge proceeds");
  assert.ok(!existsSync(lockPath), "lock released after use");
});

/**
 * Lock contention must be purely advisory: a refusal may not unlink storage,
 * may not delete rows, and may not prevent later writers from succeeding.
 */
test("concurrency: refused purge under lock contention harms nothing and later writes still succeed", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const lockPath = join(dir, "telemetry.lock");
  const scriptPath = join(dir, "writer.mjs");
  writeFileSync(scriptPath, WRITER_SOURCE);
  await seedSchema(dbPath);

  // Seed two rows so we can prove nothing is deleted by the refusal.
  const db0 = openDb(dbPath);
  db0.exec("PRAGMA journal_mode=WAL");
  const ins = db0.prepare(`INSERT OR IGNORE INTO decisions (
    decision_id, occurred_at, tool, source, execution_mode, task_domain,
    risk_score, confidence, requires_security_review,
    provider_call_attempted, provider_call_succeeded, provider_failed,
    fell_back, failure_code, guard_latency_ms, provider_latency_ms,
    jev_input_tokens, jev_output_tokens, guard_version, policy_version
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run("seed-1", new Date().toISOString(), "jev_assess_task", "jev", "execute", "backend", 0.1, 0.9, 0, 0, 0, 0, 0, null, 1, null, null, null, "0.1.0", "t");
  ins.run("seed-2", new Date().toISOString(), "jev_assess_task", "jev", "execute", "backend", 0.1, 0.9, 0, 0, 0, 0, 0, null, 1, null, null, null, "0.1.0", "t");
  const rowsBefore = db0.prepare("SELECT COUNT(*) AS n FROM decisions").get().n;
  db0.close();
  const sizeBefore = statSync(dbPath).size;

  // Simulate an active writer holding the maintenance lock (this process is alive).
  writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

  // purge and reset must both refuse.
  const purgeResult = purgeEvidence({
    databasePath: dbPath,
    lockPath,
    period: "all",
    dryRun: false,
    openDatabase: openDb,
  });
  assert.equal(purgeResult.ok, false, "purge refuses under contention");
  assert.equal(purgeResult.reason, "lock_held");

  const { resetEvidence } = await import("../dist/telemetry/maintenance.js");
  const resetResult = resetEvidence({ databasePath: dbPath, lockPath, openDatabase: openDb });
  assert.equal(resetResult.ok, false, "reset refuses under contention");
  assert.equal(resetResult.reason, "lock_held");

  // Nothing was unlinked or deleted.
  assert.ok(existsSync(dbPath), "database file still present (never unlinked)");
  assert.ok(existsSync(lockPath), "the holder's lock is left intact");
  assert.equal(statSync(dbPath).size, sizeBefore, "size unchanged by refusals");

  const db1 = openDb(dbPath);
  try {
    assert.equal(db1.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, rowsBefore, "no rows deleted");
  } finally {
    db1.close();
  }

  // Release the lock, then prove later writes still succeed and are durable.
  rmSync(lockPath, { force: true });
  const writerResult = await runWriter(dbPath, "after-lock", 10, scriptPath);
  assert.equal(writerResult.ok, 10, "later writes succeed after the lock is released");

  const db2 = openDb(dbPath);
  try {
    assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, rowsBefore + 10);
  } finally {
    db2.close();
  }

  // And a purge now succeeds, proving the earlier refusal left no bad state.
  const purgeAfter = purgeEvidence({
    databasePath: dbPath,
    lockPath,
    period: "all",
    dryRun: false,
    openDatabase: openDb,
  });
  assert.equal(purgeAfter.ok, true, "purge works once the lock is free");
  assert.equal(purgeAfter.deleted, rowsBefore + 10);
});
