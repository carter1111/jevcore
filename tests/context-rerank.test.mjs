/**
 * P5 Jev identifier rerank — pure helpers + Guard wiring (fake reranker).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import {
  CONTEXT_RERANK_MIN_PATHS,
  isContextRerankEnabled,
  orderByRelevanceScores,
  buildRerankQuestions,
} from "../dist/context-rerank.js";

describe("isContextRerankEnabled", () => {
  it("defaults ON; only 0 disables", () => {
    assert.equal(isContextRerankEnabled({}), true);
    assert.equal(isContextRerankEnabled({ JEV_CONTEXT_RERANK: "1" }), true);
    assert.equal(isContextRerankEnabled({ JEV_CONTEXT_RERANK: "0" }), false);
  });
});

describe("orderByRelevanceScores", () => {
  it("orders by descending score; stable on ties", () => {
    const paths = ["a.ts", "b.ts", "c.ts"];
    const ordered = orderByRelevanceScores(paths, {
      rel_0: 1,
      rel_1: 3,
      rel_2: 3,
    });
    assert.deepEqual(ordered, ["b.ts", "c.ts", "a.ts"]);
  });

  it("puts missing scores last", () => {
    const ordered = orderByRelevanceScores(["a.ts", "b.ts"], { rel_1: 2 });
    assert.deepEqual(ordered, ["b.ts", "a.ts"]);
  });
});

describe("buildRerankQuestions", () => {
  it("emits one score question per candidate", () => {
    const q = buildRerankQuestions(3);
    assert.equal(Object.keys(q).length, 3);
    assert.ok(q.rel_0);
    assert.ok(q.rel_2);
  });
});

describe("Guard + ContextReranker", () => {
  const fakeOk = {
    judge: async () => ({
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.1,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0,
      failed: false,
    }),
  };

  it("applies identifier-only rerank when ≥2 paths", async () => {
    let seen = null;
    const g = new Guard(fakeOk, {
      contextReranker: {
        async rerank(task, paths) {
          seen = { task, paths: [...paths] };
          return [...paths].reverse();
        },
      },
    });
    const r = await g.decide({
      task: "adjust the shared formatting helper",
      hints: { touchedFiles: ["src/format.ts", "src/util.ts", "src/other.ts"] },
    });
    assert.ok(seen);
    assert.ok(seen.paths.length >= CONTEXT_RERANK_MIN_PATHS);
    assert.ok(!JSON.stringify(seen).includes("\n"));
    assert.ok(r.contextSuggestion);
    assert.equal(r.contextSuggestion.source, "deterministic+rerank");
    assert.ok(r.contextSuggestion.reasonIds.includes("CR-RERANK"));
  });

  it("keeps deterministic ranking when reranker returns null", async () => {
    const g = new Guard(fakeOk, {
      contextReranker: {
        async rerank() {
          return null;
        },
      },
    });
    const r = await g.decide({
      task: "adjust the shared formatting helper",
      hints: { touchedFiles: ["src/format.ts", "src/util.ts"] },
    });
    assert.ok(r.contextSuggestion);
    assert.equal(r.contextSuggestion.source, "deterministic");
    assert.ok(!r.contextSuggestion.reasonIds.includes("CR-RERANK"));
  });

  it("keeps deterministic ranking when reranker throws", async () => {
    const g = new Guard(fakeOk, {
      contextReranker: {
        async rerank() {
          throw new Error("boom");
        },
      },
    });
    const r = await g.decide({
      task: "adjust the shared formatting helper",
      hints: { touchedFiles: ["src/format.ts", "src/util.ts"] },
    });
    assert.ok(r.contextSuggestion);
    assert.equal(r.contextSuggestion.source, "deterministic");
  });

  it("skips Jev rerank for a single path candidate", async () => {
    let called = 0;
    const g = new Guard(fakeOk, {
      contextReranker: {
        async rerank() {
          called += 1;
          return ["only.ts"];
        },
      },
    });
    const r = await g.decide({
      task: "tweak formatting",
      hints: { touchedFiles: ["src/format.ts"] },
    });
    assert.equal(called, 0);
    assert.ok(r.contextSuggestion);
    assert.equal(r.contextSuggestion.source, "deterministic");
  });
});
