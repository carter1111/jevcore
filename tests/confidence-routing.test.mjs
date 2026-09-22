// tests/confidence-routing.test.mjs — WP4 routing behavior through the engine.
//
// Verifies the composed routing end-to-end with a fake provider, including the
// hard-policy precedence invariant: composition can escalate, but a hard-policy
// outcome is never downgraded by it.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Guard,
  normalizeRiskFactors,
  sanitizeMisleadingRiskFactors,
} from "../dist/engine.js";
import { composeRiskAction } from "../dist/risk-composition.js";

/** Deterministic fake provider. */
class FakeJevProvider {
  constructor(answers = {}, fail = false) {
    this.answers = answers;
    this.fail = fail;
  }
  async judge() {
    if (this.fail) return { failed: true };
    return this.answers;
  }
}

function answer(overrides = {}) {
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

// ---------------------------------------------------------------------------
// Plan §9 routing table
// ---------------------------------------------------------------------------

test("routing: high-risk + low confidence -> approval_required", async () => {
  const g = new Guard(new FakeJevProvider(answer({ riskScore: 0.85, kindConfidence: 0.2 })));
  const r = await g.decide({ task: "refactor the shared module" });
  assert.equal(r.mode, "approval_required");
});

test("routing: medium-risk + low confidence -> plan_first", async () => {
  const g = new Guard(new FakeJevProvider(answer({ riskScore: 0.6, kindConfidence: 0.2 })));
  const r = await g.decide({ task: "refactor the shared module" });
  assert.equal(r.mode, "plan_first");
});

test("routing: low-risk + high confidence -> execute", async () => {
  const g = new Guard(new FakeJevProvider(answer()));
  const r = await g.decide({ task: "add a unit test" });
  assert.equal(r.mode, "execute");
});

test("routing: security-sensitive + low confidence -> approval_required", async () => {
  const g = new Guard(
    new FakeJevProvider(answer({ securityReviewNoul: 0.9, kindConfidence: 0.2 })),
  );
  const r = await g.decide({ task: "adjust the shared formatting helper" });
  assert.equal(r.mode, "approval_required");
  assert.ok(r.reasons.some((x) => x.code === "RC-SECURITY-LOW-CONF-APPROVAL"));
});

test("routing: security-sensitive + high confidence -> plan_first (no escalation)", async () => {
  // Wording chosen to trigger NO hard-policy rule, so composition is isolated.
  const g = new Guard(new FakeJevProvider(answer({ securityReviewNoul: 0.9 })));
  const r = await g.decide({ task: "adjust the shared formatting helper" });
  assert.equal(r.mode, "plan_first");
  assert.ok(!r.reasons.some((x) => x.code === "RC-SECURITY-LOW-CONF-APPROVAL"));
});

test("routing: irreversible + low confidence -> approval_required", async () => {
  const g = new Guard(
    new FakeJevProvider(answer({ riskFactors: ["irreversible"], riskConfidence: 0.2 })),
  );
  const r = await g.decide({ task: "adjust a data handling helper" });
  assert.equal(r.mode, "approval_required");
});

// ---------------------------------------------------------------------------
// Invariants preserved
// ---------------------------------------------------------------------------

test("routing: low confidence alone never reaches block", async () => {
  const g = new Guard(new FakeJevProvider(answer({ kindConfidence: 0, riskConfidence: 0 })));
  const r = await g.decide({ task: "add a unit test" });
  assert.notEqual(r.mode, "block");
});

test("routing: hard-policy block is never downgraded by composition", async () => {
  // A destructive command blocks preflight; composition never even runs.
  const g = new Guard(new FakeJevProvider(answer({ riskScore: 0 })));
  const r = await g.decide({ task: "rm -rf ./dist", hints: {} });
  assert.equal(r.mode, "block");
  assert.equal(r.classification.source, "hard_policy");
});

test("routing: hard-policy approval is never downgraded to execute", async () => {
  // A low-risk model judgment must not pull an approval-required policy down.
  const g = new Guard(new FakeJevProvider(answer({ riskScore: 0, kindConfidence: 0.99 })));
  const r = await g.decide({ task: "Add a migration to introduce the events table" });
  assert.equal(r.mode, "approval_required");
  assert.equal(r.classification.source, "hard_policy");
});

test("routing: composition reason IDs appear in engine reasons", async () => {
  const g = new Guard(new FakeJevProvider(answer({ riskScore: 0.6 })));
  const r = await g.decide({ task: "refactor the shared module" });
  assert.ok(r.reasons.some((x) => x.code === "RC-RISK-PLAN"), "composition reason surfaced");
});

test("routing: provider failure still falls back conservatively (never execute)", async () => {
  const g = new Guard(new FakeJevProvider({}, true));
  const r = await g.decide({ task: "add a unit test" });
  assert.equal(r.fellBack, true);
  assert.notEqual(r.mode, "execute");
});

test("normalizeRiskFactors: design token stylesheet strips misleading unclear/destructive", () => {
  const input = {
    task: "Rename the design token color variables in the stylesheet",
    hints: { touchedFiles: ["web/tokens.css"] },
  };
  const factors = normalizeRiskFactors(input, ["destructive", "unclear", "security"]);
  assert.deepEqual(factors, ["security"]);
  assert.deepEqual(sanitizeMisleadingRiskFactors(input, ["unclear"]), []);
});

test("routing: design token counterexample stays execute despite unclear factor", async () => {
  const g = new Guard(
    new FakeJevProvider(
      answer({
        riskScore: 0.35,
        kindConfidence: 0.95,
        riskConfidence: 0.9,
        riskFactors: ["destructive", "unclear"],
      }),
    ),
  );
  const r = await g.decide({
    task: "Rename the design token color variables in the stylesheet",
    hints: { touchedFiles: ["web/tokens.css"] },
  });
  assert.equal(r.mode, "execute");
  assert.ok(!r.risk.factors.includes("unclear"));
  assert.ok(!r.reasons.some((x) => x.code === "RC-UNCLEAR-PLAN"));
});

test("routing: design token counterexample ignores sub-threshold risk confidence jitter", async () => {
  const g = new Guard(
    new FakeJevProvider(
      answer({
        riskScore: 0.13,
        kindConfidence: 1,
        riskConfidence: 0.57,
        riskFactors: [],
      }),
    ),
  );
  const r = await g.decide({
    task: "Rename the design token color variables in the stylesheet",
    hints: { touchedFiles: ["web/tokens.css"] },
  });
  assert.equal(r.mode, "execute");
  assert.ok(!r.reasons.some((x) => x.code === "LOW-CONF"));
});

test("routing: broad multi-module refactor -> plan_first via deterministic scope", async () => {
  const g = new Guard(
    new FakeJevProvider(
      answer({ riskScore: 0.37, kindConfidence: 0.6, riskConfidence: 0.89, riskFactors: [] }),
    ),
  );
  const r = await g.decide({
    task: "Refactor the shared data layer across several modules",
    hints: { touchedFiles: ["src/data/index.ts", "src/data/store.ts"] },
  });
  assert.equal(r.mode, "plan_first");
  assert.ok(r.reasons.some((x) => x.code === "RC-SCOPE-PLAN"));
});

test("routing: composition agrees with the engine for the same signals", async () => {
  const signals = { riskScore: 0.6, riskConfidence: 0.2, kindConfidence: 0.2, securityNoul: 0.05, factors: [] };
  const composed = composeRiskAction(signals, {
    lowConfidenceThreshold: 0.6,
    planRiskThreshold: 0.5,
    approvalRiskThreshold: 0.8,
    securityReviewThreshold: 0.7,
  });
  const g = new Guard(new FakeJevProvider(answer(signals)));
  const r = await g.decide({ task: "refactor the shared module" });
  assert.equal(r.mode, composed.action, "engine mode matches the composition layer");
});
