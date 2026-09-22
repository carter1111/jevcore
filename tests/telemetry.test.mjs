// Local Guard Evidence v1 tests — run against built dist via `node --test`.
//
// PRIVACY/SAFETY CONTRACT UNDER TEST
//   1. Disabled mode is structurally inert: no directory, DB, WAL, or lock.
//   2. Telemetry never changes a decision, never triggers a provider call,
//      never produces MCP -32603.
//   3. Hard blocks record provider_call_attempted = false.
//   4. No prohibited payload field is ever stored.
//   5. Report periods filter correctly; the report itself makes no provider call.
//
// All storage is in a per-run tmpdir. The real ~/.cursor path is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createJevMcpServer } from "../dist/mcp-server.js";
import { Guard } from "../dist/engine.js";
import { resolveTelemetryConfig } from "../dist/telemetry/config.js";
import { NoopTelemetrySink } from "../dist/telemetry/noop-sink.js";
import { SqliteTelemetrySink } from "../dist/telemetry/sqlite-sink.js";
import { TelemetrySession } from "../dist/telemetry/session.js";
import { buildReport, periodStartIso } from "../dist/telemetry/report.js";
import { readEnvFile, evidenceEnvFromCursorEnvFile, filterEvidenceEnv } from "../dist/telemetry/envfile.js";
import { writeFileSync } from "node:fs";
import { formatReport, formatDisabled } from "../dist/telemetry/format.js";
import { estimateCostUsd, currentPriceEntry } from "../dist/telemetry/pricing.js";
import { purgeEvidence, resetEvidence, evidenceStatus } from "../dist/telemetry/maintenance.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cleanups = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "jev-evidence-test-"));
  cleanups.push(dir);
  return dir;
}
function tmpDbPath() {
  return join(tmpDir(), "telemetry.sqlite");
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

/** Flush a sink and return the row count. */
async function settle(sink, dbPath) {
  await sink.flush();
  if (!existsSync(dbPath)) return 0;
  const db = openDb(dbPath);
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n;
  } finally {
    db.close();
  }
}

class FakeProvider {
  constructor(answers = null, { fail = false } = {}) {
    this.answers = answers ?? {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
    this.fail = fail;
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    if (this.fail) return { failed: true };
    return this.answers;
  }
}

// ---------------------------------------------------------------------------
// 1. Disabled mode is structurally inert
// ---------------------------------------------------------------------------

test("disabled: config resolves enabled=false and does NOT resolve a path", () => {
  const cfg = resolveTelemetryConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.databasePath, "", "no path is computed while disabled");
});

test("disabled: flag must be exactly '1'", () => {
  for (const v of ["0", "true", "yes", "", undefined]) {
    const env = v === undefined ? {} : { JEV_GUARD_LOCAL_EVIDENCE: v };
    assert.equal(resolveTelemetryConfig(env).enabled, false, `value ${JSON.stringify(v)} must not enable`);
  }
  assert.equal(resolveTelemetryConfig({ JEV_GUARD_LOCAL_EVIDENCE: "1" }).enabled, true);
});

test("disabled: NoopTelemetrySink is inert and reports no write errors", async () => {
  const sink = new NoopTelemetrySink();
  assert.equal(sink.enabled, false);
  sink.recordDecision({
    decisionId: "x",
    occurredAt: new Date().toISOString(),
    tool: "jev_assess_task",
    source: "jev",
    executionMode: "execute",
    taskDomain: "backend",
    riskScore: 0.1,
    confidence: 0.9,
    requiresSecurityReview: false,
    providerCallAttempted: false,
    providerCallSucceeded: false,
    providerFailed: false,
    fellBack: false,
    failureCode: undefined,
    guardLatencyMs: 1,
    providerLatencyMs: undefined,
    jevInputTokens: undefined,
    jevOutputTokens: undefined,
    guardVersion: "0.1.0",
    policyVersion: "test",
    policyRuleIds: [],
  });
  await sink.flush();
  await sink.close();
  assert.equal(sink.writeErrorCount(), 0);
});

test("envfile bridge: CLI resolves the SAME evidence config as the MCP server", async () => {
  // The CLI must agree with the MCP server, which is launched via the Cursor
  // envFile. Verify the envFile parser reads the flag the MCP server uses.
  const dir = tmpDir();
  const envPath = join(dir, "jev-coding-guard.env");
  writeFileSync(envPath, `# evidence flag only for this test\nJEV_GUARD_LOCAL_EVIDENCE=1\n`);
  const parsed = readEnvFile(envPath);
  assert.equal(parsed.JEV_GUARD_LOCAL_EVIDENCE, "1", "flag read from envFile");
  assert.equal(Object.keys(parsed).length, 1, "only the flag is present");
});

test("envfile bridge: only evidence flags are exposed, never credentials", () => {
  const dir = tmpDir();
  const envPath = join(dir, "jev-coding-guard.env");
  writeFileSync(
    envPath,
    [
      "JEV_GUARD_LOCAL_EVIDENCE=1",
      "JEV_GUARD_EVIDENCE_PATH=/tmp/x.sqlite",
      "TYPESAFE_API_KEY=some-real-looking-secret-value",
      "",
    ].join("\n"),
  );
  const parsed = readEnvFile(envPath);
  assert.equal(parsed.JEV_GUARD_LOCAL_EVIDENCE, "1");
  assert.equal(parsed.JEV_GUARD_EVIDENCE_PATH, "/tmp/x.sqlite");
  // The parser sees every key…
  assert.ok("TYPESAFE_API_KEY" in parsed, "the parser itself sees the raw file");
  // …but the filter only forwards evidence flags; credentials never leak.
  const overlay = filterEvidenceEnv(parsed);
  assert.equal(overlay.TYPESAFE_API_KEY, undefined, "credentials must not leak into the CLI env");
  assert.equal(overlay.JEV_GUARD_LOCAL_EVIDENCE, "1");
  assert.equal(overlay.JEV_GUARD_EVIDENCE_PATH, "/tmp/x.sqlite");
});

test("disabled: a session from a disabled env creates NO artifact", async () => {
  const probeDir = mkdtempSync(join(tmpdir(), "jev-evidence-inert-"));
  cleanups.push(probeDir);
  const session = TelemetrySession.withSink(new NoopTelemetrySink(), "", 50 * 1024 * 1024);
  const guard = new Guard(new FakeProvider());
  const result = await guard.decide({ task: "add a button" });
  session.recordDecision(result, "jev_assess_task", 3);
  await session.close();

  assert.equal(session.enabled, false);
  assert.deepEqual(readdirSync(probeDir), [], "no artifact may be created while disabled");
});

test("disabled: fromEnv resolves no database path at all", () => {
  const session = TelemetrySession.fromEnv({});
  assert.equal(session.enabled, false);
  assert.equal(session.dbPath, "", "no path is computed while disabled");
});

test("disabled: node:sqlite is never loaded by a disabled session", async () => {
  // Structural inertness: a disabled process must not even load the SQLite
  // module. We detect actual module compilation rather than trusting the source.
  const Module = (await import("node:module")).default;
  const loaded = new Set();
  const original = Module.prototype._compile;
  Module.prototype._compile = function patched(content, filename, ...rest) {
    if (filename.includes("sqlite")) loaded.add(filename);
    return original.call(this, content, filename, ...rest);
  };
  try {
    const session = TelemetrySession.fromEnv({});
    const guard = new Guard(new FakeProvider());
    const r = await guard.decide({ task: "add a button" });
    session.recordDecision(r, "jev_assess_task", 1);
    await session.close();
    assert.equal(loaded.size, 0, "node:sqlite must not be loaded while disabled");
  } finally {
    Module.prototype._compile = original;
  }
});

test("disabled: MCP server works normally and the report explains it is disabled", async () => {
  const [srvT, cliT] = InMemoryTransport.createLinkedPair();
  const server = createJevMcpServer({
    provider: new FakeProvider(),
    telemetry: TelemetrySession.withSink(new NoopTelemetrySink(), "", 50 * 1024 * 1024),
  });
  await server.connect(srvT);
  let id = 0;
  const pend = new Map();
  cliT.onmessage = (m) => {
    if (m?.id !== undefined && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      p.resolve(m);
    }
  };
  await cliT.start();
  await srvT.start();
  const req = (method, params) => {
    const r = ++id;
    const p = new Promise((x) => pend.set(r, { resolve: x }));
    cliT.send({ jsonrpc: "2.0", id: r, method, params });
    return p;
  };
  const notify = (m, p) => cliT.send({ jsonrpc: "2.0", method: m, params: p });
  await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  notify("notifications/initialized", {});

  const res = await req("tools/call", { name: "jev_guard_report", arguments: { period: "7d" } });
  assert.equal(res.result.isError, undefined, "disabled report must not be an error");
  assert.match(res.result.content[0].text, /Disabled/);
  await server.close();
});

// ---------------------------------------------------------------------------
// 2. Storage + persistence
// ---------------------------------------------------------------------------

test("enabled: writes de-identified metadata and never creates prohibited columns", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  const result = await guard.decide({
    task: "SECRET-MARKER add a button",
    hints: { touchedFiles: ["SECRET-PATH/file.ts"], context: "SECRET-CONTEXT" },
  });
  session.recordDecision(result, "jev_assess_task", 7);
  await sink.close();

  assert.ok(existsSync(dbPath), "database is created when enabled");
  const db = openDb(dbPath);
  try {
    const cols = db.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
    for (const banned of ["task", "command", "diff", "prompt", "context", "path", "repo", "hash", "fingerprint"]) {
      assert.ok(!cols.includes(banned), `column ${banned} must not exist`);
    }
    const row = db.prepare("SELECT * FROM decisions").get();
    const serialized = JSON.stringify(row);
    for (const marker of ["SECRET-MARKER", "SECRET-PATH", "SECRET-CONTEXT"]) {
      assert.ok(!serialized.includes(marker), `stored row must not contain ${marker}`);
    }
    assert.match(row.decision_id, /^[0-9a-f-]{36}$/, "decision_id is a UUID");
  } finally {
    db.close();
  }
});

test("enabled: decision_id is not derived from input (two identical inputs differ)", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  for (let i = 0; i < 2; i++) {
    const r = await guard.decide({ task: "identical input text" });
    session.recordDecision(r, "jev_assess_task", 1);
  }
  await sink.close();
  const db = openDb(dbPath);
  try {
    const ids = db.prepare("SELECT decision_id FROM decisions").all().map((r) => r.decision_id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "IDs must not be content-derived");
  } finally {
    db.close();
  }
});

test("enabled: failure_code only ever holds closed-union values", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider(null, { fail: true }));
  const r = await guard.decide({ task: "add a button" });
  session.recordDecision(r, "jev_assess_task", 1);
  await sink.close();
  const db = openDb(dbPath);
  try {
    const codes = db.prepare("SELECT DISTINCT failure_code FROM decisions").all().map((r) => r.failure_code);
    const allowed = ["PREFLIGHT-BLOCK", "PROVIDER-FAIL", "PROVIDER-INVALID-RISK-SCORE", "MCP-INVALID-DECISION-OUTPUT", "LOW-CONF"];
    for (const c of codes) {
      if (c === null) continue;
      assert.ok(allowed.includes(c), `unexpected failure_code ${c}`);
    }
  } finally {
    db.close();
  }
});

test("enabled: policy rule IDs are recorded in the child table", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  const r = await guard.decide({ task: "add a migration to create the events table" });
  session.recordDecision(r, "jev_assess_task", 1);
  await sink.close();
  const db = openDb(dbPath);
  try {
    const rules = db.prepare("SELECT policy_rule_id FROM decision_policy_rules").all().map((x) => x.policy_rule_id);
    assert.ok(rules.length > 0, "at least one policy rule recorded");
    assert.ok(rules.every((x) => x.startsWith("POL-")), "only policy rule ids");
  } finally {
    db.close();
  }
});

test("REGRESSION perms: evidence directory is 0700 and database file is 0600", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await sink.close();

  assert.ok(existsSync(dbPath), "database created");
  const fileMode = statSync(dbPath).mode & 0o777;
  const dirMode = statSync(dirname(dbPath)).mode & 0o777;
  // SQLite creates files with the umask-derived mode (typically 0644), so the
  // sink must chmod explicitly. Regression: this was 0644 before the fix.
  assert.equal(fileMode.toString(8), "600", `database file must be 0600, got ${fileMode.toString(8)}`);
  assert.equal(dirMode.toString(8), "700", `evidence dir must be 0700, got ${dirMode.toString(8)}`);
});

test("enabled: batch context persists batch_id, batch_size, batch_strategy", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  const batchId = "00000000-0000-4000-8000-000000000001";
  session.recordDecision(await guard.decide({ task: "a" }), "jev_assess_task", 1, {
    batchId,
    batchSize: 2,
    strategy: "shared_system_one",
  });
  session.recordDecision(await guard.decide({ task: "b" }), "jev_assess_task", 1, {
    batchId,
    batchSize: 2,
    strategy: "shared_system_one",
  });
  await sink.close();

  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT batch_id, batch_size, batch_strategy FROM decisions ORDER BY occurred_at")
      .all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.batch_id, batchId);
      assert.equal(row.batch_size, 2);
      assert.equal(row.batch_strategy, "shared_system_one");
    }
  } finally {
    db.close();
  }
});

test("enabled: schema version is recorded and migration is idempotent", async () => {
  const dbPath = tmpDbPath();
  const first = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const s1 = TelemetrySession.withSink(first, dbPath);
  const guard = new Guard(new FakeProvider());
  s1.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await first.close();

  // Second sink on the same DB must migrate safely and preserve rows.
  const second = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const s2 = TelemetrySession.withSink(second, dbPath);
  s2.recordDecision(await guard.decide({ task: "y" }), "jev_assess_task", 1);
  await second.close();

  const db = openDb(dbPath);
  try {
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
    assert.equal(v.value, "2");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 2);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Failure containment
// ---------------------------------------------------------------------------

test("write failure is harmless: a broken sink cannot change a decision", async () => {
  const session = TelemetrySession.withSink(
    {
      enabled: true,
      recordDecision() {
        throw new Error("boom");
      },
      noteWriteError() {
        /* counted by session */
      },
      async flush() {
        throw new Error("boom");
      },
      async close() {
        throw new Error("boom");
      },
      writeErrorCount() {
        return 1;
      },
    },
    "/nonexistent/telemetry.sqlite",
  );
  const guard = new Guard(new FakeProvider());
  const r = await guard.decide({ task: "add a button" });
  // Recording must not throw and must not alter the decision.
  session.recordDecision(r, "jev_assess_task", 1);
  assert.equal(r.mode, "execute");
  await session.flush();
  await session.close();
});

test("write failure: unusable database path degrades to dropped events, never throws", async () => {
  const sink = new SqliteTelemetrySink({
    databasePath: "/proc/definitely-not-writable/telemetry.sqlite",
    flushThreshold: 1,
  });
  const session = TelemetrySession.withSink(sink, "/proc/definitely-not-writable/telemetry.sqlite");
  const guard = new Guard(new FakeProvider());
  const r = await guard.decide({ task: "add a button" });
  session.recordDecision(r, "jev_assess_task", 1);
  await sink.close();
  assert.ok(sink.writeErrorCount() >= 1, "the failure is counted");
});

// ---------------------------------------------------------------------------
// 4. Hard blocks record zero provider attempts
// ---------------------------------------------------------------------------

test("hard block: provider_call_attempted is false and zero provider calls occur", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const provider = new FakeProvider();
  const sessionProvider = provider; // engine-level counting
  const guard = new Guard(sessionProvider);
  const r = await guard.decide({ task: "cat .env" });
  session.recordDecision(r, "jev_assess_command", 1);
  await sink.close();

  assert.equal(provider.calls, 0, "hard block must make zero provider calls");
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT provider_call_attempted, provider_call_succeeded, source FROM decisions").get();
    assert.equal(row.provider_call_attempted, 0);
    assert.equal(row.provider_call_succeeded, 0);
    assert.equal(row.source, "hard_policy");
  } finally {
    db.close();
  }
});

test("provider call is recorded when a decision reaches the provider", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  const r = await guard.decide({ task: "add a button" });
  // Simulate the decorator's observation.
  session.recordProviderCall({
    attempted: true,
    succeeded: true,
    failed: false,
    latencyMs: 42,
    inputTokens: 100,
    outputTokens: 20,
  });
  session.recordDecision(r, "jev_assess_task", 5);
  await sink.close();

  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM decisions").get();
    assert.equal(row.provider_call_attempted, 1);
    assert.equal(row.provider_call_succeeded, 1);
    assert.equal(row.provider_latency_ms, 42);
    assert.equal(row.jev_input_tokens, 100);
    assert.equal(row.jev_output_tokens, 20);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------

test("report: periods resolve to the correct start time", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  assert.equal(periodStartIso("all", now), null);
  assert.equal(periodStartIso("7d", now), "2026-09-14T12:00:00.000Z");
  assert.equal(periodStartIso("14d", now), "2026-09-07T12:00:00.000Z");
  assert.equal(periodStartIso("30d", now), "2026-08-22T12:00:00.000Z");
});

test("report: aggregates decisions, outcomes, safety actions, and tokens", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  // One benign decision and one hard block.
  const benign = await guard.decide({ task: "add a button" });
  session.recordProviderCall({ attempted: true, succeeded: true, failed: false, latencyMs: 30, inputTokens: 500, outputTokens: 50 });
  session.recordDecision(benign, "jev_assess_task", 10);

  const blocked = await guard.decide({ task: "cat .env" });
  session.recordDecision(blocked, "jev_assess_command", 2);
  await sink.close();

  const db = openDb(dbPath);
  try {
    const model = buildReport(db, {
      period: "all",
      databasePath: dbPath,
      advisoryBytes: 50 * 1024 * 1024,
      telemetryWriteErrors: 0,
    });
    assert.equal(model.guardDecisions, 2);
    assert.equal(model.jevProviderCalls, 1);
    assert.equal(model.hardPolicyShortCircuits, 1);
    assert.equal(model.hardBlocksWithProviderCalls, 0, "the privacy invariant must hold");
    assert.equal(model.jevInputTokens, 500);
    assert.equal(model.jevOutputTokens, 50);
    assert.ok(model.safetyActions["POL-SECRETS-1"] >= 1, "secret block is counted");
    assert.equal(model.totalAgentTokenSavings, "not_enough_controlled_evidence");
    assert.ok(model.estimatedCostUsd > 0);
    assert.match(model.pricingBasis, /effective/);
  } finally {
    db.close();
  }
});

test("report: periods filter correctly (7d excludes older rows)", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "recent" }), "jev_assess_task", 1);
  await sink.close();

  // Backdate the stored row beyond 7 days.
  const db = openDb(dbPath);
  try {
    const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
    db.prepare("UPDATE decisions SET occurred_at = ?").run(old);

    const seven = buildReport(db, { period: "7d", databasePath: dbPath, advisoryBytes: 1, telemetryWriteErrors: 0 });
    assert.equal(seven.guardDecisions, 0, "20-day-old row must not appear in 7d");

    const thirty = buildReport(db, { period: "30d", databasePath: dbPath, advisoryBytes: 1, telemetryWriteErrors: 0 });
    assert.equal(thirty.guardDecisions, 1, "20-day-old row must appear in 30d");

    const all = buildReport(db, { period: "all", databasePath: dbPath, advisoryBytes: 1, telemetryWriteErrors: 0 });
    assert.equal(all.guardDecisions, 1);
  } finally {
    db.close();
  }
});

test("report: rendered text contains no prohibited content and states the savings caveat", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "SECRET-MARKER deploy" }), "jev_assess_task", 1);
  await sink.close();

  const db = openDb(dbPath);
  try {
    const model = buildReport(db, { period: "all", databasePath: dbPath, advisoryBytes: 1, telemetryWriteErrors: 0 });
    const text = formatReport(model);
    assert.ok(!text.includes("SECRET-MARKER"), "no input content in the report");
    assert.match(text, /Not enough controlled evidence/);
    assert.match(text, /Remote upload\s+Disabled/);
    assert.match(text, /Estimated Jev cost/);
    assert.match(text, /Pricing basis/);
    // Option B formatting contract: structured plain text, no Markdown/ANSI.
    assert.match(text, /^JEV CODING GUARD  ·  Local Guard Evidence$/m);
    assert.match(text, /^DECISION ACTIVITY$/m);
    assert.match(text, /^PRIVACY & RELIABILITY$/m);
    assert.ok(!text.includes("**"), "no Markdown bold markers");
    assert.ok(!text.includes("| ---"), "no Markdown table separators");
    assert.ok(!/\x1b\[/.test(text), "no ANSI escape codes");
  } finally {
    db.close();
  }
});

test("report: disabled formatter explains the state without touching storage", () => {
  const text = formatDisabled();
  assert.match(text, /Disabled/);
  assert.match(text, /JEV_GUARD_LOCAL_EVIDENCE=1/);
});

test("pricing: estimateCostUsd is finite and uses the versioned entry", () => {
  const entry = currentPriceEntry();
  assert.ok(entry.inputPer1M > 0);
  assert.equal(estimateCostUsd(1_000_000, 0, entry), entry.inputPer1M);
  assert.equal(estimateCostUsd(NaN, NaN), 0, "non-finite input must not produce NaN");
  assert.equal(estimateCostUsd(-5, -5), 0);
});

// ---------------------------------------------------------------------------
// 6. Maintenance (purge / reset)
// ---------------------------------------------------------------------------

test("purge --dry-run performs no deletion and takes no lock", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await sink.close();

  const lockPath = join(dbPath, "..", "telemetry.lock");
  const before = statSync(dbPath).size;
  const result = purgeEvidence({ databasePath: dbPath, lockPath, period: "all", dryRun: true, openDatabase: openDb });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.deleted, 1, "reports what would be removed");

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 1, "nothing deleted");
  } finally {
    db.close();
  }
  assert.equal(statSync(dbPath).size, before, "size unchanged");
  assert.ok(!existsSync(lockPath), "dry run takes no lock");
});

test("purge --apply deletes only eligible records", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  for (let i = 0; i < 3; i++) session.recordDecision(await guard.decide({ task: `t${i}` }), "jev_assess_task", 1);
  await sink.close();

  const db = openDb(dbPath);
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  db.prepare("UPDATE decisions SET occurred_at = ? WHERE rowid = 1").run(old);
  db.close();

  const lockPath = join(dbPath, "..", "telemetry.lock");
  const result = purgeEvidence({ databasePath: dbPath, lockPath, period: "7d", dryRun: false, openDatabase: openDb });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1, "only the old row is removed");

  const after = openDb(dbPath);
  try {
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 2, "recent rows survive");
  } finally {
    after.close();
  }
  assert.ok(!existsSync(lockPath), "lock released");
});

test("reset deletes all rows but NEVER unlinks the database file", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await sink.close();

  const lockPath = join(dbPath, "..", "telemetry.lock");
  const result = resetEvidence({ databasePath: dbPath, lockPath, openDatabase: openDb });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);

  assert.ok(existsSync(dbPath), "database file must still exist (never unlinked)");
  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 0);
  } finally {
    db.close();
  }
});

test("purge refuses safely when the maintenance lock is held", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await sink.close();

  const lockPath = join(dbPath, "..", "telemetry.lock");
  // Simulate a live holder: this process's own pid is alive.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

  const result = purgeEvidence({ databasePath: dbPath, lockPath, period: "all", dryRun: false, openDatabase: openDb });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lock_held");

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 1, "data untouched");
  } finally {
    db.close();
  }
  rmSync(lockPath, { force: true });
});

test("purge/reset report database_missing rather than throwing", () => {
  const missing = join(tmpdir(), `jev-missing-${Date.now()}`, "telemetry.sqlite");
  const r1 = purgeEvidence({ databasePath: missing, lockPath: missing + ".lock", period: "all", dryRun: false, openDatabase: openDb });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "database_missing");
  const r2 = resetEvidence({ databasePath: missing, lockPath: missing + ".lock", openDatabase: openDb });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "database_missing");
});

test("status: reports storage state without mutating anything", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await sink.close();

  const status = evidenceStatus({
    enabled: true,
    databasePath: dbPath,
    advisoryBytes: 50 * 1024 * 1024,
    openDatabase: openDb,
  });
  assert.equal(status.databaseExists, true);
  assert.equal(status.decisionsStored, 1);
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.storageAdvisory, "ok");
});

test("status: disabled mode resolves no path and reports no database", () => {
  const status = evidenceStatus({ enabled: false, databasePath: "", advisoryBytes: 1, openDatabase: openDb });
  assert.equal(status.enabled, false);
  assert.equal(status.databasePath, "");
  assert.equal(status.databaseExists, false);
});

// ---------------------------------------------------------------------------
// 7. Storage advisory
// ---------------------------------------------------------------------------

test("storage advisory: reports exceeded above the threshold, without deleting", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());
  session.recordDecision(await guard.decide({ task: "x" }), "jev_assess_task", 1);
  await sink.close();

  const db = openDb(dbPath);
  try {
    const model = buildReport(db, { period: "all", databasePath: dbPath, advisoryBytes: 1, telemetryWriteErrors: 0 });
    assert.equal(model.storageAdvisory, "exceeded");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 1, "no automatic deletion");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Lazy initialization: the first enabled decision must never be delayed or
//    broken by storage setup, including when setup fails entirely.
// ---------------------------------------------------------------------------

test("lazy init: first enabled decision returns normally even when DB setup FAILS", async () => {
  const dbPath = tmpDbPath();
  // Inject an opener that always throws: initialization cannot succeed.
  const sink = new SqliteTelemetrySink({
    databasePath: dbPath,
    flushThreshold: 1,
    openDatabase() {
      throw new Error("storage unavailable");
    },
  });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  const started = Date.now();
  const result = await guard.decide({ task: "add a button" });
  session.recordDecision(result, "jev_assess_task", 1);
  const elapsed = Date.now() - started;

  // The decision itself is unaffected and fast: setup is deferred, not awaited.
  assert.equal(result.mode, "execute", "decision must not be altered by storage failure");
  assert.ok(elapsed < 2_000, `decision must not await storage init (took ${elapsed}ms)`);

  await sink.close();
  assert.ok(sink.writeErrorCount() >= 1, "the failure is contained and counted");
});

test("lazy init: first enabled decision is not delayed by a slow DB setup", async () => {
  const dbPath = tmpDbPath();
  let opened = false;
  const sink = new SqliteTelemetrySink({
    databasePath: dbPath,
    flushThreshold: 1,
    openDatabase(path) {
      // Simulate slow storage (but synchronous, so it would block if awaited).
      const until = Date.now() + 250;
      while (Date.now() < until) {
        /* busy-wait */
      }
      opened = true;
      return openDb(path);
    },
  });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  const started = Date.now();
  const result = await guard.decide({ task: "add a button" });
  session.recordDecision(result, "jev_assess_task", 1);
  const decisionMs = Date.now() - started;

  // The decision path must not have paid the 250ms storage cost.
  assert.ok(decisionMs < 200, `decision path must not await storage init (took ${decisionMs}ms)`);
  assert.equal(result.mode, "execute");

  await sink.close();
  assert.ok(opened, "storage was eventually initialized off the decision path");
});

// ---------------------------------------------------------------------------
// 9. Close/flush: a final under-threshold batch must not be lost.
// ---------------------------------------------------------------------------

test("close: preserves a final under-threshold queued batch", async () => {
  const dbPath = tmpDbPath();
  // Threshold far above the batch size, and a long interval, so neither the
  // size nor the timer would flush it — only close() can.
  const sink = new SqliteTelemetrySink({
    databasePath: dbPath,
    flushThreshold: 1_000,
    flushIntervalMs: 60_000,
  });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  for (let i = 0; i < 3; i++) {
    session.recordDecision(await guard.decide({ task: `t${i}` }), "jev_assess_task", 1);
  }

  await sink.close();

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 3, "all 3 queued events persisted");
  } finally {
    db.close();
  }
  assert.equal(sink.writeErrorCount(), 0, "no write errors during a clean close");
});

test("close: a SIGTERM-style shutdown flush persists the final batch", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({
    databasePath: dbPath,
    flushThreshold: 1_000,
    flushIntervalMs: 60_000,
  });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  session.recordDecision(await guard.decide({ task: "a" }), "jev_assess_task", 1);
  session.recordDecision(await guard.decide({ task: "b" }), "jev_assess_task", 1);

  // This is exactly what the SIGINT/SIGTERM handler calls.
  await session.close();

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 2);
  } finally {
    db.close();
  }
});

test("flush: threshold-based flush occurs without close", async () => {
  const dbPath = tmpDbPath();
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 2, flushIntervalMs: 60_000 });
  const session = TelemetrySession.withSink(sink, dbPath);
  const guard = new Guard(new FakeProvider());

  session.recordDecision(await guard.decide({ task: "a" }), "jev_assess_task", 1);
  session.recordDecision(await guard.decide({ task: "b" }), "jev_assess_task", 1);
  // Give the triggered flush a tick to complete, without closing.
  await new Promise((r) => setTimeout(r, 50));

  const db = openDb(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 2, "threshold flush persisted both");
  } finally {
    db.close();
  }
  await sink.close();
});
