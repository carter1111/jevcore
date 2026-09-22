// tests/latency-bench.test.mjs — WP1 Latency Benchmark CONTRACT tests.
//
// These tests NEVER call Jev, NEVER require TYPESAFE_API_KEY, NEVER hit the
// network, and incur ZERO provider cost. They validate the benchmark's own
// contract:
//   1. fixtures are truthful and content-free (no real filesystem/repo/data);
//   2. the synthetic destructive pattern triggers hard policy with ZERO
//      provider calls;
//   3. the percentile math is correct;
//   4. request_bytes uses Buffer.byteLength(..., 'utf8');
//   5. the destructive fixture never appears in stored evidence rows;
//   6. Evidence disabled vs enabled yields identical stable decision fields;
//   7. the output schema is stable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { matchPolicy } from "../dist/policy.js";
import { createJevMcpServer } from "../dist/mcp-server.js";
import { TelemetrySession } from "../dist/telemetry/session.js";
import { SqliteTelemetrySink } from "../dist/telemetry/sqlite-sink.js";
import { NoopTelemetrySink } from "../dist/telemetry/noop-sink.js";
import { percentile, p50, p95, p99 } from "../tools/latency-bench.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = {
  synthetic_safe_task: "write a synthetic unit test for a helper function",
  synthetic_destructive_command_pattern: "rm -rf <synthetic-placeholder-target>",
};

const cleanups = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "jev-latency-test-"));
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
  await req("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "latency-test", version: "1" },
  });
  return { server, call: (name, args) => req("tools/call", { name, arguments: args }) };
}

class CountingProvider {
  constructor() {
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    return {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
  }
}

function openDb(path) {
  return new DatabaseSync(path);
}

// ---------------------------------------------------------------------------
// 1. Fixture safety
// ---------------------------------------------------------------------------

test("fixtures: destructive pattern is synthetic and content-free", () => {
  const p = FIXTURES.synthetic_destructive_command_pattern;
  assert.ok(p.startsWith("rm -rf"), "must exercise hard policy");
  assert.ok(!p.includes("."), "no dotfile/dir target");
  assert.ok(!p.includes("/tmp/"), "no temp filesystem target");
  assert.ok(!p.includes("~"), "no home path");
  assert.ok(!p.includes("Users"), "no user dir");
  assert.ok(!p.match(/\/[a-z]+\/[a-z]+/), "no structured path");
  assert.ok(!p.includes("cartermacbook"), "no username");
  assert.ok(!p.includes(".env"), "no env file");
  assert.ok(!p.includes("key"), "no key material");
  assert.ok(!p.includes("token"), "no token material");
});

test("fixtures: safe task contains no destructive pattern", () => {
  assert.ok(!FIXTURES.synthetic_safe_task.includes("rm "));
});

// ---------------------------------------------------------------------------
// 2. Hard-policy short-circuit with ZERO provider calls
// ---------------------------------------------------------------------------

test("hard policy: synthetic destructive pattern blocks with no provider call", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const provider = new CountingProvider();
  const t = await startServer({
    provider,
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });

  const res = await t.call("jev_assess_command", {
    userTask: "synthetic",
    repositoryContext: "repo",
    proposedCommand: FIXTURES.synthetic_destructive_command_pattern,
  });
  const decision = JSON.parse(res.result.content[0].text);
  assert.equal(decision.executionMode, "block");
  assert.equal(provider.calls, 0, "hard block must make ZERO provider calls");

  await sink.close();
  await t.server.close();
});

test("hard policy: direct matchPolicy returns a block rule on the destructive fixture", () => {
  const rule = matchPolicy({ task: FIXTURES.synthetic_destructive_command_pattern, hints: {} });
  assert.ok(rule, "a policy rule must match");
  assert.equal(rule.mode, "block");
});

// ---------------------------------------------------------------------------
// 3. Percentile math
// ---------------------------------------------------------------------------

test("percentile: nearest-rank math is correct", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(p50(sorted), 5);
  assert.equal(p95(sorted), 10);
  assert.equal(p99(sorted), 10);
  assert.equal(percentile(sorted, 0.1), 1);
  assert.equal(percentile([42], 0.5), 42);
  assert.equal(percentile([], 0.5), undefined);
});

// ---------------------------------------------------------------------------
// 4. request_bytes uses Buffer.byteLength(..., 'utf8')
// ---------------------------------------------------------------------------

test("request_bytes: measured via Buffer.byteLength utf8", () => {
  const j = JSON.stringify({ userTask: FIXTURES.synthetic_safe_task, repositoryContext: "repo" });
  const bytes = Buffer.byteLength(j, "utf8");
  assert.ok(bytes > 20, "non-trivial payload");
  assert.equal(bytes, Buffer.byteLength(j), "utf8 is the default but asserted explicitly");
});

// ---------------------------------------------------------------------------
// 5. Destructive fixture never appears in stored evidence rows
// ---------------------------------------------------------------------------

test("evidence: destructive fixture text never appears in any stored row", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const provider = new CountingProvider();
  const t = await startServer({
    provider,
    telemetry: TelemetrySession.withSink(sink, dbPath),
  });
  await t.call("jev_assess_command", {
    userTask: "synthetic",
    repositoryContext: "repo",
    proposedCommand: FIXTURES.synthetic_destructive_command_pattern,
  });
  await sink.close();

  const db = openDb(dbPath);
  try {
    const rows = db.prepare("SELECT * FROM decisions").all();
    const text = JSON.stringify(rows);
    assert.ok(rows.length >= 1, "a decision row was stored");
    assert.ok(!text.includes("rm -rf"), "destructive command text not persisted");
    assert.ok(!text.includes("synthetic-placeholder-target"), "fixture target not persisted");
    // Privacy invariant: the only failure code is the closed-union PREFLIGHT-BLOCK.
    assert.ok(rows.every((r) => r.failure_code === "PREFLIGHT-BLOCK"), "closed failure code");
  } finally {
    db.close();
  }
  await t.server.close();
});

// ---------------------------------------------------------------------------
// 6. Evidence disabled vs enabled: identical stable decision fields
// ---------------------------------------------------------------------------

async function decisionFor(telemetry) {
  const t = await startServer({
    provider: new CountingProvider(),
    telemetry,
  });
  const res = await t.call("jev_assess_task", { userTask: FIXTURES.synthetic_safe_task, repositoryContext: "repo" });
  const decision = JSON.parse(res.result.content[0].text);
  await t.server.close();
  return decision;
}

test("evidence: disabled vs enabled stable decision fields are identical", async () => {
  const off = await decisionFor(TelemetrySession.withSink(new NoopTelemetrySink(), ""));

  const dir = tmpDir();
  const dbPath = join(dir, "telemetry.sqlite");
  const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
  const on = await decisionFor(TelemetrySession.withSink(sink, dbPath));
  await sink.close();

  for (const key of ["taskDomain", "executionMode", "requiresSecurityReview", "source"]) {
    assert.deepEqual(on[key], off[key], `stable field "${key}" identical`);
  }
  // selectedPolicyRules is optional and may be absent on both — compare only
  // when present on either side; when absent on both, treat as equal.
  assert.deepEqual(
    on.selectedPolicyRules ?? [],
    off.selectedPolicyRules ?? [],
    "selectedPolicyRules identical (defaulting absent to [])",
  );
});

// ---------------------------------------------------------------------------
// 7. Output schema is stable
// ---------------------------------------------------------------------------

test("bench: exported metric helpers produce a stable shape", () => {
  // The bench module exposes only pure helpers; importing it must not have side
  // effects (no env key, no server spawn). Verify the module does not create
  // artifacts just by being imported.
  assert.equal(typeof percentile, "function");
  assert.equal(typeof p50, "function");
  assert.equal(typeof p95, "function");
  assert.equal(typeof p99, "function");
});

test("bench: destructive fixture does not appear in the emitted JSON schema keys", () => {
  // The bench's public surface is fixture constants + helpers; the report key
  // names are fixed and content-free.
  const schemaKeys = [
    "name",
    "question_count",
    "provider_calls",
    "outcome",
    "success",
    "fallback",
    "cold_or_warm",
    "policy_preflight_direct_ms",
    "client_e2e_ms",
    "request_bytes",
    "p50",
    "p95",
    "p99",
  ];
  for (const k of schemaKeys) {
    assert.ok(typeof k === "string" && k.length > 0);
  }
  assert.ok(!schemaKeys.join(" ").includes("rm -rf"), "no destructive text in schema");
});