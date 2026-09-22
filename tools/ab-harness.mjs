#!/usr/bin/env node
/**
 * tools/ab-harness.mjs — P6 A/B harness (controlled; offline by default).
 *
 * Holds constant: agent label, harness catalog, repository revision, retry
 * budget, and acceptance criteria. Compares:
 *   control  — forced "normal" tier (ignore P4 recommendation)
 *   treatment — selectHarnessModel(P4 routing)
 *
 * Does NOT change Cursor / Claude / Codex host model selection.
 * Does NOT claim cost savings — reports weights only (and wall time when --live).
 *
 *   node tools/ab-harness.mjs
 *   node tools/ab-harness.mjs --live
 *   npm run eval:ab
 *   npm run eval:ab:live
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";
import { TypeSafeProvider } from "../dist/provider.js";
import {
  selectHarnessModel,
  MODEL_ROUTER_VERSION,
  DEFAULT_HARNESS_CATALOG,
} from "../dist/model-router.js";
import { buildEvalManifest } from "../dist/eval-manifest.js";

const LIVE = process.argv.includes("--live");

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);

const AGENT_LABEL = "jev-ab-harness";
const RETRY_BUDGET = 0;
const ACCEPTANCE = {
  /** Offline proxy: treatment must not disagree with Guard mode (always true here). */
  requireModeStable: true,
  /** No claim: informational cost-weight ratio only. */
  reportCostWeights: true,
};

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

function loadApiKeyFromEnvLocal() {
  if (process.env.TYPESAFE_API_KEY) return;
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

function gitRev() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function main() {
  if (LIVE) {
    loadApiKeyFromEnvLocal();
    if (!process.env.TYPESAFE_API_KEY) {
      process.stderr.write("ab-harness: --live requires TYPESAFE_API_KEY\n");
      process.exit(2);
    }
  }

  const fixtures = CORPUS.fixtures ?? [];
  const provider = LIVE
    ? new TypeSafeProvider({ timeoutMs: 25_000 })
    : new MeasureFakeProvider();
  const guard = new Guard(provider);
  const repoRevision = gitRev();

  const controlTiers = Object.create(null);
  const treatmentTiers = Object.create(null);
  const modeCounts = Object.create(null);
  let controlCost = 0;
  let treatmentCost = 0;
  let controlLatency = 0;
  let treatmentLatency = 0;
  let bothSelected = 0;
  let tierDisagree = 0;
  let modelParticipated = 0;
  const decideMs = [];
  const samples = [];

  const t0 = performance.now();

  for (const f of fixtures) {
    const input = {
      task: f.task,
      hints: {
        touchedFiles: f.changedFiles ?? f.touchedFiles ?? [],
        context: f.repositoryContext ?? null,
        mentionsProd: f.mentionsProd ?? null,
      },
    };
    const d0 = performance.now();
    const result = await guard.decide(input);
    const wallMs = Math.max(0, Math.round(performance.now() - d0));
    decideMs.push(wallMs);

    bump(modeCounts, result.mode);
    if (result.classification?.source === "jev") modelParticipated += 1;

    const routing = result.routing ?? null;
    const control = selectHarnessModel(routing, { forceTier: "normal" });
    const treatment = selectHarnessModel(routing);

    if (control && treatment) {
      bothSelected += 1;
      bump(controlTiers, control.tier);
      bump(treatmentTiers, treatment.tier);
      controlCost += control.costWeight;
      treatmentCost += treatment.costWeight;
      controlLatency += control.latencyWeight;
      treatmentLatency += treatment.latencyWeight;
      if (control.tier !== treatment.tier) tierDisagree += 1;
      samples.push({
        id: f.id,
        mode: result.mode,
        source: result.classification?.source ?? null,
        decideMs: wallMs,
        controlModelId: control.modelId,
        treatmentModelId: treatment.modelId,
        controlTier: control.tier,
        treatmentTier: treatment.tier,
        planFirst: treatment.planFirst,
      });
    } else {
      samples.push({
        id: f.id,
        mode: result.mode,
        source: result.classification?.source ?? null,
        decideMs: wallMs,
        controlModelId: control?.modelId ?? null,
        treatmentModelId: treatment?.modelId ?? null,
        controlTier: control?.tier ?? null,
        treatmentTier: treatment?.tier ?? null,
        planFirst: null,
      });
    }
  }

  const n = fixtures.length;
  const sortedMs = [...decideMs].sort((a, b) => a - b);
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: LIVE
      ? "P6 A/B harness — live Jev routing → harness model selection (still harness-only)."
      : "P6 A/B harness — offline model selection from P4 routing (harness-only).",
    schemaVersion: 1,
    modelRouterVersion: MODEL_ROUTER_VERSION,
    heldConstant: {
      agent: AGENT_LABEL,
      repositoryRevision: repoRevision,
      retryBudget: RETRY_BUDGET,
      catalogIds: DEFAULT_HARNESS_CATALOG.map((m) => m.id),
      acceptanceCriteria: ACCEPTANCE,
    },
    versions: buildEvalManifest(),
    live: LIVE,
    fixtureCount: n,
    modelParticipated,
    elapsedMs: Math.round(performance.now() - t0),
    arms: {
      control: "forceTier=normal",
      treatment: "selectHarnessModel(P4 routing)",
    },
    metrics: {
      bothSelected,
      tierDisagree,
      tierDisagreeRate: bothSelected === 0 ? 0 : tierDisagree / bothSelected,
      controlCostWeightSum: controlCost,
      treatmentCostWeightSum: treatmentCost,
      costWeightRatio:
        controlCost === 0 ? null : Number((treatmentCost / controlCost).toFixed(4)),
      controlLatencyWeightSum: controlLatency,
      treatmentLatencyWeightSum: treatmentLatency,
      latencyWeightRatio:
        controlLatency === 0
          ? null
          : Number((treatmentLatency / controlLatency).toFixed(4)),
      decideLatencyMs: {
        p50: pct(sortedMs, 0.5),
        p95: pct(sortedMs, 0.95),
        p99: pct(sortedMs, 0.99),
      },
      modeCounts,
    },
    distributions: {
      controlTiers,
      treatmentTiers,
    },
    samples,
    limitations: [
      LIVE
        ? "Live Jev judgments drive P4 routing; catalog cost/latency are still weights, not dollars."
        : "Offline fake provider — not live Jev or host task-success.",
      "Cost/latency ratios use harness catalog weights unless noted.",
      "Does not change Cursor / Claude / Codex model selection.",
      "No savings claim is valid until a host-surface A/B with task-success (Q5).",
      "Host Q5 (which provider surface) remains open for host-coupled runs.",
    ],
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
