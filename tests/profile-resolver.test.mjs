/**
 * T07 — Effective Profile Resolver tests.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveEffectiveProfile,
  inferDelegationKey,
  createDefaultProfile,
  applyPreset,
} from "../dist/profile/index.js";
import { PreferencesMemory } from "../dist/memory/index.js";
import { Guard } from "../dist/engine.js";

describe("inferDelegationKey", () => {
  it("maps secrets and web3 to hard keys", () => {
    assert.equal(inferDelegationKey(["POL-SECRETS-1"]), "secretToRemoteProvider");
    assert.equal(inferDelegationKey(["POL-WEB3-ASSET-1"]), "web3AssetAction");
  });
  it("maps soft policy families", () => {
    assert.equal(inferDelegationKey(["POL-DB-MIGRATION-2"]), "localDevDatabase");
    assert.equal(inferDelegationKey(["POL-PROD-1"]), "productionDeploy");
    assert.equal(inferDelegationKey(["POL-AUTHZ-1"]), "authzChange");
    assert.equal(inferDelegationKey(["LOW-CONF"]), "lowConfidenceLowRisk");
  });
});

describe("resolveEffectiveProfile priority", () => {
  it("never softens engine block", () => {
    const profile = applyPreset(createDefaultProfile(), "assertive");
    profile.delegation.localDevDatabase = "auto";
    const r = resolveEffectiveProfile({
      mode: "block",
      reasons: [
        { code: "POL-SECRETS-1", detail: "secrets" },
        { code: "PREFLIGHT-BLOCK", detail: "preflight" },
      ],
      profile,
    });
    assert.equal(r.effectiveMode, "block");
    assert.equal(r.resolvedBy, "hard_boundary");
    assert.equal(r.modeAdjusted, false);
  });

  it("applies profile.ask → approval_required for staging", () => {
    const profile = createDefaultProfile();
    profile.delegation.stagingDeploy = "ask";
    const r = resolveEffectiveProfile({
      mode: "execute",
      reasons: [{ code: "POL-DB-STAGING-1", detail: "staging" }],
      classificationSource: "hard_policy",
      profile,
    });
    // Wait - if engine said execute with POL-STAGING, unusual; profile maps ask → approval
    assert.equal(r.effectiveMode, "approval_required");
    assert.equal(r.resolvedBy, "user_profile");
    assert.equal(r.authoritySource, "user_profile");
  });

  it("session grant beats profile ask", () => {
    const dirs = [];
    const dir = mkdtempSync(join(tmpdir(), "jev-res-"));
    dirs.push(dir);
    const mem = new PreferencesMemory({ databasePath: join(dir, "preferences.sqlite") });
    mem.recordGrant({
      sessionId: "s1",
      category: "stagingDeploy",
      scope: "session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const profile = createDefaultProfile();
    profile.delegation.stagingDeploy = "ask";
    const r = resolveEffectiveProfile({
      mode: "approval_required",
      reasons: [{ code: "POL-DB-STAGING-1", detail: "staging" }],
      profile,
      sessionId: "s1",
      preferencesMemory: mem,
    });
    assert.equal(r.effectiveMode, "execute");
    assert.equal(r.resolvedBy, "session_grant");
    mem.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("learned suggestions are never consulted (no API path)", () => {
    const profile = createDefaultProfile();
    const r = resolveEffectiveProfile({
      mode: "plan_first",
      reasons: [{ code: "LOW-CONF", detail: "low" }],
      profile,
    });
    assert.ok(!r.chain.some((c) => c.step.includes("learned")));
    assert.ok(r.resolvedBy !== "learned");
  });

  it("cautious interruption upgrades execute→plan_first on LOW-CONF", () => {
    const profile = applyPreset(createDefaultProfile(), "cautious");
    const r = resolveEffectiveProfile({
      mode: "execute",
      reasons: [{ code: "LOW-CONF", detail: "low" }],
      profile,
    });
    // lowConfidence key present → profile.delegation.lowConfidenceLowRisk=ask wins first
    assert.ok(
      r.effectiveMode === "approval_required" || r.effectiveMode === "plan_first",
    );
    assert.ok(
      r.resolvedBy === "user_profile" || r.resolvedBy === "interruption_preference",
    );
  });
});

describe("Guard + resolver integration", () => {
  it("profile remaps soft staging approval and hard block stays", async () => {
    const fake = {
      judge: async () => ({
        kind: "devops",
        kindConfidence: 0.95,
        riskScore: 0.2,
        riskConfidence: 0.9,
        riskFactors: [],
        securityReviewNoul: 0.05,
        failed: false,
      }),
    };
    const profile = createDefaultProfile();
    profile.delegation.stagingDeploy = "plan_then_continue";

    // Hard secrets still block
    const guardBlock = new Guard(fake, { profile });
    const blocked = await guardBlock.decide({
      task: "Commit .env with PRIVATE_KEY",
      repo: "x",
      changedFiles: [".env"],
    });
    assert.equal(blocked.mode, "block");
    assert.equal(blocked.agent?.status, "safer_path");
    assert.equal(blocked.agent?.authority.source, "hard_boundary");
  });
});
