/**
 * C-5 — FanOutProvider delegates judgeMany to batch-capable inner provider.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FanOutProvider } from "../dist/fan-out.js";
import { InstrumentedProvider } from "../dist/telemetry/instrumented-provider.js";
import { Guard } from "../dist/engine.js";

class InnerBatchProvider {
  judgeManyCalls = 0;
  judgeCalls = 0;

  async judge() {
    this.judgeCalls += 1;
    return { kind: "backend", kindConfidence: 0.9, riskScore: 0.2, riskConfidence: 0.9, failed: false };
  }

  async judgeMany(inputs) {
    this.judgeManyCalls += 1;
    return Promise.all(inputs.map(() => this.judge()));
  }
}

describe("FanOutProvider judgeMany", () => {
  it("delegates to inner judgeMany without serial judge fan-out", async () => {
    const inner = new InnerBatchProvider();
    const wrapped = new FanOutProvider(inner);
    const guard = new Guard(wrapped);
    const inputs = [{ task: "a" }, { task: "b" }];
    const { meta } = await guard.decideManyWithMeta(inputs, { strategy: "shared_system_one" });
    assert.equal(meta.strategy, "shared_system_one");
    assert.equal(meta.providerCalls, 1);
    assert.equal(inner.judgeManyCalls, 1);
    assert.ok(inner.judgeCalls >= 0);
  });

  it("InstrumentedProvider forwards judgeMany", async () => {
    const inner = new InnerBatchProvider();
    let observed = 0;
    const wrapped = new InstrumentedProvider(inner, { observe: () => { observed += 1; } });
    await wrapped.judgeMany([{ task: "x" }, { task: "y" }]);
    assert.equal(inner.judgeManyCalls, 1);
    assert.equal(observed, 1);
  });
});
