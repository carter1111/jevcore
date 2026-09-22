// tests/model-router.test.mjs — P6 harness-only model router.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectHarnessModel,
  MODEL_ROUTER_VERSION,
  DEFAULT_HARNESS_CATALOG,
} from "../dist/model-router.js";

function routing(tier) {
  return {
    complexity: "medium",
    recommendedModelTier: tier,
    recommendedContextBudget: "medium",
    recommendedSkillBundle: ["backend"],
    planFirst: false,
    source: "deterministic",
  };
}

test("model-router: version and catalog are non-empty", () => {
  assert.ok(MODEL_ROUTER_VERSION.length > 0);
  assert.ok(DEFAULT_HARNESS_CATALOG.length >= 3);
});

test("model-router: selects catalog entry by recommended tier", () => {
  const s = selectHarnessModel(routing("reasoning"));
  assert.equal(s.tier, "reasoning");
  assert.equal(s.modelId, "harness-reasoning");
  assert.equal(s.source, "harness");
});

test("model-router: forceTier overrides routing (control arm)", () => {
  const s = selectHarnessModel(routing("reasoning"), { forceTier: "normal" });
  assert.equal(s.tier, "normal");
  assert.equal(s.modelId, "harness-normal");
});

test("model-router: null routing without forceTier returns null", () => {
  assert.equal(selectHarnessModel(null), null);
  assert.equal(selectHarnessModel(undefined), null);
});

test("model-router: deterministic for fixed inputs", () => {
  const a = selectHarnessModel(routing("fast"));
  const b = selectHarnessModel(routing("fast"));
  assert.deepEqual(a, b);
});
