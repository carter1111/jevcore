#!/usr/bin/env node
/**
 * Screen corpus fixtures (or a candidate JSON file) for de-identification.
 * Does not merge candidates and does not print task text on failure — ids + reason codes only.
 *
 *   node tools/corpus-screen.mjs
 *   node tools/corpus-screen.mjs path/to/candidates.json
 */
import { readFileSync } from "node:fs";

import { screenCorpusCandidates } from "../dist/corpus-screen.js";

const file = process.argv[2]
  ? process.argv[2]
  : new URL("../tests/corpus/fixtures.json", import.meta.url);

const raw = JSON.parse(readFileSync(file, "utf8"));
const fixtures = Array.isArray(raw) ? raw : raw.fixtures;
const results = screenCorpusCandidates(fixtures);
const bad = results.filter((r) => !r.ok);

console.log(`Screened ${results.length} fixtures; rejected ${bad.length}`);
for (const r of bad) {
  console.log(`  ${r.id}: ${r.reasons.join(", ")}`);
}
process.exit(bad.length === 0 ? 0 : 1);
