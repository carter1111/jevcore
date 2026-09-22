/**
 * Profile v1 — authoritative user preferences (profile.json).
 * Not chat memory. Not Agent-owned. Learned suggestions never auto-write.
 */

export const PROFILE_SCHEMA_VERSION = 1 as const;

export type InterruptionPreference = "cautious" | "balanced" | "assertive";

export type ProfilePreset = InterruptionPreference;

export type ExplanationStyle = "concise" | "detailed";

export type ExecuteFeedback = "each_step" | "session_summary" | "silent";

export type ModelAdviceVisibility = "always" | "when_not_fast" | "never";

export type ModelAdvicePreference = "fast" | "balanced" | "capable" | "max";

/**
 * Closed delegation values (Improvement Doc §3 / Partner §3.1).
 * Hard categories must remain `never_delegate` (see hard-boundaries).
 */
export type DelegationMode =
  | "auto"
  | "plan_then_continue"
  | "draft_then_continue"
  | "ask"
  | "ask_once"
  | "never_delegate";

export type PriorityId = "project_quality" | "delivery_speed" | "cost_control";

export interface ProfilePriorities {
  order: PriorityId[];
  preferReversibleChanges: boolean;
  preferSmallDiffs: boolean;
  requireRollbackForProduction: boolean;
}

export interface ProfileModelAdvice {
  visibility: ModelAdviceVisibility;
  preference: ModelAdvicePreference;
}

export interface ProfileCollaboration {
  locale: string;
  explanationStyle: ExplanationStyle;
  executeFeedback: ExecuteFeedback;
  maxPlanSteps: number;
  modelAdvice: ProfileModelAdvice;
}

export interface ProfileDelegation {
  ordinaryCode: DelegationMode;
  testsAndDocs: DelegationMode;
  lowConfidenceLowRisk: DelegationMode;
  multiFileRefactor: DelegationMode;
  localDevDatabase: DelegationMode;
  stagingDeploy: DelegationMode;
  productionDeploy: DelegationMode;
  authzChange: DelegationMode;
  destructiveCommand: DelegationMode;
  web3AssetAction: DelegationMode;
  secretToRemoteProvider: DelegationMode;
}

export interface ProfileLearning {
  recordOverrides: boolean;
  suggestAfterRepeatedPattern: number;
  /** Must always be false in v1 — suggestions never auto-write profile. */
  autoApplyPreferenceChanges: false;
}

export interface ProfileIdentity {
  displayName?: string;
}

/** Authoritative profile.json document (schemaVersion 1). */
export interface ProfileV1 {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  profileRevision: number;
  updatedAt: string;
  identity?: ProfileIdentity;
  collaboration: ProfileCollaboration;
  interruptionPreference: InterruptionPreference;
  priorities: ProfilePriorities;
  delegation: ProfileDelegation;
  learning: ProfileLearning;
}

/** Delegation keys that profile must never relax below never_delegate. */
export const HARD_DELEGATION_KEYS = [
  "secretToRemoteProvider",
  "web3AssetAction",
] as const;

export type HardDelegationKey = (typeof HARD_DELEGATION_KEYS)[number];

export const DELEGATION_KEYS = [
  "ordinaryCode",
  "testsAndDocs",
  "lowConfidenceLowRisk",
  "multiFileRefactor",
  "localDevDatabase",
  "stagingDeploy",
  "productionDeploy",
  "authzChange",
  "destructiveCommand",
  "web3AssetAction",
  "secretToRemoteProvider",
] as const;

export type DelegationKey = (typeof DELEGATION_KEYS)[number];

export const DELEGATION_MODES: readonly DelegationMode[] = [
  "auto",
  "plan_then_continue",
  "draft_then_continue",
  "ask",
  "ask_once",
  "never_delegate",
] as const;
