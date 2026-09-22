// Policy-first preflight tests — run against built dist via `node --test`.
//
// These tests prove the security correction: deterministic hard policy is
// evaluated BEFORE the model provider, so sensitive content (private keys,
// seed phrases, .env values, PEM blocks, credential values) and destructive
// operations never reach TypeSafe. Every hard-block case asserts a provider
// call count of ZERO, and a sanitization case asserts secret-like values are
// redacted from the state handed to the provider.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import { RuleProvider } from "../dist/fallback.js";
import { redactSecrets, sanitizeForProvider, matchPolicy, DEFAULT_POLICY } from "../dist/policy.js";

// ---------------------------------------------------------------------------
// Fake provider that COUNTS calls (the core assertion for this correction)
// ---------------------------------------------------------------------------

class CountingFakeJevProvider {
  constructor(answers = null) {
    this.answers = answers ?? {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
    this.calls = 0;
    this.lastInput = null;
  }

  async judge(input) {
    this.calls += 1;
    this.lastInput = input;
    return this.answers;
  }
}

const PRIVATE_KEY_BLOCK = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAx7Vn0mZ9pQ1sT4uW8yB2cD3eF5gH6iJ7kL8mN9oP0qR1sT2u",
  "V3wX4yZ5aB6cD7eF8gH9iJ0kL1mN2oP3qR4sT5uV6wX7yZ8aB9cD0eF1gH2iJ3k",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

// Each case: input that MUST hard-block, with the expected policy rule id.
const HARD_BLOCK_CASES = [
  {
    name: "PRIVATE_KEY content",
    rule: "POL-SECRETS-1",
    input: { task: "read the PRIVATE_KEY from the wallet config and log it" },
  },
  {
    name: "seed phrase / mnemonic",
    rule: "POL-SECRETS-1",
    input: { task: "export the wallet seed phrase to a backup file" },
  },
  {
    name: ".env content",
    rule: "POL-SECRETS-1",
    input: { task: "update config", hints: { touchedFiles: [".env"] } },
  },
  {
    name: "PEM private-key block",
    rule: "POL-SECRETS-1",
    input: { task: `rotate this key:\n${PRIVATE_KEY_BLOCK}` },
  },
  {
    name: "cat .env",
    rule: "POL-SECRETS-1",
    input: { task: "run cat .env to inspect the values" },
  },
  {
    name: "rm -rf",
    rule: "POL-DESTRUCTIVE-CMD-1",
    input: { task: "run rm -rf / to clean the build directory" },
  },
  {
    name: "git push --force origin main",
    rule: "POL-FORCE-PUSH-1",
    input: { task: "run git push --force origin main to sync the branch" },
  },
  {
    name: "DROP TABLE",
    rule: "POL-DB-DESTRUCTIVE-1",
    input: { task: "run DROP TABLE users to reset the schema" },
  },
  {
    name: "production migration",
    rule: "POL-DB-PROD-1",
    input: { task: "run the migration against production" },
  },
];

// ---------------------------------------------------------------------------
// 1-4. Hard blocks: zero provider calls + source hard_policy
// ---------------------------------------------------------------------------

for (const c of HARD_BLOCK_CASES) {
  test(`preflight: ${c.name} → block with ZERO provider calls`, async () => {
    const provider = new CountingFakeJevProvider();
    const g = new Guard(provider);
    const r = await g.decide(c.input);

    assert.equal(provider.calls, 0, "provider must NOT be called on a hard block");
    assert.equal(provider.lastInput, null, "no input may reach the provider");
    assert.equal(r.mode, "block");
    assert.equal(r.classification.source, "hard_policy");
    assert.ok(
      r.reasons.some((x) => x.code === c.rule),
      `expected rule ${c.rule} in reasons: ${JSON.stringify(r.reasons.map((x) => x.code))}`,
    );
    assert.ok(r.reasons.some((x) => x.code === "PREFLIGHT-BLOCK"));
  });
}

test("preflight block makes zero calls even when the provider would fail", async () => {
  const provider = new CountingFakeJevProvider({ failed: true });
  const g = new Guard(provider);
  const r = await g.decide({ task: "cat .env" });
  assert.equal(provider.calls, 0);
  assert.equal(r.mode, "block");
  assert.equal(r.fellBack, false);
});

test("non-block policy rules still allow a provider call (approval, not preflight block)", async () => {
  const provider = new CountingFakeJevProvider();
  const g = new Guard(provider);
  const r = await g.decide({ task: "add a migration to create the events table" });
  assert.equal(provider.calls, 1, "approval-level rules are decided after judgment");
  assert.equal(r.mode, "approval_required");
  assert.equal(r.classification.source, "hard_policy");});

// ---------------------------------------------------------------------------
// 5. Sanitization: secret-like values cannot reach the provider
// ---------------------------------------------------------------------------

test("sanitization: secret-like values are redacted before the provider sees state", async () => {
  const provider = new CountingFakeJevProvider();
  const g = new Guard(provider);

  // Non-blocking prose carrying credential-looking values. These patterns are
  // redacted on the provider path but do NOT trigger a preflight block, so the
  // provider is reached and we can prove the redaction.
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  const r = await g.decide({
    task: `audit logging: the AWS key ${aws} was written to the log`,
    hints: {
      touchedFiles: ["src/logger.ts"],
      context: `sample session value: ${jwt}`,
    },
  });

  assert.equal(provider.calls, 1, "provider is called for non-blocking input");
  assert.equal(r.mode !== "block", true, "this input must not be a hard block");
  const seen = provider.lastInput;

  for (const secret of [aws, jwt]) {
    assert.ok(!seen.task.includes(secret), `task must not contain ${secret}`);
    assert.ok(
      !(seen.hints?.context ?? "").includes(secret),
      `context must not contain ${secret}`,
    );
  }
  assert.ok(seen.task.includes("[REDACTED_SECRET]"), "redaction marker is present");
});

test("sanitization: PEM block content is redacted from provider state", async () => {
  const provider = new CountingFakeJevProvider();
  const g = new Guard(provider);
  // "PRIVATE KEY" content alone blocks; use a non-secret PEM type to exercise
  // redaction on the provider path.
  const cert = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----";
  await g.decide({ task: `note the public certificate:\n${cert}` });
  assert.equal(provider.calls, 1);
  assert.ok(!provider.lastInput.task.includes("MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"));
  assert.ok(provider.lastInput.task.includes("[REDACTED_SECRET]"));
});

test("sanitizeForProvider / redactSecrets are pure and do not mutate input", () => {
  const original = {
    task: "token sk-abcdefghijklmnopqrstuvwxyz",
    hints: { touchedFiles: ["a.ts"], context: "password: hunter2value" },
  };
  const snapshot = JSON.stringify(original);
  const out = sanitizeForProvider(original);
  assert.equal(JSON.stringify(original), snapshot, "input is not mutated");
  assert.notEqual(out.task, original.task);
  assert.ok(out.task.includes("[REDACTED_SECRET]"));
  assert.equal(redactSecrets("plain text with no secrets"), "plain text with no secrets");
});

test("sanitization leaves ordinary prose about auth/password intact", () => {
  const prose = "document the password reset flow for the auth page";
  assert.equal(redactSecrets(prose), prose);
});

// ---------------------------------------------------------------------------
// Policy primitive: new rules exist and are ordered before approval rules
// ---------------------------------------------------------------------------

test("new destructive/force-push rules are blocking and ordered before approvals", () => {
  assert.equal(matchPolicy({ task: "rm -rf /var/data" }, DEFAULT_POLICY).id, "POL-DESTRUCTIVE-CMD-1");
  assert.equal(matchPolicy({ task: "git push --force origin main" }, DEFAULT_POLICY).id, "POL-FORCE-PUSH-1");
  assert.equal(matchPolicy({ task: "git push --force-with-lease origin main" }, DEFAULT_POLICY).id, "POL-FORCE-PUSH-1");
  // A force push to a feature branch is not a protected-branch block.
  assert.equal(matchPolicy({ task: "git push --force origin feature/x" }, DEFAULT_POLICY), undefined);
  // An ordinary rm without -r/-f is not a destructive-command block.
  assert.equal(matchPolicy({ task: "rm build/output.log" }, DEFAULT_POLICY), undefined);
});

// ---------------------------------------------------------------------------
// Provider-failure path is unchanged (still policy-aware, still never open)
// ---------------------------------------------------------------------------

test("provider failure still blocks on secrets (fallback path, source hard_policy)", async () => {
  const provider = new CountingFakeJevProvider({ failed: true });
  const g = new Guard(provider);
  const r = await g.decide({ task: "add logging", hints: { touchedFiles: [".env"] } });
  assert.equal(r.mode, "block");
  assert.equal(r.classification.source, "hard_policy");
});

test("provider failure on ordinary task → plan_first, source rule", async () => {
  const provider = new CountingFakeJevProvider({ failed: true });
  const g = new Guard(provider);
  const r = await g.decide({ task: "add a button" });
  assert.equal(r.mode, "plan_first");
  assert.equal(r.classification.source, "rule");
  assert.equal(provider.calls, 1);
});

test("RuleProvider still works as a fallback provider (unchanged)", async () => {
  const g = new Guard(new RuleProvider());
  const r = await g.decide({ task: "build a react component for the homepage" });
  assert.equal(r.classification.kind, "frontend");
});
