// jev-guard CLI tests — run against built dist via `node --test`.
//
// The CLI only ever touches telemetry storage. These tests prove:
//   - status is read-only
//   - purge --dry-run changes nothing
//   - purge --apply deletes only eligible rows
//   - reset requires the EXACT confirmation flag
//   - disabled mode is a no-op that creates nothing
//
// Storage is always a per-run tmpdir. The real ~/.cursor path is never used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

const cleanups = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "jev-cli-"));
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

const CLI = join(process.cwd(), "dist", "cli.js");

/** Run the CLI with an isolated evidence path and a known enable flag. */
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      JEV_GUARD_EVIDENCE_PATH: env.JEV_GUARD_EVIDENCE_PATH ?? "",
      ...env,
    },
  });
}

function openDb(path) {
  return new DatabaseSync(path);
}

/** Seed a database with N rows, one of them backdated. */
async function seed(dbPath, { rows = 3, backdateOne = false } = {}) {
  const { SqliteTelemetrySink } = await import("../dist/telemetry/sqlite-sink.js");
  const { TelemetrySession } = await import("../dist/telemetry/session.js");
  const { Guard } = await import("../dist/engine.js");

  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard({
    judge: async () => ({
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    }),
  });
  for (let i = 0; i < rows; i++) {
    session.recordDecision(await guard.decide({ task: `t${i}` }), "jev_assess_task", 1);
  }
  await sink.close();

  if (backdateOne) {
    const db = openDb(dbPath);
    const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
    db.prepare("UPDATE decisions SET occurred_at = ? WHERE rowid = 1").run(old);
    db.close();
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("cli: status reports state and mutates nothing", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  await seed(dbPath, { rows: 2 });
  const before = statSync(dbPath).size;

  const res = runCli(["evidence", "status"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /JEV CODING GUARD  ·  Local Evidence Status/);
  assert.match(res.stdout, /Decisions stored\s+2/);
  assert.match(res.stdout, /Remote upload\s+Disabled/);
  assert.equal(statSync(dbPath).size, before, "status must not change the database");
});

test("cli: status while disabled resolves no path and creates nothing", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");

  // Explicit process-env override wins over the Cursor envFile, so these tests
  // deterministically exercise the disabled path even when the envFile enables
  // evidence for the MCP server.
  const res = runCli(["evidence", "status"], {
    JEV_GUARD_LOCAL_EVIDENCE: "0",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Collection enabled\s+no/);
  assert.match(res.stdout, /not resolved while disabled/);
  assert.ok(!existsSync(dbPath), "no database created while disabled");
});

// ---------------------------------------------------------------------------
// purge --dry-run
// ---------------------------------------------------------------------------

test("cli: purge --dry-run performs no deletion", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  await seed(dbPath, { rows: 3, backdateOne: true });
  const before = statSync(dbPath).size;

  const res = runCli(["evidence", "purge", "--before", "7d", "--dry-run"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Dry run — nothing was changed/);
  assert.match(res.stdout, /Records that WOULD be removed\s+1/);
  assert.equal(statSync(dbPath).size, before, "size unchanged");

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 3, "nothing deleted");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// purge --apply
// ---------------------------------------------------------------------------

test("cli: purge --apply deletes only eligible rows and reports sizes", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  await seed(dbPath, { rows: 3, backdateOne: true });

  const res = runCli(["evidence", "purge", "--before", "7d", "--apply"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Records deleted\s+1/);
  assert.match(res.stdout, /Database size before/);
  assert.match(res.stdout, /Database size after/);
  assert.match(res.stdout, /Remaining date range/);

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 2, "only the old row removed");
  } finally {
    db.close();
  }
});

test("cli: purge requires exactly one of --dry-run / --apply", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  await seed(dbPath, { rows: 1 });

  const neither = runCli(["evidence", "purge", "--before", "7d"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });
  assert.equal(neither.status, 2);
  assert.match(neither.stderr, /exactly one of --dry-run or --apply/);

  const both = runCli(["evidence", "purge", "--before", "7d", "--dry-run", "--apply"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });
  assert.equal(both.status, 2);
});

test("cli: purge rejects an invalid period", () => {
  const res = runCli(["evidence", "purge", "--before", "bogus", "--dry-run"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--before requires one of/);
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test("cli: reset requires the EXACT confirmation flag", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  await seed(dbPath, { rows: 2 });

  for (const bad of [[], ["--confirm"], ["--force"], ["--confirm-delete-local-evidence-x"]]) {
    const res = runCli(["evidence", "reset", ...bad], {
      JEV_GUARD_LOCAL_EVIDENCE: "1",
      JEV_GUARD_EVIDENCE_PATH: dbPath,
    });
    assert.equal(res.status, 2, `args ${JSON.stringify(bad)} must be rejected`);
    assert.match(res.stderr, /exact confirmation flag/);
  }

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 2, "nothing deleted");
  } finally {
    db.close();
  }
});

test("cli: reset with the exact flag deletes all rows but keeps the file", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  await seed(dbPath, { rows: 3 });

  const res = runCli(["evidence", "reset", "--confirm-delete-local-evidence"], {
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Records deleted\s+3/);
  assert.match(res.stdout, /never unlinked/);
  assert.ok(existsSync(dbPath), "database file must still exist");

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// safety: the CLI never touches anything else
// ---------------------------------------------------------------------------

test("cli: unknown command prints usage and exits non-zero", () => {
  const res = runCli(["evidence", "nonsense"], { JEV_GUARD_LOCAL_EVIDENCE: "1" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage:/);
});

test("cli: purge while disabled is a no-op and creates nothing", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const res = runCli(["evidence", "purge", "--before", "7d", "--apply"], {
    JEV_GUARD_LOCAL_EVIDENCE: "0",
    JEV_GUARD_EVIDENCE_PATH: dbPath,
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Local evidence is disabled/);
  assert.ok(!existsSync(dbPath));
});

test("cli: evidence path stays storage-only (no keys / mcp / git / policy tables)", () => {
  // Structural guarantee for the evidence half of the CLI. Policy evaluation
  // lives in `check.ts` / `jev-guard check`, not in evidence commands.
  const src = readFileSync(join(process.cwd(), "dist", "cli.js"), "utf8");
  for (const forbidden of ["DEFAULT_POLICY", "TYPESAFE_API_KEY", "mcp.json", ".zshenv"]) {
    assert.ok(!src.includes(forbidden), `CLI must not reference ${forbidden}`);
  }
  // `matchPolicy` must not be imported by the CLI directly (only via check.js).
  assert.ok(
    !/\bimport\b[\s\S]{0,80}\bmatchPolicy\b/.test(src) && !src.includes('from "./policy'),
    "CLI must not import matchPolicy/policy.js directly",
  );
  assert.ok(!/\bgit\b/.test(src.replace(/JEV_GUARD|jev-guard/gi, "")), "CLI must not run git");
});
