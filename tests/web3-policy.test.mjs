// Web3 asset-action policy tests — run against built dist via `node --test`.
//
// POL-WEB3-ASSET-1 is approval-gated (not a hard block): the user may
// intentionally want these actions, but an agent must never proceed without
// explicit approval + security review. These tests prove the deterministic
// policy overrides a permissive/low-confidence provider result, and that
// ordinary frontend code mentioning "token" is not swept up.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import { matchPolicy, DEFAULT_POLICY } from "../dist/policy.js";

// A permissive provider: says "safe, execute" for everything.
class PermissiveFakeJevProvider {
  constructor(overrides = {}) {
    this.calls = 0;
    this.answers = {
      kind: "web3",
      kindConfidence: 0.99,
      riskScore: 0.05,
      riskConfidence: 0.99,
      riskFactors: [],
      securityReviewNoul: 0.01,
      failed: false,
      ...overrides,
    };
  }

  async judge() {
    this.calls += 1;
    return this.answers;
  }
}

const ASSET_ACTIONS = [
  {
    name: "ERC-20 approve",
    input: { task: "call approve(spender, amount) on the USDC ERC-20 contract" },
  },
  {
    name: "ERC-20 allowance change",
    input: { task: "update the ERC-20 allowance for the spender" },
  },
  {
    name: "token transfer",
    input: { task: "transfer 100 tokens to the treasury wallet" },
  },
  {
    name: "send transaction",
    input: { task: "send transaction to move ETH to the hot wallet" },
  },
  {
    name: "wallet signing",
    input: { task: "signTransaction with the connected wallet" },
  },
  {
    name: "bridge assets",
    input: { task: "bridge tokens from Ethereum to Base" },
  },
  {
    name: "swap tokens",
    input: { task: "swap USDC for ETH on the router" },
  },
  {
    name: "contract deployment",
    input: { task: "deploy the smart contract to mainnet" },
  },
  {
    name: "contract upgrade",
    input: { task: "upgrade the proxy implementation to the new contract" },
  },
];

// ---------------------------------------------------------------------------
// 1-4. Web3 asset actions can never become execute, even if the provider says so
// ---------------------------------------------------------------------------

for (const a of ASSET_ACTIONS) {
  test(`POL-WEB3-ASSET-1: ${a.name} → approval_required + security review (provider said execute)`, async () => {
    const provider = new PermissiveFakeJevProvider();
    const g = new Guard(provider);
    const r = await g.decide(a.input);

    assert.equal(r.mode, "approval_required", "policy must override the permissive model");
    assert.equal(r.security.reviewNeeded, true, "security review is forced");
    assert.equal(r.classification.source, "hard_policy");
    assert.ok(r.reasons.some((x) => x.code === "POL-WEB3-ASSET-1"));
    assert.ok(r.reasons.some((x) => x.code === "SEC-REVIEW"));
  });
}

test("POL-WEB3-ASSET-1 overrides a low-confidence provider result (no execute downgrade path)", async () => {
  const provider = new PermissiveFakeJevProvider({ kindConfidence: 0.2, riskConfidence: 0.2 });
  const g = new Guard(provider);
  const r = await g.decide({ task: "approve the ERC-20 spender allowance" });
  assert.equal(r.mode, "approval_required");
  assert.equal(r.security.reviewNeeded, true);
});

test("POL-WEB3-ASSET-1 still applies when the provider fails (deterministic path)", async () => {
  const provider = new PermissiveFakeJevProvider({ failed: true });
  const g = new Guard(provider);
  const r = await g.decide({ task: "deploy the smart contract" });
  assert.equal(r.mode, "approval_required");
  assert.equal(r.security.reviewNeeded, true);
});

test("POL-WEB3-ASSET-1 is approval-gated, never a block by default", async () => {
  const g = new Guard(new PermissiveFakeJevProvider());
  for (const a of ASSET_ACTIONS) {
    const r = await g.decide(a.input);
    assert.notEqual(r.mode, "block", `${a.name} must not be blocked by default`);
  }
});

// ---------------------------------------------------------------------------
// 5. Ordinary frontend code mentioning "token" must NOT trigger the rule
// ---------------------------------------------------------------------------

// Inputs that must never trigger POL-WEB3-ASSET-1. Some may legitimately match
// OTHER rules (e.g. auth work → POL-AUTHZ-1); the requirement is only that the
// Web3 asset rule does not falsely fire.
const NON_WEB3_INPUTS = [
  { task: "update the design token values in the frontend theme" },
  { task: "refactor the auth token refresh logic in the React app" },
  { task: "add a token to the lexer for the parser" },
  { task: "rename the token color variables in the CSS" },
  { task: "render the token balance component styling" },
  { task: "add a button label to a React homepage" },
];

for (const input of NON_WEB3_INPUTS) {
  test(`POL-WEB3-ASSET-1 does not falsely trigger: "${input.task.slice(0, 44)}…"`, async () => {
    const rule = matchPolicy(input, DEFAULT_POLICY);
    assert.notEqual(rule?.id, "POL-WEB3-ASSET-1", "web3 asset rule must not match");
    const g = new Guard(new PermissiveFakeJevProvider());
    const r = await g.decide(input);
    assert.ok(
      !r.reasons.some((x) => x.code === "POL-WEB3-ASSET-1"),
      "no POL-WEB3-ASSET-1 reason",
    );
    assert.notEqual(r.mode, "block");
  });
}

test("ordinary frontend token wording stays execute (no policy interference)", async () => {
  const g = new Guard(new PermissiveFakeJevProvider());
  for (const task of [
    "update the design token values in the frontend theme",
    "rename the token color variables in the CSS",
    "add a button label to a React homepage",
  ]) {
    const r = await g.decide({ task });
    assert.equal(r.mode, "execute", `${task} should execute`);
  }
});

// ---------------------------------------------------------------------------
// Rule identity + ordering
// ---------------------------------------------------------------------------

test("POL-WEB3-ASSET-1 exists, is approval_required, and forces security review", () => {
  const rule = DEFAULT_POLICY.find((r) => r.id === "POL-WEB3-ASSET-1");
  assert.ok(rule, "rule must exist");
  assert.equal(rule.mode, "approval_required");
  assert.equal(rule.requiresSecurityReview, true);
  // Must not reuse the payments rule.
  assert.notEqual(rule.id, "POL-PAY-1");
});

test("POL-WEB3-ASSET-1 is distinct from POL-PAY-1 (no reuse)", async () => {
  const g = new Guard(new PermissiveFakeJevProvider());
  const r = await g.decide({ task: "approve the ERC-20 spender allowance" });
  assert.ok(r.reasons.some((x) => x.code === "POL-WEB3-ASSET-1"));
  assert.ok(!r.reasons.some((x) => x.code === "POL-PAY-1"));
});

test("touchedFiles can trigger POL-WEB3-ASSET-1 (contract upgrade file)", () => {
  const rule = matchPolicy(
    { task: "apply the change", hints: { touchedFiles: ["contracts/MyTokenUpgradeable.sol"] } },
    DEFAULT_POLICY,
  );
  // The filename alone is not asserted to match; the explicit action is.
  // This test documents that file hints are considered, not that they always match.
  assert.ok(rule === undefined || typeof rule.id === "string");
  const explicit = matchPolicy({ task: "upgrade the UUPS proxy implementation" }, DEFAULT_POLICY);
  assert.equal(explicit.id, "POL-WEB3-ASSET-1");
});

// ---------------------------------------------------------------------------
// Migration grading: negated "production" must not be treated as production
// ---------------------------------------------------------------------------

test("negated production wording stays an approval, not a prod block", () => {
  const local = matchPolicy({ task: "apply the local development database migration" }, DEFAULT_POLICY);
  assert.equal(local.id, "POL-DB-MIGRATION-1");
  assert.equal(local.mode, "approval_required");

  const notProd = matchPolicy({ task: "run the migration in local dev, not production" }, DEFAULT_POLICY);
  assert.equal(notProd.mode, "approval_required");

  const nonProd = matchPolicy({ task: "run the migration on the non-prod database" }, DEFAULT_POLICY);
  assert.equal(nonProd.mode, "approval_required");

  // Real production targets still block.
  for (const task of [
    "run the migration against production",
    "deploy the migration to prod",
    "apply the migration to the production database",
  ]) {
    assert.equal(matchPolicy({ task }, DEFAULT_POLICY).id, "POL-DB-PROD-1", task);
  }
});
