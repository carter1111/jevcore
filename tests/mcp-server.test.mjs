// MCP server tests — run against built dist via `node --test`.
//
// These tests drive the REAL MCP server (`createJevMcpServer`) in-process over
// `InMemoryTransport` with raw JSON-RPC — no sockets, no subprocesses, no
// network. A `FakeJevProvider` supplies every Jev judgment; tests never touch
// `TYPESAFE_API_KEY` or the real TypeSafe API.
//
// Safety properties proven here:
//   1. All four tools are registered; the three decision tools return typed
//      decisions (structuredContent).
//   2. MCP calls never execute shell commands (probe: no file created).
//   3. MCP decision calls never write files (probe: no file created).
//   4. Hard-policy blocks stay blocks through the MCP boundary.
//   5. Provider failure fails safe: plan_first / approval_required / block
//      per risk, and never block unless hard policy demands it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createJevMcpServer, toDecisionOutput } from "../dist/mcp-server.js";
import { Guard } from "../dist/engine.js";

const TOOLS = ["jev_assess_task", "jev_assess_command", "jev_review_diff", "jev_guard_report"];

// ---------------------------------------------------------------------------
// Fake Jev provider (deterministic; no network)
// ---------------------------------------------------------------------------

class FakeJevProvider {
  constructor({ answers = null, fail = false, failFor = null } = {}) {
    this.answers = answers;
    this.fail = fail;
    this.failFor = failFor; // optional predicate over input.task
    this.calls = [];
  }

  async judge(input) {
    this.calls.push(input);
    if (this.fail) return { failed: true };
    if (this.failFor && this.failFor(input)) return { failed: true };
    if (!this.answers) {
      return {
        kind: "backend",
        kindConfidence: 0.95,
        riskScore: 0.3,
        riskConfidence: 0.9,
        riskFactors: [],
        securityReviewNoul: 0.1,
        failed: false,
      };
    }
    return this.answers;
  }
}

// A safe judgment that must NOT trigger hard policy.
function safeJev() {
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

// ---------------------------------------------------------------------------
// Minimal in-process MCP client over InMemoryTransport (raw JSON-RPC)
// ---------------------------------------------------------------------------

class McpTester {
  static async start(provider) {
    const [srvT, cliT] = InMemoryTransport.createLinkedPair();
    const server = createJevMcpServer({ provider });
    await server.connect(srvT);

    const t = new McpTester();
    t.server = server;
    t.cliT = cliT;
    t.id = 0;
    t.pending = new Map();

    cliT.onmessage = (msg) => {
      if (msg && msg.id !== undefined && t.pending.has(msg.id)) {
        const p = t.pending.get(msg.id);
        t.pending.delete(msg.id);
        p.resolve(msg);
      }
    };
    await cliT.start();
    await srvT.start();

    // Handshake (2025-era line, the same line `server.connect()` serves).
    const init = await t.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jev-test-client", version: "1.0.0" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    await t.notify("notifications/initialized", {});
    return t;
  }

  request(method, params) {
    const rid = ++this.id;
    const message = { jsonrpc: "2.0", id: rid, method, params };
    const p = new Promise((resolve) => this.pending.set(rid, { resolve }));
    this.cliT.send(message);
    return p;
  }

  notify(method, params) {
    this.cliT.send({ jsonrpc: "2.0", method, params });
  }

  async listTools() {
    const r = await this.request("tools/list", {});
    return r.result.tools;
  }

  async callTool(name, args) {
    const r = await this.request("tools/call", { name, arguments: args });
    return r;
  }

  async close() {
    await this.server.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers for asserting typed decisions
// ---------------------------------------------------------------------------

function parseDecision(result) {
  assert.equal(result.isError, undefined, "call succeeded (isError not set)");
  assert.ok(Array.isArray(result.content), "result has content array");
  const textBlock = result.content.find((c) => c.type === "text");
  assert.ok(textBlock, "result has a text block");
  const decision = JSON.parse(textBlock.text);
  return { decision, structured: result.structuredContent };
}

function assertTypedDecision(d) {
  assert.ok(
    ["frontend", "backend", "web3", "devops", "testing", "research", "general"].includes(d.taskDomain),
    "taskDomain is a valid domain",
  );
  assert.ok(
    ["execute", "plan_first", "approval_required", "block"].includes(d.executionMode),
    "executionMode is valid",
  );
  assert.ok(typeof d.riskScore === "number" && d.riskScore >= 0 && d.riskScore <= 1, "riskScore in [0,1]");
  assert.equal(typeof d.requiresSecurityReview, "boolean");
  assert.ok(typeof d.confidence === "number" && d.confidence >= 0 && d.confidence <= 1, "confidence in [0,1]");
  assert.ok(Array.isArray(d.reasons), "reasons is an array");
  assert.ok(["jev", "rule", "hard_policy"].includes(d.source), "source is jev, rule, or hard_policy");
  if (d.selectedPolicyRules !== undefined) {
    assert.ok(Array.isArray(d.selectedPolicyRules), "selectedPolicyRules is an array when present");
  }
}

// ---------------------------------------------------------------------------
// 1. All four tools exist; the three decision tools return typed decisions
// ---------------------------------------------------------------------------

test("tools/list exposes exactly the four read-only tools", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const tools = await t.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, TOOLS.slice().sort());
  assert.equal(names.length, 4, "tool list is exactly four tools");
  for (const tool of tools) {
    assert.ok(tool.annotations?.readOnlyHint === true, `${tool.name} is marked read-only`);
  }
  await t.close();
});

test("jev_assess_task returns a typed decision", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_task", {
    userTask: "Add unit tests for the string parser",
    repositoryContext: "repo: utils, branch: main",
    changedFiles: ["src/parser.test.ts"],
    diffSummary: "Adds a new describe block",
    testSummary: "All green",
  });
  const { decision, structured } = parseDecision(res.result);
  assertTypedDecision(decision);
  assert.deepEqual(decision.taskDomain, "backend");
  assert.equal(decision.executionMode, "execute");
  assert.equal(structured.taskDomain, decision.taskDomain);
  assert.equal(structured.executionMode, decision.executionMode);
  await t.close();
});

test("jev_assess_command returns a typed decision", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_command", {
    userTask: "Run the linter",
    repositoryContext: "repo: api, branch: feat/x",
    proposedCommand: "npm run lint",
    changedFiles: ["src/index.ts"],
  });
  const { decision, structured } = parseDecision(res.result);
  assertTypedDecision(decision);
  assert.ok(decision.reasons instanceof Array);
  assert.equal(structured.taskDomain, decision.taskDomain);
  await t.close();
});

test("jev_review_diff returns a typed decision", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_review_diff", {
    userTask: "Review this diff before merging",
    repositoryContext: "repo: web, branch: feature/checkout",
    changedFiles: ["src/checkout.ts", "src/checkout.test.ts"],
    diffSummary: "Adds a checkout flow with validation",
    testSummary: "unit: pass",
  });
  const { decision, structured } = parseDecision(res.result);
  assertTypedDecision(decision);
  assert.ok(Array.isArray(decision.reasons));
  assert.equal(structured.taskDomain, decision.taskDomain);
  await t.close();
});

// ---------------------------------------------------------------------------
// 2/3. MCP calls never execute shell commands and never write files
// ---------------------------------------------------------------------------

test("assessing a command does not execute it (no file created)", async () => {
  const probe = join(tmpdir(), `jev-probe-${process.pid}-${Date.now()}.txt`);
  // Clean any stale probe from a prior failed run.
  if (existsSync(probe)) unlinkSync(probe);

  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_command", {
    userTask: "Print a marker to a file",
    repositoryContext: "local sandbox",
    proposedCommand: `echo pwned > ${probe}`,
  });
  assert.equal(res.result.isError, undefined, "call succeeded (no error)");
  // The decision is returned…
  const { decision } = parseDecision(res.result);
  assertTypedDecision(decision);
  // …and the command was NOT executed: the probe file must not exist.
  assert.equal(existsSync(probe), false, "shell command must NOT have run");
  await t.close();
});

test("assessing a task never writes files (task with file hint creates nothing)", async () => {
  const probeDir = join(tmpdir(), `jev-probe-dir-${process.pid}-${Date.now()}`);
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_task", {
    userTask: "Refactor the auth module",
    repositoryContext: "repo: api",
    changedFiles: ["src/auth.ts", ".env"], // .env even forces a block decision
  });
  const { decision } = parseDecision(res.result);
  assertTypedDecision(decision);
  assert.equal(decision.executionMode, "block", "hard policy still blocks");
  assert.equal(existsSync(probeDir), false, "no directory may be created by an assessment");
  await t.close();
});

// ---------------------------------------------------------------------------
// 4. Hard-policy blocks survive the MCP boundary
// ---------------------------------------------------------------------------

test("hard policy block (secrets) is returned through jev_assess_task", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_task", {
    userTask: "Update environment config",
    repositoryContext: "repo: api",
    changedFiles: [".env"],
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "block");
  assert.ok(decision.selectedPolicyRules.includes("POL-SECRETS-1"));
  assert.ok(decision.reasons.some((r) => r.code === "POL-SECRETS-1"));
  await t.close();
});

test("hard policy block (destructive SQL) via jev_assess_command", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_command", {
    userTask: "Clean up the orders table",
    repositoryContext: "repo: api",
    proposedCommand: "psql -c 'TRUNCATE orders'",
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "block");
  assert.ok(decision.selectedPolicyRules.includes("POL-DB-DESTRUCTIVE-1"));
  await t.close();
});

test("hard policy approval (migration) via jev_review_diff", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_review_diff", {
    userTask: "Add a migration for the events table",
    repositoryContext: "repo: api",
    changedFiles: ["migrations/2026-09-20_events.ts"],
    diffSummary: "Adds CREATE TABLE events",
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "approval_required");
  // No environment stated in the diff review → unclassified-target migration rule.
  assert.ok(decision.selectedPolicyRules.includes("POL-DB-MIGRATION-2"));
  await t.close();
});

// ---------------------------------------------------------------------------
// 5. Provider failure → fail safe (never open)
// ---------------------------------------------------------------------------

test("provider failure + ordinary task → plan_first (no policy match)", async () => {
  const failing = new FakeJevProvider({ fail: true });
  const t = await McpTester.start(failing);
  const res = await t.callTool("jev_assess_task", {
    userTask: "Add a button to the homepage",
    repositoryContext: "repo: web",
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "plan_first");
  assert.equal(decision.source, "rule");
  await t.close();
});

test("provider failure + elevated-risk task → approval_required (never execute, never block)", async () => {
  // A broad, cross-cutting rewrite with data impact scored elevated by RuleProvider.
  const failing = new FakeJevProvider({ fail: true });
  const t = await McpTester.start(failing);
  const res = await t.callTool("jev_assess_task", {
    userTask: "Rewrite the service touching many modules and user data across the codebase",
    repositoryContext: "repo: platform",
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "approval_required");
  assert.equal(decision.source, "rule");
  await t.close();
});

test("provider failure + hard-policy danger → block (only from policy)", async () => {
  const failing = new FakeJevProvider({ fail: true });
  const t = await McpTester.start(failing);
  const res = await t.callTool("jev_assess_command", {
    userTask: "Inspect the environment",
    repositoryContext: "repo: api",
    proposedCommand: "cat .env",
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "block");
  assert.ok(decision.selectedPolicyRules.includes("POL-SECRETS-1"));
  await t.close();
});

// ---------------------------------------------------------------------------
// Strict schema validation is enforced at the MCP boundary
// ---------------------------------------------------------------------------

test("invalid arguments (missing required field) are rejected", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_task", {
    repositoryContext: "repo: api", // no userTask
  });
  assert.equal(res.result.isError, true, "validation failure surfaces as isError");
  await t.close();
});

test("unknown argument keys are rejected (strict schema)", async () => {
  const t = await McpTester.start(new FakeJevProvider({ answers: safeJev() }));
  const res = await t.callTool("jev_assess_command", {
    userTask: "Run the linter",
    repositoryContext: "repo: api",
    proposedCommand: "npm run lint",
    surpriseKey: "should be rejected",
  });
  assert.equal(res.result.isError, true, "strict schema rejects unknown keys");
  await t.close();
});

// ---------------------------------------------------------------------------
// Policy-first preflight: MCP boundary must not leak secrets to the provider
// ---------------------------------------------------------------------------

test("MCP hard block makes ZERO provider calls and reports source hard_policy", async () => {
  const provider = new FakeJevProvider({ answers: safeJev() });
  const t = await McpTester.start(provider);
  const res = await t.callTool("jev_assess_task", {
    userTask: "rotate the PRIVATE_KEY and log it",
    repositoryContext: "repo: api",
  });
  const { decision } = parseDecision(res.result);
  assert.equal(decision.executionMode, "block");
  assert.equal(decision.source, "hard_policy");
  assert.equal(provider.calls.length, 0, "no judgment may reach the provider on a hard block");
  await t.close();
});

test("MCP sanitizes secret-like values before the provider sees them", async () => {
  const provider = new FakeJevProvider({ answers: safeJev() });
  const t = await McpTester.start(provider);
  const aws = "AKIAIOSFODNN7EXAMPLE";
  await t.callTool("jev_review_diff", {
    userTask: "review the logging change",
    repositoryContext: `repo: api; sample key ${aws}`,
    changedFiles: ["src/logger.ts"],
    diffSummary: "logs request metadata",
  });
  assert.equal(provider.calls.length, 1);
  const seen = provider.calls[0];
  assert.ok(!JSON.stringify(seen).includes(aws), "AWS key must be redacted before the provider");
  await t.close();
});

// ---------------------------------------------------------------------------
// Risk-score normalization at the MCP boundary (must always be 0..1)
// ---------------------------------------------------------------------------

test("MCP structuredContent riskScore is always within [0,1]", async () => {
  const provider = new FakeJevProvider({
    answers: {
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.9433333333333334, // normalized value from raw 2.83
      riskConfidence: 0.9,
      riskFactors: ["destructive", "scope"],
      securityReviewNoul: 0.1,
      failed: false,
    },
  });
  const t = await McpTester.start(provider);
  const res = await t.callTool("jev_assess_task", {
    userTask: "Rewrite the service touching many modules",
    repositoryContext: "platform repo",
  });
  const { decision, structured } = parseDecision(res.result);
  assert.ok(decision.riskScore >= 0 && decision.riskScore <= 1, `riskScore ${decision.riskScore}`);
  assert.ok(structured.riskScore >= 0 && structured.riskScore <= 1, `structured ${structured.riskScore}`);
  await t.close();
});

test("MCP does not fail output validation for a high-risk task", async () => {
  // Simulates the real bug: a high-risk judgment must not produce > 1 and
  // therefore must not trigger an output-schema validation error.
  const provider = new FakeJevProvider({
    answers: {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.9433333333333334,
      riskConfidence: 0.95,
      riskFactors: ["destructive", "data", "irreversible"],
      securityReviewNoul: 0.8,
      failed: false,
    },
  });
  const t = await McpTester.start(provider);
  for (const tool of [
    ["jev_assess_task", { userTask: "Rewrite many modules", repositoryContext: "platform" }],
    ["jev_review_diff", { userTask: "Review risky diff", repositoryContext: "platform", changedFiles: ["src/a.ts"], diffSummary: "Broad rewrite" }],
  ]) {
    const res = await t.callTool(tool[0], tool[1]);
    assert.equal(res.result.isError, undefined, `${tool[0]} must not error`);
    const { decision } = parseDecision(res.result);
    assert.ok(decision.riskScore >= 0 && decision.riskScore <= 1);
    assert.equal(decision.executionMode, "approval_required");
  }
  await t.close();
});

// ---------------------------------------------------------------------------
// Boundary fallback: invalid values injected at the MCP output boundary
// across ALL THREE tools (explicit fallback, never silent coercion)
// ---------------------------------------------------------------------------

/** Provider that returns a raw EngineResult-like shape via a crafted judgment. */
class BoundaryProbeProvider {
  constructor({ riskScore = 0.2, kindConfidence = 0.9, riskConfidence = 0.9 } = {}) {
    this.riskScore = riskScore;
    this.kindConfidence = kindConfidence;
    this.riskConfidence = riskConfidence;
  }
  async judge() {
    return {
      kind: "backend",
      kindConfidence: this.kindConfidence,
      riskScore: this.riskScore,
      riskConfidence: this.riskConfidence,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
  }
}

const ALL_TOOLS_ARGS = {
  jev_assess_task: { userTask: "refactor the parser module", repositoryContext: "repo" },
  jev_assess_command: { userTask: "run the build", repositoryContext: "repo", proposedCommand: "npm run build" },
  jev_review_diff: { userTask: "review the change", repositoryContext: "repo", changedFiles: ["src/a.ts"], diffSummary: "small change" },
};

/**
 * Confidence is NOT validated by the engine, so an invalid confidence flows all
 * the way to the MCP output boundary — these cases exercise the boundary
 * fallback through all three real tools.
 *
 * (Invalid riskScore is intercepted earlier by the engine, per requirement #1,
 * so it is covered by the engine-level test plus a direct boundary test below.)
 */
const INVALID_CONFIDENCE_VALUES = [
  { field: "classification confidence", value: 1.01 },
  { field: "classification confidence", value: -0.01 },
  { field: "classification confidence", value: NaN },
  { field: "classification confidence", value: Infinity },
  { field: "risk confidence", value: 1.01 },
  { field: "risk confidence", value: -0.01 },
  { field: "risk confidence", value: NaN },
  { field: "risk confidence", value: Infinity },
];

for (const { field, value } of INVALID_CONFIDENCE_VALUES) {
  const label = `${field}=${String(value)}`;
  test(`boundary fallback: ${label} → explicit safe fallback in all 3 tools`, async () => {
    const opts = field === "classification confidence" ? { kindConfidence: value } : { riskConfidence: value };

    for (const [tool, args] of Object.entries(ALL_TOOLS_ARGS)) {
      const t = await McpTester.start(new BoundaryProbeProvider(opts));
      const res = await t.callTool(tool, args);

      // Protocol-valid: no isError, no -32603, no thrown protocol error.
      assert.ok(res.result, `${tool} [${label}] must not return a protocol error`);
      assert.equal(res.result.isError, undefined, `${tool} [${label}] must not be isError`);

      const { decision, structured } = parseDecision(res.result);

      // Explicit conservative fallback — NOT a coercion of the invalid value.
      assert.equal(decision.executionMode, "plan_first", `${tool} [${label}] mode`);
      assert.equal(decision.riskScore, 1, `${tool} [${label}] riskScore must be exactly 1`);
      assert.equal(decision.confidence, 0, `${tool} [${label}] confidence must be exactly 0`);
      assert.equal(decision.requiresSecurityReview, true, `${tool} [${label}] security review`);
      assert.equal(decision.source, "rule", `${tool} [${label}] source`);
      assert.ok(
        decision.reasons.some((r) => r.code === "MCP-INVALID-DECISION-OUTPUT"),
        `${tool} [${label}] must carry MCP-INVALID-DECISION-OUTPUT`,
      );
      // structuredContent satisfies the schema (valid domain + ranges).
      assertTypedDecision(decision);
      assertTypedDecision(structured);
      assert.equal(structured.riskScore, 1);
      assert.equal(structured.confidence, 0);
      await t.close();
    }
  });
}

/**
 * Invalid riskScore: the engine intercepts it first (requirement #1 →
 * PROVIDER-INVALID-RISK-SCORE), so through the tools the decision is the
 * engine's safe fallback. The MCP boundary's own riskScore guard is proven by
 * direct injection (the boundary must still be correct if it is ever reached).
 */
const INVALID_RISK_VALUES = [3.01, -0.01, NaN, Infinity];

for (const value of INVALID_RISK_VALUES) {
  const label = `riskScore=${String(value)}`;

  test(`engine fallback (not boundary): ${label} via tools → plan_first + PROVIDER-INVALID-RISK-SCORE`, async () => {
    for (const [tool, args] of Object.entries(ALL_TOOLS_ARGS)) {
      const t = await McpTester.start(new BoundaryProbeProvider({ riskScore: value }));
      const res = await t.callTool(tool, args);
      assert.ok(res.result, `${tool} [${label}] must not return a protocol error`);
      assert.equal(res.result.isError, undefined, `${tool} [${label}] must not be isError`);
      const { decision, structured } = parseDecision(res.result);
      assert.equal(decision.executionMode, "plan_first", `${tool} [${label}] mode`);
      assert.equal(decision.riskScore, 1, `${tool} [${label}] riskScore must be exactly 1`);
      assert.equal(decision.confidence, 0, `${tool} [${label}] confidence`);
      assert.ok(
        decision.reasons.some((r) => r.code === "PROVIDER-INVALID-RISK-SCORE"),
        `${tool} [${label}] must carry PROVIDER-INVALID-RISK-SCORE`,
      );
      assertTypedDecision(decision);
      assertTypedDecision(structured);
      await t.close();
    }
  });

  test(`boundary fallback (direct injection): ${label} → explicit safe fallback`, () => {
    const out = toDecisionOutput({
      classification: { kind: "backend", confidence: 0.9, source: "jev" },
      risk: { score: value, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
    });
    assert.equal(out.executionMode, "plan_first", `[${label}] mode`);
    assert.equal(out.riskScore, 1, `[${label}] riskScore exactly 1`);
    assert.equal(out.confidence, 0, `[${label}] confidence exactly 0`);
    assert.equal(out.requiresSecurityReview, true, `[${label}] security review`);
    assert.equal(out.source, "rule", `[${label}] source`);
    assert.ok(
      out.reasons.some((r) => r.code === "MCP-INVALID-DECISION-OUTPUT"),
      `[${label}] must carry MCP-INVALID-DECISION-OUTPUT`,
    );
    assertTypedDecision(out);
  });
}

// ---------------------------------------------------------------------------
// toDecisionOutput unit coverage (pure mapping)
// ---------------------------------------------------------------------------

test("toDecisionOutput maps an EngineResult into the typed decision shape", async () => {
  const g = new Guard(new FakeJevProvider({ answers: safeJev() }));
  const result = await g.decide({ task: "add a test", hints: { touchedFiles: ["a.test.ts"] } });
  const out = toDecisionOutput(result);
  assertTypedDecision(out);
  assert.deepEqual(out.taskDomain, "backend");
  assert.equal(out.executionMode, "execute");
  assert.equal(out.requiresSecurityReview, false);
  assert.equal(out.selectedPolicyRules, undefined);
});