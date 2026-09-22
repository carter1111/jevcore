#!/usr/bin/env node
/**
 * tools/fanout-live-compare.mjs — live spot-check: base provider vs FanOut+WP5.1.
 *
 * Opt-in live Jev cost. Content-free JSON (fixture ids + aggregates only).
 * Does NOT enable default-on fan-out; measurement only.
 *
 *   node tools/fanout-live-compare.mjs
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";
import { TypeSafeProvider } from "../dist/provider.js";
import { FanOutProvider } from "../dist/fan-out.js";

const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);

if (!process.env.TYPESAFE_API_KEY) {
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^[ \t]*TYPESAFE_API_KEY[＝=][ \t]*([^ \t\r]+)/);
      if (m) {
        process.env.TYPESAFE_API_KEY = m[1];
        break;
      }
    }
  } catch {
    /* fall through */
  }
}

if (!process.env.TYPESAFE_API_KEY) {
  process.stderr.write("fanout-live-compare: TYPESAFE_API_KEY required\n");
  process.exit(2);
}

const rank = { execute: 0, plan_first: 1, approval_required: 2, block: 3 };
const expectRank = { execute: 0, plan: 1, approve: 2, block: 3 };

function inputFor(f) {
  return {
    task: f.task,
    hints: {
      touchedFiles: f.changedFiles ?? f.touchedFiles ?? [],
      context: f.repositoryContext ?? null,
      mentionsProd: f.mentionsProd ?? null,
    },
  };
}

async function runLabel(label, wrapFanOut) {
  const samples = [];
  let unsafeAllow = 0;
  let unnecessary = 0;
  let fanOutTriggers = 0;
  let packCounts = Object.create(null);
  let modelParticipated = 0;

  for (const f of CORPUS.fixtures) {
    const base = new TypeSafeProvider({ timeoutMs: 25_000 });
    let observed = null;
    const provider = wrapFanOut
      ? new FanOutProvider(base, {
          onFanOut: (info) => {
            observed = info;
          },
        })
      : base;
    const guard = new Guard(provider);
    const t0 = performance.now();
    const result = await guard.decide(inputFor(f));
    const ms = Math.max(0, Math.round(performance.now() - t0));

    const got = result.mode;
    const expected = f.semanticExpectation.minimumAction;
    const gotR = rank[got] ?? 1;
    const expR = expectRank[expected] ?? 1;
    if (gotR < expR) unsafeAllow += 1;
    if (gotR > expR) unnecessary += 1;
    if (result.classification.source === "jev") modelParticipated += 1;

    if (wrapFanOut && observed?.calls === 2) {
      fanOutTriggers += 1;
      const id = observed.packId ?? "unknown";
      packCounts[id] = (packCounts[id] ?? 0) + 1;
    }

    samples.push({
      id: f.id,
      mode: got,
      source: result.classification.source,
      ms,
      fanOutCalls: observed?.calls ?? 1,
      packId: observed?.packId ?? null,
      packSelectReason: observed?.packSelectReason ?? null,
      verificationFailed: observed?.verificationFailed === true,
    });
  }

  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p) =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

  return {
    label,
    fixtureCount: CORPUS.fixtures.length,
    modelParticipated,
    unsafeAllowCount: unsafeAllow,
    unnecessaryActionCount: unnecessary,
    fanOutTriggerCount: wrapFanOut ? fanOutTriggers : null,
    fanOutTriggerRate: wrapFanOut ? fanOutTriggers / CORPUS.fixtures.length : null,
    domainPackCounts: wrapFanOut ? packCounts : null,
    latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    samples,
  };
}

async function main() {
  const t0 = performance.now();
  const without = await runLabel("fan-out OFF (default)", false);
  const withFan = await runLabel("fan-out ON + WP5.1 packs", true);
  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    purpose:
      "Live compare default single-call vs FanOut+domain packs. Measurement only — does not flip default-on.",
    elapsedMs: Math.round(performance.now() - t0),
    without,
    withFanOut: withFan,
    deltas: {
      unsafeAllowDelta: withFan.unsafeAllowCount - without.unsafeAllowCount,
      unnecessaryDelta: withFan.unnecessaryActionCount - without.unnecessaryActionCount,
      p50MsDelta: (withFan.latencyMs.p50 ?? 0) - (without.latencyMs.p50 ?? 0),
      p95MsDelta: (withFan.latencyMs.p95 ?? 0) - (without.latencyMs.p95 ?? 0),
    },
    limitations: [
      "40-fixture synthetic corpus; not production calibration.",
      "Semantic expectations are approximate labels.",
      "Context rerank may also add latency when ≥2 path hints exist.",
      "No pass/fail gate — operator decision for default-on fan-out.",
    ],
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`fanout-live-compare failed: ${e?.message ?? e}\n`);
  process.exitCode = 1;
});
