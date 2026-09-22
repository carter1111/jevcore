/**
 * Fan-out policy (WP5) — decides WHETHER a second verification call is allowed
 * and which focused follow-up question set to use.
 *
 * Design (Plan §10):
 * - **Conditional, not default.** Most assessments make exactly one call.
 * - **Narrow trigger.** A second call is permitted only when the Round 0
 *   judgment is genuinely uncertain AND risk/security-relevant — never for
 *   low-risk, high-confidence work. This protects p95 latency (WP1 measured
 *   warm p50 ≈ 354 ms; a second call roughly doubles the tail).
 * - **Hard policy that already settles the action prevents extra calls.**
 * - **No caller-controlled depth knob.** The budget is a code constant.
 * - Deterministic and content-free: it inspects bounded signal values only.
 */
import type { GuardInput, ModelJudgment } from "./types.js";
import { matchPolicy } from "./policy.js";
import type { HardPolicyRule } from "./types.js";

/** Hard budget ceiling. Not configurable by callers (Plan §10). */
export const MAX_PROVIDER_CALLS = 2;

/** Version identifier for the fan-out policy. Bump on any rule change. */
export const FAN_OUT_POLICY_VERSION = "2026-09-21.3";

/** Why a second call was (or was not) permitted. Closed set. */
export type FanOutDecisionReason =
  | "FO-HARD-POLICY-SETTLED"
  | "FO-PROVIDER-FAILED"
  | "FO-LOW-RISK-CONFIDENT"
  | "FO-NEAR-THRESHOLD"
  | "FO-AMBIGUOUS-FACTOR"
  | "FO-SECURITY-SENSITIVE-LOW-CONF"
  | "FO-UNCLEAR-FACTOR";

export const FAN_OUT_DECISION_REASONS: readonly FanOutDecisionReason[] = [
  "FO-HARD-POLICY-SETTLED",
  "FO-PROVIDER-FAILED",
  "FO-LOW-RISK-CONFIDENT",
  "FO-NEAR-THRESHOLD",
  "FO-AMBIGUOUS-FACTOR",
  "FO-SECURITY-SENSITIVE-LOW-CONF",
  "FO-UNCLEAR-FACTOR",
] as const;

export interface FanOutThresholds {
  lowConfidenceThreshold: number;
  planRiskThreshold: number;
  approvalRiskThreshold: number;
  securityReviewThreshold: number;
}

/** Bounded inputs for the trigger decision. */
export interface FanOutInputs {
  input: GuardInput;
  round0: ModelJudgment;
  thresholds: FanOutThresholds;
  policy?: HardPolicyRule[];
}

export interface FanOutDecision {
  version: string;
  /** Whether a second (focused verification) call is permitted. */
  allowed: boolean;
  reason: FanOutDecisionReason;
  /** The band this decision falls into, for observability. */
  nearThreshold: boolean;
  securitySensitive: boolean;
  ambiguous: boolean;
}

/**
 * Decide whether a second verification call is permitted.
 *
 * NARROW trigger (per approved WP5 scope + 2026-09-21 live A/B tightening):
 *
 *   1. Hard policy already settles the action (block/approval) → NO second call.
 *   2. Provider already failed → NO second call (handled by fallback).
 *   3. Risk is low AND confidence is high AND not security-sensitive → NO
 *      second call (clearly safe). An `unclear` flag alone is NOT enough —
 *      live compare showed unclear-only Round 1 drove unnecessary escalations.
 *   4. Otherwise, permit a second call only if one of:
 *      - risk sits near a decision threshold (could tip either way),
 *      - `unclear` AND (near-threshold OR low-confidence OR risk≥plan OR
 *        security-sensitive),
 *      - security-sensitive with low confidence.
 */
export function decideFanOut(inputs: FanOutInputs): FanOutDecision {
  const { input, round0, thresholds } = inputs;
  const policy = inputs.policy;

  const base: Omit<FanOutDecision, "allowed" | "reason"> = {
    version: FAN_OUT_POLICY_VERSION,
    nearThreshold: false,
    securitySensitive: false,
    ambiguous: false,
  };

  // 1. Hard policy already settles the action → never spend a second call.
  const rule = matchPolicy(input, policy);
  if (rule !== undefined) {
    return { ...base, allowed: false, reason: "FO-HARD-POLICY-SETTLED" };
  }

  // 2. Provider failure is not a judgment; the fallback handles it.
  if (round0.failed === true) {
    return { ...base, allowed: false, reason: "FO-PROVIDER-FAILED" };
  }

  const risk = typeof round0.riskScore === "number" && Number.isFinite(round0.riskScore) ? round0.riskScore : 0;
  const riskConf = round0.riskConfidence ?? 0;
  const kindConf = round0.kindConfidence ?? 0;
  const lowConfidence =
    kindConf < thresholds.lowConfidenceThreshold || riskConf < thresholds.lowConfidenceThreshold;
  const securitySensitive = (round0.securityReviewNoul ?? 0) >= thresholds.securityReviewThreshold;
  const factors = round0.riskFactors ?? [];
  const ambiguous = factors.includes("unclear");

  // 3. Clearly safe: low risk + high confidence + not security-sensitive.
  //    Live A/B (2026-09-21): unclear-only verification increased unnecessary
  //    approvals without enough safety gain → do not spend Round 1 here.
  const lowRisk = risk < thresholds.planRiskThreshold;
  const highConfidence = !lowConfidence;
  if (lowRisk && highConfidence && !securitySensitive) {
    return { ...base, allowed: false, reason: "FO-LOW-RISK-CONFIDENT", securitySensitive, ambiguous };
  }

  // 4. Narrow trigger: only uncertain-and-consequential cases.
  const margin = 0.15;
  const nearThreshold =
    Math.abs(risk - thresholds.planRiskThreshold) <= margin ||
    Math.abs(risk - thresholds.approvalRiskThreshold) <= margin;

  const unclearConsequential =
    ambiguous && (nearThreshold || lowConfidence || securitySensitive || !lowRisk);
  if (unclearConsequential) {
    return { ...base, allowed: true, reason: "FO-UNCLEAR-FACTOR", securitySensitive, ambiguous, nearThreshold };
  }
  if (securitySensitive && lowConfidence) {
    return { ...base, allowed: true, reason: "FO-SECURITY-SENSITIVE-LOW-CONF", securitySensitive, ambiguous, nearThreshold };
  }
  if (nearThreshold) {
    return { ...base, allowed: true, reason: "FO-NEAR-THRESHOLD", securitySensitive, ambiguous, nearThreshold };
  }

  // Uncertain but not consequential enough to justify a second call.
  return { ...base, allowed: false, reason: "FO-LOW-RISK-CONFIDENT", securitySensitive, ambiguous, nearThreshold };
}
