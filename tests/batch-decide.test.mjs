/**
 * C-5 Phase A — Guard.decideMany / runDecideMany (offline).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import {
  BatchTooLargeError,
  DEFAULT_BATCH_MAX_ITEMS,
  runDecideMany,
} from "../dist/batch.js";

class CountingProvider {
  calls = 0;
  batchCalls = 0;
  async judge() {
    this.calls += 1;
    // Tiny delay so concurrency interleaves.
    await new Promise((r) => setTimeout(r, 5));
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
  async judgeMany(inputs) {
    this.batchCalls += 1;
    return inputs.map(() => ({
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.2,
      riskConfidence: 0.9,
      riskFactors: [],
      securityReviewNoul: 0.1,
      failed: false,
    }));
  }
}

describe("C-5 decideMany", () => {
  it("returns empty array for empty input", async () => {
    const g = new Guard(new CountingProvider());
    assert.deepEqual(await g.decideMany([]), []);
  });

  it("throws BatchTooLargeError when over maxItems", async () => {
    const g = new Guard(new CountingProvider());
    const inputs = Array.from({ length: DEFAULT_BATCH_MAX_ITEMS + 1 }, (_, i) => ({
      task: `task ${i}`,
    }));
    await assert.rejects(() => g.decideMany(inputs), (err) => {
      assert.ok(err instanceof BatchTooLargeError);
      assert.equal(err.code, "BATCH-TOO-LARGE");
      return true;
    });
  });

  it("never calls the provider for a hard-block item in a mixed batch", async () => {
    const provider = new CountingProvider();
    const g = new Guard(provider);
    const items = await g.decideMany(
      [
        { task: "rename a helper", hints: { touchedFiles: ["src/util.ts"] } },
        {
          task: "update local configuration",
          hints: { touchedFiles: ["config/local.env.example.bak"] },
        },
        // Strong secret-path evidence without putting secret material in the shell.
        { task: "touch credentials store", hints: { touchedFiles: ["credentials/app.json"] } },
      ],
      { concurrency: 2 },
    );
    assert.equal(items.length, 3);
    assert.equal(items[0].index, 0);
    assert.equal(items[2].index, 2);
    assert.equal(items[2].result.mode, "block");
    assert.ok(items[2].result.reasons.some((r) => r.code === "POL-SECRETS-1"));
    // Only non-block items may call the provider (item 0; item 1 may or may not
    // match a path rule depending on pattern — credentials path is the hard assert).
    assert.ok(provider.calls >= 1);
    assert.ok(provider.calls <= 2);
  });

  it("preserves order under concurrency", async () => {
    const provider = new CountingProvider();
    const g = new Guard(provider);
    const inputs = Array.from({ length: 8 }, (_, i) => ({ task: `ordinary work ${i}` }));
    const items = await g.decideMany(inputs, { concurrency: 4 });
    assert.deepEqual(
      items.map((x) => x.index),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(provider.calls, 8);
  });

  it("runDecideMany works as a standalone helper", async () => {
    let n = 0;
    const out = await runDecideMany(
      async () => {
        n += 1;
        return {
          classification: { kind: "general", confidence: 1, source: "rule" },
          risk: { score: 0, confidence: 1, factors: [] },
          security: { reviewNeeded: false, noul: 0, findings: [] },
          mode: "execute",
          reasons: [],
          fellBack: false,
        };
      },
      [{ task: "a" }, { task: "b" }],
      { concurrency: 2 },
    );
    assert.equal(n, 2);
    assert.equal(out[1].index, 1);
  });

  it("shared_system_one uses one judgeMany per chunk", async () => {
    const provider = new CountingProvider();
    const g = new Guard(provider);
    const inputs = Array.from({ length: 5 }, (_, i) => ({ task: `work ${i}` }));
    const { items, meta } = await g.decideManyWithMeta(inputs, {
      strategy: "shared_system_one",
    });
    assert.equal(items.length, 5);
    assert.equal(meta.strategy, "shared_system_one");
    assert.equal(meta.providerCalls, 1);
    assert.equal(provider.batchCalls, 1);
    assert.equal(provider.calls, 0);
  });

  it("shared_system_one skips provider for preflight blocks", async () => {
    const provider = new CountingProvider();
    const g = new Guard(provider);
    const { items, meta } = await g.decideManyWithMeta(
      [
        { task: "ordinary", hints: { touchedFiles: ["src/a.ts"] } },
        { task: "secrets path", hints: { touchedFiles: ["credentials/x.json"] } },
      ],
      { strategy: "shared_system_one" },
    );
    assert.equal(items[1].result.mode, "block");
    assert.equal(items[1].settledBy, "hard_policy_preflight");
    assert.equal(meta.providerCalls, 1);
    assert.equal(provider.batchCalls, 1);
  });

  it("decideManyStream yields the same modes as decideMany", async () => {
    const provider = new CountingProvider();
    const g = new Guard(provider);
    const inputs = [
      { task: "ordinary rename", hints: { touchedFiles: ["src/a.ts"] } },
      { task: "secrets path", hints: { touchedFiles: ["credentials/x.json"] } },
    ];
    const batch = await g.decideMany(inputs);
    const streamed = [];
    for await (const item of g.decideManyStream(inputs)) streamed.push(item);
    assert.equal(streamed.length, 2);
    const byIndex = [...streamed].sort((a, b) => a.index - b.index);
    assert.equal(byIndex[0].result.mode, batch[0].result.mode);
    assert.equal(byIndex[1].result.mode, "block");
    await assert.rejects(
      async () => {
        for await (const _item of g.decideManyStream(inputs, { strategy: "shared_system_one" })) {
          /* drain */
        }
      },
      /serial strategy only/,
    );
  });
});
