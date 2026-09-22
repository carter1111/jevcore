/**
 * T04 — agent field on engine + MCP decision output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import { toDecisionOutput } from "../dist/mcp-server.js";
import { agentStatusFromExecutionMode } from "../dist/agent/index.js";

const fakeOk = {
  judge: async () => ({
    kind: "backend",
    kindConfidence: 0.95,
    riskScore: 0.2,
    riskConfidence: 0.9,
    riskFactors: [],
    securityReviewNoul: 0.05,
    failed: false,
  }),
};

describe("engine attaches agent", () => {
  it("decide() always includes agent mapped from mode", async () => {
    const guard = new Guard(fakeOk);
    const r = await guard.decide({
      task: "Add a unit test for a pure helper",
      repo: "jev-coding-guard",
    });
    assert.ok(r.agent);
    assert.equal(r.agent.status, agentStatusFromExecutionMode(r.mode));
    assert.ok(r.agent.valueReceipt.did.length >= 1);
    // when_not_fast may omit advice on fast paths; if present, never auto-applied.
    if (r.agent.modelAdvice) {
      assert.equal(r.agent.modelAdvice.hostAutoApplied, false);
    }
  });

  it("hard preflight block still attaches safer_path agent", async () => {
    const guard = new Guard({
      judge: async () => {
        throw new Error("provider must not run");
      },
    });
    // Match existing hard-policy fixtures (secrets / destructive) — T01 owns policy.ts.
    const r = await guard.decide({
      task: "Commit the .env file with the production PRIVATE_KEY and seed phrase",
      repo: "jev-coding-guard",
      changedFiles: [".env"],
    });
    assert.equal(r.mode, "block");
    assert.equal(r.agent?.status, "safer_path");
    assert.equal(r.agent?.valueReceipt.evidence.hardPolicyShortCircuit, true);
    assert.equal(r.agent?.valueReceipt.evidence.providerCalled, false);
  });
});

describe("toDecisionOutput agent", () => {
  it("always emits agent alongside executionMode", () => {
    const out = toDecisionOutput({
      classification: { kind: "frontend", confidence: 0.9, source: "jev" },
      risk: { score: 0.1, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
    });
    assert.equal(out.executionMode, "execute");
    assert.equal(out.agent.status, "advance");
    assert.ok(out.agent.valueReceipt);
    assert.equal(out.agent.nextActions[0]?.id, "continue");
  });

  it("maps approval_required → your_call", () => {
    const out = toDecisionOutput({
      classification: { kind: "devops", confidence: 0.8, source: "hard_policy" },
      risk: { score: 0.7, confidence: 0.8, factors: [] },
      security: { reviewNeeded: true, noul: 0.8, findings: [] },
      mode: "approval_required",
      reasons: [{ code: "POL-PROD-1", detail: "production change" }],
      fellBack: false,
    });
    assert.equal(out.agent.status, "your_call");
    assert.equal(out.agent.authority.profileRuleId, "POL-PROD-1");
  });

  it("boundary fallback still includes agent", () => {
    const out = toDecisionOutput({
      classification: { kind: "frontend", confidence: 0.9, source: "jev" },
      risk: { score: 99, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
    });
    assert.equal(out.executionMode, "plan_first");
    assert.equal(out.agent.status, "pave_way");
  });

  it("rebuilds agent when stale status contradicts executionMode", () => {
    const out = toDecisionOutput({
      classification: { kind: "devops", confidence: 0, source: "rule" },
      risk: { score: 1, confidence: 0, factors: ["unclear"] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "approval_required",
      reasons: [
        { code: "PROVIDER-FAIL", detail: "Model provider unavailable" },
        { code: "FAIL-SAFE", detail: "escalated" },
      ],
      fellBack: true,
      agent: {
        status: "pave_way",
        summary: "stale",
        headline: "stale",
        authority: {
          source: "engine_uncertainty",
          userCanOverride: true,
          allowedScopes: [],
        },
        facts: [],
        nextActions: [{ id: "start_now", label: "Start now", enabled: true }],
        valueReceipt: {
          locale: "en",
          headline: "stale",
          did: [{ kind: "paved", steps: 0 }],
          evidence: { providerCalled: true, hardPolicyShortCircuit: false },
        },
      },
    });
    assert.equal(out.executionMode, "approval_required");
    assert.equal(out.agent.status, "your_call");
    assert.ok(out.agent.nextActions.some((a) => a.id === "approve_once"));
    assert.equal(
      out.agent.nextActions.some((a) => a.id === "start_now"),
      false,
    );
    assert.ok(out.agent.facts.some((f) => f.code === "FAIL-SAFE"));
  });
});
