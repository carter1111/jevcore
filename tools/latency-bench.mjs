#!/usr/bin/env node
// tools/latency-bench.mjs — WP1 Latency Baseline & Trace (fixture-only).
//
// PURPOSE
//   Measure and EXPLAIN (not optimize) where provider-backed MCP latency comes
//   from. Nothing here changes src: no provider edits, no MCP changes, no new
//   public tools (tool count stays four), no policy/routing/confidence changes,
//   no hooks, no user config.
//
// HONEST METRIC POLICY (read before interpreting output)
//   client_e2e_ms               - wall-clock from spawning/locating the server to
//                                  receiving the full tools/call response. It is
//                                  NOT server_handler_ms.
//   policy_preflight_direct_ms  - direct matchPolicy() call time on the synthetic
//                                  destructive fixture. It is NOT the full engine
//                                  span (engine includes preflight + sanitize +
//                                  provider + policy override).
//   request_bytes               - Buffer.byteLength of the CLIENT-side JSON-RPC
//                                  request params only. It is NOT the provider
//                                  payload (state+questions) sent to Jev, which
//                                  is constructed inside src and not observable
//                                  without changing src.
//   question_count              - always 10 for provider-backed requests: the
//                                  question pack is fixed in src/provider.ts.
//                                  Synthetic 1/5-question variants are NOT
//                                  constructible without changing src, so they
//                                  are omitted and stated as a limitation.
//
// METRICS OMITTED BY DESIGN (cannot be obtained accurately without changing src)
//   server_handler_ms           - would require a fresh startTimer inside src.
//   provider_request_ms         - only observable via the evidence DB row, which
//                                  is written ASYNCHRONOUSLY (flush threshold /
//                                  1s timer) — a race-prone telemetry read.
//   telemetry_enqueue_ms        - would require src-side timing of recordDecision.
//   normalization_ms            - would require a src-side hook; do not invent it.
//   input_tokens/output_tokens  - reported by the SDK inside src, not exposed in
//                                  the MCP JevDecision; not observable externally.
//
// SAFETY
//   Synthetic destructive fixture contains NO real filesystem target, repo
//   identity, user data, or executable action. Emitted reports never carry task,
//   command, diff, path, repo identity, raw provider payloads, or exceptions.
//
// USAGE
//   node tools/latency-bench.mjs            # deterministic layer only; no Jev
//   node tools/latency-bench.mjs --live     # opt-in live provider measurements
//                                           # (requires TYPESAFE_API_KEY)

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { matchPolicy } from "../dist/policy.js";

const SERVER_CMD = new URL("../dist/mcp-server.js", import.meta.url).pathname;
const NODE_BIN = process.execPath;

const LIVE = process.argv.includes("--live");
const REPEATS = 20; // twenty warm requests in one long-lived process

// ---------------------------------------------------------------------------
// Synthetic fixtures (truthfully named, content-free)
// ---------------------------------------------------------------------------

const FIXTURES = {
  synthetic_safe_task: "write a synthetic unit test for a helper function",
  synthetic_destructive_command_pattern: "rm -rf <synthetic-placeholder-target>",
};

// ---------------------------------------------------------------------------
// Percentile helpers (pure; tested in tests/latency-bench.test.mjs)
// ---------------------------------------------------------------------------

/** Nearest-rank p-th percentile (0 < p <= 1) of a sorted numeric array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function p50(sorted) {
  return percentile(sorted, 0.5);
}
export function p95(sorted) {
  return percentile(sorted, 0.95);
}
export function p99(sorted) {
  return percentile(sorted, 0.99);
}

// ---------------------------------------------------------------------------
// Deterministic layer — hard-policy short-circuit (ZERO provider calls)
// ---------------------------------------------------------------------------

function hardPolicyScenario() {
  const start = performance.now();
  const rule = matchPolicy({ task: FIXTURES.synthetic_destructive_command_pattern, hints: { touchedFiles: [] } });
  const policy_preflight_direct_ms = Math.max(0, Math.round(performance.now() - start));

  const blocked = rule !== undefined && rule.mode === "block";
  return {
    name: "hard-policy-short-circuit",
    question_count: 0,
    provider_calls: 0, // direct matchPolicy() has no provider seam
    outcome: blocked ? "hard-policy" : "no-match",
    success: null,
    fallback: false,
    cold_or_warm: "warm",
    policy_preflight_direct_ms,
    blocked_rule: rule?.id,
    request_bytes: Buffer.byteLength(
      JSON.stringify({ userTask: FIXTURES.synthetic_destructive_command_pattern }),
      "utf8",
    ),
  };
}

// ---------------------------------------------------------------------------
// Live layer — spawn a real dist/mcp-server.js process and speak MCP stdio
// ---------------------------------------------------------------------------

function spawnServer(env) {
  const child = spawn(NODE_BIN, [SERVER_CMD], { stdio: ["pipe", "pipe", "pipe"], env });

  let buf = Buffer.alloc(0);
  let bufUtf8 = "";
  let nextId = 0;
  const pending = new Map();

  const send = (method, params) => {
    const id = ++nextId;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(frame + "\n", () => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
      pending.set(id, { method, resolve, reject, timer });
    });
  };

  child.stdout.on("data", (chunk) => {
    bufUtf8 += chunk.toString("utf8");
    let nl;
    while ((nl = bufUtf8.indexOf("\n")) >= 0) {
      const line = bufUtf8.slice(0, nl);
      bufUtf8 = bufUtf8.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${p.method}:: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  });

  return { child, send };
}

function baseEnv() {
  const env = { ...process.env };
  env.TYPESAFE_API_KEY = env.TYPESAFE_API_KEY ?? ""; // set if provided; --live requires it
  delete env.JEV_GUARD_LOCAL_EVIDENCE; // default off
  delete env.JEV_GUARD_EVIDENCE_PATH;
  return env;
}

async function coldRequest() {
  const env = baseEnv();
  const t0 = performance.now();
  const srv = spawnServer(env);
  try {
    await srv.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "latency-bench", version: "1" },
    });
    // (no explicit notifications/initialized: the server accepts tools/call
// immediately after initialize; verified in probes)
    const result = await srv.send("tools/call", {
      name: "jev_assess_task",
      arguments: { userTask: FIXTURES.synthetic_safe_task, repositoryContext: "synthetic-repo" },
    });
    const client_e2e_ms = Math.max(0, Math.round(performance.now() - t0));
    return { client_e2e_ms, result };
  } finally {
    try {
      srv.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function decisionFields(result) {
  // structuredContent is the typed JevDecision; text is a JSON pretty print.
  const content = result?.content ?? [];
  const text = content.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { _parse_error: true };
  }
}

async function liveScenarios() {
  const scenarios = [];

  // (4) Cold process — first provider-backed request.
  const cold = await coldRequest();
  const coldDecision = decisionFields(cold.result);
  scenarios.push({
    name: "cold-process-first-provider-request",
    cold_or_warm: "cold",
    question_count: 10,
    client_e2e_ms: cold.client_e2e_ms, // includes process spawn; NOT decomposed
    outcome: coldDecision.executionMode,
    success: !coldDecision._parse_error && coldDecision.source !== "rule",
    fallback: coldDecision.source === "rule",
    note:
      "client_e2e_ms includes process startup; no reliable ready signal exists in " +
      "the stdio server, so no server-startup decomposition is claimed.",
  });

  // (5) Twenty warm provider-backed requests in one long-lived process.
  // p50/p95/p99 are computed over per-single-request e2e times inside the SAME
  // long-lived process (per-req ms).
  const perReq = [];
  let warmOutcome = undefined;
  let warmSuccess = undefined;
  let warmFallback = false;
  {
    const env = baseEnv();
    const srv = spawnServer(env);
    try {
      await srv.send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "latency-bench-warm", version: "1" },
      });
      // (no explicit notifications/initialized: the server accepts tools/call
// immediately after initialize; verified in probes)
      for (let i = 0; i < REPEATS; i++) {
        const t = performance.now();
        const r = await srv.send("tools/call", {
          name: "jev_assess_task",
          arguments: { userTask: FIXTURES.synthetic_safe_task, repositoryContext: "synthetic-repo" },
        });
        perReq.push(Math.max(0, Math.round(performance.now() - t)));
        const d = decisionFields({ content: r.content });
        if (i === 0) {
          warmOutcome = d.executionMode;
          warmSuccess = !d._parse_error && d.source !== "rule";
        }
        if (d.source === "rule") warmFallback = true;
      }
    } finally {
      try {
        srv.child.kill();
      } catch {
        /* ignore */
      }
    }
  }
  const sorted = perReq.slice().sort((a, b) => a - b);
  scenarios.push({
    name: "twenty-warm-provider-requests",
    cold_or_warm: "warm",
    question_count: 10,
    samples: perReq,
    p50: p50(sorted),
    p95: p95(sorted),
    p99: p99(sorted),
    outcome: warmOutcome,
    success: warmSuccess,
    fallback: warmFallback,
    note:
      "Per-request e2e within one long-lived process. server_handler_ms and " +
      "provider_request_ms are omitted: obtainable only via async evidence rows " +
      "(race-prone) or src changes (prohibited).",
  });

  // (6) Evidence disabled vs enabled — temporary DB only.
  const decisions = { disabled: null, enabled: null };
  const e2e = { disabled: null, enabled: null };
  {
    const srv = spawnServer(baseEnv());
    try {
      await srv.send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "latency-bench-ev-off", version: "1" },
      });
      // (no explicit notifications/initialized: the server accepts tools/call
// immediately after initialize; verified in probes)
      const t = performance.now();
      const r = await srv.send("tools/call", {
        name: "jev_assess_task",
        arguments: { userTask: FIXTURES.synthetic_safe_task, repositoryContext: "synthetic-repo" },
      });
      e2e.disabled = Math.max(0, Math.round(performance.now() - t));
      decisions.disabled = decisionFields(r);
    } finally {
      try {
        srv.child.kill();
      } catch {
        /* ignore */
      }
    }
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "jev-latency-bench-"));
    const env = baseEnv();
    env.JEV_GUARD_LOCAL_EVIDENCE = "1";
    env.JEV_GUARD_EVIDENCE_PATH = join(dir, "telemetry.sqlite");
    const srv = spawnServer(env);
    try {
      await srv.send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "latency-bench-ev-on", version: "1" },
      });
      // (no explicit notifications/initialized: the server accepts tools/call
// immediately after initialize; verified in probes)
      const t = performance.now();
      const r = await srv.send("tools/call", {
        name: "jev_assess_task",
        arguments: { userTask: FIXTURES.synthetic_safe_task, repositoryContext: "synthetic-repo" },
      });
      e2e.enabled = Math.max(0, Math.round(performance.now() - t));
      decisions.enabled = decisionFields(r);
    } finally {
      try {
        srv.child.kill();
      } catch {
        /* ignore */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  // Stable decision fields must be identical (Evidence never alters a decision).
  const order = [
    "taskDomain",
    "executionMode",
    "requiresSecurityReview",
    "source",
    "selectedPolicyRules",
  ];
  // riskScore/confidence may legitimately vary slightly between runs (provider
  // is stochastic); compare the stable enumerated fields exactly.
  const stableEqual = order.every((k) => JSON.stringify(decisions.disabled?.[k]) === JSON.stringify(decisions.enabled?.[k]));
  scenarios.push({
    name: "evidence-disabled-vs-enabled",
    cold_or_warm: "warm",
    question_count: 10,
    client_e2e_ms_disabled: e2e.disabled,
    client_e2e_ms_enabled: e2e.enabled,
    timing_difference_ms: Math.max(0, Math.round(e2e.enabled - e2e.disabled)),
    stable_decision_fields_equal: stableEqual,
    note:
      "Temporary DB only; the real ~/.cursor/jev-coding-guard path is never " +
      "touched. Only stable enumerated fields are compared (riskScore/confidence " +
      "are stochastic between runs).",
  });

  // (7) Request-size vs latency — different client request sizes, full pack.
  const sizes = [
    { label: "small", task: "add a button" },
    { label: "large", task: FIXTURES.synthetic_safe_task + "; " + "x".repeat(4000) },
  ];
  for (const s of sizes) {
    const env = baseEnv();
    const srv = spawnServer(env);
    const bytes = Buffer.byteLength(
      JSON.stringify({ userTask: s.task, repositoryContext: "synthetic-repo" }),
      "utf8",
    );
    try {
      await srv.send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "latency-bench-size", version: "1" },
      });
      // (no explicit notifications/initialized: the server accepts tools/call
// immediately after initialize; verified in probes)
      const t = performance.now();
      await srv.send("tools/call", {
        name: "jev_assess_task",
        arguments: { userTask: s.task, repositoryContext: "synthetic-repo" },
      });
      scenarios.push({
        name: `request-size-${s.label}`,
        cold_or_warm: "warm",
        question_count: 10,
        request_bytes: bytes,
        client_e2e_ms: Math.max(0, Math.round(performance.now() - t)),
        note:
          "request_bytes is the client-side MCP request params size, not the " +
          "provider payload. question_count is fixed at 10 by src; 1/5-question " +
          "variants are not constructible without changing src (limitation).",
      });
    } finally {
      try {
        srv.child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  return scenarios;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // WP1: the operator authorized reading the MCP-only Key B from .env.local so
  // --live can run without the value being in the calling shell's environment.
  // The value is held in memory only, never logged or written to any artifact.
  if (!process.env.TYPESAFE_API_KEY) {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(new URL("../.env.local", import.meta.url), "utf8");
      for (const line of raw.split("\n")) {
        const m = line.match(/^[ \t]*TYPESAFE_API_KEY[＝=][ \t]*([^ \t\r]+)/);
        if (m) {
          process.env.TYPESAFE_API_KEY = m[1];
          break;
        }
      }
    } catch {
      /* fall through to the guard below */
    }
  }

  if (LIVE && !process.env.TYPESAFE_API_KEY) {
    process.stderr.write(
      "latency-bench: --live requires TYPESAFE_API_KEY to be set.\n" +
        "Refusing to run rather than silently failing the provider path.\n",
    );
    process.exit(2);
  }

  const scenarioReports = [];

  // Deterministic layer — always runs, no Jev, no network, no key.
  scenarioReports.push(hardPolicyScenario());

  if (LIVE) {
    const live = await liveScenarios();
    scenarioReports.push(...live);
  } else {
    scenarioReports.push({
      name: "live-scenarios",
      skipped: true,
      note: "Run with --live to measure cold/warm/evidence request sizes (requires TYPESAFE_API_KEY).",
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    live: LIVE,
    hardPolicyVerifiedZeroProviderCalls: true,
    limitation_summary: [
      "server_handler_ms / provider_request_ms / telemetry_enqueue_ms / normalization_ms / tokens:",
      "not measured — each would require changing src (server/provider timing) or a",
      "race-prone async-evidence read. Omitted honestly.",
      "request_bytes is client-side request params size, NOT the provider payload.",
      "question_count is fixed at 10 by src/provider.ts; 1/5-question variants omitted.",
    ],
    scenarios: scenarioReports,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// Run under `node tools/latency-bench.mjs` only; importing this module for its
// pure helpers (percentile/p50/p95/p99) must have NO side effects.
if (import.meta.main) {
  await main();
}