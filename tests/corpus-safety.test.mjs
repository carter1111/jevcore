// tests/corpus-safety.test.mjs — WP3 offline corpus invariants.
//
// Deterministic-only: no key, no network, no real Jev, no cost. Uses the real
// `matchPolicy` and the real `Guard` with a fake provider, so every assertion
// here is an exact pass/fail about deterministic behavior.
//
// IMPORTANT: semantic expectations (expected kind / risk band under a real
// model) are NOT proven here. They remain pending until an explicit live run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Guard } from "../dist/engine.js";
import { matchPolicy } from "../dist/policy.js";

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

const CORPUS = JSON.parse(
  readFileSync(new URL("./corpus/fixtures.json", import.meta.url), "utf8"),
);

/** A fake provider that always returns a permissive, low-risk judgment. */
class PermissiveFakeProvider {
  constructor() {
    this.calls = 0;
  }
  async judge() {
    this.calls += 1;
    return {
      kind: "backend",
      kindConfidence: 0.95,
      riskScore: 0.05,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.05,
      failed: false,
    };
  }
}

/** A provider that always fails, to exercise the deterministic fallback. */
class FailingProvider {
  async judge() {
    return { failed: true };
  }
}

function inputFor(fixture) {
  return { task: fixture.task, hints: { touchedFiles: fixture.touchedFiles ?? [] } };
}

/** Map an engine mode to the corpus' coarse action vocabulary. */
function actionOf(mode) {
  switch (mode) {
    case "block":
      return "block";
    case "approval_required":
      return "approve";
    case "plan_first":
      return "plan";
    default:
      return "execute";
  }
}

/** Minimum-action ordering (higher = more restrictive). */
const ACTION_RANK = { execute: 0, plan: 1, approve: 2, block: 3 };

const MODES = new Set(["execute", "plan_first", "approval_required", "block"]);
const ACTIONS = new Set(["execute", "plan", "approve", "block"]);
const RISK_BANDS = new Set(["low", "medium", "high", "critical"]);

// ---------------------------------------------------------------------------
// 1. Corpus schema / integrity
// ---------------------------------------------------------------------------

test("corpus: declared count matches fixture array length", () => {
  assert.equal(CORPUS.fixtures.length, CORPUS.count);
  assert.ok(CORPUS.count >= 50, "WP3 target corpus size is at least 50 fixtures");
});

test("corpus: fixture ids are unique and non-empty", () => {
  const ids = CORPUS.fixtures.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.ok(typeof id === "string" && id.length > 0);
});

test("corpus: every fixture separates deterministic and semantic expectations", () => {
  for (const f of CORPUS.fixtures) {
    const d = f.deterministicExpectation;
    const s = f.semanticExpectation;
    assert.ok(d && s, `${f.id} has both expectation blocks`);
    assert.ok(Array.isArray(d.policyRuleIds), `${f.id} deterministic.policyRuleIds`);
    assert.ok(
      d.providerCallExpected === "prohibited" || d.providerCallExpected === "allowed",
      `${f.id} deterministic.providerCallExpected`,
    );
    assert.ok(ACTIONS.has(d.minimumAction), `${f.id} deterministic.minimumAction`);
    assert.ok(typeof s.expectedKind === "string" && s.expectedKind.length > 0, `${f.id} semantic.expectedKind`);
    assert.ok(RISK_BANDS.has(s.expectedRiskBand), `${f.id} semantic.expectedRiskBand`);
    assert.ok(ACTIONS.has(s.minimumAction), `${f.id} semantic.minimumAction`);
    assert.ok(
      s.expectedSecurityReview === null || s.expectedSecurityReview === "required",
      `${f.id} semantic.expectedSecurityReview`,
    );
  }
});

test("corpus: fixture tasks and files are non-empty strings", () => {
  for (const f of CORPUS.fixtures) {
    assert.ok(typeof f.task === "string" && f.task.length > 0, `${f.id} task`);
    assert.ok(Array.isArray(f.touchedFiles), `${f.id} touchedFiles is an array`);
    for (const p of f.touchedFiles) assert.ok(typeof p === "string" && p.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 2. Synthetic privacy boundaries
// ---------------------------------------------------------------------------

test("corpus: no real absolute paths, usernames, hostnames, or credential material", () => {
  const forbidden = [
    /\/Users\//, /\/home\//, /\/private\//, /\bC:\\/, // absolute paths
    /\blocalhost\b/i, /\b127\.0\.0\.1\b/i, /\.local\b/i, // hostnames
    /\b(?:postgres|mysql|mongodb|redis):\/\//i, // db urls
    /\bsk-[a-z0-9]{16,}\b/i, /\bghp_[a-z0-9]{20,}\b/i, /\bxox[baprs]-/i, // api keys
    /\bAKIA[0-9A-Z]{16}\b/, // aws key
    /BEGIN [A-Z ]+PRIVATE KEY/i, // pem block
    /https?:\/\//i, // any real URL
  ];
  for (const f of CORPUS.fixtures) {
    const hay = `${f.id}\n${f.task}\n${(f.touchedFiles ?? []).join("\n")}`;
    for (const re of forbidden) {
      assert.ok(!re.test(hay), `${f.id} must not contain ${re}`);
    }
  }
});

test("corpus: no fixture declares a real email or phone-like PII", () => {
  for (const f of CORPUS.fixtures) {
    const hay = `${f.task}\n${(f.touchedFiles ?? []).join("\n")}`;
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(hay), `${f.id} must not contain an email`);
    assert.ok(!/\+\d[\d\s-]{7,}/.test(hay), `${f.id} must not contain a phone number`);
  }
});

// ---------------------------------------------------------------------------
// 3. Hard-policy escape rate = 0
// ---------------------------------------------------------------------------

test("corpus: hard-policy escape rate is 0 (deterministic expectations hold)", () => {
  let escapes = 0;
  for (const f of CORPUS.fixtures) {
    const rule = matchPolicy(inputFor(f));
    const actualIds = rule ? [rule.id] : [];
    const expected = f.deterministicExpectation.policyRuleIds;
    if (JSON.stringify(actualIds) !== JSON.stringify(expected)) {
      escapes += 1;
      assert.fail(
        `${f.id}: expected policy ${JSON.stringify(expected)}, got ${JSON.stringify(actualIds)}`,
      );
    }
  }
  assert.equal(escapes, 0);
});

// ---------------------------------------------------------------------------
// 4. Deterministic migration safety invariants
// ---------------------------------------------------------------------------

test("corpus: every migration fixture resolves to block or approval (never execute)", () => {
  const migrationFixtures = CORPUS.fixtures.filter((f) => /migrat/i.test(f.task));
  assert.ok(migrationFixtures.length >= 5, "corpus covers several migration cases");
  for (const f of migrationFixtures) {
    const rule = matchPolicy(inputFor(f));
    assert.ok(rule, `${f.id} migration must match a policy rule`);
    assert.ok(
      rule.mode === "block" || rule.mode === "approval_required",
      `${f.id} migration must be block or approval, got ${rule.mode}`,
    );
    assert.notEqual(actionOf(rule.mode), "execute", `${f.id} must never reach execute`);
  }
});

// ---------------------------------------------------------------------------
// 5. Hard-block provider-call violations = 0
// ---------------------------------------------------------------------------

test("corpus: hard-block fixtures make ZERO provider calls through the engine", async () => {
  const blockFixtures = CORPUS.fixtures.filter(
    (f) => f.deterministicExpectation.providerCallExpected === "prohibited",
  );
  assert.ok(blockFixtures.length >= 5, "corpus covers several prohibited cases");

  for (const f of blockFixtures) {
    const provider = new PermissiveFakeProvider();
    const guard = new Guard(provider);
    const result = await guard.decide(inputFor(f));
    assert.equal(result.mode, "block", `${f.id} must block`);
    assert.equal(provider.calls, 0, `${f.id} must make zero provider calls`);
    assert.equal(result.classification.source, "hard_policy", `${f.id} source is hard_policy`);
  }
});

test("corpus: providerCallExpected=prohibited fixtures all yield mode block", async () => {
  for (const f of CORPUS.fixtures) {
    if (f.deterministicExpectation.providerCallExpected !== "prohibited") continue;
    const provider = new PermissiveFakeProvider();
    const result = await new Guard(provider).decide(inputFor(f));
    assert.equal(result.mode, "block", `${f.id}`);
  }
});

test("corpus: providerCallExpected=allowed fixtures do not block", async () => {
  for (const f of CORPUS.fixtures) {
    if (f.deterministicExpectation.providerCallExpected !== "allowed") continue;
    const result = await new Guard(new PermissiveFakeProvider()).decide(inputFor(f));
    assert.notEqual(result.mode, "block", `${f.id} must not block`);
  }
});

// ---------------------------------------------------------------------------
// 6. Conservative fallback behavior
// ---------------------------------------------------------------------------

test("corpus: provider failure never fails open (block stays block, others >= plan)", async () => {
  for (const f of CORPUS.fixtures) {
    const result = await new Guard(new FailingProvider()).decide(inputFor(f));
    assert.ok(MODES.has(result.mode), `${f.id} mode is valid`);
    assert.notEqual(result.mode, "execute", `${f.id} must never execute after provider failure`);
    if (f.deterministicExpectation.minimumAction === "block") {
      assert.equal(result.mode, "block", `${f.id} must stay block on provider failure`);
    }
  }
});

test("corpus: low-confidence provider judgment cannot reach execute", async () => {
  const lowConf = {
    async judge() {
      return {
        kind: "backend",
        kindConfidence: 0.1,
        riskScore: 0.05,
        riskConfidence: 0.1,
        riskFactors: [],
        securityReviewNoul: 0.05,
        failed: false,
      };
    },
  };
  for (const f of CORPUS.fixtures) {
    const result = await new Guard(lowConf).decide(inputFor(f));
    assert.notEqual(result.mode, "execute", `${f.id} low confidence must not execute`);
  }
});

// ---------------------------------------------------------------------------
// 7. Temp-only storage behavior
// ---------------------------------------------------------------------------

test("corpus: offline evaluation never touches the real evidence path", () => {
  // This test process must not have enabled evidence, and must never reference
  // the real home-directory database.
  assert.notEqual(process.env.JEV_GUARD_LOCAL_EVIDENCE, "1", "evidence must be off in tests");
  const realPath = `${process.env.HOME ?? ""}/.cursor/jev-coding-guard`;
  // The corpus module and this test never compute or open that path; assert the
  // fixture file itself contains no reference to it.
  const raw = readFileSync(new URL("./corpus/fixtures.json", import.meta.url), "utf8");
  assert.ok(!raw.includes(realPath), "corpus must not embed the real evidence path");
  assert.ok(!raw.includes(".cursor/jev-coding-guard"), "corpus must not reference the evidence dir");
});

// ---------------------------------------------------------------------------
// 8. Metric aggregation math
// ---------------------------------------------------------------------------

/** Rate helper mirroring the harness: count(predicate) / total. */
function rate(items, predicate) {
  if (items.length === 0) return 0;
  return items.filter(predicate).length / items.length;
}

test("corpus-metrics: rate math is correct on known inputs", () => {
  const items = [1, 2, 3, 4];
  assert.equal(rate(items, (n) => n % 2 === 0), 0.5);
  assert.equal(rate(items, () => true), 1);
  assert.equal(rate(items, () => false), 0);
  assert.equal(rate([], () => true), 0, "empty set is 0, not NaN");
});

test("corpus-metrics: escape rate computes to 0 on the real corpus", () => {
  const escapeRate = rate(CORPUS.fixtures, (f) => {
    const rule = matchPolicy(inputFor(f));
    const actual = rule ? [rule.id] : [];
    return JSON.stringify(actual) !== JSON.stringify(f.deterministicExpectation.policyRuleIds);
  });
  assert.equal(escapeRate, 0);
});

test("corpus-metrics: minimum-action ranking is monotonic", () => {
  assert.ok(ACTION_RANK.execute < ACTION_RANK.plan);
  assert.ok(ACTION_RANK.plan < ACTION_RANK.approve);
  assert.ok(ACTION_RANK.approve < ACTION_RANK.block);
});

// ---------------------------------------------------------------------------
// 9. Semantic expectations are explicitly NOT offline proof
// ---------------------------------------------------------------------------

/** C-1 policy ids that must appear in at least one fixture (merge gate). */
const REQUIRED_POLICY_COVERAGE = [
  "POL-CI-SECRETS-1",
  "POL-CI-SECRETS-2",
  "POL-CI-PRIV-1",
  "POL-INFRA-DESTROY-1",
  "POL-PUBLISH-1",
  "POL-PII-EGRESS-1",
];

test("corpus: covers C-1 policy expansion rules", () => {
  const covered = new Set(CORPUS.fixtures.flatMap((f) => f.deterministicExpectation.policyRuleIds));
  for (const id of REQUIRED_POLICY_COVERAGE) {
    assert.ok(covered.has(id), `corpus must include a fixture for ${id}`);
  }
});

test("corpus: semantic expectations are declared but not asserted offline", () => {
  // Guard against the mistake of treating semantic expectations as offline
  // truth: they exist for the live harness, and this offline suite must not
  // claim them. Assert they are present (so live mode has work to do) and that
  // every fixture declares them separately from deterministic ones.
  for (const f of CORPUS.fixtures) {
    assert.ok(f.semanticExpectation, `${f.id} declares semantic expectations for live runs`);
    assert.notEqual(
      f.deterministicExpectation,
      f.semanticExpectation,
      `${f.id} keeps the two expectation kinds separate`,
    );
  }
});
