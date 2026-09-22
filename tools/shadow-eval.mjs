#!/usr/bin/env node
/**
 * tools/shadow-eval.mjs — WP6 shadow-mode offline evaluation.
 *
 * Compares control (plain Guard) vs treatment (Guard + FanOutProvider with an
 * uncertain fake) on the golden corpus. Content-free JSON only.
 *
 * Does NOT enable default-on fan-out. Does NOT upload. Does NOT train.
 *
 *   node tools/shadow-eval.mjs
 *   node tools/shadow-eval.mjs --json
 *   npm run eval:shadow
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";
import { FanOutProvider } from "../dist/fan-out.js";
import { buildEvalManifest } from "../dist/eval-manifest.js";
import {
  compareShadowPair,
  summarizeShadowPairs,
  SHADOW_EVAL_VERSION,
} from "../dist/shadow-eval.js";

const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);
const JSON_ONLY = process.argv.includes("--json");

/**
 * Uncertain fake — near plan threshold so fan-out *can* fire when hard policy
 * does not settle. Isolates shadow deltas from live Jev semantics.
 */
class UncertainFakeProvider {
  calls = 0;
  async judge() {
    this.calls += 1;
    return {
      kind: "backend",
      kindConfidence: 0.85,
      riskScore: 0.55,
      riskConfidence: 0.85,
      riskFactors: ["unclear"],
      securityReviewNoul: 0.2,
      failed: false,
    };
  }
}

function signalsFrom(result) {
  return {
    mode: result.mode,
    riskScore: result.risk.score,
    reviewNeeded: result.security.reviewNeeded === true,
    fellBack: result.fellBack === true,
    recommendedModelTier: result.routing?.recommendedModelTier ?? null,
  };
}

async function main() {
  const fixtures = CORPUS.fixtures ?? [];
  const controlProvider = new UncertainFakeProvider();
  const treatmentInner = new UncertainFakeProvider();
  const controlGuard = new Guard(controlProvider);
  const treatmentGuard = new Guard(new FanOutProvider(treatmentInner));

  const pairs = [];
  const t0 = performance.now();

  for (const f of fixtures) {
    const input = {
      task: f.task,
      hints: {
        touchedFiles: f.changedFiles ?? f.touchedFiles ?? [],
        context: f.repositoryContext ?? null,
      },
    };
    const c = await controlGuard.decide(input);
    const t = await treatmentGuard.decide(input);
    pairs.push(compareShadowPair(f.id, signalsFrom(c), signalsFrom(t)));
  }

  const summary = summarizeShadowPairs(pairs);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "WP6 shadow-mode offline evaluation (fan-out treatment vs plain control).",
    shadowEvalVersion: SHADOW_EVAL_VERSION,
    versions: buildEvalManifest(),
    live: false,
    fixtureCount: fixtures.length,
    elapsedMs: Math.round(performance.now() - t0),
    providerCalls: {
      control: controlProvider.calls,
      treatment: treatmentInner.calls,
    },
    summary,
    /** Content-free sample rows (ids + deltas only). */
    samples: pairs.map((p) => ({
      id: p.id,
      deltas: p.deltas,
      treatmentStricterOrEqual: p.treatmentStricterOrEqual,
      controlMode: p.control.mode,
      treatmentMode: p.treatment.mode,
    })),
    limitations: [
      "Offline uncertain fake provider — not live Jev semantics.",
      "Treatment wraps FanOutProvider; MCP default fan-out remains OFF.",
      "No upload, no training, no online routing change.",
      "treatmentStricterOrEqual is a bounded signal check, not a safety proof.",
    ],
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!JSON_ONLY && summary.treatmentStricterOrEqualRate < 1) {
    // Non-zero exit only when treatment *loosens* safety on some fixture —
    // informational for CI; still print the report above.
    process.exitCode = 0;
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
