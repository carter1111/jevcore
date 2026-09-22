#!/usr/bin/env node
/**
 * Propose corpus candidates for human review (screen + offline decide).
 * Does NOT merge into fixtures.json.
 *
 *   node tools/corpus-propose.mjs
 *   node tools/corpus-propose.mjs --json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Guard } from "../dist/engine.js";
import { buildReviewQueue } from "../dist/corpus-review.js";

const JSON_ONLY = process.argv.includes("--json");
const here = dirname(fileURLToPath(import.meta.url));
const inboxPath = join(here, "../tests/corpus/candidates/inbox.json");
const outPath = join(here, "../tests/corpus/candidates/review-queue.json");

class PermissiveFake {
  async judge() {
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

const inbox = JSON.parse(readFileSync(inboxPath, "utf8"));
const candidates = Array.isArray(inbox) ? inbox : inbox.candidates ?? [];
const corpus = JSON.parse(
  readFileSync(join(here, "../tests/corpus/fixtures.json"), "utf8"),
);
const existingIds = new Set(corpus.fixtures.map((f) => f.id));

const offlineModes = new Map();
const guard = new Guard(new PermissiveFake());
for (const c of candidates) {
  const r = await guard.decide({
    task: c.task,
    hints: { touchedFiles: c.touchedFiles ?? [] },
  });
  offlineModes.set(c.id, r.mode);
}

const report = buildReviewQueue({ candidates, existingIds, offlineModes });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Corpus propose (human review queue)");
  console.log("─".repeat(48));
  console.log(`Inbox:        ${inboxPath}`);
  console.log(`Screened:     ${report.screened}`);
  console.log(`Rejected:     ${report.rejectedByScreen}`);
  console.log(`Ready:        ${report.readyForHumanReview}`);
  console.log(`Duplicates:   ${report.duplicates}`);
  console.log(`Wrote:        ${outPath}`);
  console.log("");
  console.log("Next: edit tests/corpus/candidates/approvals.json with approvedIds,");
  console.log("      then: npm run corpus:merge -- --apply");
}
process.exit(0);
