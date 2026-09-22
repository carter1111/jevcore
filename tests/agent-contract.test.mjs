/**
 * T02 — Agent Contract types + locale templates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  agentStatusFromExecutionMode,
  resolveAgentLocale,
  statusHeadline,
  buildNextActions,
  buildAgentResultFromExecutionMode,
  yourCallBeyondAuthSummary,
} from "../dist/agent/index.js";

describe("agentStatusFromExecutionMode", () => {
  it("maps four execution modes to four agent statuses", () => {
    assert.equal(agentStatusFromExecutionMode("execute"), "advance");
    assert.equal(agentStatusFromExecutionMode("plan_first"), "pave_way");
    assert.equal(agentStatusFromExecutionMode("approval_required"), "your_call");
    assert.equal(agentStatusFromExecutionMode("block"), "safer_path");
  });
});

describe("resolveAgentLocale", () => {
  it("defaults to en", () => {
    assert.equal(resolveAgentLocale(undefined), "en");
    assert.equal(resolveAgentLocale(""), "en");
    assert.equal(resolveAgentLocale("en-US"), "en");
  });
  it("accepts zh variants", () => {
    assert.equal(resolveAgentLocale("zh"), "zh");
    assert.equal(resolveAgentLocale("zh-CN"), "zh");
  });
});

describe("templates EN/ZH", () => {
  it("returns bilingual status headlines", () => {
    assert.match(statusHeadline("en", "advance"), /advance/i);
    assert.match(statusHeadline("zh", "advance"), /推进/);
    assert.match(statusHeadline("zh", "safer_path"), /安全|换/);
  });
  it("your_call copy mentions authorization", () => {
    assert.match(yourCallBeyondAuthSummary("en", "productionDeploy"), /authorization/);
    assert.match(yourCallBeyondAuthSummary("zh", "productionDeploy"), /授权/);
  });
  it("builds next actions for each status", () => {
    const advance = buildNextActions("en", "advance");
    assert.equal(advance[0]?.id, "continue");
    const yc = buildNextActions("zh", "your_call");
    assert.ok(yc.some((a) => a.id === "approve_once"));
    assert.ok(yc.some((a) => a.id === "approve_session"));
  });
});

describe("buildAgentResultFromExecutionMode", () => {
  it("produces agent + valueReceipt without LLM", () => {
    const bundle = buildAgentResultFromExecutionMode("execute", {
      locale: "en",
      evidence: { providerCalled: false, hardPolicyShortCircuit: true },
      modelAdviceTier: "fast",
    });
    assert.equal(bundle.agent.status, "advance");
    assert.equal(bundle.agent.valueReceipt.did.some((d) => d.kind === "precheck"), true);
    assert.equal(bundle.agent.modelAdvice?.hostAutoApplied, false);
    assert.equal(bundle.agent.modelAdvice?.tier, "fast");
  });
});
