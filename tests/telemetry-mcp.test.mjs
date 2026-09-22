// Local Guard Evidence — MCP integration tests.
//
// Proves the evidence layer integrates with the MCP server without altering
// safety behavior:
//   - jev_guard_report is registered, read-only, and never calls TypeSafe
//   - telemetry records through the provider decorator (engine untouched)
//   - hard blocks still make ZERO provider calls with evidence enabled
//   - telemetry failure never produces MCP -32603 or isError
//   - disabled mode is structurally inert from import through exit
//
// Storage is always a per-run tmpdir; the real ~/.cursor path is never used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createJevMcpServer } from "../dist/mcp-server.js";
import { TelemetrySession } from "../dist/telemetry/session.js";
import { SqliteTelemetrySink } from "../dist/telemetry/sqlite-sink.js";
import { NoopTelemetrySink } from "../dist/telemetry/noop-sink.js";
import { InstrumentedProvider } from "../dist/telemetry/instrumented-provider.js";

const cleanups = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "jev-mcp-ev-"));
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

/** Minimal in-process MCP client. */
async function startServer(options) {
  const [srvT, cliT] = InMemoryTransport.createLinkedPair();
  const server = createJevMcpServer(options);
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
  await req("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ev-test", version: "1" },
  });
  notify("notifications/initialized", {});
  return { server, req, call: (name, args) => req("tools/call", { name, arguments: args }) };
}

/** A provider that counts calls and reports token usage. */
class CountingProvider {
  constructor({ fail = false } = {}) {
    this.calls = 0;
    this.fail = fail;
  }
  async judge() {
    this.calls += 1;
    if (this.fail) return { failed: true };
    return this.ok();
  }

  async judgeMany(inputs) {
    this.calls += 1;
    if (this.fail) return inputs.map(() => ({ failed: true }));
    return inputs.map(() => this.ok());
  }

  ok() {
    return {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
      usage: { inputTokens: 700, outputTokens: 80 },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

test("mcp: jev_guard_report is registered and read-only", async () => {
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(new NoopTelemetrySink(), ""),
  });
  const list = await t.req("tools/list", {});
  const report = list.result.tools.find((x) => x.name === "jev_guard_report");
  assert.ok(report, "report tool is registered");
  assert.equal(report.annotations?.readOnlyHint, true);
  await t.server.close();
});

test("mcp: report tool never calls the provider", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const provider = new CountingProvider();
  const t = await startServer({
    provider,
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  const callsAfterDecision = provider.calls;

  await t.call("jev_guard_report", { period: "7d" });
  assert.equal(provider.calls, callsAfterDecision, "report must not call TypeSafe");

  await sink.close();
  await t.server.close();
});

// ---------------------------------------------------------------------------
// Telemetry wiring through the decorator
// ---------------------------------------------------------------------------

test("mcp: telemetry records through the decorator without engine changes", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const provider = new CountingProvider();
  const t = await startServer({
    provider,
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  const res = await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  assert.equal(res.result.isError, undefined);
  await sink.close();

  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM decisions").get();
    assert.ok(row, "a decision row was stored");
    assert.equal(row.provider_call_attempted, 1, "provider call observed via the decorator");
    assert.equal(row.provider_call_succeeded, 1);
    assert.equal(row.jev_input_tokens, 700, "token usage propagated from the SDK result");
    assert.equal(row.jev_output_tokens, 80);
    assert.ok(row.guard_latency_ms >= 0, "guard latency recorded");
    assert.ok(row.provider_latency_ms >= 0, "provider latency recorded");
    assert.equal(row.tool, "jev_assess_task");
  } finally {
    db.close();
  }
  await t.server.close();
});

test("mcp: hard block with evidence enabled makes ZERO provider calls", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const provider = new CountingProvider();
  const t = await startServer({
    provider,
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  const res = await t.call("jev_assess_command", {
    userTask: "inspect env",
    repositoryContext: "repo",
    proposedCommand: "cat .env",
  });
  const decision = JSON.parse(res.result.content[0].text);
  assert.equal(decision.executionMode, "block");
  assert.equal(provider.calls, 0, "hard block must not call the provider");

  await sink.close();
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM decisions").get();
    assert.equal(row.provider_call_attempted, 0, "privacy invariant holds");
    assert.equal(row.source, "hard_policy");
    assert.equal(row.failure_code, "PREFLIGHT-BLOCK");
  } finally {
    db.close();
  }
  await t.server.close();
});

test("mcp: provider fallback is recorded distinctly from boundary fallback", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const t = await startServer({
    provider: new CountingProvider({ fail: true }),
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  await sink.close();

  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM decisions").get();
    assert.equal(row.provider_call_attempted, 1);
    assert.equal(row.provider_failed, 1, "provider failure recorded");
    assert.equal(row.fell_back, 1, "fallback recorded separately");
    assert.equal(row.failure_code, "PROVIDER-FAIL");
  } finally {
    db.close();
  }
  await t.server.close();
});

// ---------------------------------------------------------------------------
// Failure containment at the MCP boundary
// ---------------------------------------------------------------------------

test("mcp: a throwing sink cannot produce -32603 or alter a decision", async () => {
  const exploding = {
    enabled: true,
    recordDecision() {
      throw new Error("telemetry exploded");
    },
    noteWriteError() {},
    async flush() {
      throw new Error("flush exploded");
    },
    async close() {
      throw new Error("close exploded");
    },
    writeErrorCount() {
      return 3;
    },
  };
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(exploding, "/nonexistent/telemetry.sqlite"),
  });

  const res = await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  assert.ok(res.result, "no protocol error");
  assert.equal(res.result.isError, undefined, "no isError");
  const decision = JSON.parse(res.result.content[0].text);
  assert.equal(decision.executionMode, "execute", "decision unaffected by telemetry failure");
  await t.server.close();
});

test("mcp: report degrades gracefully when storage is unavailable", async () => {
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(new NoopTelemetrySink(), "", 1024),
  });
  // Noop session is disabled, so this exercises the disabled path.
  const res = await t.call("jev_guard_report", { period: "all" });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /Disabled/);
  await t.server.close();
});

// ---------------------------------------------------------------------------
// Structural inertness
// ---------------------------------------------------------------------------

test("mcp: disabled mode creates no artifact across a full decision cycle", async () => {
  const probeDir = tmpDir();
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(new NoopTelemetrySink(), ""),
  });

  await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  await t.call("jev_assess_command", {
    userTask: "lint",
    repositoryContext: "repo",
    proposedCommand: "npm run lint",
  });
  await t.call("jev_review_diff", {
    userTask: "review",
    repositoryContext: "repo",
    changedFiles: ["a.ts"],
    diffSummary: "small",
  });
  await t.call("jev_guard_report", { period: "all" });

  assert.deepEqual(readdirSync(probeDir), [], "disabled mode writes nothing anywhere");
  assert.ok(!existsSync(join(probeDir, "telemetry.sqlite")));
  await t.server.close();
});

test("decorator: preserves the judgment exactly and never throws on observer failure", async () => {
  const inner = new CountingProvider();
  const decorated = new InstrumentedProvider(inner, {
    observe() {
      throw new Error("observer exploded");
    },
  });
  const judgment = await decorated.judge({ task: "x" });
  assert.equal(judgment.failed, false);
  assert.equal(judgment.kind, "backend");
  assert.equal(judgment.riskScore, 0.2);
  assert.equal(inner.calls, 1);
});

test("decorator: a throwing provider is observed as a failure and returns failed", async () => {
  const throwing = {
    async judge() {
      throw new Error("transport down");
    },
  };
  let observed = null;
  const decorated = new InstrumentedProvider(throwing, {
    observe(r) {
      observed = r;
    },
  });
  const judgment = await decorated.judge({ task: "x" });
  assert.equal(judgment.failed, true, "failure shape preserved");
  assert.equal(observed.attempted, true);
  assert.equal(observed.failed, true);
  assert.equal(observed.succeeded, false);
});

// ---------------------------------------------------------------------------
// REGRESSION: report tool must work with a REAL sink (not just a Noop one).
// The original suite only exercised jev_guard_report with NoopTelemetrySink,
// which hid a `TypeError: Cannot call constructor without 'new'` in the
// read-only open path.
// ---------------------------------------------------------------------------

test("REGRESSION report: works with a real SQLite sink and returns actual aggregates", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const provider = new CountingProvider();
  const t = await startServer({
    provider,
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  await sink.flush();

  const res = await t.call("jev_guard_report", { period: "all" });
  const text = res.result.content[0].text;
  assert.equal(res.result.isError, undefined, "report must not be an error");
  assert.ok(
    !/currently unavailable/.test(text),
    `report must not degrade when a real sink is active; got:\n${text}`,
  );
  assert.match(text, /JEV CODING GUARD  ·  Local Guard Evidence/);
  assert.match(text, /Last 7 days|All retained evidence/);
  assert.match(text, /Guard decisions\s+1/);
  assert.match(text, /Jev provider calls\s+1/);
  assert.match(text, /Hard blocks with provider calls\s+0/);
  assert.match(text, /Remote upload\s+Disabled/);

  await sink.close();
  await t.server.close();
});

test("REGRESSION report: hard-block-only evidence still reports correctly with a real sink", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  await t.call("jev_assess_command", {
    userTask: "inspect env",
    repositoryContext: "repo",
    proposedCommand: "cat .env",
  });
  await sink.flush();

  const res = await t.call("jev_guard_report", { period: "all" });
  const text = res.result.content[0].text;
  assert.ok(!/currently unavailable/.test(text), text);
  assert.match(text, /Sensitive inputs blocked\s+1/);
  assert.match(text, /Hard-policy short circuits\s+1/);
  assert.match(text, /Hard blocks with provider calls\s+0/);

  await sink.close();
  await t.server.close();
});

test("mcp: batchItems tags each evidence row with shared batch_id", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  await t.call("jev_assess_task", {
    userTask: "parent",
    repositoryContext: "repo",
    batchItems: [
      { userTask: "rename helper", changedFiles: ["src/a.ts"] },
      { userTask: "fix typo", changedFiles: ["README.md"] },
    ],
    batchStrategy: "shared_system_one",
  });
  await sink.close();

  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT batch_id, batch_size, batch_strategy FROM decisions ORDER BY occurred_at")
      .all();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].batch_id, "batch_id is a random UUID");
    assert.equal(rows[0].batch_id, rows[1].batch_id, "items share one batch_id");
    assert.equal(rows[0].batch_size, 2);
    assert.equal(rows[0].batch_strategy, "shared_system_one");
  } finally {
    db.close();
  }
  await t.server.close();
});

test("REGRESSION report: report works while the sink holds the write connection", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  await t.call("jev_assess_task", { userTask: "add a button", repositoryContext: "repo" });
  // Deliberately do NOT close the sink: the write connection stays open, which
  // is the real runtime condition when a user asks for a report.
  const res = await t.call("jev_guard_report", { period: "7d" });
  assert.ok(!/currently unavailable/.test(res.result.content[0].text), res.result.content[0].text);

  await sink.close();
  await t.server.close();
});
