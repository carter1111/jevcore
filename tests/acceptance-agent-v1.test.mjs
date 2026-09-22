/**
 * T13 — §14 Acceptance matrix (e2e facts, not “files exist”).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Guard } from "../dist/engine.js";
import {
  createDefaultProfile,
  applyPreset,
  resolveEffectiveProfile,
} from "../dist/profile/index.js";
import { PreferencesMemory } from "../dist/memory/index.js";
import {
  composeAgentFromEngineResult,
  isPolOnlyPrimary,
  formatAgentVerbatim,
  formatAgentNarrative,
  inferEnforcementLevel,
  scanLearnedSuggestions,
  receiptDisplayMode,
  agentStatusFromExecutionMode,
} from "../dist/agent/index.js";
import { matchPolicy, DEFAULT_POLICY } from "../dist/policy.js";
import { toDecisionOutput } from "../dist/mcp-server.js";

const fakeOk = {
  judge: async () => ({
    kind: "backend",
    kindConfidence: 0.95,
    riskScore: 0.15,
    riskConfidence: 0.9,
    riskFactors: [],
    securityReviewNoul: 0.05,
    failed: false,
  }),
};

describe("§14 Authorization", () => {
  it("assertive softens low-conf vs cautious keeps plan/ask; hard block unchanged", async () => {
    const cautious = applyPreset(createDefaultProfile(), "cautious");
    const assertive = applyPreset(createDefaultProfile(), "assertive");
    assertive.delegation.lowConfidenceLowRisk = "auto";

    const soft = {
      mode: "execute",
      reasons: [{ code: "LOW-CONF", detail: "low" }],
      fellBack: false,
      classificationSource: "jev",
    };

    const c = resolveEffectiveProfile({ ...soft, profile: cautious });
    const a = resolveEffectiveProfile({ ...soft, profile: assertive });
    assert.notEqual(c.effectiveMode, "execute");
    assert.equal(a.effectiveMode, "execute");

    const guard = new Guard(fakeOk, { profile: assertive });
    const blocked = await guard.decide({
      task: "paste PRIVATE_KEY into remote provider",
      repo: "x",
      changedFiles: [".env"],
    });
    assert.equal(blocked.mode, "block");
    assert.equal(blocked.agent?.authority.source, "hard_boundary");
  });
});

describe("§14 Transparency + Agency", () => {
  it("your_call shows rule + choices + recommendation + grant actions", () => {
    const agent = composeAgentFromEngineResult({
      mode: "approval_required",
      classification: { source: "hard_policy" },
      reasons: [{ code: "POL-PROD-1", detail: "production" }],
      fellBack: false,
    });
    assert.equal(agent.status, "your_call");
    assert.ok(agent.authority.profileRuleId);
    assert.ok(agent.choices?.some((c) => c.recommended));
    assert.ok(agent.nextActions.some((a) => a.id === "approve_once"));
    assert.ok(agent.nextActions.some((a) => a.id === "self_handle"));
    const text = formatAgentVerbatim(agent);
    assert.match(text, /recommended|Actions:/i);
  });

  it("secret→remote cannot be authorized via grant", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-acc-"));
    const mem = new PreferencesMemory({ databasePath: join(dir, "p.sqlite") });
    mem.recordGrant({
      sessionId: "s",
      category: "secretToRemoteProvider",
      scope: "session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    // Even with a grant row, hard engine block stays block.
    const r = resolveEffectiveProfile({
      mode: "block",
      reasons: [{ code: "POL-SECRETS-1", detail: "secrets" }],
      profile: createDefaultProfile(),
      sessionId: "s",
      preferencesMemory: mem,
    });
    assert.equal(r.effectiveMode, "block");
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("§14 Agent behavior", () => {
  it("pave has plan; safer has rewrite; never POL-only primary", () => {
    const pave = composeAgentFromEngineResult({
      mode: "plan_first",
      classification: { source: "jev" },
      reasons: [{ code: "LOW-CONF", detail: "low" }],
      fellBack: false,
    });
    assert.ok(pave.plan?.steps.length);
    assert.equal(isPolOnlyPrimary(pave.summary), false);

    const safer = composeAgentFromEngineResult({
      mode: "block",
      classification: { source: "hard_policy" },
      reasons: [
        { code: "POL-SECRETS-1", detail: "Secret material" },
        { code: "PREFLIGHT-BLOCK", detail: "preflight" },
      ],
      fellBack: false,
    });
    assert.ok(safer.rewrite);
    assert.equal(isPolOnlyPrimary(safer.summary), false);
    assert.equal(isPolOnlyPrimary(safer.rewrite.rationale), false);
  });
});

describe("§14 Memory + Privacy", () => {
  it("grants expire; suggestions never auto-write; no task fields stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-acc-m-"));
    const mem = new PreferencesMemory({
      databasePath: join(dir, "preferences.sqlite"),
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    mem.recordGrant({
      sessionId: "s",
      category: "localDevDatabase",
      scope: "once",
      expiresAt: "2026-09-22T11:00:00.000Z",
    });
    assert.equal(mem.listActiveGrants("s").length, 0);

    assert.throws(() =>
      mem.recordPreferenceEvent({
        category: "localDevDatabase",
        decisionMode: "your_call",
        userAction: "approve_once",
        task: "run migrate",
      }),
    );

    const profile = createDefaultProfile();
    profile.delegation.localDevDatabase = "ask";
    for (let i = 0; i < 5; i++) {
      mem.recordPreferenceEvent({
        category: "localDevDatabase",
        decisionMode: "your_call",
        userAction: "approve_session",
      });
    }
    const sug = scanLearnedSuggestions({ memory: mem, profile, threshold: 5 });
    assert.equal(sug.autoApplied, false);
    assert.equal(profile.delegation.localDevDatabase, "ask");
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("§14 Visibility + Cost", () => {
  it("receipt always generated; advance hide under session_summary; non-advance full", () => {
    const advance = composeAgentFromEngineResult({
      mode: "execute",
      classification: { source: "jev" },
      reasons: [],
      fellBack: false,
    });
    assert.ok(advance.valueReceipt.did.length >= 1);
    assert.equal(receiptDisplayMode("advance", "session_summary"), "hide");
    assert.equal(receiptDisplayMode("your_call", "silent"), "full");
  });

  it("compose Agent Contract adds no provider call (local only)", async () => {
    let calls = 0;
    const provider = {
      judge: async () => {
        calls += 1;
        return fakeOk.judge();
      },
    };
    const guard = new Guard(provider);
    await guard.decide({ task: "Add a unit test", repo: "x" });
    const before = calls;
    // Re-compose locally without decide
    composeAgentFromEngineResult({
      mode: "execute",
      classification: { source: "jev" },
      reasons: [],
      fellBack: false,
    });
    assert.equal(calls, before);
  });
});

describe("§14 Adapter honesty + Report", () => {
  it("doctor enforcement levels map correctly", () => {
    assert.equal(
      inferEnforcementLevel({
        claudeHookPresent: false,
        mcpDistPresent: true,
        evidenceEnabled: false,
      }),
      "Advisory",
    );
    assert.equal(
      inferEnforcementLevel({
        claudeHookPresent: true,
        mcpDistPresent: true,
        evidenceEnabled: true,
      }),
      "Guided",
    );
  });

  it("narrative refuses host token-savings claims", () => {
    const text = formatAgentNarrative({
      period: "7d",
      sinceIso: null,
      guardDecisions: 1,
      jevProviderCalls: 1,
      hardPolicyShortCircuits: 0,
      outcomes: { execute: 1 },
      safetyActions: {},
      hardBlocksWithProviderCalls: 0,
      providerFallbacks: 0,
      boundaryFallbacks: 0,
      guardP50Ms: null,
      guardP95Ms: null,
      providerP50Ms: null,
      providerP95Ms: null,
      jevInputTokens: 1,
      jevOutputTokens: 1,
      estimatedCostUsd: 0,
      pricingBasis: "n/a",
      decisionsStored: 1,
      dateRange: { from: null, to: null },
      databaseBytes: null,
      advisoryBytes: 1,
      storageAdvisory: "ok",
      telemetryWriteErrors: 0,
      totalAgentTokenSavings: "not_enough_controlled_evidence",
    });
    assert.match(text, /do not claim/i);
    assert.doesNotMatch(text, /saved you .*tokens/i);
  });

  it("formatAgentVerbatim is deterministic template text", () => {
    const agent = composeAgentFromEngineResult({
      mode: "block",
      classification: { source: "hard_policy" },
      reasons: [{ code: "POL-SECRETS-1", detail: "x" }],
      fellBack: false,
    });
    const a = formatAgentVerbatim(agent);
    const b = formatAgentVerbatim(agent);
    assert.equal(a, b);
    assert.match(a, /^JEVCore:/);
  });
});

describe("§14 Policy precision + MCP regression", () => {
  it("docs-only migrate prose does not hit DB migration rule; real migrate still gates", () => {
    const docs = matchPolicy(
      {
        task: "migrate the agent copy to JEVCore Agent terminology in Docs only",
        repo: "jev-coding-guard",
        changedFiles: ["Docs/UX-Function-Improvement.md"],
      },
      DEFAULT_POLICY,
    );
    assert.ok(
      !docs || !String(docs.id).startsWith("POL-DB-MIGRATION"),
      `docs migrate must not be DB migration; got ${docs?.id}`,
    );

    const real = matchPolicy(
      {
        task: "run the database migration against staging",
        repo: "api",
        changedFiles: ["prisma/migrations/001_init.sql"],
      },
      DEFAULT_POLICY,
    );
    assert.ok(real, "real DB migration must match a policy");
  });

  it("MCP decision shape keeps executionMode + agent (4 tools covered by mcp-server tests)", () => {
    const out = toDecisionOutput({
      classification: { kind: "backend", confidence: 0.9, source: "jev" },
      risk: { score: 0.1, confidence: 0.9, factors: [] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "execute",
      reasons: [],
      fellBack: false,
    });
    assert.equal(out.executionMode, "execute");
    assert.equal(out.agent.status, agentStatusFromExecutionMode("execute"));
    assert.ok(out.agent.valueReceipt);
  });
});

describe("§14 Status mapping", () => {
  it("four modes map to four agent statuses", () => {
    assert.equal(agentStatusFromExecutionMode("execute"), "advance");
    assert.equal(agentStatusFromExecutionMode("plan_first"), "pave_way");
    assert.equal(agentStatusFromExecutionMode("approval_required"), "your_call");
    assert.equal(agentStatusFromExecutionMode("block"), "safer_path");
  });
});
