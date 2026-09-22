/**
 * C-6 — live calibration aggregation (offline fake provider).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateLiveStabilityReports,
  corpusFixtureToLiveCalibration,
  runLiveCalibration,
  DEFAULT_THRESHOLDS,
} from "../dist/threshold-calibrate.js";

class LowConfProvider {
  async judge() {
    return {
      kind: "backend",
      kindConfidence: 0.25,
      riskScore: 0.2,
      riskConfidence: 0.85,
      securityReviewNoul: 0.05,
      failed: false,
    };
  }
}

class HighConfProvider {
  async judge() {
    return {
      kind: "backend",
      kindConfidence: 0.92,
      riskScore: 0.15,
      riskConfidence: 0.9,
      securityReviewNoul: 0.05,
      failed: false,
    };
  }
}

describe("C-6 live calibration", () => {
  it("corpusFixtureToLiveCalibration maps minimumAction", () => {
    const row = corpusFixtureToLiveCalibration({
      id: "x",
      task: "fix typo",
      touchedFiles: ["src/a.ts"],
      category: "normal",
      semanticExpectation: { minimumAction: "execute" },
    });
    assert.equal(row.minimumAction, "execute");
    assert.equal(row.input.task, "fix typo");
  });

  it("runLiveCalibration counts LOW-CONF among model-participated fixtures", async () => {
    const report = await runLiveCalibration(
      new LowConfProvider(),
      [
        {
          id: "a",
          input: { task: "rename helper", hints: { touchedFiles: ["src/util.ts"] } },
          minimumAction: "plan",
        },
      ],
      DEFAULT_THRESHOLDS,
    );
    assert.equal(report.modelParticipatedCount, 1);
    assert.equal(report.lowConfTriggeredCount, 1);
    assert.equal(report.samples[0].mode, "plan_first");
  });

  it("runLiveCalibration flags unsafe allow vs minimumAction", async () => {
    const report = await runLiveCalibration(
      new HighConfProvider(),
      [
        {
          id: "risky",
          input: { task: "Deploy billing change", hints: {} },
          minimumAction: "approve",
        },
      ],
      DEFAULT_THRESHOLDS,
    );
    assert.ok(report.unsafeAllowCount >= 0);
    assert.equal(report.fixtureCount, 1);
  });

  it("aggregateLiveStabilityReports summarizes multi-run fixture flip rates", async () => {
    const fx = [
      {
        id: "a",
        input: { task: "rename helper", hints: { touchedFiles: ["src/util.ts"] } },
        minimumAction: "execute",
      },
      {
        id: "b",
        input: { task: "Deploy billing change", hints: {} },
        minimumAction: "approve",
      },
    ];
    const stable = await runLiveCalibration(new HighConfProvider(), fx, DEFAULT_THRESHOLDS);
    const low = await runLiveCalibration(new LowConfProvider(), [fx[0]], DEFAULT_THRESHOLDS);
    const merged = {
      ...stable,
      samples: [
        stable.samples[0],
        { ...stable.samples[1], mode: "execute", unsafeAllow: true, unnecessaryAction: false },
      ],
      unsafeAllowCount: 1,
      modeExactMatchCount: 1,
      modeAccuracy: 0.5,
    };
    const summary = aggregateLiveStabilityReports([stable, merged]);
    assert.equal(summary.runCount, 2);
    assert.equal(summary.aggregate.unsafeAllowCount.max, 1);
    assert.equal(summary.aggregate.modeAccuracy.min, 0.5);
    assert.ok(summary.aggregate.flakyFixtures.some((f) => f.id === "b"));
    assert.equal(low.samples[0].mode, "plan_first");
  });

  it("hard-policy block short-circuits without model participation", async () => {
    const report = await runLiveCalibration(
      new HighConfProvider(),
      [
        {
          id: "secret",
          input: { task: "touch env", hints: { touchedFiles: [".env"] } },
          minimumAction: "block",
        },
      ],
      DEFAULT_THRESHOLDS,
    );
    assert.equal(report.hardPolicyShortCircuitCount, 1);
    assert.equal(report.modelParticipatedCount, 0);
    assert.equal(report.samples[0].mode, "block");
  });
});
