#!/usr/bin/env node
/**
 * C-6 — live threshold calibration on WP3 corpus (advisory).
 *
 *   node tools/threshold-calibrate-live.mjs
 *   node tools/threshold-calibrate-live.mjs --subset model
 *   node tools/threshold-calibrate-live.mjs --verbose
 *   node tools/threshold-calibrate-live.mjs --json
 *   node tools/threshold-calibrate-live.mjs --runs 5
 */
import { readFileSync } from "node:fs";

import {
  aggregateLiveStabilityReports,
  corpusFixtureToLiveCalibration,
  DEFAULT_THRESHOLDS,
  runLiveCalibration,
} from "../dist/threshold-calibrate.js";
import { TypeSafeProvider } from "../dist/provider.js";
import { requireTypesafeApiKey } from "./lib/load-typesafe-key.mjs";

const args = process.argv.slice(2);
const JSON_ONLY = args.includes("--json");
const VERBOSE = args.includes("--verbose") || JSON_ONLY;
const subsetIdx = args.indexOf("--subset");
const subsetArg = args.find((a) => a.startsWith("--subset"));
const subset =
  subsetArg?.includes("=") && subsetArg !== "--subset"
    ? subsetArg.split("=")[1]
    : subsetIdx >= 0 && args[subsetIdx + 1] && !args[subsetIdx + 1].startsWith("-")
      ? args[subsetIdx + 1]
      : "model";

const runsIdx = args.indexOf("--runs");
let runCount = 1;
if (runsIdx >= 0) {
  const raw = args[runsIdx + 1];
  runCount = parseInt(raw ?? "", 10);
  if (!Number.isFinite(runCount) || runCount < 1 || runCount > 20) {
    console.error("threshold-calibrate-live: --runs must be an integer from 1 to 20");
    process.exit(2);
  }
}

requireTypesafeApiKey("threshold-calibrate-live");

const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);

function filterFixtures(all) {
  if (subset === "model" || subset === undefined) {
    return all.filter((f) => f.deterministicExpectation.providerCallExpected === "allowed");
  }
  if (subset === "all") return all;
  console.error(`Unknown --subset ${subset}; use "model" (default) or "all"`);
  process.exit(2);
}

function modeToAction(mode) {
  if (mode === "block") return "block";
  if (mode === "approval_required") return "approve";
  if (mode === "plan_first") return "plan";
  return "execute";
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

const fixtures = filterFixtures(CORPUS.fixtures).map(corpusFixtureToLiveCalibration);
const corpusById = new Map(CORPUS.fixtures.map((f) => [f.id, f]));

const reports = [];
for (let i = 0; i < runCount; i++) {
  const provider = new TypeSafeProvider({ timeoutMs: 45_000 });
  const report = await runLiveCalibration(provider, fixtures, DEFAULT_THRESHOLDS);
  reports.push(report);
  if (runCount > 1 && !JSON_ONLY) {
    process.stderr.write(
      `  run ${i + 1}/${runCount}: accuracy ${(report.modeAccuracy * 100).toFixed(1)}%, unsafe ${report.unsafeAllowCount}, unnecessary ${report.unnecessaryActionCount}\n`,
    );
  }
}

function buildSingleRunOutput(report) {
  const mismatches = report.samples.filter((s) => modeToAction(s.mode) !== s.minimumAction);
  const kindEvaluated = report.samples.filter((s) => s.modelParticipated);
  let kindCorrectCount = 0;
  for (const s of kindEvaluated) {
    const corpus = corpusById.get(s.id);
    if (corpus && s.kind === corpus.semanticExpectation.expectedKind) kindCorrectCount += 1;
  }

  return {
    version: "2026-09-21.c6-live",
    subset: subset ?? "model",
    runCount: 1,
    thresholds: report.thresholds,
    fixtureCount: report.fixtureCount,
    metrics: {
      unsafeAllowCount: report.unsafeAllowCount,
      unnecessaryActionCount: report.unnecessaryActionCount,
      modeExactMatchCount: report.modeExactMatchCount,
      modeAccuracy: report.modeAccuracy,
      kindAccuracy: kindEvaluated.length === 0 ? null : kindCorrectCount / kindEvaluated.length,
      kindEvaluatedCount: kindEvaluated.length,
      modelParticipatedCount: report.modelParticipatedCount,
      hardPolicyShortCircuitCount: report.hardPolicyShortCircuitCount,
      lowConfTriggeredCount: report.lowConfTriggeredCount,
      lowConfRateAmongModel: report.lowConfRateAmongModel,
      avgKindConfidenceAmongModel: report.avgKindConfidenceAmongModel,
      avgRiskConfidenceAmongModel: report.avgRiskConfidenceAmongModel,
    },
    latencyMs: report.latencyMs,
    mismatches: mismatches.slice(0, 12).map((s) => ({
      id: s.id,
      expected: s.minimumAction,
      actual: modeToAction(s.mode),
    })),
    samples: VERBOSE
      ? report.samples.map((s) => ({
          id: s.id,
          source: s.classificationSource,
          kind: s.kind,
          kindConf: round3(s.kindConfidence),
          riskScore: round3(s.riskScore),
          riskConf: round3(s.riskConfidence),
          lowConf: s.lowConfTriggered,
          expected: s.minimumAction,
          got: modeToAction(s.mode),
          match: modeToAction(s.mode) === s.minimumAction,
        }))
      : undefined,
    recommendation:
      report.unsafeAllowCount === 0
        ? "No unsafe-allows on labeled live run at current defaults (advisory)."
        : "Review unsafe-allows before changing defaults; run offline grid with npm run calibrate:thresholds:grid.",
    note: report.note,
  };
}

const report = reports[reports.length - 1];
let output;
let stability;
let exitUnsafe = 0;

if (runCount === 1) {
  output = buildSingleRunOutput(report);
  exitUnsafe = report.unsafeAllowCount;
} else {
  stability = aggregateLiveStabilityReports(reports);
  output = {
    version: "2026-09-21.c6-live-stability",
    subset: subset ?? "model",
    runCount,
    thresholds: stability.thresholds,
    fixtureCount: stability.fixtureCount,
    runs: stability.runs,
    aggregate: stability.aggregate,
    recommendation:
      stability.aggregate.unsafeAllowCount.max === 0
        ? `Stable on safety: unsafe allow 0 in all ${runCount} runs (advisory).`
        : `Worst-case unsafe allow ${stability.aggregate.unsafeAllowCount.max} across ${runCount} runs — review before changing defaults.`,
    note: stability.note,
  };
  exitUnsafe = stability.aggregate.unsafeAllowCount.max;
}

if (JSON_ONLY) {
  console.log(JSON.stringify(output, null, 2));
} else if (runCount === 1) {
  printSingleRun(output);
} else {
  printStability(output);
}

function printSingleRun(output) {
  console.log("C-6 Live Threshold Calibration (WP3 corpus subset)");
  console.log("─".repeat(52));
  console.log(`Fixtures:     ${output.fixtureCount} (--subset ${output.subset})`);
  console.log(`Thresholds:   ${JSON.stringify(output.thresholds)}`);
  console.log(`Mode accuracy: ${(output.metrics.modeAccuracy * 100).toFixed(1)}%`);
  console.log(`Unsafe allow:  ${output.metrics.unsafeAllowCount}`);
  console.log(`Unnecessary:   ${output.metrics.unnecessaryActionCount}`);
  console.log(
    `Kind accuracy: ${output.metrics.kindAccuracy === null ? "n/a" : `${(output.metrics.kindAccuracy * 100).toFixed(1)}%`} (${output.metrics.kindEvaluatedCount} evaluated)`,
  );
  console.log(
    `Model path:    ${output.metrics.modelParticipatedCount}/${output.fixtureCount} jev, LOW-CONF ${output.metrics.lowConfTriggeredCount}${output.metrics.lowConfRateAmongModel === null ? "" : ` (${(output.metrics.lowConfRateAmongModel * 100).toFixed(0)}%)`}`,
  );
  if (output.metrics.avgKindConfidenceAmongModel !== null) {
    console.log(
      `Avg conf:      kind ${output.metrics.avgKindConfidenceAmongModel.toFixed(2)}, risk ${output.metrics.avgRiskConfidenceAmongModel.toFixed(2)}`,
    );
  }
  console.log(`Latency p50/p95: ${output.latencyMs.p50}/${output.latencyMs.p95} ms`);

  if (args.includes("--verbose") && output.samples) {
    printVerboseSamples(output.samples);
  } else if (output.mismatches.length) {
    console.log("Sample mismatches:");
    for (const m of output.mismatches) {
      console.log(`  ${m.id}: expected ${m.expected}, got ${m.actual}`);
    }
    console.log("  (use --verbose for source/confidence breakdown)");
  }

  console.log("");
  console.log(output.recommendation);
}

function printStability(output) {
  const agg = output.aggregate;
  console.log("C-6 Live Threshold Calibration — Stability Report");
  console.log("─".repeat(52));
  console.log(`Runs:         ${output.runCount} (--subset ${output.subset})`);
  console.log(`Fixtures:     ${output.fixtureCount}`);
  console.log(`Thresholds:   ${JSON.stringify(output.thresholds)}`);
  console.log("");
  console.log("Per-run accuracy:");
  for (const r of output.runs) {
    console.log(
      `  #${r.runIndex}: ${(r.modeAccuracy * 100).toFixed(1)}%  unsafe=${r.unsafeAllowCount}  unnecessary=${r.unnecessaryActionCount}  p50=${r.latencyMs.p50}ms`,
    );
  }
  console.log("");
  console.log(
    `Mode accuracy: min ${(agg.modeAccuracy.min * 100).toFixed(1)}% / mean ${(agg.modeAccuracy.mean * 100).toFixed(1)}% / max ${(agg.modeAccuracy.max * 100).toFixed(1)}%` +
      (agg.modeAccuracy.stdev === null ? "" : ` (σ ${(agg.modeAccuracy.stdev * 100).toFixed(2)}%)`),
  );
  console.log(
    `Unsafe allow:  min ${agg.unsafeAllowCount.min} / max ${agg.unsafeAllowCount.max} (${agg.unsafeAllowCount.runsWithUnsafe} runs >0)`,
  );
  console.log(
    `Unnecessary:   min ${agg.unnecessaryActionCount.min} / mean ${agg.unnecessaryActionCount.mean.toFixed(1)} / max ${agg.unnecessaryActionCount.max}`,
  );
  console.log(
    `Latency p50:   min ${agg.latencyMs.p50.min} / mean ${agg.latencyMs.p50.mean?.toFixed(0) ?? "n/a"} / max ${agg.latencyMs.p50.max} ms`,
  );
  console.log(
    `Stable fixtures: ${agg.fullyStableFixtureCount}/${output.fixtureCount} (same mode + label match every run)`,
  );

  if (agg.flakyFixtures.length) {
    console.log("");
    console.log("Flaky or mismatched fixtures:");
    const idW = 42;
    console.log("  id".padEnd(idW) + "expected".padEnd(10) + "matchRate".padEnd(12) + "modesSeen");
    for (const f of agg.flakyFixtures) {
      const modes = Object.entries(f.modesSeen)
        .map(([m, c]) => `${m}:${c}`)
        .join(", ");
      console.log(
        `  ${f.id}`.padEnd(idW) +
          String(f.expected).padEnd(10) +
          `${(f.matchRate * 100).toFixed(0)}% (${f.matchCount}/${f.runCount})`.padEnd(12) +
          modes +
          (f.modeFlipped ? " [mode flip]" : ""),
      );
    }
  }

  console.log("");
  console.log(output.recommendation);
}

function printVerboseSamples(samples) {
  console.log("");
  console.log("Per-fixture breakdown:");
  const idW = 42;
  console.log(
    "  id".padEnd(idW) +
      "source".padEnd(14) +
      "kindConf".padEnd(10) +
      "riskConf".padEnd(10) +
      "LOW-CONF".padEnd(10) +
      "expected→got",
  );
  for (const s of samples) {
    const mark = s.match ? " " : "*";
    console.log(
      `${mark} ${s.id}`.padEnd(idW) +
        String(s.source).padEnd(14) +
        String(s.kindConf).padEnd(10) +
        String(s.riskConf).padEnd(10) +
        (s.lowConf ? "yes" : "no").padEnd(10) +
        `${s.expected}→${s.got}`,
    );
  }
}

process.exitCode = exitUnsafe > 0 ? 1 : 0;
