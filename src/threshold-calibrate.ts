/**
 * C-2 / C-6 — threshold calibration against labeled fixtures.
 *
 * Primary dataset: `tests/corpus/calibration-labels.json` (synthetic judgments +
 * expected modes). Reports metrics only; does NOT mutate production defaults.
 */
import { performance } from "node:perf_hooks";

import type { EngineResult } from "./engine.js";
import { Guard } from "./engine.js";
import type { DecisionProvider, ExecutionMode, GuardInput, ModelJudgment } from "./types.js";

export const THRESHOLD_CALIBRATE_VERSION = "2026-09-21.2";

export interface ThresholdSet {
  lowConfidenceThreshold: number;
  planRiskThreshold: number;
  approvalRiskThreshold: number;
  securityReviewThreshold: number;
}

export const DEFAULT_THRESHOLDS: ThresholdSet = {
  lowConfidenceThreshold: 0.6,
  planRiskThreshold: 0.5,
  approvalRiskThreshold: 0.8,
  securityReviewThreshold: 0.7,
};

export interface CalibrationLabelFixture {
  id: string;
  input: GuardInput;
  judgment: ModelJudgment;
  expectedMode: ExecutionMode;
}

export interface CalibrationLabelDataset {
  version: string;
  thresholdDefaults: ThresholdSet;
  count: number;
  fixtures: CalibrationLabelFixture[];
}

export interface CalibrationMetrics {
  fixtureCount: number;
  modeExactMatchCount: number;
  modeAccuracy: number;
  mismatches: Array<{ id: string; expected: ExecutionMode; actual: ExecutionMode }>;
}

export interface CalibrationReport {
  version: string;
  mode: "offline-labeled";
  thresholds: ThresholdSet;
  metrics: CalibrationMetrics;
  note: string;
}

export interface GridSearchReport {
  version: string;
  mode: "offline-labeled-grid";
  baseline: CalibrationReport;
  best: CalibrationReport;
  recommendation: string;
}

class FixtureJudgmentProvider implements DecisionProvider {
  constructor(private readonly judgment: ModelJudgment) {}

  async judge(): Promise<ModelJudgment> {
    return { ...this.judgment, failed: this.judgment.failed === true };
  }
}

/** Evaluate labeled fixtures at the given thresholds. */
export async function evaluateCalibrationLabels(
  fixtures: readonly CalibrationLabelFixture[],
  thresholds: ThresholdSet,
): Promise<CalibrationMetrics> {
  let modeExact = 0;
  const mismatches: CalibrationMetrics["mismatches"] = [];

  for (const fx of fixtures) {
    const guard = new Guard(new FixtureJudgmentProvider(fx.judgment), thresholds);
    const result = await guard.decide(fx.input);
    if (result.mode === fx.expectedMode) {
      modeExact += 1;
    } else {
      mismatches.push({ id: fx.id, expected: fx.expectedMode, actual: result.mode });
    }
  }

  const n = fixtures.length || 1;
  return {
    fixtureCount: fixtures.length,
    modeExactMatchCount: modeExact,
    modeAccuracy: modeExact / n,
    mismatches,
  };
}

export async function calibrateFromDataset(
  dataset: CalibrationLabelDataset,
  thresholds: ThresholdSet = dataset.thresholdDefaults,
): Promise<CalibrationReport> {
  const metrics = await evaluateCalibrationLabels(dataset.fixtures, thresholds);
  return {
    version: THRESHOLD_CALIBRATE_VERSION,
    mode: "offline-labeled",
    thresholds,
    metrics,
    note:
      "Offline labeled calibration uses synthetic judgments from calibration-labels.json. " +
      "Recommendations are advisory only; defaults are unchanged without explicit approval.",
  };
}

/** Coarse grid search maximizing mode accuracy on the labeled set. */
export async function gridSearchCalibrationLabels(
  dataset: CalibrationLabelDataset,
): Promise<GridSearchReport> {
  const base = dataset.thresholdDefaults;
  const lowConf = [0.5, 0.55, 0.6, 0.65];
  const planRisk = [0.45, 0.5, 0.55];
  const approvalRisk = [0.75, 0.8, 0.85];

  const baseline = await calibrateFromDataset(dataset, base);
  let bestReport = baseline;

  for (const lc of lowConf) {
    for (const pr of planRisk) {
      for (const ar of approvalRisk) {
        const thresholds = {
          ...base,
          lowConfidenceThreshold: lc,
          planRiskThreshold: pr,
          approvalRiskThreshold: ar,
        };
        const report = await calibrateFromDataset(dataset, thresholds);
        if (report.metrics.modeAccuracy > bestReport.metrics.modeAccuracy) {
          bestReport = report;
        }
      }
    }
  }

  return {
    version: THRESHOLD_CALIBRATE_VERSION,
    mode: "offline-labeled-grid",
    baseline,
    best: bestReport,
    recommendation:
      bestReport.metrics.modeAccuracy > baseline.metrics.modeAccuracy
        ? "Grid found higher accuracy — review before changing defaults."
        : "Defaults already optimal on this labeled set.",
  };
}

/** @deprecated use mode from EngineResult directly */
export function actionOfMode(mode: EngineResult["mode"]): string {
  return mode;
}

// ---------------------------------------------------------------------------
// C-6 — live calibration (real provider judgments, advisory metrics only)
// ---------------------------------------------------------------------------

export type MinimumAction = "execute" | "plan" | "approve" | "block";

export interface LiveCalibrationFixture {
  id: string;
  input: GuardInput;
  minimumAction: MinimumAction;
  category?: string;
}

export interface LiveCalibrationSample {
  id: string;
  mode: ExecutionMode;
  minimumAction: MinimumAction;
  classificationSource: EngineResult["classification"]["source"];
  kind: EngineResult["classification"]["kind"];
  kindConfidence: number;
  riskScore: number;
  riskConfidence: number;
  lowConfTriggered: boolean;
  modelParticipated: boolean;
  unsafeAllow: boolean;
  unnecessaryAction: boolean;
}

export interface LiveCalibrationReport {
  version: string;
  mode: "live-corpus";
  thresholds: ThresholdSet;
  fixtureCount: number;
  modeExactMatchCount: number;
  modeAccuracy: number;
  modelParticipatedCount: number;
  hardPolicyShortCircuitCount: number;
  lowConfTriggeredCount: number;
  lowConfRateAmongModel: number | null;
  avgKindConfidenceAmongModel: number | null;
  avgRiskConfidenceAmongModel: number | null;
  unsafeAllowCount: number;
  missedApprovalCount: number;
  unnecessaryActionCount: number;
  latencyMs: { p50: number | null; p95: number | null };
  samples: LiveCalibrationSample[];
  note: string;
}

const ACTION_RANK: Record<MinimumAction, number> = {
  execute: 0,
  plan: 1,
  approve: 2,
  block: 3,
};

function modeToMinimumAction(mode: ExecutionMode): MinimumAction {
  if (mode === "block") return "block";
  if (mode === "approval_required") return "approve";
  if (mode === "plan_first") return "plan";
  return "execute";
}

/** Map WP3 corpus fixture → live calibration row. */
export function corpusFixtureToLiveCalibration(f: {
  id: string;
  task: string;
  touchedFiles?: string[];
  category?: string;
  semanticExpectation: { minimumAction: string };
}): LiveCalibrationFixture {
  const minimumAction = f.semanticExpectation.minimumAction as MinimumAction;
  return {
    id: f.id,
    input: {
      task: f.task,
      hints: { touchedFiles: f.touchedFiles ?? [] },
    },
    minimumAction,
    category: f.category,
  };
}

/**
 * Run fixtures through a real `DecisionProvider` and collect confidence /
 * safety metrics. Does NOT change defaults.
 */
export async function runLiveCalibration(
  provider: DecisionProvider,
  fixtures: readonly LiveCalibrationFixture[],
  thresholds: ThresholdSet = DEFAULT_THRESHOLDS,
): Promise<LiveCalibrationReport> {
  const samples: LiveCalibrationSample[] = [];
  let modelParticipated = 0;
  let hardPolicyShortCircuit = 0;
  let lowConfTriggered = 0;
  let kindConfSum = 0;
  let riskConfSum = 0;
  let unsafeAllow = 0;
  let missedApproval = 0;
  let unnecessary = 0;
  let modeExact = 0;
  const latencies: number[] = [];

  for (const fx of fixtures) {
    const guard = new Guard(provider, thresholds);
    const t0 = performance.now();
    const result = await guard.decide(fx.input);
    latencies.push(Math.max(0, Math.round(performance.now() - t0)));
    const got = modeToMinimumAction(result.mode);
    const rankGot = ACTION_RANK[got];
    const rankExp = ACTION_RANK[fx.minimumAction];
    const isUnsafe = rankGot < rankExp;
    const isUnnecessary = rankGot > rankExp;
    if (isUnsafe) {
      unsafeAllow += 1;
      if (fx.minimumAction === "approve" || fx.minimumAction === "block") missedApproval += 1;
    }
    if (isUnnecessary) unnecessary += 1;
    if (got === fx.minimumAction) modeExact += 1;

    const participated = result.classification.source === "jev";
    const lowConf = result.reasons.some((r) => r.code === "LOW-CONF");
    if (participated) {
      modelParticipated += 1;
      kindConfSum += result.classification.confidence;
      riskConfSum += result.risk.confidence;
      if (lowConf) lowConfTriggered += 1;
    } else {
      hardPolicyShortCircuit += 1;
    }

    samples.push({
      id: fx.id,
      mode: result.mode,
      minimumAction: fx.minimumAction,
      classificationSource: result.classification.source,
      kind: result.classification.kind,
      kindConfidence: result.classification.confidence,
      riskScore: result.risk.score,
      riskConfidence: result.risk.confidence,
      lowConfTriggered: lowConf,
      modelParticipated: participated,
      unsafeAllow: isUnsafe,
      unnecessaryAction: isUnnecessary,
    });
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const n = fixtures.length || 1;

  return {
    version: THRESHOLD_CALIBRATE_VERSION,
    mode: "live-corpus",
    thresholds,
    fixtureCount: fixtures.length,
    modeExactMatchCount: modeExact,
    modeAccuracy: modeExact / n,
    modelParticipatedCount: modelParticipated,
    hardPolicyShortCircuitCount: hardPolicyShortCircuit,
    lowConfTriggeredCount: lowConfTriggered,
    lowConfRateAmongModel:
      modelParticipated === 0 ? null : lowConfTriggered / modelParticipated,
    avgKindConfidenceAmongModel:
      modelParticipated === 0 ? null : kindConfSum / modelParticipated,
    avgRiskConfidenceAmongModel:
      modelParticipated === 0 ? null : riskConfSum / modelParticipated,
    unsafeAllowCount: unsafeAllow,
    missedApprovalCount: missedApproval,
    unnecessaryActionCount: unnecessary,
    latencyMs: {
      p50: sortedLatencies.length ? sortedLatencies[Math.ceil(0.5 * sortedLatencies.length) - 1]! : null,
      p95: sortedLatencies.length ? sortedLatencies[Math.ceil(0.95 * sortedLatencies.length) - 1]! : null,
    },
    samples,
    note:
      "Live calibration sample — advisory only. Unsafe-allow uses corpus minimumAction " +
      "as the reference; do not auto-flip thresholds without explicit approval.",
  };
}

export interface LiveStabilityRunSummary {
  runIndex: number;
  modeAccuracy: number;
  unsafeAllowCount: number;
  unnecessaryActionCount: number;
  latencyMs: { p50: number | null; p95: number | null };
}

export interface LiveStabilityFixtureStat {
  id: string;
  expected: MinimumAction;
  matchRate: number;
  matchCount: number;
  runCount: number;
  modesSeen: Partial<Record<MinimumAction, number>>;
  /** True when the resolved action differed across runs. */
  modeFlipped: boolean;
  /** True when label match differed across runs. */
  labelFlipped: boolean;
}

export interface LiveStabilityAggregate {
  modeAccuracy: { min: number; max: number; mean: number; stdev: number | null };
  unsafeAllowCount: { min: number; max: number; runsWithUnsafe: number };
  unnecessaryActionCount: { min: number; max: number; mean: number };
  latencyMs: {
    p50: { min: number | null; max: number | null; mean: number | null };
    p95: { min: number | null; max: number | null; mean: number | null };
  };
  fullyStableFixtureCount: number;
  flakyFixtures: LiveStabilityFixtureStat[];
}

export interface LiveStabilityReport {
  version: string;
  mode: "live-corpus-stability";
  runCount: number;
  thresholds: ThresholdSet;
  fixtureCount: number;
  runs: LiveStabilityRunSummary[];
  aggregate: LiveStabilityAggregate;
  note: string;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return mean(nums);
}

/** Summarize multi-run live calibration for stability / worst-case metrics. */
export function aggregateLiveStabilityReports(
  reports: readonly LiveCalibrationReport[],
): LiveStabilityReport {
  if (reports.length === 0) {
    throw new Error("aggregateLiveStabilityReports requires at least one report");
  }

  const first = reports[0]!;
  const fixtureIds = first.samples.map((s) => s.id);
  const byIdExpected = new Map(first.samples.map((s) => [s.id, s.minimumAction]));

  const fixtureStats: LiveStabilityFixtureStat[] = fixtureIds.map((id) => {
    const expected = byIdExpected.get(id)!;
    const modesSeen: Partial<Record<MinimumAction, number>> = {};
    let matchCount = 0;
    const gotSeq: MinimumAction[] = [];
    for (const report of reports) {
      const sample = report.samples.find((s) => s.id === id);
      if (!sample) continue;
      const got = modeToMinimumAction(sample.mode);
      gotSeq.push(got);
      modesSeen[got] = (modesSeen[got] ?? 0) + 1;
      if (got === expected) matchCount += 1;
    }
    const runCount = gotSeq.length;
    const uniqueModes = new Set(gotSeq);
    const uniqueMatch = new Set(gotSeq.map((g) => (g === expected ? "match" : "miss")));
    return {
      id,
      expected,
      matchRate: runCount === 0 ? 0 : matchCount / runCount,
      matchCount,
      runCount,
      modesSeen,
      modeFlipped: uniqueModes.size > 1,
      labelFlipped: uniqueMatch.size > 1,
    };
  });

  const accuracies = reports.map((r) => r.modeAccuracy);
  const unsafeCounts = reports.map((r) => r.unsafeAllowCount);
  const unnecessaryCounts = reports.map((r) => r.unnecessaryActionCount);
  const p50s = reports.map((r) => r.latencyMs.p50);
  const p95s = reports.map((r) => r.latencyMs.p95);

  const flakyFixtures = fixtureStats
    .filter((f) => f.modeFlipped || f.labelFlipped || f.matchRate < 1)
    .sort((a, b) => a.matchRate - b.matchRate || a.id.localeCompare(b.id));

  return {
    version: THRESHOLD_CALIBRATE_VERSION,
    mode: "live-corpus-stability",
    runCount: reports.length,
    thresholds: first.thresholds,
    fixtureCount: first.fixtureCount,
    runs: reports.map((r, i) => ({
      runIndex: i + 1,
      modeAccuracy: r.modeAccuracy,
      unsafeAllowCount: r.unsafeAllowCount,
      unnecessaryActionCount: r.unnecessaryActionCount,
      latencyMs: r.latencyMs,
    })),
    aggregate: {
      modeAccuracy: {
        min: Math.min(...accuracies),
        max: Math.max(...accuracies),
        mean: mean(accuracies)!,
        stdev: stdev(accuracies),
      },
      unsafeAllowCount: {
        min: Math.min(...unsafeCounts),
        max: Math.max(...unsafeCounts),
        runsWithUnsafe: unsafeCounts.filter((n) => n > 0).length,
      },
      unnecessaryActionCount: {
        min: Math.min(...unnecessaryCounts),
        max: Math.max(...unnecessaryCounts),
        mean: mean(unnecessaryCounts)!,
      },
      latencyMs: {
        p50: {
          min: p50s.every((v) => v === null) ? null : Math.min(...p50s.filter((v): v is number => v !== null)),
          max: p50s.every((v) => v === null) ? null : Math.max(...p50s.filter((v): v is number => v !== null)),
          mean: meanNullable(p50s),
        },
        p95: {
          min: p95s.every((v) => v === null) ? null : Math.min(...p95s.filter((v): v is number => v !== null)),
          max: p95s.every((v) => v === null) ? null : Math.max(...p95s.filter((v): v is number => v !== null)),
          mean: meanNullable(p95s),
        },
      },
      fullyStableFixtureCount: fixtureStats.filter((f) => !f.modeFlipped && f.matchRate === 1).length,
      flakyFixtures,
    },
    note:
      "Multi-run live stability sample — advisory only. Prefer worst-case unsafeAllow max " +
      "and flaky fixture matchRate over a single-run 100%.",
  };
}
