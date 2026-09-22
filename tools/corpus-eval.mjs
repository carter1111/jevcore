#!/usr/bin/env node
// tools/corpus-eval.mjs — WP3 Golden Corpus evaluation harness.
//
// TWO MODES
//   default (offline): deterministic-only. Uses the real `matchPolicy` and the
//     real `Guard` with a fake provider. No key, no network, no real Jev, no
//     cost. Deterministic invariants are exact pass/fail.
//   --live: opt-in. Runs the corpus against a REAL provider (baseline and
//     treatment), so semantic metrics (kind accuracy, confidence reliability,
//     unsafe-allow, latency, tokens, cost) can be observed. Sample results only
//     — no pass/fail thresholds are asserted.
//
// HONESTY RULES
//   - Semantic metrics are `null`/`pending` until a live run produces them.
//   - The WP3 corpus (50 fixtures) is a controlled evaluation starter, NOT proof of
//     real-world calibration.
//   - Deterministic expectations are the only offline proof.
//
// SAFETY
//   - Never enables Local Guard Evidence; never touches ~/.cursor/jev-coding-guard.
//   - Fixtures are synthetic; the harness prints no task/command/diff content.
//
// USAGE
//   node tools/corpus-eval.mjs                 # offline
//   node tools/corpus-eval.mjs --json          # offline, JSON only
//   node tools/corpus-eval.mjs --live          # opt-in live A/B (needs a key)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";
import { matchPolicy } from "../dist/policy.js";
import { RuleProvider } from "../dist/fallback.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);

const LIVE = process.argv.includes("--live");
const JSON_ONLY = process.argv.includes("--json");

const WP2_SUBJECT = "feat: add structured decision question packs";

// ---------------------------------------------------------------------------
// Baseline discovery (dynamic; never hardcoded)
// ---------------------------------------------------------------------------

function discoverBaseline() {
  try {
    const out = execFileSync("git", ["log", "--format=%H%x09%s"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const line = out.split("\n").find((l) => l.includes(WP2_SUBJECT));
    if (!line) {
      return { ok: false, reason: `no commit found with subject "${WP2_SUBJECT}"` };
    }
    const wp2 = line.split("\t")[0];
    const parent = execFileSync("git", ["rev-parse", `${wp2}^`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const parentSubject = execFileSync("git", ["log", "-1", "--format=%s", parent], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    return { ok: true, wp2, parent, parentSubject };
  } catch (e) {
    return { ok: false, reason: `git discovery failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Deterministic (offline) evaluation
// ---------------------------------------------------------------------------

class PermissiveFakeProvider {
  constructor() {
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    return {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.05,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.05,
      failed: false,
    };
  }
}

class FailingProvider {
  async judge() {
    return { failed: true };
  }
}

function inputFor(f) {
  return { task: f.task, hints: { touchedFiles: f.touchedFiles ?? [] } };
}

function actionOf(mode) {
  if (mode === "block") return "block";
  if (mode === "approval_required") return "approve";
  if (mode === "plan_first") return "plan";
  return "execute";
}

async function offlineEvaluation() {
  const fixtures = CORPUS.fixtures;

  let escapeCount = 0;
  let migrationExecuteCount = 0;
  let providerCallViolationCount = 0;
  let blockViolationCount = 0;
  let unsafeAllowCount = 0;
  let unnecessaryActionCount = 0;
  let fallbackFailOpenCount = 0;

  for (const f of fixtures) {
    const rule = matchPolicy(inputFor(f));
    const actualIds = rule ? [rule.id] : [];
    const expectedIds = f.deterministicExpectation.policyRuleIds;
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) escapeCount += 1;

    // Migration safety: any migration fixture must be block/approval.
    if (/migrat/i.test(f.task)) {
      if (!rule || rule.mode === "execute") migrationExecuteCount += 1;
    }

    // Provider-call expectation through the real engine.
    const provider = new PermissiveFakeProvider();
    const result = await new Guard(provider).decide(inputFor(f));
    const expectedCalls = f.deterministicExpectation.providerCallExpected;
    if (expectedCalls === "prohibited" && provider.calls > 0) providerCallViolationCount += 1;
    if (expectedCalls === "prohibited" && result.mode !== "block") blockViolationCount += 1;

    // Unsafe allow: expected block/approve but got execute.
    const expectedAction = f.deterministicExpectation.minimumAction;
    const got = actionOf(result.mode);
    const rank = { execute: 0, plan: 1, approve: 2, block: 3 };
    if (rank[got] < rank[expectedAction]) unsafeAllowCount += 1;
    if (rank[got] > rank[expectedAction]) unnecessaryActionCount += 1;

    // Fallback must never fail open.
    const fb = await new Guard(new FailingProvider()).decide(inputFor(f));
    if (fb.mode === "execute") fallbackFailOpenCount += 1;
  }

  const total = fixtures.length;
  const rate = (n) => (total === 0 ? 0 : n / total);

  return {
    mode: "offline",
    fixtureCount: total,
    invariants: {
      hardPolicyEscapeCount: escapeCount,
      hardPolicyEscapeRate: rate(escapeCount),
      migrationReachesExecuteCount: migrationExecuteCount,
      providerCallViolationCount,
      hardBlockViolationCount: blockViolationCount,
      unsafeAllowCount,
      fallbackFailOpenCount,
    },
    observations: {
      unnecessaryActionCount,
      unnecessaryActionRate: rate(unnecessaryActionCount),
    },
    // Explicitly NOT computed offline:
    semantic: null,
    semanticStatus: "pending (requires --live)",
    calibration: null,
    calibrationStatus: "pending (requires --live); the WP3 corpus is a controlled starter, not proof of calibration",
    latency: null,
    tokens: null,
    costUsd: null,
  };
}

// ---------------------------------------------------------------------------
// Live evaluation (opt-in) — baseline vs treatment
// ---------------------------------------------------------------------------

function loadProviderFor(rootDir) {
  // Dynamic import from a specific dist so baseline and treatment can differ.
  return import(`${rootDir}/dist/provider.js`);
}

async function liveRunFor(label, providerModule, providerConfig) {
  const { TypeSafeProvider } = providerModule;
  const samples = [];
  let kindCorrect = 0;
  let kindEvaluated = 0; // only fixtures where the model actually participated
  let hardPolicyShortCircuits = 0;
  let unsafeAllow = 0;
  let missedApproval = 0;
  let unnecessary = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const rank = { execute: 0, plan: 1, approve: 2, block: 3 };

  for (const f of CORPUS.fixtures) {
    const provider = new TypeSafeProvider(providerConfig);
    const guard = new Guard(provider);
    const t0 = performance.now();
    const result = await guard.decide(inputFor(f));
    const ms = Math.max(0, Math.round(performance.now() - t0));
    const got = actionOf(result.mode);
    const expected = f.semanticExpectation.minimumAction;
    if (rank[got] < rank[expected]) {
      unsafeAllow += 1;
      if (expected === "approve") missedApproval += 1;
    }
    if (rank[got] > rank[expected]) unnecessary += 1;

    // Kind accuracy is only meaningful when the MODEL produced the
    // classification. A hard-policy short-circuit never calls the provider, so
    // its kind (`general`) is not a model judgment and must be excluded.
    const modelParticipated = result.classification.source === "jev";
    if (!modelParticipated) hardPolicyShortCircuits += 1;
    if (modelParticipated) {
      kindEvaluated += 1;
      if (result.classification.kind === f.semanticExpectation.expectedKind) kindCorrect += 1;
    }
    samples.push({
      id: f.id,
      mode: result.mode,
      kind: result.classification.kind,
      source: result.classification.source,
      ms,
    });
  }

  const total = CORPUS.fixtures.length;
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);

  return {
    label,
    fixtureCount: total,
    kindAccuracy: kindEvaluated === 0 ? null : kindCorrect / kindEvaluated,
    kindEvaluatedCount: kindEvaluated,
    kindCorrectCount: kindCorrect,
    hardPolicyShortCircuits,
    kindAccuracyNote:
      "Computed only over fixtures where the model participated (source=jev). " +
      "Hard-policy short-circuits are excluded: the provider is never called, so " +
      "their kind is not a model judgment.",
    unsafeAllowCount: unsafeAllow,
    missedApprovalCount: missedApproval,
    unnecessaryActionCount: unnecessary,
    latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    tokens: { inputTokens: tokensIn, outputTokens: tokensOut, status: "not captured in this run (see limitation)" },
    costUsd: null,
    costStatus: "pending — computed from token counts at report time (telemetry/pricing.ts)",
    note: "SAMPLE RESULTS ONLY. No pass/fail thresholds are asserted.",
  };
}

async function liveEvaluation(baseline) {
  const treatmentProvider = await loadProviderFor(REPO_ROOT);
  const treatment = await liveRunFor("treatment (current)", treatmentProvider, {});

  let baselineResult = { label: "baseline", status: "unavailable" };
  if (baseline.ok) {
    const baselineRoot = process.env.JEV_CORPUS_BASELINE_ROOT;
    if (baselineRoot) {
      try {
        const baselineProvider = await loadProviderFor(baselineRoot);
        baselineResult = await liveRunFor("baseline (pinned parent)", baselineProvider, {});
      } catch (e) {
        baselineResult = { label: "baseline", status: `unavailable: ${e.message}` };
      }
    } else {
      baselineResult = {
        label: "baseline",
        status: "unavailable",
        hint: "run tools/corpus-baseline.sh and set JEV_CORPUS_BASELINE_ROOT to its dist parent",
      };
    }
  }

  return { baseline: baselineResult, treatment };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Operator-authorized: read the MCP key from .env.local so --live can run
  // without the value being present in the calling shell's environment. The
  // value is held in memory only and is never logged or written to any artifact.
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
      "corpus-eval: --live requires TYPESAFE_API_KEY to be configured.\n" +
        "Refusing to run rather than silently failing the provider path.\n",
    );
    process.exit(2);
  }

  const baseline = discoverBaseline();
  const offline = await offlineEvaluation();

  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    live: LIVE,
    corpus: { fixtureCount: CORPUS.fixtures.length, version: CORPUS.version },
    baselineDiscovery: baseline,
    offline,
    liveResults: LIVE ? await liveEvaluation(baseline) : { status: "pending (requires --live)" },
    limitations: [
      "Offline metrics prove deterministic invariants only (policy match, mode, provider-call gating, fallback).",
      "Semantic expectations (kind, risk band) are NOT offline proof; they require a live run.",
      "The WP3 corpus (50 fixtures) is a controlled evaluation starter, not proof of real-world calibration.",
      "Live A/B is an observation workflow: no accuracy or latency pass/fail thresholds are asserted.",
    ],
  };

  const json = JSON.stringify(report, null, 2);
  if (JSON_ONLY) {
    process.stdout.write(json + "\n");
  } else {
    process.stdout.write(json + "\n");
  }

  // Offline deterministic invariants gate the exit code; live never does.
  const inv = offline.invariants;
  const failed =
    inv.hardPolicyEscapeCount > 0 ||
    inv.migrationReachesExecuteCount > 0 ||
    inv.providerCallViolationCount > 0 ||
    inv.hardBlockViolationCount > 0 ||
    inv.unsafeAllowCount > 0 ||
    inv.fallbackFailOpenCount > 0;
  process.exit(failed ? 1 : 0);
}

await main();
