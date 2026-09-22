// tests/fan-out.test.mjs — WP5 FanOutProvider decorator.
//
// No network, no key, no cost: a scripted fake provider records call counts and
// returns per-call answers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FanOutProvider, mergeJudgments } from "../dist/fan-out.js";
import { MAX_PROVIDER_CALLS } from "../dist/fan-out-policy.js";

// ---------------------------------------------------------------------------
// Scripted fake provider
// ---------------------------------------------------------------------------

/** Returns answers[callIndex] (or the last one), recording every call. */
class ScriptedProvider {
  constructor(answers, { throwOn = null, failOn = null } = {}) {
    this.answers = answers;
    this.throwOn = throwOn;
    this.failOn = failOn;
    this.calls = 0;
  }
  async judge() {
    const i = this.calls;
    this.calls += 1;
    if (this.throwOn === i) throw new Error("scripted transport failure");
    if (this.failOn === i) return { failed: true };
    return this.answers[Math.min(i, this.answers.length - 1)];
  }
}

/** A judgment that will NOT trigger fan-out (low risk, high confidence). */
function safe() {
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

/** A judgment that WILL trigger fan-out (near the plan threshold). */
function nearThreshold() {
  return {
    kind: "backend",
    kindConfidence: 0.9,
    riskScore: 0.55,
    riskConfidence: 0.9,
    riskFactors: [],
    securityReviewNoul: 0.05,
    failed: false,
  };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test("fan-out: a clearly-safe judgment makes exactly ONE call", async () => {
  const inner = new ScriptedProvider([safe(), safe()]);
  const provider = new FanOutProvider(inner);
  const j = await provider.judge({ task: "add a unit test" });
  assert.equal(inner.calls, 1, "no second call for clearly-safe work");
  assert.equal(j.failed, false);
});

test("fan-out: an uncertain judgment makes TWO calls (one verification)", async () => {
  const inner = new ScriptedProvider([nearThreshold(), nearThreshold()]);
  const provider = new FanOutProvider(inner);
  await provider.judge({ task: "refactor the shared module" });
  assert.equal(inner.calls, 2);
});

test("fan-out: never exceeds the hard budget of MAX_PROVIDER_CALLS", async () => {
  assert.equal(MAX_PROVIDER_CALLS, 2);
  const inner = new ScriptedProvider([nearThreshold(), nearThreshold(), nearThreshold()]);
  const provider = new FanOutProvider(inner);
  await provider.judge({ task: "refactor the shared module" });
  assert.ok(inner.calls <= MAX_PROVIDER_CALLS, `calls=${inner.calls} must be <= ${MAX_PROVIDER_CALLS}`);
});

test("fan-out: hard-policy-settled input makes exactly ONE call (no verification)", async () => {
  const inner = new ScriptedProvider([safe(), safe()]);
  const provider = new FanOutProvider(inner);
  // A destructive command is settled by policy; no extra provider call.
  await provider.judge({ task: "rm -rf ./dist" });
  assert.equal(inner.calls, 1, "policy-settled input must not spend a second call");
});

test("fan-out: a failed Round 0 makes exactly ONE call (fallback handles it)", async () => {
  const inner = new ScriptedProvider([safe()], { failOn: 0 });
  const provider = new FanOutProvider(inner);
  const j = await provider.judge({ task: "refactor the shared module" });
  assert.equal(inner.calls, 1);
  assert.equal(j.failed, true);
});

// ---------------------------------------------------------------------------
// Conservative merge
// ---------------------------------------------------------------------------

test("merge: confirmed higher Round 1 risk is taken", () => {
  const a = { kind: "backend", kindConfidence: 0.9, riskScore: 0.3, riskConfidence: 0.8, riskFactors: ["scope"], securityReviewNoul: 0.2, failed: false };
  const b = { kind: "backend", kindConfidence: 0.9, riskScore: 0.7, riskConfidence: 0.8, riskFactors: ["data"], securityReviewNoul: 0.8, failed: false };
  const m = mergeJudgments(a, b);
  assert.equal(m.riskScore, 0.7, "confirmed higher risk");
  assert.equal(m.securityReviewNoul, 0.8, "confirmed higher security");
  assert.deepEqual([...m.riskFactors].sort(), ["data", "scope"], "union of confirmed factors");
});

test("merge: unconfirmed higher Round 1 risk is ignored (no confidence collapse)", () => {
  const a = { kind: "backend", kindConfidence: 0.9, riskScore: 0.2, riskConfidence: 0.9, riskFactors: [], securityReviewNoul: 0.1, failed: false };
  const b = { kind: "backend", kindConfidence: 0.4, riskScore: 0.7, riskConfidence: 0.3, riskFactors: ["unclear"], securityReviewNoul: 0.8, failed: false };
  const m = mergeJudgments(a, b);
  assert.equal(m.riskScore, 0.2, "low-conf Round 1 must not inflate risk");
  assert.equal(m.riskConfidence, 0.9, "Round 0 confidence is kept");
  assert.equal(m.kindConfidence, 0.9, "agreed kind keeps Round 0 confidence");
  assert.equal(m.securityReviewNoul, 0.1);
  assert.deepEqual(m.riskFactors ?? [], []);
});

test("merge: kind disagreement mins kind confidence only", () => {
  const a = { kind: "backend", kindConfidence: 0.9, riskScore: 0.3, riskConfidence: 0.8, riskFactors: [], securityReviewNoul: 0.1, failed: false };
  const b = { kind: "devops", kindConfidence: 0.5, riskScore: 0.3, riskConfidence: 0.8, riskFactors: [], securityReviewNoul: 0.1, failed: false };
  const m = mergeJudgments(a, b);
  assert.equal(m.kindConfidence, 0.5, "min kind confidence on disagreement");
  assert.equal(m.riskConfidence, 0.8, "risk confidence stays Round 0 when risk did not rise");
  assert.equal(m.kind, "backend", "Round 0 kind is kept");
});

test("merge: merged risk is never lower than Round 0", () => {
  const a = { riskScore: 0.4, riskConfidence: 0.9, kindConfidence: 0.9, securityReviewNoul: 0.1, riskFactors: [], failed: false };
  const b = { riskScore: 0.2, riskConfidence: 0.9, kindConfidence: 0.9, securityReviewNoul: 0.1, riskFactors: [], failed: false };
  const m = mergeJudgments(a, b);
  assert.ok((m.riskScore ?? 0) >= a.riskScore);
});

// ---------------------------------------------------------------------------
// Verification failure never fails open
// ---------------------------------------------------------------------------

test("fan-out: a failed verification call yields verificationFailed (never a pass)", async () => {
  const inner = new ScriptedProvider([nearThreshold()], { failOn: 1 });
  const provider = new FanOutProvider(inner);
  const j = await provider.judge({ task: "refactor the shared module" });
  assert.equal(inner.calls, 2, "the second call was attempted");
  assert.equal(j.verificationFailed, true, "verification failure is signalled");
  assert.equal(j.failed, false, "Round 0's judgment is preserved");
  assert.equal(j.riskScore, nearThreshold().riskScore);
});

test("fan-out: a throwing verification call yields verificationFailed", async () => {
  const inner = new ScriptedProvider([nearThreshold()], { throwOn: 1 });
  const provider = new FanOutProvider(inner);
  const j = await provider.judge({ task: "refactor the shared module" });
  assert.equal(j.verificationFailed, true);
  assert.equal(j.failed, false);
});

test("fan-out: a successful run does NOT set verificationFailed", async () => {
  const inner = new ScriptedProvider([nearThreshold(), nearThreshold()]);
  const j = await new FanOutProvider(inner).judge({ task: "refactor the shared module" });
  assert.notEqual(j.verificationFailed, true);
});

// ---------------------------------------------------------------------------
// Observability + no depth knob
// ---------------------------------------------------------------------------

test("fan-out: observer receives call count and reason, and never affects the result", async () => {
  const seen = [];
  const inner = new ScriptedProvider([nearThreshold(), nearThreshold()]);
  const provider = new FanOutProvider(inner, { onFanOut: (info) => seen.push(info) });
  const j = await provider.judge({ task: "refactor the shared module" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].calls, 2);
  assert.equal(typeof seen[0].reason, "string");
  assert.equal(j.failed, false);
});

test("fan-out: a throwing observer never affects the decision", async () => {
  const inner = new ScriptedProvider([nearThreshold(), nearThreshold()]);
  const provider = new FanOutProvider(inner, {
    onFanOut: () => {
      throw new Error("observer exploded");
    },
  });
  const j = await provider.judge({ task: "refactor the shared module" });
  assert.equal(j.failed, false, "decision unaffected");
});

test("fan-out: exposes no caller-controlled depth knob", () => {
  // The options object only accepts thresholds and an observer — no `depth`,
  // `rounds`, or similar. Assert the constructor shape is exactly that.
  const inner = new ScriptedProvider([safe()]);
  const provider = new FanOutProvider(inner, {});
  const keys = Object.keys(provider);
  assert.ok(!keys.includes("depth"), "no depth knob");
  assert.ok(!keys.includes("rounds"), "no rounds knob");
});

test("fan-out: isFanOutEnabled defaults ON (opt out with 0)", async () => {
  const { isFanOutEnabled, FAN_OUT_ENV_FLAG } = await import("../dist/fan-out.js");
  assert.equal(isFanOutEnabled({}), true);
  assert.equal(isFanOutEnabled({ [FAN_OUT_ENV_FLAG]: "1" }), true);
  assert.equal(isFanOutEnabled({ [FAN_OUT_ENV_FLAG]: "true" }), true);
  assert.equal(isFanOutEnabled({ [FAN_OUT_ENV_FLAG]: "0" }), false);
  assert.equal(FAN_OUT_ENV_FLAG, "JEV_FAN_OUT");
});
