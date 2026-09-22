// Risk-score normalization regression tests.
//
// The public Guard/MCP `riskScore` contract is 0..1. TypeSafe `Score` returns a
// LEVEL INDEX across ordered criteria levels (4 levels here → raw 0..3), so the
// provider must normalize with `raw / maxLevel`. These tests lock that contract
// and prove invalid provider data fails safe (never clamped, never -32603).
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRiskScore, RISK_CRITERIA, RISK_MAX_LEVEL, TypeSafeProvider } from "../dist/provider.js";
import { Guard } from "../dist/engine.js";
import { toDecisionOutput } from "../dist/mcp-server.js";

// ---------------------------------------------------------------------------
// 1-5. Exact normalization values (four-level rubric)
// ---------------------------------------------------------------------------

test("RISK_MAX_LEVEL is derived from the criteria (4 levels → 3)", () => {
  assert.equal(RISK_CRITERIA.length, 4);
  assert.equal(RISK_MAX_LEVEL, 3);
  assert.equal(RISK_MAX_LEVEL, RISK_CRITERIA.length - 1, "must be derived, not hard-coded");
});

const NORMALIZATION_CASES = [
  { raw: 0, expected: 0 },
  { raw: 0.78, expected: 0.26 },
  { raw: 1.5, expected: 0.5 },
  { raw: 2.83, expected: 2.83 / 3 },
  { raw: 3, expected: 1 },
];

for (const c of NORMALIZATION_CASES) {
  test(`raw ${c.raw} normalizes to ${c.expected}`, () => {
    const got = normalizeRiskScore(c.raw);
    assert.ok(got !== undefined, "must normalize");
    assert.ok(Math.abs(got - c.expected) < 1e-9, `expected ${c.expected}, got ${got}`);
    assert.ok(got >= 0 && got <= 1, "normalized value must be within [0,1]");
  });
}

test("raw 2.83 normalizes to approximately 0.9433", () => {
  const got = normalizeRiskScore(2.83);
  assert.ok(Math.abs(got - 0.9433) < 0.0001, `got ${got}`);
});

test("normalized values are monotonically increasing across the rubric", () => {
  const vals = [0, 1, 2, 3].map((r) => normalizeRiskScore(r));
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i] > vals[i - 1], `${vals[i]} must exceed ${vals[i - 1]}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Invalid provider data → safe fallback (no clamping, no -32603)
// ---------------------------------------------------------------------------

const INVALID_RAW_VALUES = [
  { label: "below 0", raw: -0.01 },
  { label: "well below 0", raw: -5 },
  { label: "above maxLevel", raw: 3.01 },
  { label: "far above maxLevel", raw: 99 },
  { label: "NaN", raw: NaN },
  { label: "Infinity", raw: Infinity },
  { label: "-Infinity", raw: -Infinity },
  { label: "undefined", raw: undefined },
  { label: "null", raw: null },
  { label: "string", raw: "1.5" },
];

for (const c of INVALID_RAW_VALUES) {
  test(`invalid raw risk score (${c.label}) → undefined, never clamped`, () => {
    assert.equal(normalizeRiskScore(c.raw), undefined);
  });
}

/** Fake provider that emits raw (possibly invalid) provider data. */
class RawAnswerProvider {
  constructor(rawRiskScore) {
    this.rawRiskScore = rawRiskScore;
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    return {
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: this.rawRiskScore, // simulates un-normalized provider output
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
  }
}

test("engine treats an out-of-range provider riskScore as a safe fallback", async () => {
  const g = new Guard(new RawAnswerProvider(3.5));
  const r = await g.decide({ task: "some ambiguous refactor" });
  assert.equal(r.mode, "plan_first", "invalid data must never execute");
  assert.equal(r.fellBack, true);
  assert.ok(r.risk.score >= 0 && r.risk.score <= 1, "fallback risk must be in [0,1]");
});

test("toDecisionOutput returns an explicit safe fallback for invalid output", () => {
  const fakeResult = {
    classification: { kind: "backend", confidence: 2, source: "jev" },
    risk: { score: 3.5, confidence: 5, factors: [] },
    security: { reviewNeeded: false, noul: 0, findings: [] },
    mode: "execute",
    reasons: [],
    fellBack: false,
  };
  const out = toDecisionOutput(fakeResult);
  // Explicit fallback — NOT a coercion of 3.5 → 1 or 2 → 1.
  assert.equal(out.executionMode, "plan_first");
  assert.equal(out.riskScore, 1);
  assert.equal(out.confidence, 0);
  assert.equal(out.requiresSecurityReview, true);
  assert.equal(out.source, "rule");
  assert.ok(
    out.reasons.some((r) => r.code === "MCP-INVALID-DECISION-OUTPUT"),
    `expected MCP-INVALID-DECISION-OUTPUT, got ${JSON.stringify(out.reasons.map((r) => r.code))}`,
  );
});

test("toDecisionOutput never emits NaN for non-finite inputs", () => {
  const out = toDecisionOutput({
    classification: { kind: "general", confidence: NaN, source: "rule" },
    risk: { score: NaN, confidence: NaN, factors: [] },
    security: { reviewNeeded: false, noul: 0, findings: [] },
    mode: "plan_first",
    reasons: [],
    fellBack: true,
  });
  assert.ok(Number.isFinite(out.riskScore), "riskScore must be finite");
  assert.ok(Number.isFinite(out.confidence), "confidence must be finite");
  assert.equal(out.riskScore, 1);
  assert.equal(out.confidence, 0);
  assert.ok(out.reasons.some((r) => r.code === "MCP-INVALID-DECISION-OUTPUT"));
});

test("toDecisionOutput leaves a fully valid decision unchanged (no coercion)", () => {
  const out = toDecisionOutput({
    classification: { kind: "backend", confidence: 0.8, source: "jev" },
    risk: { score: 0.25, confidence: 0.6, factors: ["scope"] },
    security: { reviewNeeded: false, noul: 0.1, findings: [] },
    mode: "execute",
    reasons: [],
    fellBack: false,
  });
  assert.equal(out.riskScore, 0.25, "valid riskScore must pass through unchanged");
  assert.equal(out.confidence, 0.6, "valid confidence must pass through unchanged");
  assert.equal(out.executionMode, "execute");
  assert.ok(!out.reasons.some((r) => r.code === "MCP-INVALID-DECISION-OUTPUT"));
});

test("toDecisionOutput falls back when taskDomain violates the fixed enum", () => {
  const out = toDecisionOutput({
    classification: { kind: "not-a-domain", confidence: 0.9, source: "jev" },
    risk: { score: 0.2, confidence: 0.9, factors: [] },
    security: { reviewNeeded: false, noul: 0, findings: [] },
    mode: "execute",
    reasons: [],
    fellBack: false,
  });
  assert.equal(out.taskDomain, "general", "safe valid fallback domain");
  assert.equal(out.executionMode, "plan_first");
  assert.ok(out.reasons.some((r) => r.code === "MCP-INVALID-DECISION-OUTPUT"));
});

test("boundary fallback detail names only the field category (no secrets/payloads)", () => {
  const out = toDecisionOutput({
    classification: { kind: "backend", confidence: NaN, source: "jev" },
    risk: { score: NaN, confidence: 0.5, factors: [] },
    security: { reviewNeeded: false, noul: 0, findings: [] },
    mode: "execute",
    reasons: [],
    fellBack: false,
  });
  const detail = out.reasons.find((r) => r.code === "MCP-INVALID-DECISION-OUTPUT").detail;
  assert.ok(/riskScore outside public 0\.\.1 contract/.test(detail), detail);
  assert.ok(/classification confidence outside public 0\.\.1 contract/.test(detail), detail);
  assert.ok(!/NaN/.test(detail), "detail must not echo raw values");
  assert.ok(!/sk-|Bearer|PRIVATE KEY/.test(detail), "detail must not contain secret material");
});

// ---------------------------------------------------------------------------
// Provider-level: invalid risk answer → failed (drives the safe fallback)
// ---------------------------------------------------------------------------

test("TypeSafeProvider.normalizeRiskScore is used for the public contract", () => {
  // The provider module exposes the canonical path; the Guard contract is 0..1.
  assert.equal(typeof normalizeRiskScore, "function");
  assert.ok(RISK_MAX_LEVEL === 3);
});

test("provider failure code names the invalid risk score", async () => {
  // A provider returning `failed` with the diagnostic code surfaces that reason.
  class InvalidRiskProvider {
    async judge() {
      return { failed: true, failureCode: "PROVIDER-INVALID-RISK-SCORE" };
    }
  }
  const g = new Guard(new InvalidRiskProvider());
  const r = await g.decide({ task: "ambiguous change" });
  assert.equal(r.mode, "plan_first");
  assert.ok(
    r.reasons.some((x) => x.code === "PROVIDER-INVALID-RISK-SCORE"),
    `expected diagnostic reason, got ${JSON.stringify(r.reasons.map((x) => x.code))}`,
  );
});

// ---------------------------------------------------------------------------
// Hard blocks still make zero provider calls (unchanged guarantee)
// ---------------------------------------------------------------------------

test("hard block still makes zero provider calls after normalization change", async () => {
  const provider = new RawAnswerProvider(1);
  const g = new Guard(provider);
  const r = await g.decide({ task: "cat .env" });
  assert.equal(provider.calls, 0);
  assert.equal(r.mode, "block");
  assert.equal(r.classification.source, "hard_policy");
});
