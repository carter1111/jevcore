/**
 * T10 — safer_path rewrite: data vs delegation; never POL-only primary.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSaferPathPayload,
  classifySaferBoundary,
  isPolOnlyPrimary,
  composeAgentFromEngineResult,
} from "../dist/agent/index.js";

describe("classifySaferBoundary", () => {
  it("maps secrets / web3 / pii to data", () => {
    assert.equal(classifySaferBoundary(["POL-SECRETS-1", "PREFLIGHT-BLOCK"]), "data");
    assert.equal(classifySaferBoundary(["POL-WEB3-ASSET-1"]), "data");
    assert.equal(classifySaferBoundary(["POL-PII-EGRESS-1"]), "data");
    assert.equal(classifySaferBoundary(["POL-CI-SECRETS-2"]), "data");
  });
  it("maps destructive / force-push / db-prod to delegation", () => {
    assert.equal(classifySaferBoundary(["POL-DESTRUCTIVE-CMD-1"]), "delegation");
    assert.equal(classifySaferBoundary(["POL-FORCE-PUSH-1"]), "delegation");
    assert.equal(classifySaferBoundary(["POL-DB-PROD-1"]), "delegation");
  });
});

describe("buildSaferPathPayload", () => {
  it("EN data copy is prose, not POL-only", () => {
    const p = buildSaferPathPayload({
      locale: "en",
      reasonCodes: ["POL-SECRETS-1", "PREFLIGHT-BLOCK"],
    });
    assert.equal(p.boundaryKind, "data");
    assert.equal(isPolOnlyPrimary(p.rationale), false);
    assert.equal(isPolOnlyPrimary(p.rewrite.suggestedTask), false);
    assert.match(p.rationale, /credential|Data boundary/i);
    assert.ok(p.rewrite.alternatives.length >= 2);
    assert.match(p.receiptDetail, /POL-SECRETS-1/);
  });

  it("ZH delegation copy", () => {
    const p = buildSaferPathPayload({
      locale: "zh",
      reasonCodes: ["POL-DESTRUCTIVE-CMD-1"],
    });
    assert.equal(p.boundaryKind, "delegation");
    assert.match(p.rationale, /委托|破坏/);
    assert.equal(isPolOnlyPrimary(p.rewrite.rationale), false);
  });
});

describe("composeAgentFromEngineResult safer_path", () => {
  it("attaches rewrite and data boundary for secrets block", () => {
    const agent = composeAgentFromEngineResult({
      mode: "block",
      classification: { source: "hard_policy" },
      reasons: [
        { code: "POL-SECRETS-1", detail: "Secret/credential material requires human handling" },
        { code: "PREFLIGHT-BLOCK", detail: "blocked before provider" },
      ],
      fellBack: false,
    });
    assert.equal(agent.status, "safer_path");
    assert.equal(agent.authority.boundaryKind, "data");
    assert.ok(agent.rewrite);
    assert.equal(isPolOnlyPrimary(agent.summary), false);
    assert.equal(isPolOnlyPrimary(agent.rewrite.rationale), false);
    assert.ok(agent.nextActions.some((a) => a.id === "use_safer_path"));
    assert.ok(agent.nextActions.some((a) => a.id === "self_handle"));
    assert.deepEqual(agent.authority.allowedScopes, []);
  });

  it("rebuilds when stale agent lacks rewrite", () => {
    const agent = composeAgentFromEngineResult({
      mode: "block",
      classification: { source: "hard_policy" },
      reasons: [{ code: "POL-FORCE-PUSH-1", detail: "force push blocked" }],
      fellBack: false,
      agent: {
        status: "safer_path",
        summary: "POL-FORCE-PUSH-1",
        headline: "POL-FORCE-PUSH-1",
        authority: {
          source: "hard_boundary",
          userCanOverride: false,
          allowedScopes: [],
        },
        facts: [],
        nextActions: [],
        valueReceipt: {
          locale: "en",
          headline: "x",
          did: [{ kind: "safer_path", detail: "POL-FORCE-PUSH-1" }],
          evidence: { providerCalled: false, hardPolicyShortCircuit: true },
        },
      },
    });
    assert.ok(agent.rewrite);
    assert.equal(agent.authority.boundaryKind, "delegation");
    assert.equal(isPolOnlyPrimary(agent.summary), false);
  });
});
