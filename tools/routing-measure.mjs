#!/usr/bin/env node
/**
 * tools/routing-measure.mjs — P4 recommendation measurement (precondition for P6).
 *
 * Offline by default: runs the golden corpus through Guard + a fake provider,
 * aggregates routing recommendation distributions. Content-free JSON only
 * (fixture ids + counts/rates). Never prints task/command/diff text.
 *
 *   node tools/routing-measure.mjs
 *   node tools/routing-measure.mjs --json
 *   npm run measure:routing
 *
 * This does NOT enable P6. It only records how often P4 suggests each bucket
 * under the current deterministic corpus offline path.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";

const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);
const JSON_ONLY = process.argv.includes("--json");

/** High-confidence low-risk fake — isolates routing from provider noise. */
class MeasureFakeProvider {
  async judge() {
    return {
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
  }
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

async function main() {
  const guard = new Guard(new MeasureFakeProvider());
  const fixtures = CORPUS.fixtures ?? [];

  const complexity = Object.create(null);
  const tiers = Object.create(null);
  const budgets = Object.create(null);
  const skills = Object.create(null);
  const planFirst = { true: 0, false: 0 };
  const modes = Object.create(null);
  const sources = Object.create(null);

  let withRouting = 0;
  let withoutRouting = 0;
  let withContext = 0;
  const samples = [];
  const t0 = performance.now();

  for (const f of fixtures) {
    const input = {
      task: f.task,
      hints: {
        touchedFiles: f.changedFiles ?? f.touchedFiles ?? [],
        context: f.repositoryContext ?? null,
      },
    };
    const result = await guard.decide(input);
    bump(modes, result.mode);
    bump(sources, result.classification.source);

    if (result.routing) {
      withRouting += 1;
      bump(complexity, result.routing.complexity);
      bump(tiers, result.routing.recommendedModelTier);
      bump(budgets, result.routing.recommendedContextBudget);
      planFirst[result.routing.planFirst ? "true" : "false"] += 1;
      for (const s of result.routing.recommendedSkillBundle) bump(skills, s);
      samples.push({
        id: f.id,
        mode: result.mode,
        source: result.classification.source,
        complexity: result.routing.complexity,
        tier: result.routing.recommendedModelTier,
        planFirst: result.routing.planFirst,
        skills: result.routing.recommendedSkillBundle,
        contextPaths: result.contextSuggestion?.paths?.length ?? 0,
      });
    } else {
      withoutRouting += 1;
      samples.push({
        id: f.id,
        mode: result.mode,
        source: result.classification.source,
        complexity: null,
        tier: null,
        planFirst: null,
        skills: [],
        contextPaths: result.contextSuggestion?.paths?.length ?? 0,
      });
    }
    if (result.contextSuggestion) withContext += 1;
  }

  const elapsedMs = Math.round(performance.now() - t0);
  const n = fixtures.length;
  const rate = (count) => (n === 0 ? 0 : count / n);

  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    purpose: "P4 recommendation measurement (P6 precondition). Not an A/B harness.",
    live: false,
    fixtureCount: n,
    elapsedMs,
    coverage: {
      withRouting,
      withoutRouting,
      routingCoverageRate: rate(withRouting),
      withContextSuggestion: withContext,
      contextCoverageRate: rate(withContext),
    },
    distributions: {
      executionMode: modes,
      classificationSource: sources,
      complexity,
      recommendedModelTier: tiers,
      recommendedContextBudget: budgets,
      planFirst,
      skills,
    },
    samples,
    limitations: [
      "Offline fake provider — not live Jev semantics.",
      "Hard-policy fixtures dominate some buckets; interpret coverage accordingly.",
      "No cost/latency claim; no host model selection is performed.",
      "P6 remains blocked until a controlled A/B harness exists.",
    ],
  };

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`routing-measure failed: ${e?.message ?? e}\n`);
  process.exitCode = 1;
});
