// tests/fan-out-policy.test.mjs — WP5 fan-out trigger matrix (unit).
//
// Pure-function tests of the trigger decision. No provider, no network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideFanOut,
  FAN_OUT_POLICY_VERSION,
  FAN_OUT_DECISION_REASONS,
  MAX_PROVIDER_CALLS,
} from "../dist/fan-out-policy.js";

const T = {
  lowConfidenceThreshold: 0.6,
  planRiskThreshold: 0.5,
  approvalRiskThreshold: 0.8,
  securityReviewThreshold: 0.7,
};

function judgment(overrides = {}) {
  return {
    kind: "backend",
    kindConfidence: 0.95,
    riskScore: 0.05,
    riskConfidence: 0.9,
    riskFactors: [],
    securityReviewNoul: 0.05,
    failed: false,
    ...overrides,
  };
}

function decide(task, overrides = {}, extra = {}) {
  return decideFanOut({
    input: { task, hints: {} },
    round0: judgment(overrides),
    thresholds: T,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Version + reason IDs
// ---------------------------------------------------------------------------

test("fan-out-policy: version is non-empty and stable", () => {
  assert.equal(typeof FAN_OUT_POLICY_VERSION, "string");
  assert.ok(FAN_OUT_POLICY_VERSION.length > 0);
});

test("fan-out-policy: reason IDs are a closed, non-empty set", () => {
  assert.ok(FAN_OUT_DECISION_REASONS.length > 0);
  assert.equal(new Set(FAN_OUT_DECISION_REASONS).size, FAN_OUT_DECISION_REASONS.length);
  for (const id of FAN_OUT_DECISION_REASONS) assert.ok(id.startsWith("FO-"), id);
});

// ---------------------------------------------------------------------------
// Never-spend cases
// ---------------------------------------------------------------------------

test("fan-out-policy: hard policy settles the action -> NOT allowed", () => {
  const d = decide("rm -rf ./dist", { riskScore: 0.9, kindConfidence: 0.1 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "FO-HARD-POLICY-SETTLED");
});

test("fan-out-policy: provider failure -> NOT allowed (fallback handles it)", () => {
  const d = decide("refactor the shared module", { failed: true });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "FO-PROVIDER-FAILED");
});

test("fan-out-policy: low risk + high confidence -> NOT allowed", () => {
  const d = decide("add a unit test", { riskScore: 0.05, kindConfidence: 0.95, riskConfidence: 0.9 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "FO-LOW-RISK-CONFIDENT");
});

// ---------------------------------------------------------------------------
// Narrow trigger cases
// ---------------------------------------------------------------------------

test("fan-out-policy: risk near the plan threshold -> allowed", () => {
  const d = decide("refactor the shared module", { riskScore: 0.55, kindConfidence: 0.9, riskConfidence: 0.9 });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "FO-NEAR-THRESHOLD");
  assert.equal(d.nearThreshold, true);
});

test("fan-out-policy: risk near the approval threshold -> allowed", () => {
  const d = decide("refactor the shared module", { riskScore: 0.82, kindConfidence: 0.9, riskConfidence: 0.9 });
  assert.equal(d.allowed, true);
  assert.equal(d.nearThreshold, true);
});

test("fan-out-policy: unclear alone at low risk + high conf -> NOT allowed", () => {
  const d = decide("improve the system", {
    riskScore: 0.2,
    kindConfidence: 0.9,
    riskConfidence: 0.9,
    riskFactors: ["unclear"],
  });
  assert.equal(d.allowed, false, "live A/B: unclear-only Round 1 over-escalated");
  assert.equal(d.reason, "FO-LOW-RISK-CONFIDENT");
  assert.equal(d.ambiguous, true);
});

test("fan-out-policy: unclear + near plan threshold -> allowed", () => {
  const d = decide("improve the system", {
    riskScore: 0.55,
    kindConfidence: 0.9,
    riskConfidence: 0.9,
    riskFactors: ["unclear"],
  });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "FO-UNCLEAR-FACTOR");
});

test("fan-out-policy: unclear + low confidence -> allowed", () => {
  const d = decide("improve the system", {
    riskScore: 0.2,
    kindConfidence: 0.3,
    riskConfidence: 0.3,
    riskFactors: ["unclear"],
  });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "FO-UNCLEAR-FACTOR");
});

test("fan-out-policy: security-sensitive + low confidence -> allowed", () => {
  const d = decide("adjust the shared formatting helper", {
    securityReviewNoul: 0.9,
    kindConfidence: 0.3,
    riskScore: 0.2,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "FO-SECURITY-SENSITIVE-LOW-CONF");
});

// ---------------------------------------------------------------------------
// Narrowness: not everything uncertain triggers
// ---------------------------------------------------------------------------

test("fan-out-policy: low confidence alone (not near a threshold) -> NOT allowed", () => {
  // Low risk (0.2), not near 0.5 or 0.8, no unclear factor, not security-sensitive.
  const d = decide("adjust the shared formatting helper", {
    riskScore: 0.2,
    kindConfidence: 0.3,
    riskConfidence: 0.3,
  });
  assert.equal(d.allowed, false, "low confidence alone must not justify a second call");
});

test("fan-out-policy: clearly-high risk away from thresholds -> NOT allowed", () => {
  // risk 0.95 is above approval and more than the margin away from it.
  const d = decide("refactor the shared module", { riskScore: 0.98, kindConfidence: 0.9, riskConfidence: 0.9 });
  assert.equal(d.allowed, false, "already-decisive risk needs no verification");
});

// ---------------------------------------------------------------------------
// Determinism / purity / budget
// ---------------------------------------------------------------------------

test("fan-out-policy: is deterministic (same input -> same decision)", () => {
  const j = judgment({ riskScore: 0.55 });
  const a = decideFanOut({ input: { task: "refactor the shared module", hints: {} }, round0: j, thresholds: T });
  const b = decideFanOut({ input: { task: "refactor the shared module", hints: {} }, round0: j, thresholds: T });
  assert.deepEqual(a, b);
});

test("fan-out-policy: output is content-free", () => {
  const d = decide("refactor the shared module", { riskScore: 0.55 });
  assert.deepEqual(Object.keys(d).sort(), ["allowed", "ambiguous", "nearThreshold", "reason", "securitySensitive", "version"]);
});

test("fan-out-policy: the budget is a hard constant of 2", () => {
  assert.equal(MAX_PROVIDER_CALLS, 2);
});

test("fan-out-policy: never mutates the input judgment", () => {
  const j = judgment({ riskScore: 0.55, riskFactors: ["scope"] });
  const before = JSON.stringify(j);
  decideFanOut({ input: { task: "refactor the shared module", hints: {} }, round0: j, thresholds: T });
  assert.equal(JSON.stringify(j), before);
});
