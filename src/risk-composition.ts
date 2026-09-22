/**
 * Risk Signal Composition (WP4) — versioned, deterministic, explainable.
 *
 * This module replaces ad-hoc threshold checks with an explicit composition of
 * BOUNDED signals into a minimum safety action. It is deliberately:
 *
 * - **Deterministic**: same signals → same action, always.
 * - **Explainable**: it returns the reason IDs that drove the result.
 * - **Monotonic in safety**: it can only PRESERVE or ESCALATE an action. It can
 *   never downgrade a hard-policy outcome — `engine.ts` applies the policy
 *   override after this, and the override always wins.
 * - **Content-free**: it stores only bounded numeric values, factor names, and
 *   version/reason IDs. No task, command, diff, path, or secret data.
 *
 * Calibration rule (Plan §9): the thresholds used here remain PROVISIONAL until
 * evaluated against a labeled corpus. Do not claim calibration without that
 * evidence.
 */
import type { ExecutionMode, RiskFactor } from "./types.js";

/** Version identifier for the composition layer. Bump on any rule change. */
export const RISK_COMPOSITION_VERSION = "2026-09-21.3";

/** Reason IDs emitted by the composition layer. Closed set. */
export type CompositionReasonId =
  | "RC-RISK-APPROVAL"
  | "RC-RISK-PLAN"
  | "RC-SECURITY-REVIEW"
  | "RC-SECURITY-LOW-CONF-APPROVAL"
  | "RC-LOW-CONF-PLAN"
  | "RC-IRREVERSIBLE"
  | "RC-UNCLEAR-PLAN"
  | "RC-SCOPE-PLAN"
  | "RC-UNCLEAR-LOW-CONF"
  | "RC-VERIFICATION-FAILED";

export const COMPOSITION_REASON_IDS: readonly CompositionReasonId[] = [
  "RC-RISK-APPROVAL",
  "RC-RISK-PLAN",
  "RC-SECURITY-REVIEW",
  "RC-SECURITY-LOW-CONF-APPROVAL",
  "RC-LOW-CONF-PLAN",
  "RC-IRREVERSIBLE",
  "RC-UNCLEAR-PLAN",
  "RC-SCOPE-PLAN",
  "RC-UNCLEAR-LOW-CONF",
  "RC-VERIFICATION-FAILED",
] as const;

/** Bounded, content-free inputs to composition. */
export interface RiskSignals {
  /** Model risk score, 0..1. */
  riskScore: number;
  /** Model risk confidence, 0..1. */
  riskConfidence: number;
  /** Model classification confidence, 0..1. */
  kindConfidence: number;
  /** Security-review noul, 0..1. */
  securityNoul: number;
  /** Present risk factors (bounded enum values). */
  factors: RiskFactor[];
  /**
   * Internal (WP5): a verification call was attempted and unavailable. When
   * true the composition escalates to `approval_required` — verification
   * unavailability must never fail open.
   */
  verificationFailed?: boolean;
}

/** Thresholds. PROVISIONAL until corpus-calibrated (Plan §9). */
export interface CompositionThresholds {
  lowConfidenceThreshold: number;
  planRiskThreshold: number;
  approvalRiskThreshold: number;
  securityReviewThreshold: number;
}

export interface CompositionResult {
  version: string;
  /** The composed minimum action (never lower than `execute`). */
  action: ExecutionMode;
  /** Reason IDs explaining the composed action. */
  reasonIds: CompositionReasonId[];
  /** Whether the composition escalated above what risk alone would give. */
  escalated: boolean;
  /** Bounded, content-free echo of the signals used (for evidence/reporting). */
  signalsUsed: {
    riskScore: number;
    riskConfidence: number;
    kindConfidence: number;
    securityNoul: number;
    lowConfidence: boolean;
    securityReviewNeeded: boolean;
    factors: RiskFactor[];
  };
}

/** Ordering for safety actions (higher = more restrictive). */
const ACTION_RANK: Record<ExecutionMode, number> = {
  execute: 0,
  plan_first: 1,
  approval_required: 2,
  block: 3,
};

/** Return the more restrictive of two actions. */
export function maxAction(a: ExecutionMode, b: ExecutionMode): ExecutionMode {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

/**
 * Compose bounded signals into a minimum safety action.
 *
 * Routing rules (Plan §9):
 *   1. risk >= approvalThreshold            → approval_required
 *   2. risk >= planThreshold                → plan_first
 *   3. securityReviewNeeded                 → plan_first
 *   4. securityReviewNeeded + lowConfidence → approval_required  (escalation)
 *   5. irreversible factor + lowConfidence  → approval_required  (escalation)
 *   6. unclear + (risk ≥ plan/2 or low kind conf) → plan_first  (ambiguity)
 *   7. scope factor (high confidence)       → plan_first         (broad change)
 *   8. lowConfidence                        → plan_first         (downgrade)
 *   9. otherwise                            → execute
 *
 * Confidence NEVER escalates on its own; it only escalates when combined with a
 * risk/security signal (rules 4-5). This preserves the spirit of the original
 * "low confidence never escalates" invariant while satisfying Plan §9.
 */
export function composeRiskAction(
  signals: RiskSignals,
  thresholds: CompositionThresholds,
): CompositionResult {
  const reasonIds: CompositionReasonId[] = [];

  const lowConfidence =
    signals.kindConfidence < thresholds.lowConfidenceThreshold ||
    signals.riskConfidence < thresholds.lowConfidenceThreshold;
  const securityReviewNeeded = signals.securityNoul >= thresholds.securityReviewThreshold;
  const irreversible = signals.factors.includes("irreversible");

  // Base action from risk bands alone.
  let action: ExecutionMode = "execute";
  if (signals.riskScore >= thresholds.approvalRiskThreshold) {
    action = "approval_required";
    reasonIds.push("RC-RISK-APPROVAL");
  } else if (signals.riskScore >= thresholds.planRiskThreshold) {
    action = "plan_first";
    reasonIds.push("RC-RISK-PLAN");
  }

  const riskOnly = action;

  // Verification unavailable → escalate, never fail open (WP5).
  if (signals.verificationFailed === true) {
    action = maxAction(action, "approval_required");
    reasonIds.push("RC-VERIFICATION-FAILED");
  }

  // Security review requires at least a plan.
  if (securityReviewNeeded) {
    action = maxAction(action, "plan_first");
    reasonIds.push("RC-SECURITY-REVIEW");
  }

  // Plan §9 escalations: a risk/security signal COMBINED with low confidence.
  if (securityReviewNeeded && lowConfidence) {
    action = maxAction(action, "approval_required");
    reasonIds.push("RC-SECURITY-LOW-CONF-APPROVAL");
  }
  if (irreversible && lowConfidence) {
    action = maxAction(action, "approval_required");
    reasonIds.push("RC-IRREVERSIBLE");
  }

  // Unclear factor alone on a clearly low-risk, high-confidence task stays execute.
  const unclearNeedsPlan =
    signals.riskScore >= thresholds.planRiskThreshold * 0.5 ||
    signals.kindConfidence < thresholds.lowConfidenceThreshold;
  if (signals.factors.includes("unclear") && action === "execute" && unclearNeedsPlan) {
    action = "plan_first";
    reasonIds.push("RC-UNCLEAR-PLAN");
  }
  if (signals.factors.includes("scope") && action === "execute") {
    action = "plan_first";
    reasonIds.push("RC-SCOPE-PLAN");
  }

  // Low confidence alone only downgrades execute → plan_first.
  if (lowConfidence) {
    if (action === "execute") {
      action = "plan_first";
      reasonIds.push("RC-LOW-CONF-PLAN");
    }
    if (signals.factors.includes("unclear") && action === "plan_first") {
      reasonIds.push("RC-UNCLEAR-LOW-CONF");
    }
  }

  const escalated = ACTION_RANK[action] > ACTION_RANK[riskOnly];

  return {
    version: RISK_COMPOSITION_VERSION,
    action,
    reasonIds,
    escalated,
    signalsUsed: {
      riskScore: signals.riskScore,
      riskConfidence: signals.riskConfidence,
      kindConfidence: signals.kindConfidence,
      securityNoul: signals.securityNoul,
      lowConfidence,
      securityReviewNeeded,
      factors: [...signals.factors],
    },
  };
}
