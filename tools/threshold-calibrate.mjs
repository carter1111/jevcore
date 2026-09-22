#!/usr/bin/env node
// tools/threshold-calibrate.mjs — C-2 offline threshold calibration report.
//
// Loads tests/corpus/calibration-labels.json and measures mode accuracy against
// synthetic provider judgments. Optional grid search; does NOT mutate defaults.
//
// Usage:
//   node tools/threshold-calibrate.mjs
//   node tools/threshold-calibrate.mjs --json
//   node tools/threshold-calibrate.mjs --grid   # small local search (slow)

import { readFileSync } from "node:fs";

import { Guard } from "../dist/engine.js";

const JSON_ONLY = process.argv.includes("--json");
const GRID = process.argv.includes("--grid");

const DATA = JSON.parse(
  readFileSync(new URL("../tests/corpus/calibration-labels.json", import.meta.url), "utf8"),
);

class FixtureProvider {
  constructor(judgment) {
    this.judgment = judgment;
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    return { ...this.judgment, failed: this.judgment.failed === true };
  }
}

async function evaluate(thresholds) {
  let correct = 0;
  const mismatches = [];
  for (const fx of DATA.fixtures) {
    const provider = new FixtureProvider(fx.judgment);
    const guard = new Guard(provider, thresholds);
    const result = await guard.decide(fx.input);
    if (result.mode === fx.expectedMode) {
      correct += 1;
    } else {
      mismatches.push({
        id: fx.id,
        expected: fx.expectedMode,
        actual: result.mode,
      });
    }
  }
  return {
    accuracy: correct / DATA.fixtures.length,
    correct,
    total: DATA.fixtures.length,
    mismatches,
  };
}

async function gridSearchAsync() {
  const base = DATA.thresholdDefaults;
  const lowConf = [0.5, 0.55, 0.6, 0.65];
  const planRisk = [0.45, 0.5, 0.55];
  const approvalRisk = [0.75, 0.8, 0.85];
  let best = { accuracy: -1, thresholds: base, mismatches: [] };

  for (const lc of lowConf) {
    for (const pr of planRisk) {
      for (const ar of approvalRisk) {
        const thresholds = {
          ...base,
          lowConfidenceThreshold: lc,
          planRiskThreshold: pr,
          approvalRiskThreshold: ar,
        };
        const r = await evaluate(thresholds);
        if (r.accuracy > best.accuracy) {
          best = { accuracy: r.accuracy, thresholds, mismatches: r.mismatches };
        }
      }
    }
  }
  return best;
}

const baseline = await evaluate(DATA.thresholdDefaults);
const report = {
  version: DATA.version,
  fixtureCount: DATA.count,
  thresholds: DATA.thresholdDefaults,
  baseline,
};

if (GRID) {
  report.gridBest = await gridSearchAsync();
  report.recommendation =
    report.gridBest.accuracy > baseline.accuracy
      ? "Grid found higher accuracy — review before changing defaults."
      : "Defaults already optimal on this labeled set.";
} else {
  report.recommendation =
    baseline.accuracy === 1
      ? "Defaults match all labeled fixtures on this set."
      : "Review mismatches; run with --grid for a small local search.";
}

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("C-2 Threshold Calibration (offline)");
  console.log("─".repeat(48));
  console.log(`Fixtures:     ${report.fixtureCount}`);
  console.log(`Thresholds:   ${JSON.stringify(report.thresholds)}`);
  console.log(
    `Accuracy:     ${(baseline.accuracy * 100).toFixed(1)}% (${baseline.correct}/${baseline.total})`,
  );
  if (baseline.mismatches.length) {
    console.log("Mismatches:");
    for (const m of baseline.mismatches) {
      console.log(`  ${m.id}: expected ${m.expected}, got ${m.actual}`);
    }
  }
  if (GRID && report.gridBest) {
    console.log("");
    console.log(`Grid best:    ${(report.gridBest.accuracy * 100).toFixed(1)}%`);
    console.log(`  thresholds: ${JSON.stringify(report.gridBest.thresholds)}`);
  }
  console.log("");
  console.log(report.recommendation);
}

process.exitCode = baseline.mismatches.length ? 1 : 0;
