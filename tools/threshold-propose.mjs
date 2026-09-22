#!/usr/bin/env node
/**
 * Threshold change proposal (advisory). Never mutates defaults.
 *
 * To apply later (requires explicit operator approval flags):
 *   node tools/threshold-propose.mjs --apply-defaults --i-approve-threshold-change
 *
 * Host model forcing is intentionally unsupported — do not add it here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Guard } from "../dist/engine.js";
import { DEFAULT_THRESHOLDS } from "../dist/threshold-calibrate.js";

const JSON_ONLY = process.argv.includes("--json");
const APPLY = process.argv.includes("--apply-defaults");
const APPROVED = process.argv.includes("--i-approve-threshold-change");

const DATA = JSON.parse(
  readFileSync(new URL("../tests/corpus/calibration-labels.json", import.meta.url), "utf8"),
);

class FixtureProvider {
  constructor(judgment) {
    this.judgment = judgment;
  }
  async judge() {
    return { ...this.judgment, failed: this.judgment.failed === true };
  }
}

async function evaluate(thresholds) {
  let correct = 0;
  for (const fx of DATA.fixtures) {
    const result = await new Guard(new FixtureProvider(fx.judgment), thresholds).decide(fx.input);
    if (result.mode === fx.expectedMode) correct += 1;
  }
  return { accuracy: correct / DATA.fixtures.length, correct, total: DATA.fixtures.length };
}

const baseline = await evaluate(DEFAULT_THRESHOLDS);
const lowConf = [0.5, 0.55, 0.6, 0.65];
const planRisk = [0.45, 0.5, 0.55];
const approvalRisk = [0.75, 0.8, 0.85];
let best = { accuracy: baseline.accuracy, thresholds: { ...DEFAULT_THRESHOLDS } };

for (const lc of lowConf) {
  for (const pr of planRisk) {
    for (const ar of approvalRisk) {
      const thresholds = {
        ...DEFAULT_THRESHOLDS,
        lowConfidenceThreshold: lc,
        planRiskThreshold: pr,
        approvalRiskThreshold: ar,
      };
      const r = await evaluate(thresholds);
      if (r.accuracy > best.accuracy) best = { accuracy: r.accuracy, thresholds };
    }
  }
}

const improved = best.accuracy > baseline.accuracy + 1e-9;
const proposal = {
  version: "2026-09-21.threshold-propose",
  baseline: { thresholds: DEFAULT_THRESHOLDS, ...baseline },
  best: best,
  improved,
  recommendation: improved
    ? "Grid found higher offline accuracy — operator may approve apply with both flags."
    : "Defaults already optimal on the labeled set — do not change.",
  hostModelForcing: "blocked — MCP modelSelection remains advisory only; no apply path exists.",
  applyInstructions:
    "Only if improved===true AND product owner approves: " +
    "node tools/threshold-propose.mjs --apply-defaults --i-approve-threshold-change",
};

const outPath = resolve(
  new URL("../tests/corpus/threshold-proposal.json", import.meta.url).pathname,
);
writeFileSync(outPath, JSON.stringify(proposal, null, 2) + "\n");

if (APPLY) {
  if (!APPROVED) {
    console.error("Refusing apply: missing --i-approve-threshold-change");
    process.exit(2);
  }
  if (!improved) {
    console.error("Refusing apply: no improvement over defaults on labeled set");
    process.exit(1);
  }
  console.error(
    "Apply path is gated but source patching is intentionally not automated.",
  );
  console.error("Manually update DEFAULT_THRESHOLDS in src/threshold-calibrate.ts and");
  console.error("DEFAULTS in src/engine.ts to:", JSON.stringify(best.thresholds));
  console.error("Then run npm test && npm run calibrate:thresholds:live:stability");
  process.exit(3);
}

if (JSON_ONLY) {
  console.log(JSON.stringify(proposal, null, 2));
} else {
  console.log("Threshold proposal (defaults unchanged)");
  console.log("─".repeat(48));
  console.log(`Baseline accuracy: ${(baseline.accuracy * 100).toFixed(1)}%`);
  console.log(`Best grid accuracy: ${(best.accuracy * 100).toFixed(1)}%`);
  console.log(`Improved: ${improved}`);
  console.log(proposal.recommendation);
  console.log(`Wrote ${outPath}`);
  console.log(`Host model forcing: ${proposal.hostModelForcing}`);
}
process.exit(0);
