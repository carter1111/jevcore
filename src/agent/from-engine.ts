/**
 * Compose AgentResult from an EngineResult (T04 + T08–T11).
 * Profile/Memory resolver (T07) injects interruption/priorities later.
 */
import { buildAgentResultFromExecutionMode } from "./contract.js";
import { buildSaferPathPayload } from "./safer.js";
import { resolveAgentLocale } from "./locale.js";
import {
  resolveModelAdvice,
  type ModelAdviceVisibility,
} from "./model-advice.js";
import { resolveReadFirst, resolveRecommendedSkills } from "./read-first.js";
import { buildPaveWayPlan, type InterruptionPreference } from "./plan.js";
import {
  allowSessionGrantForRule,
  buildYourCallOptions,
  type PriorityId,
} from "./options.js";
import type { AgentResult, AuthoritySource } from "./types.js";

/** Minimal engine shape needed to compose agent — avoids circular import with engine.ts. */
export interface EngineResultForAgent {
  mode: "execute" | "plan_first" | "approval_required" | "block";
  classification: { source: "jev" | "rule" | "hard_policy" };
  reasons: Array<{ code: string; detail: string }>;
  fellBack: boolean;
  security?: { reviewNeeded?: boolean };
  routing?: {
    complexity?: "small" | "medium" | "large";
    recommendedModelTier?: "fast" | "normal" | "reasoning";
    recommendedSkillBundle?: string[];
  };
  modelSelection?: { tier: "fast" | "normal" | "reasoning" };
  contextSuggestion?: { paths: string[] };
  agent?: AgentResult;
}

export interface ComposeAgentOptions {
  locale?: string | null;
  /** From profile.collaboration.modelAdvice.visibility when T07 wires it. */
  modelAdviceVisibility?: ModelAdviceVisibility;
  /** From profile.interruptionPreference (default balanced). */
  interruptionPreference?: InterruptionPreference;
  /** From profile.collaboration.maxPlanSteps. */
  maxPlanSteps?: number;
  /** From profile.priorities.order. */
  priorityOrder?: PriorityId[];
  /** T07 resolver overrides. */
  authoritySource?: AuthoritySource;
  profileRuleId?: string;
  boundaryKind?: import("./types.js").BoundaryKind;
  executeFeedback?: import("./types.js").ExecuteFeedback;
}

function authorityFromEngine(result: EngineResultForAgent): AuthoritySource {
  const preflight = result.reasons.some((r) => r.code === "PREFLIGHT-BLOCK");
  if (preflight || (result.mode === "block" && result.classification.source === "hard_policy")) {
    return "hard_boundary";
  }
  // Product DEFAULT_POLICY is not a user profile until T07 wires real profiles.
  if (result.classification.source === "hard_policy") {
    return result.mode === "approval_required" ? "product_default" : "hard_boundary";
  }
  if (result.fellBack || result.mode === "plan_first") return "engine_uncertainty";
  if (result.mode === "approval_required") return "engine_uncertainty";
  return "product_default";
}

function agentIsFresh(agent: AgentResult, mode: EngineResultForAgent["mode"]): boolean {
  if (mode === "plan_first" && !agent.plan) return false;
  if (mode === "approval_required" && (!agent.choices || agent.choices.length === 0)) {
    return false;
  }
  if (mode === "block" && !agent.rewrite) return false;
  return true;
}

/**
 * Build AgentResult for a finished engine decision.
 * Idempotent only when status matches and rich payloads are present.
 */
export function composeAgentFromEngineResult(
  result: EngineResultForAgent,
  localeHintOrOptions?: string | null | ComposeAgentOptions,
): AgentResult {
  const opts: ComposeAgentOptions =
    localeHintOrOptions && typeof localeHintOrOptions === "object"
      ? localeHintOrOptions
      : { locale: localeHintOrOptions as string | null | undefined };

  const expectedStatus =
    result.mode === "execute"
      ? "advance"
      : result.mode === "plan_first"
        ? "pave_way"
        : result.mode === "approval_required"
          ? "your_call"
          : "safer_path";
  if (
    result.agent &&
    result.agent.status === expectedStatus &&
    agentIsFresh(result.agent, result.mode)
  ) {
    return result.agent;
  }

  const preflight = result.reasons.some((r) => r.code === "PREFLIGHT-BLOCK");
  const profileRuleId = result.reasons.find((r) => r.code.startsWith("POL-"))?.code;
  const locale = resolveAgentLocale(opts.locale);
  const reasonCodes = result.reasons.map((r) => r.code);

  const safer =
    result.mode === "block"
      ? buildSaferPathPayload({ locale, reasonCodes })
      : undefined;

  const plan =
    result.mode === "plan_first"
      ? buildPaveWayPlan({
          locale,
          interruptionPreference: opts.interruptionPreference,
          maxPlanSteps: opts.maxPlanSteps,
          reasonCodes,
          complexity: result.routing?.complexity,
          securityReviewNeeded: result.security?.reviewNeeded,
        })
      : undefined;

  const yourCall =
    result.mode === "approval_required"
      ? buildYourCallOptions({
          locale,
          profileRuleId,
          reasonCodes,
          priorityOrder: opts.priorityOrder,
          allowSessionGrant: allowSessionGrantForRule(profileRuleId),
        })
      : undefined;

  const modelAdvice = resolveModelAdvice({
    locale,
    routingTier: result.modelSelection?.tier ?? result.routing?.recommendedModelTier,
    complexity: result.routing?.complexity,
    mode: result.mode,
    securityReviewNeeded: result.security?.reviewNeeded,
    visibility: opts.modelAdviceVisibility,
  });

  const readFirst = resolveReadFirst(result.contextSuggestion?.paths);
  const recommendedSkills = resolveRecommendedSkills(
    result.routing?.recommendedSkillBundle,
  );

  const facts = result.reasons.map((r) => ({ code: r.code, detail: r.detail }));
  if (yourCall) {
    facts.unshift({ code: "YOUR-CALL", detail: yourCall.touchedRuleDetail });
  }

  const bundle = buildAgentResultFromExecutionMode(result.mode, {
    locale,
    authoritySource: opts.authoritySource ?? authorityFromEngine(result),
    profileRuleId: opts.profileRuleId ?? profileRuleId,
    boundaryKind: opts.boundaryKind ?? safer?.boundaryKind,
    facts,
    plan,
    choices: yourCall?.choices,
    yourCallOptions: yourCall?.choices.length,
    modelAdviceTier: modelAdvice?.tier,
    modelAdviceReason: modelAdvice?.reason,
    recommendedSkills,
    readFirst,
    rewrite: safer?.rewrite,
    saferPathDetail: safer?.receiptDetail,
    rollbackHint: plan?.rollbackHint,
    executeFeedback: opts.executeFeedback,
    evidence: {
      providerCalled: !preflight,
      hardPolicyShortCircuit: preflight,
    },
  });

  // Prefer your_call nextActions (session grant may be disabled for prod rules).
  if (yourCall) {
    bundle.agent.nextActions = yourCall.nextActions;
  }

  return bundle.agent;
}
