/**
 * C-2 / C-6 — offline threshold calibration (labeled dataset).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calibrateFromDataset,
  gridSearchCalibrationLabels,
  evaluateCalibrationLabels,
} from "../dist/threshold-calibrate.js";

const DATA = JSON.parse(
  readFileSync(new URL("./corpus/calibration-labels.json", import.meta.url), "utf8"),
);

describe("threshold calibration", () => {
  it("dataset has at least 20 labeled fixtures", () => {
    assert.ok(DATA.fixtures.length >= 20);
    assert.equal(DATA.count, DATA.fixtures.length);
  });

  it("defaults match all labeled fixtures", async () => {
    const metrics = await evaluateCalibrationLabels(DATA.fixtures, DATA.thresholdDefaults);
    assert.deepEqual(metrics.mismatches, []);
    assert.equal(metrics.modeAccuracy, 1);
  });

  it("calibrateFromDataset reports full accuracy at defaults", async () => {
    const report = await calibrateFromDataset(DATA);
    assert.equal(report.mode, "offline-labeled");
    assert.equal(report.metrics.modeAccuracy, 1);
    assert.equal(report.metrics.mismatches.length, 0);
  });

  it("grid search returns a recommendation", async () => {
    const report = await gridSearchCalibrationLabels(DATA);
    assert.ok(report.recommendation.length > 0);
    assert.equal(report.baseline.metrics.modeAccuracy, 1);
  });
});
