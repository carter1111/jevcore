/**
 * C-5 Phase B — shared `systemOne` batch strategy (offline).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import {
  buildBatchQuestions,
  buildBatchState,
  parseBatchJudgments,
  DEFAULT_SHARED_CHUNK_SIZE,
} from "../dist/provider-batch.js";

class SharedCapturingProvider {
  judgeCalls = 0;
  judgeManyCalls = 0;
  lastJudgeManySize = 0;

  async judge() {
    this.judgeCalls += 1;
    return this.ok();
  }

  async judgeMany(inputs) {
    this.judgeManyCalls += 1;
    this.lastJudgeManySize = inputs.length;
    return inputs.map(() => this.ok());
  }

  ok() {
    return {
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    };
  }
}

describe("C-5 Phase B provider-batch helpers", () => {
  it("builds namespaced state and parses judgments", () => {
    const inputs = [
      { task: "add endpoint", hints: { touchedFiles: ["src/api.ts"] } },
      { task: "fix typo", hints: { touchedFiles: ["README.md"] } },
    ];
    const state = buildBatchState(inputs);
    assert.ok(state.items);
    assert.ok(state.items.i0);
    assert.ok(state.items.i1);

    // Risk scores are TypeSafe level indices (0..RISK_MAX_LEVEL), not 0..1.
    const answers = {
      i0_kind: { choice: "backend", confidence: 0.9 },
      i0_risk: { score: 1, confidence: 0.85 },
      i0_security_review: { noul: 0.1 },
      i1_kind: { choice: "general", confidence: 0.88 },
      i1_risk: { score: 0, confidence: 0.9 },
      i1_security_review: { noul: 0.05 },
    };
    const parsed = parseBatchJudgments(answers, 2);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].kind, "backend");
    assert.equal(parsed[0].riskScore, 1 / 3);
    assert.equal(parsed[1].riskScore, 0);
  });

  it("buildBatchQuestions prefixes keys per item", () => {
    const q = buildBatchQuestions(2);
    assert.ok(q.i0_kind);
    assert.ok(q.i1_risk);
    assert.equal(Object.keys(q).length >= 6, true);
  });
});

describe("C-5 Phase B decideMany shared_system_one", () => {
  it("uses one judgeMany call for a small batch", async () => {
    const provider = new SharedCapturingProvider();
    const g = new Guard(provider);
    const inputs = Array.from({ length: 4 }, (_, i) => ({ task: `work ${i}` }));
    const result = await g.decideManyWithMeta(inputs, { strategy: "shared_system_one" });
    assert.equal(result.meta.strategy, "shared_system_one");
    assert.equal(result.meta.providerCalls, 1);
    assert.equal(provider.judgeManyCalls, 1);
    assert.equal(provider.judgeCalls, 0);
    assert.equal(provider.lastJudgeManySize, 4);
    assert.equal(result.items.length, 4);
  });

  it("chunks judgeMany when over DEFAULT_SHARED_CHUNK_SIZE", async () => {
    const provider = new SharedCapturingProvider();
    const g = new Guard(provider);
    const n = DEFAULT_SHARED_CHUNK_SIZE + 2;
    const inputs = Array.from({ length: n }, (_, i) => ({ task: `chunk ${i}` }));
    const result = await g.decideManyWithMeta(inputs, { strategy: "shared_system_one" });
    assert.equal(provider.judgeManyCalls, 2);
    assert.equal(result.meta.providerCalls, 2);
    assert.equal(result.items.length, n);
  });

  it("never calls provider for hard-block items in shared batch", async () => {
    const provider = new SharedCapturingProvider();
    const g = new Guard(provider);
    const result = await g.decideManyWithMeta(
      [
        { task: "ordinary refactor", hints: { touchedFiles: ["src/a.ts"] } },
        { task: "touch credentials", hints: { touchedFiles: ["credentials/app.json"] } },
      ],
      { strategy: "shared_system_one" },
    );
    assert.equal(result.items[1].result.mode, "block");
    assert.equal(provider.judgeManyCalls, 1);
    assert.equal(provider.lastJudgeManySize, 1);
    assert.equal(result.meta.providerCalls, 1);
  });

  it("falls back per item when one batch judgment is missing", async () => {
    const provider = {
      judgeManyCalls: 0,
      async judgeMany(inputs) {
        this.judgeManyCalls += 1;
        const ok = new SharedCapturingProvider().ok();
        return inputs.map((_, i) => (i === 1 ? { failed: true, failureCode: "PROVIDER-INVALID-RISK-SCORE" } : ok));
      },
    };
    const g = new Guard(provider);
    const result = await g.decideManyWithMeta(
      [
        { task: "rename helper", hints: { touchedFiles: ["src/a.ts"] } },
        { task: "fix typo", hints: { touchedFiles: ["README.md"] } },
      ],
      { strategy: "shared_system_one" },
    );
    assert.equal(provider.judgeManyCalls, 1);
    assert.notEqual(result.items[0].result.mode, "block");
    assert.notEqual(result.items[1].result.mode, "execute");
    assert.equal(result.items[1].result.classification.source, "rule");
  });

  it("falls back to serial when provider lacks judgeMany", async () => {
    const provider = { async judge() { return new SharedCapturingProvider().ok(); } };
    const g = new Guard(provider);
    const result = await g.decideManyWithMeta(
      [{ task: "a" }, { task: "b" }],
      { strategy: "shared_system_one" },
    );
    assert.equal(result.meta.strategy, "serial");
  });
});
