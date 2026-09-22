/**
 * C-2 — labeled calibration set matches Guard at default thresholds.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Guard } from "../dist/engine.js";

const DATA = JSON.parse(
  readFileSync(new URL("./corpus/calibration-labels.json", import.meta.url), "utf8"),
);

class FixtureProvider {
  constructor(judgment) {
    this.judgment = judgment;
  }
  async judge() {
    return { ...this.judgment, failed: this.judgment.failed === true };
  }
}

describe("C-2 calibration labels", () => {
  it("all fixtures match expected mode at default thresholds", async () => {
    const mismatches = [];
    for (const fx of DATA.fixtures) {
      const guard = new Guard(new FixtureProvider(fx.judgment), DATA.thresholdDefaults);
      const result = await guard.decide(fx.input);
      if (result.mode !== fx.expectedMode) {
        mismatches.push(`${fx.id}: expected ${fx.expectedMode}, got ${result.mode}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  it("dataset has at least 20 labeled fixtures", () => {
    assert.ok(DATA.fixtures.length >= 20);
    assert.equal(DATA.count, DATA.fixtures.length);
  });
});
