/**
 * WP6 — shadow-mode decision comparison (offline evaluation readiness).
 *
 * Compares two finalized decisions by bounded signal fields only. Never stores
 * or requires task/command/diff content. Used by fixture shadow experiments
 * before any online routing change — does not alter live MCP behavior.
 */
import type { ExecutionMode, RecommendedModelTier } from "./types.js";

/** Bounded, content-free outcome used in shadow comparisons. */
export interface ShadowDecisionSignals {
  mode: ExecutionMode;
  riskScore: number;
  reviewNeeded: boolean;
  fellBack: boolean;
  recommendedModelTier?: RecommendedModelTier | null;
}

export type ShadowDeltaField =
  | "mode"
  | "riskScore"
  | "reviewNeeded"
  | "fellBack"
  | "recommendedModelTier";

export interface ShadowPairResult {
  /** Fixture or sample id (caller-supplied; never task text). */
  id: string;
  control: ShadowDecisionSignals;
  treatment: ShadowDecisionSignals;
  /** Fields that differ between control and treatment. */
  deltas: ShadowDeltaField[];
  /** True when treatment mode is stricter than control (escalate-only check). */
  treatmentStricterOrEqual: boolean;
}

export interface ShadowSummary {
  version: string;
  pairCount: number;
  identicalCount: number;
  deltaCount: number;
  modeDisagreeCount: number;
  treatmentStricterOrEqualRate: number;
  fieldDeltaCounts: Record<ShadowDeltaField, number>;
}

export const SHADOW_EVAL_VERSION = "2026-09-21.1";

const MODE_RANK: Record<ExecutionMode, number> = {
  execute: 0,
  plan_first: 1,
  approval_required: 2,
  block: 3,
};

export function compareShadowPair(
  id: string,
  control: ShadowDecisionSignals,
  treatment: ShadowDecisionSignals,
): ShadowPairResult {
  const deltas: ShadowDeltaField[] = [];
  if (control.mode !== treatment.mode) deltas.push("mode");
  if (control.riskScore !== treatment.riskScore) deltas.push("riskScore");
  if (control.reviewNeeded !== treatment.reviewNeeded) deltas.push("reviewNeeded");
  if (control.fellBack !== treatment.fellBack) deltas.push("fellBack");
  if ((control.recommendedModelTier ?? null) !== (treatment.recommendedModelTier ?? null)) {
    deltas.push("recommendedModelTier");
  }

  const treatmentStricterOrEqual =
    MODE_RANK[treatment.mode] >= MODE_RANK[control.mode] &&
    treatment.riskScore >= control.riskScore &&
    (treatment.reviewNeeded || !control.reviewNeeded);

  return { id, control, treatment, deltas, treatmentStricterOrEqual };
}

export function summarizeShadowPairs(pairs: readonly ShadowPairResult[]): ShadowSummary {
  const fieldDeltaCounts: Record<ShadowDeltaField, number> = {
    mode: 0,
    riskScore: 0,
    reviewNeeded: 0,
    fellBack: 0,
    recommendedModelTier: 0,
  };
  let identicalCount = 0;
  let modeDisagreeCount = 0;
  let stricterOk = 0;

  for (const p of pairs) {
    if (p.deltas.length === 0) identicalCount += 1;
    if (p.deltas.includes("mode")) modeDisagreeCount += 1;
    if (p.treatmentStricterOrEqual) stricterOk += 1;
    for (const d of p.deltas) fieldDeltaCounts[d] += 1;
  }

  const n = pairs.length;
  return {
    version: SHADOW_EVAL_VERSION,
    pairCount: n,
    identicalCount,
    deltaCount: n - identicalCount,
    modeDisagreeCount,
    treatmentStricterOrEqualRate: n === 0 ? 1 : stricterOk / n,
    fieldDeltaCounts,
  };
}
