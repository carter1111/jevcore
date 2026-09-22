// tests/shadow-eval.test.mjs — WP6 shadow comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareShadowPair,
  summarizeShadowPairs,
  SHADOW_EVAL_VERSION,
} from "../dist/shadow-eval.js";

test("shadow-eval: version is non-empty", () => {
  assert.ok(SHADOW_EVAL_VERSION.length > 0);
});

test("shadow-eval: identical pairs have no deltas", () => {
  const sig = {
    mode: "execute",
    riskScore: 0.1,
    reviewNeeded: false,
    fellBack: false,
    recommendedModelTier: "fast",
  };
  const p = compareShadowPair("x", sig, { ...sig });
  assert.deepEqual(p.deltas, []);
  assert.equal(p.treatmentStricterOrEqual, true);
});

test("shadow-eval: mode escalate is stricter-or-equal", () => {
  const c = {
    mode: "execute",
    riskScore: 0.1,
    reviewNeeded: false,
    fellBack: false,
    recommendedModelTier: "fast",
  };
  const t = { ...c, mode: "approval_required", riskScore: 0.6 };
  const p = compareShadowPair("y", c, t);
  assert.ok(p.deltas.includes("mode"));
  assert.equal(p.treatmentStricterOrEqual, true);
});

test("shadow-eval: mode loosen fails stricter-or-equal", () => {
  const c = {
    mode: "block",
    riskScore: 0.9,
    reviewNeeded: true,
    fellBack: false,
    recommendedModelTier: "reasoning",
  };
  const t = { ...c, mode: "execute", riskScore: 0.1, reviewNeeded: false };
  const p = compareShadowPair("z", c, t);
  assert.equal(p.treatmentStricterOrEqual, false);
});

test("shadow-eval: summarize aggregates field deltas", () => {
  const pairs = [
    compareShadowPair("a", {
      mode: "execute",
      riskScore: 0.1,
      reviewNeeded: false,
      fellBack: false,
      recommendedModelTier: "fast",
    }, {
      mode: "execute",
      riskScore: 0.1,
      reviewNeeded: false,
      fellBack: false,
      recommendedModelTier: "fast",
    }),
    compareShadowPair("b", {
      mode: "execute",
      riskScore: 0.1,
      reviewNeeded: false,
      fellBack: false,
      recommendedModelTier: "fast",
    }, {
      mode: "plan_first",
      riskScore: 0.5,
      reviewNeeded: false,
      fellBack: false,
      recommendedModelTier: "normal",
    }),
  ];
  const s = summarizeShadowPairs(pairs);
  assert.equal(s.pairCount, 2);
  assert.equal(s.identicalCount, 1);
  assert.equal(s.deltaCount, 1);
  assert.equal(s.modeDisagreeCount, 1);
  assert.equal(s.fieldDeltaCounts.mode, 1);
  assert.equal(s.treatmentStricterOrEqualRate, 1);
});
