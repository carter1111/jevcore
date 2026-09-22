/**
 * C-5 §8 — WP3 multi-item batch corpus scenarios (offline).
 *
 * Loads tests/corpus/batch-fixtures.json and resolves fixtureRefs against
 * tests/corpus/fixtures.json. Proves batch invariants from C5 §8 testing plan:
 *   - all-hard-block → providerCalls === 0
 *   - mixed block + allowed → provider called once; blocks unchanged
 *   - shared_system_one modes match serial on the same inputs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Guard } from "../dist/engine.js";

const CORPUS = JSON.parse(
  readFileSync(new URL("./corpus/fixtures.json", import.meta.url), "utf8"),
);
const BATCH = JSON.parse(
  readFileSync(new URL("./corpus/batch-fixtures.json", import.meta.url), "utf8"),
);

const FIXTURE_BY_ID = new Map(CORPUS.fixtures.map((f) => [f.id, f]));

const ACTION_RANK = { execute: 0, plan: 1, approve: 2, block: 3 };

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

function inputFor(fixture) {
  return { task: fixture.task, hints: { touchedFiles: fixture.touchedFiles ?? [] } };
}

function resolveScenario(scenario) {
  const fixtures = scenario.fixtureRefs.map((id) => {
    const f = FIXTURE_BY_ID.get(id);
    assert.ok(f, `${scenario.id}: unknown fixture ref ${id}`);
    return f;
  });
  return fixtures.map(inputFor);
}

class PermissiveFakeProvider {
  constructor() {
    this.calls = 0;
    this.judgeManyCalls = 0;
    this.lastJudgeManySize = 0;
  }

  async judge() {
    this.calls += 1;
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
      kindConfidence: 0.95,
      riskScore: 0.05,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.05,
      failed: false,
    };
  }
}

describe("C-5 §8 batch corpus", () => {
  it("declares exactly 2 scenarios", () => {
    assert.equal(BATCH.count, 2);
    assert.equal(BATCH.scenarios.length, 2);
  });

  it("scenario ids are unique and refs resolve", () => {
    const ids = BATCH.scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of BATCH.scenarios) {
      assert.ok(Array.isArray(s.fixtureRefs) && s.fixtureRefs.length >= 2, `${s.id} has >=2 refs`);
      resolveScenario(s);
    }
  });

  for (const scenario of BATCH.scenarios) {
    it(`${scenario.id}: meets deterministic batch expectations`, async () => {
      const inputs = resolveScenario(scenario);
      const exp = scenario.deterministicExpectation;
      const provider = new PermissiveFakeProvider();
      const guard = new Guard(provider);
      const { items, meta } = await guard.decideManyWithMeta(inputs, {
        strategy: exp.strategy,
      });

      assert.equal(meta.strategy, exp.strategy);
      assert.equal(meta.providerCalls, exp.providerCalls, `${scenario.id} providerCalls`);
      assert.equal(items.length, exp.minimumActionPerItem.length);

      for (let i = 0; i < items.length; i++) {
        const actual = actionOf(items[i].result.mode);
        const minimum = exp.minimumActionPerItem[i];
        assert.ok(
          ACTION_RANK[actual] >= ACTION_RANK[minimum],
          `${scenario.id}[${i}]: got ${actual}, need >= ${minimum}`,
        );
      }

      if (exp.providerCalls === 0) {
        assert.equal(provider.judgeManyCalls, 0);
        assert.equal(provider.calls, 0);
      }
    });

    it(`${scenario.id}: shared_system_one modes match serial`, async () => {
      const inputs = resolveScenario(scenario);
      const sharedProvider = new PermissiveFakeProvider();
      const serialProvider = new PermissiveFakeProvider();
      const shared = await new Guard(sharedProvider).decideManyWithMeta(inputs, {
        strategy: "shared_system_one",
      });
      const serial = await new Guard(serialProvider).decideManyWithMeta(inputs, {
        strategy: "serial",
      });
      assert.equal(shared.items.length, serial.items.length);
      for (let i = 0; i < shared.items.length; i++) {
        assert.equal(
          shared.items[i].result.mode,
          serial.items[i].result.mode,
          `${scenario.id}[${i}] mode parity`,
        );
      }
    });
  }
});
