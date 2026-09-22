/**
 * De-identification screen for corpus candidates (offline).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { screenCorpusCandidate, screenCorpusCandidates } from "../dist/corpus-screen.js";

describe("corpus screen", () => {
  it("rejects credential-like and absolute-path candidates", () => {
    const bad = screenCorpusCandidate({
      id: "leak",
      task: "see https://example.com and user@example.com",
      touchedFiles: ["/Users/someone/project/.env"],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.reasons.includes("url"));
    assert.ok(bad.reasons.includes("email"));
    assert.ok(bad.reasons.includes("absolute-path"));
  });

  it("accepts the checked-in WP3 corpus", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("./corpus/fixtures.json", import.meta.url), "utf8"),
    );
    const results = screenCorpusCandidates(corpus.fixtures);
    const bad = results.filter((r) => !r.ok);
    assert.deepEqual(bad, []);
  });
});
