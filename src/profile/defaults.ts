/**
 * Profile v1 defaults and interruption presets (cautious|balanced|assertive).
 * Presets adjust soft stops only — hard delegation stays never_delegate.
 */
import type {
  DelegationMode,
  InterruptionPreference,
  ProfileDelegation,
  ProfilePreset,
  ProfileV1,
} from "./types.js";
import { PROFILE_SCHEMA_VERSION } from "./types.js";

function isoNow(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

/** Balanced baseline — matches Improvement Doc §3.2 illustrative surface. */
export function createDefaultProfile(now: () => Date = () => new Date()): ProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileRevision: 1,
    updatedAt: isoNow(now),
    identity: { displayName: "Owner" },
    collaboration: {
      locale: "en",
      explanationStyle: "concise",
      executeFeedback: "session_summary",
      maxPlanSteps: 5,
      modelAdvice: {
        visibility: "when_not_fast",
        preference: "balanced",
      },
    },
    interruptionPreference: "balanced",
    priorities: {
      order: ["project_quality", "delivery_speed", "cost_control"],
      preferReversibleChanges: true,
      preferSmallDiffs: true,
      requireRollbackForProduction: true,
    },
    delegation: balancedDelegation(),
    learning: {
      recordOverrides: true,
      suggestAfterRepeatedPattern: 5,
      autoApplyPreferenceChanges: false,
    },
  };
}

function balancedDelegation(): ProfileDelegation {
  return {
    ordinaryCode: "auto",
    testsAndDocs: "auto",
    lowConfidenceLowRisk: "draft_then_continue",
    multiFileRefactor: "plan_then_continue",
    localDevDatabase: "plan_then_continue",
    stagingDeploy: "ask",
    productionDeploy: "ask",
    authzChange: "ask",
    destructiveCommand: "ask_once",
    web3AssetAction: "never_delegate",
    secretToRemoteProvider: "never_delegate",
  };
}

function cautiousDelegation(): ProfileDelegation {
  return {
    ...balancedDelegation(),
    ordinaryCode: "plan_then_continue",
    testsAndDocs: "plan_then_continue",
    lowConfidenceLowRisk: "ask",
    multiFileRefactor: "ask",
    localDevDatabase: "ask",
    stagingDeploy: "ask",
    productionDeploy: "ask",
    authzChange: "ask",
    destructiveCommand: "ask",
    // hard keys unchanged
    web3AssetAction: "never_delegate",
    secretToRemoteProvider: "never_delegate",
  };
}

function assertiveDelegation(): ProfileDelegation {
  return {
    ...balancedDelegation(),
    ordinaryCode: "auto",
    testsAndDocs: "auto",
    lowConfidenceLowRisk: "draft_then_continue",
    multiFileRefactor: "plan_then_continue",
    localDevDatabase: "plan_then_continue",
    stagingDeploy: "ask_once",
    productionDeploy: "ask",
    authzChange: "ask",
    destructiveCommand: "ask_once",
    web3AssetAction: "never_delegate",
    secretToRemoteProvider: "never_delegate",
  };
}

const PRESET_DELEGATION: Record<ProfilePreset, () => ProfileDelegation> = {
  cautious: cautiousDelegation,
  balanced: balancedDelegation,
  assertive: assertiveDelegation,
};

/**
 * Apply an interruption preset onto a profile.
 * Soft delegation + interruptionPreference change; hard keys stay never_delegate.
 */
export function applyPreset(
  profile: ProfileV1,
  preset: ProfilePreset,
  now: () => Date = () => new Date(),
): ProfileV1 {
  return {
    ...profile,
    interruptionPreference: preset as InterruptionPreference,
    delegation: PRESET_DELEGATION[preset](),
    updatedAt: isoNow(now),
  };
}

/** Soft-only delta for diffs / summaries (hard keys omitted). */
export function softDelegationDiff(
  before: ProfileDelegation,
  after: ProfileDelegation,
): Partial<Record<keyof ProfileDelegation, { from: DelegationMode; to: DelegationMode }>> {
  const out: Partial<
    Record<keyof ProfileDelegation, { from: DelegationMode; to: DelegationMode }>
  > = {};
  for (const key of Object.keys(before) as (keyof ProfileDelegation)[]) {
    if (before[key] !== after[key]) {
      out[key] = { from: before[key], to: after[key] };
    }
  }
  return out;
}
