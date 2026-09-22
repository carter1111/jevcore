#!/usr/bin/env node
/**
 * Merge human-approved corpus candidates into fixtures.json.
 * Dry-run by default. Requires --apply + approvals.json with approvedIds.
 *
 *   node tools/corpus-merge.mjs
 *   node tools/corpus-merge.mjs --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeApprovedCandidates } from "../dist/corpus-review.js";
import { screenCorpusCandidates } from "../dist/corpus-screen.js";

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const inboxPath = join(here, "../tests/corpus/candidates/inbox.json");
const approvalsPath = join(here, "../tests/corpus/candidates/approvals.json");
const fixturesPath = join(here, "../tests/corpus/fixtures.json");

const inbox = JSON.parse(readFileSync(inboxPath, "utf8"));
const candidates = Array.isArray(inbox) ? inbox : inbox.candidates ?? [];
const approvals = JSON.parse(readFileSync(approvalsPath, "utf8"));
const corpus = JSON.parse(readFileSync(fixturesPath, "utf8"));

const screen = screenCorpusCandidates(candidates);
const blocked = screen.filter((s) => !s.ok && approvals.approvedIds.includes(s.id));
if (blocked.length) {
  console.error("Refusing merge: approved ids fail privacy screen:");
  for (const b of blocked) console.error(`  ${b.id}: ${b.reasons.join(", ")}`);
  process.exit(2);
}

let result;
try {
  result = mergeApprovedCandidates({
    existingFixtures: corpus.fixtures,
    candidates,
    approvals,
  });
} catch (e) {
  console.error(String(e.message || e));
  process.exit(2);
}

console.log("Corpus merge");
console.log("─".repeat(40));
console.log(`Would merge: ${result.mergedIds.join(", ") || "(none)"}`);
console.log(`Skipped:     ${result.skipped.join("; ") || "(none)"}`);
console.log(`New count:   ${result.fixtures.length}`);

if (!APPLY) {
  console.log("");
  console.log("Dry-run only. Re-run with --apply after human review of approvals.json.");
  process.exit(0);
}

if (result.mergedIds.length === 0) {
  console.error("Nothing to merge — check approvals.approvedIds");
  process.exit(1);
}

corpus.fixtures = result.fixtures;
corpus.count = result.fixtures.length;
if (typeof corpus.description === "string") {
  corpus.description = corpus.description.replace(
    /\d+ synthetic/,
    `${corpus.count} synthetic`,
  );
}
writeFileSync(fixturesPath, JSON.stringify(corpus, null, 2) + "\n");
console.log(`Applied merge into ${fixturesPath}`);
process.exit(0);
