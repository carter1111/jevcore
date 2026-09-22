// tests/risk-composition.test.mjs — WP4 risk signal composition (unit).
//
// Pure-function tests of the composition layer. No provider, no network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeRiskAction,
  maxAction,
  RISK_COMPOSITION_VERSION,
  COMPOSITION_REASON_IDS,
} from "../dist/risk-composition.js";

const T = {
  lowConfidenceThreshold: 0.6,
  planRiskThreshold: 0.5,
  approvalRiskThreshold: 0.8,
  securityReviewThreshold: 0.7,
};

/** A high-confidence, low-risk, non-security signal baseline. */
function base(overrides = {}) {
  return {
    riskScore: 0.05,
    riskConfidence: 0.9,
    kindConfidence: 0.95,
    securityNoul: 0.05,
    factors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Version + reason IDs
// ---------------------------------------------------------------------------

test("composition: version is non-empty and stable", () => {
  assert.equal(typeof RISK_COMPOSITION_VERSION, "string");
  assert.ok(RISK_COMPOSITION_VERSION.length > 0);
});

test("composition: reason IDs are a closed, non-empty set", () => {
  assert.ok(COMPOSITION_REASON_IDS.length > 0);
  assert.equal(new Set(COMPOSITION_REASON_IDS).size, COMPOSITION_REASON_IDS.length);
  for (const id of COMPOSITION_REASON_IDS) assert.ok(id.startsWith("RC-"), id);
});

// ---------------------------------------------------------------------------
// Risk bands (preserved behavior)
// ---------------------------------------------------------------------------

test("composition: high risk -> approval_required", () => {
  const r = composeRiskAction(base({ riskScore: 0.9 }), T);
  assert.equal(r.action, "approval_required");
  assert.ok(r.reasonIds.includes("RC-RISK-APPROVAL"));
});

test("composition: medium risk -> plan_first", () => {
  const r = composeRiskAction(base({ riskScore: 0.6 }), T);
  assert.equal(r.action, "plan_first");
  assert.ok(r.reasonIds.includes("RC-RISK-PLAN"));
});

test("composition: low risk + high confidence -> execute", () => {
  const r = composeRiskAction(base(), T);
  assert.equal(r.action, "execute");
  assert.equal(r.reasonIds.length, 0);
  assert.equal(r.escalated, false);
});

// ---------------------------------------------------------------------------
// Security review
// ---------------------------------------------------------------------------

test("composition: security review alone -> plan_first", () => {
  const r = composeRiskAction(base({ securityNoul: 0.9 }), T);
  assert.equal(r.action, "plan_first");
  assert.ok(r.reasonIds.includes("RC-SECURITY-REVIEW"));
});

test("composition: security review + low confidence -> approval_required (Plan 9)", () => {
  const r = composeRiskAction(base({ securityNoul: 0.9, kindConfidence: 0.2 }), T);
  assert.equal(r.action, "approval_required");
  assert.ok(r.reasonIds.includes("RC-SECURITY-LOW-CONF-APPROVAL"));
  assert.equal(r.escalated, true, "escalated above the risk-only action");
});

test("composition: irreversible + low confidence -> approval_required", () => {
  const r = composeRiskAction(base({ factors: ["irreversible"], riskConfidence: 0.2 }), T);
  assert.equal(r.action, "approval_required");
  assert.ok(r.reasonIds.includes("RC-IRREVERSIBLE"));
});

test("composition: unclear + medium risk -> plan_first", () => {
  const r = composeRiskAction(base({ factors: ["unclear"], riskScore: 0.37 }), T);
  assert.equal(r.action, "plan_first");
  assert.ok(r.reasonIds.includes("RC-UNCLEAR-PLAN"));
});

test("composition: unclear + low risk + high confidence -> execute", () => {
  const r = composeRiskAction(
    base({ factors: ["unclear"], riskScore: 0.06, kindConfidence: 0.9, riskConfidence: 0.9 }),
    T,
  );
  assert.equal(r.action, "execute");
  assert.ok(!r.reasonIds.includes("RC-UNCLEAR-PLAN"));
});

test("composition: scope factor + high confidence -> plan_first", () => {
  const r = composeRiskAction(base({ factors: ["scope"], riskScore: 0.37 }), T);
  assert.equal(r.action, "plan_first");
  assert.ok(r.reasonIds.includes("RC-SCOPE-PLAN"));
});

// ---------------------------------------------------------------------------
// Low confidence alone: downgrade only, never escalate
// ---------------------------------------------------------------------------

test("composition: low confidence alone downgrades execute -> plan_first", () => {
  const r = composeRiskAction(base({ kindConfidence: 0.2 }), T);
  assert.equal(r.action, "plan_first");
  assert.ok(r.reasonIds.includes("RC-LOW-CONF-PLAN"));
});

test("composition: low confidence alone NEVER reaches approval_required", () => {
  for (const conf of [0, 0.1, 0.3, 0.59]) {
    const r = composeRiskAction(base({ kindConfidence: conf, riskConfidence: conf }), T);
    assert.notEqual(r.action, "approval_required", `conf=${conf} must not escalate alone`);
    assert.notEqual(r.action, "block", `conf=${conf} must never block`);
  }
});

test("composition: low confidence never produces block under any input", () => {
  const cases = [
    base({ kindConfidence: 0, riskConfidence: 0 }),
    base({ kindConfidence: 0, riskScore: 1, securityNoul: 1, factors: ["irreversible", "unclear"] }),
  ];
  for (const c of cases) {
    assert.notEqual(composeRiskAction(c, T).action, "block");
  }
});

// ---------------------------------------------------------------------------
// Monotonicity / determinism / purity
// ---------------------------------------------------------------------------

test("composition: is deterministic (same input -> same output)", () => {
  const s = base({ riskScore: 0.7, securityNoul: 0.8 });
  const a = composeRiskAction(s, T);
  const b = composeRiskAction(s, T);
  assert.deepEqual(a, b);
});

test("composition: maxAction is monotonic in safety", () => {
  assert.equal(maxAction("execute", "plan_first"), "plan_first");
  assert.equal(maxAction("plan_first", "execute"), "plan_first");
  assert.equal(maxAction("approval_required", "block"), "block");
  assert.equal(maxAction("block", "approval_required"), "block");
  assert.equal(maxAction("block", "block"), "block");
});

test("composition: output is content-free (only bounded values and IDs)", () => {
  const r = composeRiskAction(base({ riskScore: 0.7, factors: ["data"] }), T);
  const keys = Object.keys(r).sort();
  assert.deepEqual(keys, ["action", "escalated", "reasonIds", "signalsUsed", "version"]);
  const signalKeys = Object.keys(r.signalsUsed).sort();
  assert.deepEqual(signalKeys, [
    "factors",
    "kindConfidence",
    "lowConfidence",
    "riskConfidence",
    "riskScore",
    "securityNoul",
    "securityReviewNeeded",
  ]);
});

test("composition: does not mutate the input signals", () => {
  const s = base({ factors: ["data", "scope"] });
  const before = JSON.stringify(s);
  composeRiskAction(s, T);
  assert.equal(JSON.stringify(s), before, "input unchanged");
});

test("composition: escalated flag reflects escalation above risk-only action", () => {
  // Risk alone already gives approval; security+lowconf adds no new tier.
  const already = composeRiskAction(base({ riskScore: 0.9, securityNoul: 0.9, kindConfidence: 0.1 }), T);
  assert.equal(already.action, "approval_required");
  assert.equal(already.escalated, false, "no escalation beyond the risk band");

  // Risk alone gives plan; security+lowconf escalates to approval.
  const esc = composeRiskAction(base({ riskScore: 0.6, securityNoul: 0.9, kindConfidence: 0.1 }), T);
  assert.equal(esc.escalated, true);
});
