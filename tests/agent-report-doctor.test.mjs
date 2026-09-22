/**
 * T12 — agent report / doctor / suggest.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  formatAgentNarrative,
  inferEnforcementLevel,
  scanLearnedSuggestions,
  formatSuggestions,
} from "../dist/agent/index.js";
import { createDefaultProfile } from "../dist/profile/index.js";
import { PreferencesMemory } from "../dist/memory/index.js";

const emptyModel = {
  period: "7d",
  sinceIso: null,
  guardDecisions: 3,
  jevProviderCalls: 1,
  hardPolicyShortCircuits: 1,
  outcomes: { execute: 1, plan_first: 1, approval_required: 0, block: 1 },
  safetyActions: {},
  hardBlocksWithProviderCalls: 0,
  providerFallbacks: 0,
  boundaryFallbacks: 0,
  guardP50Ms: 10,
  guardP95Ms: 20,
  providerP50Ms: 100,
  providerP95Ms: 200,
  jevInputTokens: 50,
  jevOutputTokens: 10,
  estimatedCostUsd: 0.001,
  pricingBasis: "test",
  decisionsStored: 3,
  dateRange: { from: null, to: null },
  databaseBytes: 100,
  advisoryBytes: 1,
  storageAdvisory: "ok",
  telemetryWriteErrors: 0,
  totalAgentTokenSavings: "not_enough_controlled_evidence",
};

describe("formatAgentNarrative", () => {
  it("EN narrative has prove-only language and no host savings claim", () => {
    const text = formatAgentNarrative(emptyModel, {
      locale: "en",
      activeSessionGrants: 2,
      pendingSuggestions: 0,
    });
    assert.match(text, /Advances/);
    assert.match(text, /do not claim/i);
    assert.doesNotMatch(text, /saved \d+ (minutes|hours)/i);
    assert.doesNotMatch(text, /host (LLM )?token savings were/i);
  });

  it("ZH narrative is present", () => {
    const text = formatAgentNarrative(emptyModel, { locale: "zh" });
    assert.match(text, /推进|铺路|安全路径/);
  });
});

describe("inferEnforcementLevel", () => {
  it("maps hook / mcp / evidence honesty", () => {
    assert.equal(
      inferEnforcementLevel({
        claudeHookPresent: true,
        mcpDistPresent: true,
        evidenceEnabled: true,
      }),
      "Guided",
    );
    assert.equal(
      inferEnforcementLevel({
        claudeHookPresent: false,
        mcpDistPresent: true,
        evidenceEnabled: false,
      }),
      "Advisory",
    );
  });
});

describe("scanLearnedSuggestions", () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("records pending suggestions but never auto-applies", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-sug-"));
    dirs.push(dir);
    const mem = new PreferencesMemory({ databasePath: join(dir, "preferences.sqlite") });
    const profile = createDefaultProfile();
    profile.delegation.localDevDatabase = "ask";
    profile.learning.suggestAfterRepeatedPattern = 3;

    for (let i = 0; i < 3; i++) {
      mem.recordPreferenceEvent({
        category: "localDevDatabase",
        decisionMode: "your_call",
        userAction: "approve_session",
        scope: "session",
        sessionId: "s",
      });
    }

    const result = scanLearnedSuggestions({ memory: mem, profile, threshold: 3 });
    assert.equal(result.autoApplied, false);
    assert.ok(result.created.length >= 1);
    assert.equal(result.created[0].category, "localDevDatabase");
    assert.equal(profile.delegation.localDevDatabase, "ask", "profile unchanged");

    const text = formatSuggestions(result, "en");
    assert.match(text, /never auto-write/i);
    assert.match(text, /autoApplied: false/);
    mem.close();
  });
});
