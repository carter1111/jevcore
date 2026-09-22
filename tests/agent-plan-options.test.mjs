/**
 * T08 / T09 — pave_way plan + your_call options.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPaveWayPlan,
  buildYourCallOptions,
  allowSessionGrantForRule,
  composeAgentFromEngineResult,
} from "../dist/agent/index.js";

describe("buildPaveWayPlan", () => {
  it("returns ≤5 steps with verify and rollback", () => {
    const plan = buildPaveWayPlan({
      locale: "en",
      interruptionPreference: "balanced",
      complexity: "large",
      reasonCodes: ["LOW-CONF"],
    });
    assert.ok(plan.steps.length >= 1 && plan.steps.length <= 5);
    assert.equal(plan.allowStartNow, true);
    assert.ok(plan.verify?.length);
    assert.ok(plan.rollbackHint);
  });

  it("cautious disables start_now", () => {
    const plan = buildPaveWayPlan({
      locale: "zh",
      interruptionPreference: "cautious",
      maxPlanSteps: 3,
    });
    assert.equal(plan.allowStartNow, false);
    assert.equal(plan.steps.length, 3);
  });
});

describe("buildYourCallOptions", () => {
  it("recommends safer when quality is top priority", () => {
    const yc = buildYourCallOptions({
      locale: "en",
      profileRuleId: "POL-STAGING-1",
      priorityOrder: ["project_quality", "delivery_speed"],
    });
    assert.equal(yc.choices.length, 2);
    assert.equal(yc.choices.find((c) => c.id === "B")?.recommended, true);
    assert.ok(yc.nextActions.some((a) => a.id === "approve_once"));
    assert.match(yc.touchedRuleDetail, /POL-STAGING-1/);
  });

  it("disables session grant for production rules", () => {
    assert.equal(allowSessionGrantForRule("POL-PROD-1"), false);
    const yc = buildYourCallOptions({
      locale: "zh",
      profileRuleId: "POL-PROD-1",
      allowSessionGrant: false,
      priorityOrder: ["delivery_speed"],
    });
    const session = yc.nextActions.find((a) => a.id === "approve_session");
    assert.equal(session?.enabled, false);
    assert.equal(yc.choices.find((c) => c.id === "A")?.recommended, true);
  });
});

describe("compose plan + choices", () => {
  it("plan_first attaches plan and respects start_now enablement", () => {
    const agent = composeAgentFromEngineResult(
      {
        mode: "plan_first",
        classification: { source: "jev" },
        reasons: [{ code: "LOW-CONF", detail: "low confidence" }],
        fellBack: false,
        routing: { complexity: "medium", recommendedModelTier: "reasoning" },
      },
      { interruptionPreference: "cautious" },
    );
    assert.equal(agent.status, "pave_way");
    assert.ok(agent.plan);
    assert.equal(agent.plan.allowStartNow, false);
    const start = agent.nextActions.find((a) => a.id === "start_now");
    assert.equal(start?.enabled, false);
  });

  it("approval_required attaches choices and YOUR-CALL fact", () => {
    const agent = composeAgentFromEngineResult({
      mode: "approval_required",
      classification: { source: "hard_policy" },
      reasons: [{ code: "POL-PROD-1", detail: "production change" }],
      fellBack: false,
    });
    assert.equal(agent.status, "your_call");
    assert.ok(agent.choices && agent.choices.length === 2);
    assert.ok(agent.facts.some((f) => f.code === "YOUR-CALL"));
    assert.equal(
      agent.nextActions.find((a) => a.id === "approve_session")?.enabled,
      false,
    );
  });
});
