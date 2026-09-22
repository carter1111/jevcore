/**
 * C-1 — policy coverage expansion tests (offline, no network).
 *
 * Proves the new rules fire with the expected mode, that stronger rules win
 * over weaker ones, and that narrow counterexamples do not false-trigger.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import { DEFAULT_POLICY, matchPolicy } from "../dist/policy.js";

class PermissiveFake {
  constructor() {
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    return {
      kind: "devops",
      kindConfidence: 0.99,
      riskScore: 0.05,
      riskConfidence: 0.99,
      riskFactors: [],
      securityReviewNoul: 0.01,
      failed: false,
    };
  }
}

describe("C-1 policy coverage", () => {
  it("ships the expected new rule ids in order", () => {
    const ids = DEFAULT_POLICY.map((r) => r.id);
    for (const id of [
      "POL-CI-SECRETS-1",
      "POL-CI-PRIV-1",
      "POL-CI-SECRETS-2",
      "POL-INFRA-DESTROY-1",
      "POL-PUBLISH-1",
      "POL-PII-EGRESS-1",
    ]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.ok(ids.indexOf("POL-CI-SECRETS-1") < ids.indexOf("POL-CI-SECRETS-2"));
    assert.ok(ids.indexOf("POL-CI-PRIV-1") < ids.indexOf("POL-AUTHZ-1"));
    assert.ok(ids.indexOf("POL-INFRA-DESTROY-1") < ids.indexOf("POL-INFRA-1"));
    assert.equal(DEFAULT_POLICY.length, 23);
  });

  it("POL-CI-SECRETS-1 blocks echo of ${{ secrets.X }} (provider not called)", async () => {
    const provider = new PermissiveFake();
    const g = new Guard(provider);
    const r = await g.decide({
      task: "echo ${{ secrets.NPM_TOKEN }} into the build log",
    });
    assert.equal(r.mode, "block");
    assert.equal(r.classification.source, "hard_policy");
    assert.ok(r.reasons.some((x) => x.code === "POL-CI-SECRETS-1"));
    assert.equal(provider.calls, 0);
  });

  it("POL-CI-SECRETS-1 blocks hardcoding a secret value into a workflow", () => {
    // Use AKIA… (not ghp_/sk-) so POL-SECRETS-1 does not own the match first.
    const r = matchPolicy({
      task: "set AWS_ACCESS_KEY_ID: AKIATESTKEY123456789 in the deploy job",
      hints: { touchedFiles: [".github/workflows/publish.yml"] },
    });
    assert.equal(r?.id, "POL-CI-SECRETS-1");
    assert.equal(r?.mode, "block");
  });

  it("POL-CI-SECRETS-2 approvals normal secrets.NAME workflow wiring", async () => {
    const provider = new PermissiveFake();
    const g = new Guard(provider);
    const r = await g.decide({
      task: "Add ${{ secrets.NPM_TOKEN }} to the release workflow",
      hints: { touchedFiles: [".github/workflows/release.yml"] },
    });
    assert.equal(r.mode, "approval_required");
    assert.equal(r.security.reviewNeeded, true);
    assert.ok(r.reasons.some((x) => x.code === "POL-CI-SECRETS-2"));
  });

  it("POL-CI-SECRETS-2 approvals workflow path + secrets wording", () => {
    const r = matchPolicy({
      task: "Wire the deploy secrets into the pipeline",
      hints: { touchedFiles: [".github/workflows/deploy.yml"] },
    });
    assert.equal(r?.id, "POL-CI-SECRETS-2");
    assert.equal(r?.mode, "approval_required");
    assert.equal(r?.requiresSecurityReview, true);
  });

  it("ordinary workflow edit without secrets does not hit CI-secrets rules", () => {
    const r = matchPolicy({
      task: "Add a cache step to the CI workflow",
      hints: { touchedFiles: [".github/workflows/ci.yml"] },
    });
    assert.notEqual(r?.id, "POL-CI-SECRETS-1");
    assert.notEqual(r?.id, "POL-CI-SECRETS-2");
  });

  it("POL-CI-SECRETS-2 approvals ${{ secrets.API_KEY }} (not shadowed by POL-SECRETS-1)", () => {
    const r = matchPolicy({
      task: "Wire ${{ secrets.API_KEY }} into the release job",
      hints: { touchedFiles: [".github/workflows/release.yml"] },
    });
    assert.equal(r?.id, "POL-CI-SECRETS-2");
    assert.equal(r?.mode, "approval_required");
  });

  it("POL-INFRA-DESTROY-1 blocks terraform -chdir destroy", () => {
    assert.equal(
      matchPolicy({ task: "terraform -chdir=infra destroy -auto-approve" })?.id,
      "POL-INFRA-DESTROY-1",
    );
  });

  it("counterexample — quoted kubectl delete mention does not fire destroy", () => {
    const r = matchPolicy({ task: 'rg "kubectl delete" docs/' });
    assert.notEqual(r?.id, "POL-INFRA-DESTROY-1");
  });

  it("POL-INFRA-DESTROY-1 blocks terraform destroy and kubectl delete", async () => {
    const provider = new PermissiveFake();
    const g = new Guard(provider);
    const r = await g.decide({ task: "terraform destroy -auto-approve" });
    assert.equal(r.mode, "block");
    assert.ok(r.reasons.some((x) => x.code === "POL-INFRA-DESTROY-1"));
    assert.equal(provider.calls, 0);

    assert.equal(matchPolicy({ task: "kubectl delete namespace staging" })?.id, "POL-INFRA-DESTROY-1");
    assert.equal(matchPolicy({ task: "helm uninstall my-release" })?.id, "POL-INFRA-DESTROY-1");
  });

  it("terraform apply stays POL-INFRA-1 (approval), not destroy", () => {
    const r = matchPolicy({ task: "terraform apply -auto-approve" });
    assert.equal(r?.id, "POL-INFRA-1");
    assert.equal(r?.mode, "approval_required");
  });

  it("POL-PUBLISH-1 requires approval for registry publish", async () => {
    const provider = new PermissiveFake();
    const g = new Guard(provider);
    const r = await g.decide({ task: "npm publish --access public" });
    assert.equal(r.mode, "approval_required");
    assert.ok(r.reasons.some((x) => x.code === "POL-PUBLISH-1"));
  });

  it("POL-PII-EGRESS-1 requires approval + security review", async () => {
    const provider = new PermissiveFake();
    const g = new Guard(provider);
    const r = await g.decide({ task: "Export customer data dump for the analytics partner" });
    assert.equal(r.mode, "approval_required");
    assert.equal(r.security.reviewNeeded, true);
    assert.ok(r.reasons.some((x) => x.code === "POL-PII-EGRESS-1"));
  });

  it("counterexample — dump without PII object does not fire POL-PII-EGRESS-1", () => {
    const r = matchPolicy({ task: "dump the redis cache keys for debugging" });
    assert.notEqual(r?.id, "POL-PII-EGRESS-1");
  });

  it("seed / mnemonic / bip39 / recovery phrase still blocked by POL-SECRETS-1", () => {
    assert.equal(matchPolicy({ task: "store the wallet seed phrase in config" })?.id, "POL-SECRETS-1");
    assert.equal(matchPolicy({ task: "print the mnemonic for recovery" })?.id, "POL-SECRETS-1");
    assert.equal(matchPolicy({ task: "store the bip39 recovery phrase in the notes file" })?.id, "POL-SECRETS-1");
    assert.equal(matchPolicy({ task: "write down the 12-word seed phrase for the wallet" })?.id, "POL-SECRETS-1");
  });

  it("secret path touch still blocks (Write-gate relevant)", () => {
    const r = matchPolicy({
      task: "Write local config",
      hints: { touchedFiles: [".env.local"] },
    });
    assert.equal(r?.id, "POL-SECRETS-1");
    assert.equal(r?.mode, "block");
  });

  it("counterexample — add a unit test does not fire publish/destroy/pii", () => {
    const r = matchPolicy({ task: "add a unit test for the parser helper" });
    assert.equal(r, undefined);
  });
});
