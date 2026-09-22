/**
 * T11 — Model advice (advise-only, includes max) + visibility.
 * Never claims host IDE auto-switched the model.
 */
import { modelAdviceDetail } from "./templates.js";
import type { AgentLocale, AgentModelAdvice, ModelAdviceTier } from "./types.js";

export type ModelAdviceVisibility = "always" | "when_not_fast" | "never";

/** Full agent-facing catalog (P4 routing may still be fast|normal|reasoning only). */
export const AGENT_MODEL_ADVICE_CATALOG: readonly ModelAdviceTier[] = [
  "fast",
  "normal",
  "reasoning",
  "max",
] as const;

export interface ResolveModelAdviceInput {
  locale: AgentLocale;
  /** From P4 / harness when present. */
  routingTier?: "fast" | "normal" | "reasoning";
  complexity?: "small" | "medium" | "large";
  mode: "execute" | "plan_first" | "approval_required" | "block";
  securityReviewNeeded?: boolean;
  /** Profile collaboration.modelAdvice.visibility; default when_not_fast. */
  visibility?: ModelAdviceVisibility;
}

/**
 * Escalate to max only when cost is likely worth it: large +
 * (approval/block or security review). Otherwise keep routing tier / normal.
 */
export function selectAdviceTier(input: ResolveModelAdviceInput): ModelAdviceTier {
  const base: ModelAdviceTier = input.routingTier ?? "normal";
  const escalate =
    input.complexity === "large" &&
    (input.mode === "block" ||
      input.mode === "approval_required" ||
      input.securityReviewNeeded === true);
  return escalate ? "max" : base;
}

export function shouldShowModelAdvice(
  tier: ModelAdviceTier,
  visibility: ModelAdviceVisibility = "when_not_fast",
): boolean {
  if (visibility === "never") return false;
  if (visibility === "always") return true;
  return tier !== "fast";
}

/**
 * Build advisory model tip. hostAutoApplied is always false in v1.
 * Returns undefined when visibility hides the tip.
 */
export function resolveModelAdvice(
  input: ResolveModelAdviceInput,
): AgentModelAdvice | undefined {
  const tier = selectAdviceTier(input);
  const visibility = input.visibility ?? "when_not_fast";
  if (!shouldShowModelAdvice(tier, visibility)) return undefined;
  return {
    tier,
    reason: modelAdviceDetail(input.locale, tier),
    hostAutoApplied: false,
  };
}
