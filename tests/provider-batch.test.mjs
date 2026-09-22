/**
 * C-5 Phase B — provider-batch helpers (offline).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  batchItemId,
  buildBatchQuestions,
  buildBatchState,
  parseBatchJudgments,
} from "../dist/provider-batch.js";

describe("provider-batch", () => {
  it("buildBatchState lists items by id", () => {
    const state = buildBatchState([
      { task: "a", hints: { touchedFiles: ["src/a.ts"] } },
      { task: "b" },
    ]);
    assert.equal(state.batchVersion, "2026-09-21.1");
    assert.equal(state.items.i0.task, "a");
    assert.deepEqual(state.items.i0.touchedFiles, ["src/a.ts"]);
    assert.equal(state.items.i1.task, "b");
  });

  it("buildBatchQuestions namespaces keys per item", () => {
    const q = buildBatchQuestions(2);
    assert.ok(q.i0_kind);
    assert.ok(q.i0_risk);
    assert.ok(q.i1_kind);
    assert.ok(q.i1_security_review);
    assert.ok(!q.kind);
  });

  it("parseBatchJudgments maps prefixed answers", () => {
    const judgments = parseBatchJudgments(
      {
        i0_kind: { choice: "backend", confidence: 0.9 },
        i0_risk: { score: 0, confidence: 0.85 },
        i0_factor_scope: { noul: 0.1 },
        i0_factor_destructive: { noul: 0.1 },
        i0_factor_data: { noul: 0.1 },
        i0_factor_security: { noul: 0.1 },
        i0_factor_irreversible: { noul: 0.1 },
        i0_factor_unclear: { noul: 0.1 },
        i0_security_review: { noul: 0.05 },
      },
      1,
    );
    assert.equal(judgments[0].kind, "backend");
    assert.equal(judgments[0].riskScore, 0);
    assert.equal(judgments[0].failed, false);
  });

  it("batchItemId is stable", () => {
    assert.equal(batchItemId(0), "i0");
    assert.equal(batchItemId(3), "i3");
  });

  it("parseBatchJudgments marks missing item answers as failed", () => {
    const judgments = parseBatchJudgments(
      {
        i0_kind: { choice: "backend", confidence: 0.9 },
        i0_risk: { score: 0, confidence: 0.85 },
        i0_security_review: { noul: 0.05 },
        i1_kind: { choice: "general", confidence: 0.88 },
        // i1_risk missing → failed for item 1 only
      },
      2,
    );
    assert.equal(judgments.length, 2);
    assert.equal(judgments[0].failed, false);
    assert.equal(judgments[1].failed, true);
    assert.equal(judgments[1].failureCode, "PROVIDER-INVALID-RISK-SCORE");
  });
});
