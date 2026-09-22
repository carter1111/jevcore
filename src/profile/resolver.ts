/**
 * T07 — Effective Profile Resolver (§2.2 priority chain).
 *
 * Learned suggestions NEVER grant power (not consulted for mode).
 * Hard engine `block` and hard delegation categories cannot be softened.
 */
import type { ComposeAgentOptions } from "../agent/from-engine.js";
import type { ModelAdviceVisibility } from "../agent/model-advice.js";
import type { InterruptionPreference } from "../agent/plan.js";
import type { PriorityId } from "../agent/options.js";
import type { AuthoritySource, BoundaryKind } from "../agent/types.js";
import type { PreferencesMemory, SessionGrantRecord } from "../memory/index.js";
import type { ExecutionMode } from "../types.js";
import type { DelegationKey, DelegationMode, ProfileV1 } from "./types.js";
import { inferDelegationKey, isHardDelegationKey } from "./category.js";

export type ResolverAuthorityStep =
  | "hard_boundary"
  | "session_restriction"
  | "one_time_grant"
  | "session_grant"
  | "user_profile"
  | "interruption_preference"
  | "engine"
  | "product_default";

export interface ResolverInput {
  mode: ExecutionMode;
  reasons: Array<{ code: string; detail: string }>;
  fellBack?: boolean;
  classificationSource?: "jev" | "rule" | "hard_policy";
  profile?: ProfileV1 | null;
  sessionId?: string;
  preferencesMemory?: PreferencesMemory;
  /** Categories explicitly denied for this session (higher than grants). */
  sessionRestrictions?: readonly string[];
  now?: Date;
}

export interface EffectiveResolution {
  effectiveMode: ExecutionMode;
  authoritySource: AuthoritySource;
  profileRuleId?: string;
  delegationKey?: DelegationKey;
  delegationMode?: DelegationMode;
  boundaryKind?: BoundaryKind;
  resolvedBy: ResolverAuthorityStep;
  chain: Array<{ step: ResolverAuthorityStep; detail: string }>;
  compose: ComposeAgentOptions;
  modeAdjusted: boolean;
}

function mapDelegationToMode(mode: DelegationMode): ExecutionMode {
  switch (mode) {
    case "auto":
      return "execute";
    case "plan_then_continue":
    case "draft_then_continue":
      return "plan_first";
    case "ask":
    case "ask_once":
      return "approval_required";
    case "never_delegate":
      return "block";
  }
}

export function profileExecuteFeedbackToAgent(
  feedback: ProfileV1["collaboration"]["executeFeedback"],
): "silent" | "session_summary" | "detailed" {
  if (feedback === "each_step") return "detailed";
  if (feedback === "silent") return "silent";
  return "session_summary";
}

function composeFromProfile(profile: ProfileV1 | null | undefined): ComposeAgentOptions {
  if (!profile) {
    return { interruptionPreference: "balanced" };
  }
  return {
    locale: profile.collaboration.locale,
    modelAdviceVisibility: profile.collaboration.modelAdvice
      .visibility as ModelAdviceVisibility,
    interruptionPreference: profile.interruptionPreference as InterruptionPreference,
    maxPlanSteps: profile.collaboration.maxPlanSteps,
    priorityOrder: profile.priorities.order as PriorityId[],
  };
}

function findGrant(
  grants: SessionGrantRecord[],
  key: DelegationKey | undefined,
): SessionGrantRecord | undefined {
  if (!key) return undefined;
  return grants.find(
    (g) => g.category === key || g.category.toLowerCase() === key.toLowerCase(),
  );
}

function boundaryForBlock(key: DelegationKey | undefined): BoundaryKind {
  if (key && isHardDelegationKey(key)) return "data";
  if (key) return "delegation";
  return "data";
}

/**
 * Resolve effective execution mode + authority using §2.2 priority.
 * Does not read or apply learned_suggestions.
 */
export function resolveEffectiveProfile(input: ResolverInput): EffectiveResolution {
  const chain: EffectiveResolution["chain"] = [];
  const profile = input.profile ?? null;
  const compose = composeFromProfile(profile);
  const reasonCodes = input.reasons.map((r) => r.code);
  const delegationKey = inferDelegationKey(reasonCodes);
  const engineMode = input.mode;
  const polId = reasonCodes.find((c) => c.startsWith("POL-"));

  // --- 1. Hard boundary: engine block cannot be softened --------------------
  if (engineMode === "block") {
    chain.push({
      step: "hard_boundary",
      detail: polId
        ? `Engine block retained (${polId}); profile cannot soften`
        : "Engine block retained; profile cannot soften",
    });
    return {
      effectiveMode: "block",
      authoritySource: "hard_boundary",
      profileRuleId: polId ?? delegationKey,
      delegationKey,
      boundaryKind: boundaryForBlock(delegationKey),
      resolvedBy: "hard_boundary",
      chain,
      compose,
      modeAdjusted: false,
    };
  }

  // Note: hard categories (secret/web3) are enforced via profile.delegation
  // never_delegate below — do NOT force-block when the engine left the mode
  // as approval_required/plan_first (product policy may still ask the user).

  // --- 2. Session restriction -----------------------------------------------
  if (
    delegationKey &&
    input.sessionRestrictions?.some(
      (r) => r === delegationKey || r.toLowerCase() === delegationKey.toLowerCase(),
    )
  ) {
    chain.push({
      step: "session_restriction",
      detail: `Session restriction on ${delegationKey}`,
    });
    return {
      effectiveMode: "approval_required",
      authoritySource: "interruption_preference",
      profileRuleId: delegationKey,
      delegationKey,
      resolvedBy: "session_restriction",
      chain,
      compose,
      modeAdjusted: engineMode !== "approval_required",
    };
  }

  // --- 3–4. One-time / session grants ---------------------------------------
  let grants: SessionGrantRecord[] = [];
  if (input.sessionId && input.preferencesMemory) {
    try {
      grants = input.preferencesMemory.listActiveGrants(input.sessionId, input.now);
    } catch {
      grants = [];
    }
  }
  const grant = findGrant(grants, delegationKey);
  if (grant) {
    const step: ResolverAuthorityStep =
      grant.scope === "once" ? "one_time_grant" : "session_grant";
    const source: AuthoritySource =
      grant.scope === "once" ? "one_time_grant" : "session_grant";
    chain.push({
      step,
      detail: `Active ${grant.scope} grant ${grant.grantId} for ${grant.category}`,
    });
    return {
      effectiveMode: "execute",
      authoritySource: source,
      profileRuleId: grant.category,
      delegationKey,
      resolvedBy: step,
      chain,
      compose,
      modeAdjusted: engineMode !== "execute",
    };
  }

  // --- 5. User profile delegation -------------------------------------------
  if (profile && delegationKey) {
    const mode = profile.delegation[delegationKey];
    const mapped = mapDelegationToMode(mode);
    chain.push({
      step: "user_profile",
      detail: `profile.delegation.${delegationKey}=${mode} → ${mapped}`,
    });
    return {
      effectiveMode: mapped,
      authoritySource: "user_profile",
      profileRuleId: `${delegationKey}=${mode}`,
      delegationKey,
      delegationMode: mode,
      boundaryKind: mapped === "block" ? "delegation" : undefined,
      resolvedBy: "user_profile",
      chain,
      compose,
      modeAdjusted: mapped !== engineMode,
    };
  }

  // --- 6. Interruption preference (low-confidence soft) ---------------------
  const lowConf = reasonCodes.some((c) => c === "LOW-CONF" || c.startsWith("LOW-CONF"));
  if (profile && lowConf) {
    const pref = profile.interruptionPreference;
    if (pref === "cautious" && engineMode === "execute") {
      chain.push({
        step: "interruption_preference",
        detail: "cautious → plan_first on LOW-CONF",
      });
      return {
        effectiveMode: "plan_first",
        authoritySource: "interruption_preference",
        profileRuleId: "lowConfidenceLowRisk",
        delegationKey: "lowConfidenceLowRisk",
        resolvedBy: "interruption_preference",
        chain,
        compose,
        modeAdjusted: true,
      };
    }
    if (
      pref === "assertive" &&
      engineMode === "plan_first" &&
      profile.delegation.lowConfidenceLowRisk === "auto"
    ) {
      chain.push({
        step: "interruption_preference",
        detail: "assertive + lowConfidenceLowRisk=auto → execute",
      });
      return {
        effectiveMode: "execute",
        authoritySource: "interruption_preference",
        profileRuleId: "lowConfidenceLowRisk=auto",
        delegationKey: "lowConfidenceLowRisk",
        resolvedBy: "interruption_preference",
        chain,
        compose,
        modeAdjusted: true,
      };
    }
  }

  // --- 7–8. Engine / product default (learned never consulted) --------------
  const source: AuthoritySource = input.fellBack
    ? "engine_uncertainty"
    : input.classificationSource === "hard_policy"
      ? "product_default"
      : engineMode === "plan_first" || engineMode === "approval_required"
        ? "engine_uncertainty"
        : "product_default";
  const step: ResolverAuthorityStep =
    source === "product_default" ? "product_default" : "engine";
  chain.push({
    step,
    detail: `Retain engine mode ${engineMode}`,
  });

  return {
    effectiveMode: engineMode,
    authoritySource: source,
    profileRuleId: polId,
    delegationKey,
    resolvedBy: step,
    chain,
    compose,
    modeAdjusted: false,
  };
}
