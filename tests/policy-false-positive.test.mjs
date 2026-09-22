/**
 * T01 / M-PolicyPrecision — hard-policy false-positive counterexamples.
 *
 * Lexical “migrat*” must NOT trigger POL-DB-MIGRATION-* without a DB domain
 * cue. True prisma/SQL migrate cases remain gated (see db-environment-policy).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchPolicy } from "../dist/policy.js";

function ruleId(input) {
  return matchPolicy(input)?.id ?? null;
}

describe("T01 policy false positives (migrat*)", () => {
  it("rename-sense: migrate field/type to identifier does not hit DB migrat*", () => {
    assert.equal(
      ruleId({ task: "Rename the draft field name — migrate to `agent` in the UX doc" }),
      null,
    );
    assert.equal(
      ruleId({
        task: "migrate the json key to agent in Docs/UX-Function-Improvement.md",
        hints: { touchedFiles: ["Docs/UX-Function-Improvement.md"] },
      }),
      null,
    );
    assert.equal(ruleId({ task: "migrate the User type to a shared package" }), null);
    assert.equal(ruleId({ task: "migrate to agent for the contract field" }), null);
  });

  it("docs-only paths with migrat* prose and no DB cue skip DB rules", () => {
    assert.equal(
      ruleId({
        task: "Update the migration section heading in the design note",
        hints: { touchedFiles: ["Docs/UX-Function-Improvement.md"] },
      }),
      null,
    );
    assert.equal(
      ruleId({
        task: "python3 write Docs/notes.md containing the word migration in a heading",
        hints: { touchedFiles: ["Docs/notes.md"] },
      }),
      null,
    );
  });

  it("meta/research discuss POL-DB-MIGRATION false positives without proposedCommand", () => {
    assert.equal(
      ruleId({
        task: "Explain POL-DB-MIGRATION-2 false positives in hard-policy matchers",
        hints: {},
      }),
      null,
    );
    assert.equal(
      ruleId({
        task: "Tighten hard-policy matchers so lexical migrate false positives stop requiring approval",
      }),
      null,
    );
    assert.equal(
      ruleId({
        task: "Research and analyze matcher false positives for migration tokens",
      }),
      null,
    );
    assert.equal(
      ruleId({
        task:
          "Review hard-policy matcher precision for DB migration false-positive reduction; EXPLICIT forms include apply/run migrations; no Proposed command",
      }),
      null,
    );
  });
});

describe("T01 true positives still gated", () => {
  it("prisma migrate deploy / unknown target still hit", () => {
    assert.equal(
      ruleId({
        task: "Assess the proposed database migration deploy command\nProposed command: pnpm prisma migrate deploy",
      }),
      "POL-DB-DEPLOY-UNKNOWN-1",
    );
  });

  it("staging DB migrations still hit", () => {
    assert.equal(
      ruleId({
        task: "Run the database migration against staging\nProposed command: pnpm prisma migrate deploy",
      }),
      "POL-DB-STAGING-1",
    );
  });

  it("local migrate still maps to POL-DB-MIGRATION-1", () => {
    assert.equal(
      ruleId({
        task: "Apply the local development database migration\nProposed command: npx prisma migrate dev --name add_events",
      }),
      "POL-DB-MIGRATION-1",
    );
  });

  it("unclassified migration with table/schema cue still hits POL-DB-MIGRATION-2", () => {
    assert.equal(
      ruleId({ task: "Add a migration for the events table" }),
      "POL-DB-MIGRATION-2",
    );
    assert.equal(
      ruleId({ task: "add a migration to create the events table" }),
      "POL-DB-MIGRATION-2",
    );
  });

  it("destructive SQL / secrets / web3 / force-push / rm -rf still hit", () => {
    assert.equal(ruleId({ task: "DROP TABLE users in production" }), "POL-DB-DESTRUCTIVE-1");
    assert.equal(
      ruleId({ task: "truncate the sessions table" }),
      "POL-DB-DESTRUCTIVE-1",
    );
    assert.equal(
      ruleId({ task: "touch env", hints: { touchedFiles: [".env"] } }),
      "POL-SECRETS-1",
    );
    assert.equal(
      ruleId({ task: "Call ERC-20 approve for the router spender" }),
      "POL-WEB3-ASSET-1",
    );
    assert.equal(
      ruleId({ task: "git push --force origin main" }),
      "POL-FORCE-PUSH-1",
    );
    assert.equal(ruleId({ task: "rm -rf ./dist" }), "POL-DESTRUCTIVE-CMD-1");
  });
});
