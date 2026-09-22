/**
 * P4 Preflight Router — deterministic recommendations from existing signals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import { recommendRouting } from "../dist/routing.js";
import { toDecisionOutput } from "../dist/mcp-server.js";

const fakeOk = {
  judge: async () => ({
    kind: "frontend",
    kindConfidence: 0.95,
    riskScore: 0.1,
    riskConfidence: 0.9,
    riskFactors: [],
    securityReviewNoul: 0.05,
    failed: false,
  }),
};

describe("recommendRouting (pure)", () => {
  it("small/fast for low-risk execute frontend", () => {
    const r = recommendRouting({
      classification: { kind: "frontend", confidence: 0.95, source: "jev" },
      risk: { score: 0.1, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0.05, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
    });
    assert.ok(r);
    assert.equal(r.complexity, "small");
    assert.equal(r.recommendedModelTier, "fast");
    assert.equal(r.recommendedContextBudget, "small");
    assert.equal(r.planFirst, false);
    assert.deepEqual(r.recommendedSkillBundle, ["frontend"]);
    assert.equal(r.source, "deterministic");
  });

  it("large/reasoning for block", () => {
    const r = recommendRouting({
      classification: { kind: "general", confidence: 0, source: "hard_policy" },
      risk: { score: 1, confidence: 0, factors: ["destructive"] },
      security: { reviewNeeded: false, noul: 1, findings: [] },
      mode: "block",
      reasons: [],
      fellBack: false,
    });
    assert.ok(r);
    assert.equal(r.complexity, "large");
    assert.equal(r.recommendedModelTier, "reasoning");
    assert.equal(r.planFirst, true);
  });

  it("adds security skill when reviewNeeded", () => {
    const r = recommendRouting({
      classification: { kind: "backend", confidence: 0.8, source: "jev" },
      risk: { score: 0.5, confidence: 0.8, factors: ["security"] },
      security: { reviewNeeded: true, noul: 0.8, findings: ["x"] },
      mode: "approval_required",
      reasons: [],
      fellBack: false,
    });
    assert.ok(r);
    assert.ok(r.recommendedSkillBundle.includes("backend"));
    assert.ok(r.recommendedSkillBundle.includes("security"));
    assert.equal(r.planFirst, true);
  });

  it("returns null for incomplete signals (omit — no fabricate)", () => {
    assert.equal(
      recommendRouting({
        classification: { kind: "frontend", confidence: NaN, source: "jev" },
        risk: { score: 0.1, confidence: 0.9, factors: [] },
        security: { reviewNeeded: false, noul: 0, findings: [] },
        mode: "execute",
        reasons: [],
        fellBack: false,
      }),
      null,
    );
  });
});

describe("Guard.decide attaches routing", () => {
  it("additive routing on normal path; core fields unchanged", async () => {
    const g = new Guard(fakeOk);
    const r = await g.decide({ task: "Add a button label to a React homepage" });
    assert.equal(r.mode, "execute");
    assert.equal(r.classification.kind, "frontend");
    assert.ok(r.routing);
    assert.equal(r.routing.source, "deterministic");
    assert.equal(r.routing.complexity, "small");
    assert.ok(r.modelSelection);
    assert.equal(r.modelSelection.source, "harness");
    assert.equal(r.modelSelection.tier, r.routing.recommendedModelTier);
  });

  it("hard-policy block still short-circuits provider and still gets routing", async () => {
    let calls = 0;
    const g = new Guard({
      judge: async () => {
        calls += 1;
        return {
          kind: "general",
          kindConfidence: 0.9,
          riskScore: 0.1,
          riskConfidence: 0.9,
          riskFactors: [],
          securityReviewNoul: 0,
          failed: false,
        };
      },
    });
    const r = await g.decide({ task: "cat .env" });
    assert.equal(calls, 0, "provider must not be called");
    assert.equal(r.mode, "block");
    assert.equal(r.classification.source, "hard_policy");
    assert.ok(r.routing);
    assert.equal(r.routing.complexity, "large");
  });
});

describe("MCP toDecisionOutput routing", () => {
  it("includes routing when present on EngineResult", () => {
    const out = toDecisionOutput({
      classification: { kind: "frontend", confidence: 0.9, source: "jev" },
      risk: { score: 0.1, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
      routing: {
        complexity: "small",
        recommendedModelTier: "fast",
        recommendedContextBudget: "small",
        recommendedSkillBundle: ["frontend"],
        planFirst: false,
        source: "deterministic",
      },
    });
    assert.equal(out.taskDomain, "frontend");
    assert.equal(out.executionMode, "execute");
    assert.ok(out.routing);
    assert.equal(out.routing.recommendedModelTier, "fast");
  });

  it("includes advisory modelSelection when present", () => {
    const out = toDecisionOutput({
      classification: { kind: "frontend", confidence: 0.9, source: "jev" },
      risk: { score: 0.1, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
      routing: {
        complexity: "small",
        recommendedModelTier: "fast",
        recommendedContextBudget: "small",
        recommendedSkillBundle: ["frontend"],
        planFirst: false,
        source: "deterministic",
      },
      modelSelection: {
        version: "2026-09-21.1",
        modelId: "harness-fast",
        tier: "fast",
        contextBudget: "small",
        planFirst: false,
        costWeight: 1,
        latencyWeight: 1,
        source: "harness",
      },
    });
    assert.ok(out.modelSelection);
    assert.equal(out.modelSelection.modelId, "harness-fast");
    assert.equal(out.modelSelection.source, "harness");
    assert.equal("costWeight" in out.modelSelection, false, "eval weights stay off MCP");
  });

  it("omits routing on boundary fallback (invalid decision)", () => {
    const out = toDecisionOutput({
      classification: { kind: "frontend", confidence: 0.9, source: "jev" },
      risk: { score: 99, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
      routing: {
        complexity: "small",
        recommendedModelTier: "fast",
        recommendedContextBudget: "small",
        recommendedSkillBundle: [],
        planFirst: false,
        source: "deterministic",
      },
    });
    assert.equal(out.executionMode, "plan_first");
    assert.equal(out.routing, undefined);
  });
});
