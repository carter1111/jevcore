#!/usr/bin/env node
/**
 * C-5 Phase B — live A/B: serial decideMany vs shared_system_one.
 *
 * Opt-in live Jev. Content-free JSON (fixture ids + aggregates only).
 *
 *   node tools/batch-live-compare.mjs
 *   node tools/batch-live-compare.mjs --json
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";
import { TypeSafeProvider } from "../dist/provider.js";
import { requireTypesafeApiKey } from "./lib/load-typesafe-key.mjs";

const JSON_ONLY = process.argv.includes("--json");
requireTypesafeApiKey("batch-live-compare");

const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);

/** Provider-allowed fixtures only (hard blocks excluded from batch timing). */
const BATCH_FIXTURES = CORPUS.fixtures.filter(
  (f) => f.deterministicExpectation.providerCallExpected === "allowed",
);

const BATCH_SIZE = Math.min(8, BATCH_FIXTURES.length);

function inputFor(f) {
  return {
    task: f.task,
    hints: { touchedFiles: f.touchedFiles ?? [] },
  };
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function runStrategy(strategy) {
  const slice = BATCH_FIXTURES.slice(0, BATCH_SIZE);
  const inputs = slice.map(inputFor);
  const provider = new TypeSafeProvider({ timeoutMs: 45_000 });
  const guard = new Guard(provider);
  const t0 = performance.now();
  const { items, meta } = await guard.decideManyWithMeta(inputs, { strategy });
  const totalMs = Math.max(0, Math.round(performance.now() - t0));
  return {
    strategy: meta.strategy,
    providerCalls: meta.providerCalls,
    totalMs,
    itemCount: items.length,
    modes: items.map((x, i) => ({ id: slice[i].id, mode: x.result.mode })),
  };
}

const serial = await runStrategy("serial");
const shared = await runStrategy("shared_system_one");

const modeAgree = serial.modes.every((m, i) => m.mode === shared.modes[i].mode);
const rttRatio = serial.totalMs / Math.max(1, shared.totalMs);

const report = {
  version: "2026-09-21.c5b-live",
  batchSize: BATCH_SIZE,
  fixtureIds: serial.modes.map((m) => m.id),
  serial: {
    totalMs: serial.totalMs,
    providerCalls: serial.providerCalls,
  },
  shared: {
    totalMs: shared.totalMs,
    providerCalls: shared.providerCalls,
  },
  modeAgreement: modeAgree,
  wallClockRatioSerialOverShared: Number(rttRatio.toFixed(3)),
  recommendation:
    modeAgree && shared.providerCalls < serial.providerCalls
      ? "Shared batch preserves modes with fewer provider calls — favorable for multi-item hosts."
      : modeAgree
        ? "Modes agree; evaluate latency vs token cost for your batch size."
        : "Mode mismatch between strategies — investigate before enabling shared batch in production.",
  note: "Sample measurement only; not a merge gate.",
};

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("C-5 Batch Live Compare (serial vs shared_system_one)");
  console.log("─".repeat(52));
  console.log(`Batch size:   ${report.batchSize} fixtures (provider-allowed)`);
  console.log(`Serial:       ${serial.totalMs} ms, ${serial.providerCalls} provider call(s)`);
  console.log(`Shared:       ${shared.totalMs} ms, ${shared.providerCalls} provider call(s)`);
  console.log(`Mode agree:   ${modeAgree}`);
  console.log(`RTT ratio:    ${report.wallClockRatioSerialOverShared}x (serial/shared)`);
  console.log("");
  console.log(report.recommendation);
}
