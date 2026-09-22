// Database-environment policy refinement regression tests.
//
// Covers the graded migration/schema-push policy:
//   - explicit local/dev  → approval_required, no forced review
//   - explicit staging    → approval_required, no forced review (migrations)
//   - unknown target      → approval_required, FORCED review (deploy-style)
//   - explicit production → block
//   - destructive         → block (highest migration precedence)
//
// Also enforces the ordering contract: every blocking migration rule must
// precede the approval-required migration rule(s) it must override.
import { test } from "node:test";
import assert from "node:assert/strict";

import { matchPolicy, DEFAULT_POLICY } from "../dist/policy.js";

// ---------------------------------------------------------------------------
// Case matrix: [label, input, expectedRule, expectedMode, expectedReview]
// ---------------------------------------------------------------------------

const CASES = [
  [
    "prisma migrate dev + explicit local/dev",
    { task: "Apply the local development database migration\nProposed command: npx prisma migrate dev --name add_events" },
    "POL-DB-MIGRATION-1", "approval_required", false,
  ],
  [
    "prisma migrate deploy + no environment",
    { task: "Assess the proposed database migration deploy command\nProposed command: pnpm prisma migrate deploy" },
    "POL-DB-DEPLOY-UNKNOWN-1", "approval_required", true,
  ],
  [
    "prisma migrate deploy + staging",
    { task: "Run the database migration against staging\nProposed command: pnpm prisma migrate deploy" },
    "POL-DB-STAGING-1", "approval_required", false,
  ],
  [
    "prisma migrate deploy + production",
    { task: "Run the database migration against production\nProposed command: pnpm prisma migrate deploy" },
    "POL-DB-PROD-1", "block", false,
  ],
  [
    "prisma migrate deploy + live database",
    { task: "Run the migration on the live database\nProposed command: pnpm prisma migrate deploy" },
    "POL-DB-PROD-1", "block", false,
  ],
  [
    "prisma migrate deploy + 'not production'",
    { task: "Run the database migration, not production\nProposed command: pnpm prisma migrate deploy" },
    "POL-DB-DEPLOY-UNKNOWN-1", "approval_required", true,
  ],
  [
    "prisma migrate deploy + mentionsProd hint",
    { task: "Run the database migration deploy", hints: { mentionsProd: true } },
    "POL-DB-PROD-1", "block", false,
  ],
  [
    "prisma migrate deploy + DROP TABLE precedence",
    { task: "Run the database migration\nProposed command: prisma migrate deploy && psql -c 'DROP TABLE users'" },
    "POL-DB-DESTRUCTIVE-1", "block", false,
  ],
  [
    "generic SQL migration + explicit local/dev",
    { task: "Apply the SQL migration to the local development database" },
    "POL-DB-MIGRATION-1", "approval_required", false,
  ],
  [
    "generic SQL migration + explicit production",
    { task: "Apply the SQL migration to the production database" },
    "POL-DB-PROD-1", "block", false,
  ],
  [
    "non-migration production deploy reaches POL-PROD-1",
    { task: "Deploy the new build to production" },
    "POL-PROD-1", "approval_required", false,
  ],
  [
    "prisma db push + unknown target",
    { task: "Run prisma db push to sync the schema" },
    "POL-DB-SCHEMA-PUSH-2", "approval_required", true,
  ],
  [
    "prisma db push + explicit local/dev",
    { task: "Run prisma db push on the local development database" },
    "POL-DB-SCHEMA-PUSH-3", "approval_required", false,
  ],
  [
    "prisma db push + production",
    { task: "Run prisma db push against production" },
    "POL-DB-PROD-1", "block", false,
  ],
  [
    "prisma db push --accept-data-loss",
    { task: "Run prisma db push --accept-data-loss" },
    "POL-DB-SCHEMA-PUSH-1", "block", false,
  ],
  [
    "prisma db push + staging (unknown-style, forced review)",
    { task: "Run prisma db push against the staging database" },
    "POL-DB-SCHEMA-PUSH-2", "approval_required", true,
  ],
];

for (const [label, input, expectedRule, expectedMode, expectedReview] of CASES) {
  test(`db-env policy: ${label}`, () => {
    const rule = matchPolicy(input, DEFAULT_POLICY);
    assert.ok(rule, `${label}: expected a matching rule`);
    assert.equal(rule.id, expectedRule, `${label}: rule`);
    assert.equal(rule.mode, expectedMode, `${label}: mode`);
    assert.equal(rule.requiresSecurityReview ?? false, expectedReview, `${label}: requiresSecurityReview`);
  });
}

// ---------------------------------------------------------------------------
// Wording correctness: unknown-target must NOT be described as local/dev
// ---------------------------------------------------------------------------

test("POL-DB-MIGRATION-1 is worded as explicit local/dev, not a catch-all", () => {
  const rule = DEFAULT_POLICY.find((r) => r.id === "POL-DB-MIGRATION-1");
  assert.ok(rule);
  assert.match(rule.description, /local\/development/i);
  assert.doesNotMatch(rule.description, /ordinary/i, "must not claim to be a generic catch-all");
});

test("POL-DB-DEPLOY-UNKNOWN-1 states the environment is unknown and needs confirmation", () => {
  const rule = DEFAULT_POLICY.find((r) => r.id === "POL-DB-DEPLOY-UNKNOWN-1");
  assert.ok(rule);
  assert.match(rule.reason.detail, /unknown/i);
  assert.match(rule.reason.detail, /confirm/i);
});

test("unknown-target deploy migration is never labelled local/dev", () => {
  const input = { task: "Proposed command: pnpm prisma migrate deploy" };
  const rule = matchPolicy(input, DEFAULT_POLICY);
  assert.equal(rule.id, "POL-DB-DEPLOY-UNKNOWN-1");
  assert.notEqual(rule.id, "POL-DB-MIGRATION-1");
});

// ---------------------------------------------------------------------------
// live-target matcher: both "live db" and "live database"
// ---------------------------------------------------------------------------

test("live target matcher accepts both 'live db' and 'live database'", () => {
  for (const text of [
    "run the migration on the live db",
    "run the migration on the live database",
  ]) {
    const rule = matchPolicy({ task: text }, DEFAULT_POLICY);
    assert.equal(rule.id, "POL-DB-PROD-1", text);
    assert.equal(rule.mode, "block", text);
  }
});

test("negated production does not block", () => {
  const rule = matchPolicy({ task: "run the migration, not production" }, DEFAULT_POLICY);
  assert.notEqual(rule.mode, "block");
});

test("'non-prod' does not block", () => {
  const rule = matchPolicy({ task: "run the migration on the non-prod database" }, DEFAULT_POLICY);
  assert.notEqual(rule.mode, "block");
});

// ---------------------------------------------------------------------------
// Ordering contract: blocking migration rules precede approval migration rules
// ---------------------------------------------------------------------------

const MIGRATION_RULE_IDS = [
  "POL-DB-DESTRUCTIVE-1",
  "POL-DB-SCHEMA-PUSH-1",
  "POL-DB-PROD-1",
  "POL-DB-DEPLOY-UNKNOWN-1",
  "POL-DB-STAGING-1",
  "POL-DB-SCHEMA-PUSH-2",
  "POL-DB-MIGRATION-1",
];
test("ordering contract: every blocking migration rule precedes the approval rules it overrides", () => {
  const indexOf = (id) => {
    const i = DEFAULT_POLICY.findIndex((r) => r.id === id);
    assert.ok(i >= 0, `${id} must exist`);
    return i;
  };

  const blockIds = MIGRATION_RULE_IDS.filter(
    (id) => DEFAULT_POLICY.find((r) => r.id === id).mode === "block",
  );
  const approvalIds = MIGRATION_RULE_IDS.filter(
    (id) => DEFAULT_POLICY.find((r) => r.id === id).mode === "approval_required",
  );

  for (const b of blockIds) {
    for (const a of approvalIds) {
      assert.ok(
        indexOf(b) < indexOf(a),
        `blocking rule ${b} (index ${indexOf(b)}) must precede approval rule ${a} (index ${indexOf(a)})`,
      );
    }
  }
});

test("ordering contract: destructive data ops precede all migration rules", () => {
  const destructive = DEFAULT_POLICY.findIndex((r) => r.id === "POL-DB-DESTRUCTIVE-1");
  for (const id of MIGRATION_RULE_IDS.filter((x) => x !== "POL-DB-DESTRUCTIVE-1")) {
    const i = DEFAULT_POLICY.findIndex((r) => r.id === id);
    assert.ok(destructive < i, `POL-DB-DESTRUCTIVE-1 must precede ${id}`);
  }
});

test("ordering contract: migration-specific rules precede generic POL-PROD-1", () => {
  const generic = DEFAULT_POLICY.findIndex((r) => r.id === "POL-PROD-1");
  for (const id of ["POL-DB-DEPLOY-UNKNOWN-1", "POL-DB-STAGING-1", "POL-DB-MIGRATION-1"]) {
    const i = DEFAULT_POLICY.findIndex((r) => r.id === id);
    assert.ok(i < generic, `${id} must precede POL-PROD-1`);
  }
});

test("ordering contract: POL-PROD-1 remains reachable for non-migration deploy text", () => {
  const rule = matchPolicy({ task: "Deploy the new build to production" }, DEFAULT_POLICY);
  assert.equal(rule.id, "POL-PROD-1");
});

// ---------------------------------------------------------------------------
// Precedence spot-checks: destructive/prod always win over unknown/staging
// ---------------------------------------------------------------------------

test("precedence: production + destructive still blocks via the destructive rule", () => {
  const rule = matchPolicy(
    { task: "run the migration against production with DROP TABLE users" },
    DEFAULT_POLICY,
  );
  assert.equal(rule.mode, "block");
});

test("precedence: --accept-data-loss blocks even with a stated local target", () => {
  const rule = matchPolicy(
    { task: "run prisma db push --accept-data-loss on the local development database" },
    DEFAULT_POLICY,
  );
  assert.equal(rule.id, "POL-DB-SCHEMA-PUSH-1");
  assert.equal(rule.mode, "block");
});

test("no migration rule lets an unknown-target deploy reach execute", () => {
  for (const text of [
    "pnpm prisma migrate deploy",
    "run the migrations",
    "apply pending migrations",
  ]) {
    const rule = matchPolicy({ task: text }, DEFAULT_POLICY);
    assert.ok(rule, `"${text}" must match a rule`);
    assert.notEqual(rule.mode, "execute", `"${text}" must not be execute`);
  }
});

test("fail-open guard: NO migration text may reach execute (unclassified target)", () => {
  // A bare migration with no environment must still be approval-gated. Falling
  // through to `execute` would violate the guard's never-fail-open invariant.
  for (const text of [
    "add a migration to create the events table",
    "create a new database migration",
    "write a migration for the users table",
    "migrate the schema",
    "run the migration",
  ]) {
    const rule = matchPolicy({ task: text }, DEFAULT_POLICY);
    assert.ok(rule, `"${text}" must match some rule`);
    assert.notEqual(rule.mode, "execute", `"${text}" must not be execute`);
    assert.equal(rule.mode, "approval_required", `"${text}" should require approval`);
  }
});

test("ordering contract: POL-DB-MIGRATION-2 precedes generic POL-PROD-1", () => {
  const unclassified = DEFAULT_POLICY.findIndex((r) => r.id === "POL-DB-MIGRATION-2");
  const generic = DEFAULT_POLICY.findIndex((r) => r.id === "POL-PROD-1");
  assert.ok(unclassified >= 0, "POL-DB-MIGRATION-2 must exist");
  assert.ok(unclassified < generic, "migration-specific rule must precede POL-PROD-1");
});

// ---------------------------------------------------------------------------
// `prisma db push` provenance: must NEVER match a POL-DB-MIGRATION-* rule
// ---------------------------------------------------------------------------

const DB_PUSH_CASES = [
  ["--accept-data-loss", { task: "Run prisma db push --accept-data-loss" }, "POL-DB-SCHEMA-PUSH-1", "block", false],
  ["+ production", { task: "Run prisma db push against production" }, "POL-DB-PROD-1", "block", false],
  ["+ live database", { task: "Run prisma db push against the live database" }, "POL-DB-PROD-1", "block", false],
  ["+ unknown target", { task: "Run prisma db push to sync the schema" }, "POL-DB-SCHEMA-PUSH-2", "approval_required", true],
  ["+ staging", { task: "Run prisma db push against the staging database" }, "POL-DB-SCHEMA-PUSH-2", "approval_required", true],
  ["+ explicit local/dev", { task: "Run prisma db push on the local development database" }, "POL-DB-SCHEMA-PUSH-3", "approval_required", false],
];

for (const [label, input, expectedRule, expectedMode, expectedReview] of DB_PUSH_CASES) {
  test(`db push provenance: ${label} → ${expectedRule}`, () => {
    const rule = matchPolicy(input, DEFAULT_POLICY);
    assert.ok(rule, `db push ${label}: expected a matching rule`);
    assert.equal(rule.id, expectedRule, `db push ${label}: rule`);
    assert.equal(rule.mode, expectedMode, `db push ${label}: mode`);
    assert.equal(rule.requiresSecurityReview ?? false, expectedReview, `db push ${label}: review`);
  });
}

test("db push explicit local/dev does NOT select any POL-DB-MIGRATION-* rule", () => {
  const rule = matchPolicy({ task: "Run prisma db push on the local development database" }, DEFAULT_POLICY);
  assert.ok(rule, "expected a matching rule");
  assert.ok(
    !/^POL-DB-MIGRATION-/.test(rule.id),
    `db push must not match a migration rule; got ${rule.id}`,
  );
  assert.ok(/^POL-DB-SCHEMA-PUSH-/.test(rule.id), `expected a schema-push rule; got ${rule.id}`);
});

test("db push never matches any POL-DB-MIGRATION-* rule in any environment", () => {
  const inputs = [
    "Run prisma db push",
    "Run prisma db push on the local development database",
    "Run prisma db push against staging",
    "Run prisma db push against production",
    "Run prisma db push --accept-data-loss",
    "prisma db push --skip-generate",
  ];
  for (const task of inputs) {
    const rule = matchPolicy({ task }, DEFAULT_POLICY);
    assert.ok(rule, `"${task}" must match a rule`);
    assert.ok(
      !/^POL-DB-MIGRATION-/.test(rule.id),
      `"${task}" must not match POL-DB-MIGRATION-*; got ${rule.id}`,
    );
  }
});

test("migration commands still match migration rules (no over-correction)", () => {
  // Guard against the fix accidentally routing migrations to schema-push rules.
  assert.equal(matchPolicy({ task: "apply the local development database migration" }, DEFAULT_POLICY).id, "POL-DB-MIGRATION-1");
  assert.equal(matchPolicy({ task: "add a migration to create the events table" }, DEFAULT_POLICY).id, "POL-DB-MIGRATION-2");
  assert.equal(matchPolicy({ task: "pnpm prisma migrate deploy" }, DEFAULT_POLICY).id, "POL-DB-DEPLOY-UNKNOWN-1");
});

test("ordering contract: POL-DB-MIGRATION-2 does not shadow explicit environments", () => {
  // Explicit local/staging/prod/deploy must still resolve to their own rules.
  assert.equal(matchPolicy({ task: "apply the local development database migration" }, DEFAULT_POLICY).id, "POL-DB-MIGRATION-1");
  assert.equal(matchPolicy({ task: "run the migration against staging" }, DEFAULT_POLICY).id, "POL-DB-STAGING-1");
  assert.equal(matchPolicy({ task: "run the migration against production" }, DEFAULT_POLICY).id, "POL-DB-PROD-1");
  assert.equal(matchPolicy({ task: "pnpm prisma migrate deploy" }, DEFAULT_POLICY).id, "POL-DB-DEPLOY-UNKNOWN-1");
});
