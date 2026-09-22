/**
 * Profile v1 schema validation + hard-boundary enforcement.
 */
import {
  DELEGATION_KEYS,
  DELEGATION_MODES,
  HARD_DELEGATION_KEYS,
  PROFILE_SCHEMA_VERSION,
  type DelegationKey,
  type DelegationMode,
  type ProfileDelegation,
  type ProfileV1,
} from "./types.js";

export class ProfileValidationError extends Error {
  readonly code = "PROFILE-VALIDATE";
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

const PRIORITY_IDS = new Set(["project_quality", "delivery_speed", "cost_control"]);
const INTERRUPTIONS = new Set(["cautious", "balanced", "assertive"]);
const EXPLANATION = new Set(["concise", "detailed"]);
const FEEDBACK = new Set(["each_step", "session_summary", "silent"]);
const MODEL_VIS = new Set(["always", "when_not_fast", "never"]);
const MODEL_PREF = new Set(["fast", "balanced", "capable", "max"]);
const DELEGATION_SET = new Set<string>(DELEGATION_MODES);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function expectString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ProfileValidationError(`${path}.${key} must be a non-empty string`);
  }
  return v;
}

function expectBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") {
    throw new ProfileValidationError(`${path}.${key} must be a boolean`);
  }
  return v;
}

function expectNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ProfileValidationError(`${path}.${key} must be a finite number`);
  }
  return v;
}

function expectDelegation(obj: Record<string, unknown>, key: DelegationKey, path: string): DelegationMode {
  const v = obj[key];
  if (typeof v !== "string" || !DELEGATION_SET.has(v)) {
    throw new ProfileValidationError(
      `${path}.${key} must be one of: ${DELEGATION_MODES.join(", ")}`,
    );
  }
  return v as DelegationMode;
}

/**
 * Hard boundaries: secret→remote and web3 signing/assets cannot be lowered.
 */
export function assertHardBoundaries(delegation: ProfileDelegation): void {
  for (const key of HARD_DELEGATION_KEYS) {
    if (delegation[key] !== "never_delegate") {
      throw new ProfileValidationError(
        `Hard boundary ${key} must remain never_delegate (cannot be lowered by profile)`,
      );
    }
  }
}

/** Validate unknown JSON into ProfileV1 (throws ProfileValidationError). */
export function validateProfile(input: unknown): ProfileV1 {
  if (!isObject(input)) {
    throw new ProfileValidationError("profile must be a JSON object");
  }

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileValidationError(
      `schemaVersion must be ${PROFILE_SCHEMA_VERSION}, got ${String(schemaVersion)}`,
    );
  }

  const profileRevision = expectNumber(input, "profileRevision", "profile");
  if (!Number.isInteger(profileRevision) || profileRevision < 1) {
    throw new ProfileValidationError("profileRevision must be an integer >= 1");
  }

  const updatedAt = expectString(input, "updatedAt", "profile");
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new ProfileValidationError("updatedAt must be an ISO-8601 timestamp");
  }

  let identity: ProfileV1["identity"];
  if (input.identity !== undefined) {
    if (!isObject(input.identity)) {
      throw new ProfileValidationError("identity must be an object");
    }
    if (input.identity.displayName !== undefined) {
      if (typeof input.identity.displayName !== "string") {
        throw new ProfileValidationError("identity.displayName must be a string");
      }
      identity = { displayName: input.identity.displayName };
    } else {
      identity = {};
    }
  }

  if (!isObject(input.collaboration)) {
    throw new ProfileValidationError("collaboration must be an object");
  }
  const collab = input.collaboration;
  const locale = expectString(collab, "locale", "collaboration");
  const explanationStyle = expectString(collab, "explanationStyle", "collaboration");
  if (!EXPLANATION.has(explanationStyle)) {
    throw new ProfileValidationError("collaboration.explanationStyle invalid");
  }
  const executeFeedback = expectString(collab, "executeFeedback", "collaboration");
  if (!FEEDBACK.has(executeFeedback)) {
    throw new ProfileValidationError("collaboration.executeFeedback invalid");
  }
  const maxPlanSteps = expectNumber(collab, "maxPlanSteps", "collaboration");
  if (!Number.isInteger(maxPlanSteps) || maxPlanSteps < 1 || maxPlanSteps > 20) {
    throw new ProfileValidationError("collaboration.maxPlanSteps must be 1..20");
  }
  if (!isObject(collab.modelAdvice)) {
    throw new ProfileValidationError("collaboration.modelAdvice must be an object");
  }
  const modelAdvice = collab.modelAdvice;
  const visibility = expectString(modelAdvice, "visibility", "collaboration.modelAdvice");
  if (!MODEL_VIS.has(visibility)) {
    throw new ProfileValidationError("collaboration.modelAdvice.visibility invalid");
  }
  const preference = expectString(modelAdvice, "preference", "collaboration.modelAdvice");
  if (!MODEL_PREF.has(preference)) {
    throw new ProfileValidationError("collaboration.modelAdvice.preference invalid");
  }

  const interruptionPreference = expectString(input, "interruptionPreference", "profile");
  if (!INTERRUPTIONS.has(interruptionPreference)) {
    throw new ProfileValidationError("interruptionPreference must be cautious|balanced|assertive");
  }

  if (!isObject(input.priorities)) {
    throw new ProfileValidationError("priorities must be an object");
  }
  const priorities = input.priorities;
  if (!Array.isArray(priorities.order) || priorities.order.length !== 3) {
    throw new ProfileValidationError("priorities.order must be an array of 3 priority ids");
  }
  for (const id of priorities.order) {
    if (typeof id !== "string" || !PRIORITY_IDS.has(id)) {
      throw new ProfileValidationError(`priorities.order contains invalid id: ${String(id)}`);
    }
  }
  const orderUnique = new Set(priorities.order);
  if (orderUnique.size !== 3) {
    throw new ProfileValidationError("priorities.order must contain unique ids");
  }

  if (!isObject(input.delegation)) {
    throw new ProfileValidationError("delegation must be an object");
  }
  const delegationRaw = input.delegation;
  const delegation = {} as ProfileDelegation;
  for (const key of DELEGATION_KEYS) {
    delegation[key] = expectDelegation(delegationRaw, key, "delegation");
  }
  assertHardBoundaries(delegation);

  if (!isObject(input.learning)) {
    throw new ProfileValidationError("learning must be an object");
  }
  const learning = input.learning;
  const recordOverrides = expectBoolean(learning, "recordOverrides", "learning");
  const suggestAfterRepeatedPattern = expectNumber(
    learning,
    "suggestAfterRepeatedPattern",
    "learning",
  );
  if (
    !Number.isInteger(suggestAfterRepeatedPattern) ||
    suggestAfterRepeatedPattern < 1 ||
    suggestAfterRepeatedPattern > 100
  ) {
    throw new ProfileValidationError("learning.suggestAfterRepeatedPattern must be 1..100");
  }
  const autoApply = learning.autoApplyPreferenceChanges;
  if (autoApply !== false) {
    throw new ProfileValidationError(
      "learning.autoApplyPreferenceChanges must be false (suggestions never auto-write profile)",
    );
  }

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileRevision,
    updatedAt,
    ...(identity !== undefined ? { identity } : {}),
    collaboration: {
      locale,
      explanationStyle: explanationStyle as ProfileV1["collaboration"]["explanationStyle"],
      executeFeedback: executeFeedback as ProfileV1["collaboration"]["executeFeedback"],
      maxPlanSteps,
      modelAdvice: {
        visibility: visibility as ProfileV1["collaboration"]["modelAdvice"]["visibility"],
        preference: preference as ProfileV1["collaboration"]["modelAdvice"]["preference"],
      },
    },
    interruptionPreference: interruptionPreference as ProfileV1["interruptionPreference"],
    priorities: {
      order: priorities.order as ProfileV1["priorities"]["order"],
      preferReversibleChanges: expectBoolean(priorities, "preferReversibleChanges", "priorities"),
      preferSmallDiffs: expectBoolean(priorities, "preferSmallDiffs", "priorities"),
      requireRollbackForProduction: expectBoolean(
        priorities,
        "requireRollbackForProduction",
        "priorities",
      ),
    },
    delegation,
    learning: {
      recordOverrides,
      suggestAfterRepeatedPattern,
      autoApplyPreferenceChanges: false,
    },
  };
}

/** Parse + validate a JSON string. */
export function parseAndValidateProfileJson(text: string): ProfileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileValidationError("profile JSON is not parseable");
  }
  return validateProfile(parsed);
}

/** Map CLI kebab-case field names onto profile paths. */
export const SETTABLE_FIELDS: Record<
  string,
  { kind: "delegation" | "interruption" | "collaboration" | "learning"; path: string }
> = {
  "ordinary-code": { kind: "delegation", path: "ordinaryCode" },
  "tests-and-docs": { kind: "delegation", path: "testsAndDocs" },
  "low-confidence": { kind: "delegation", path: "lowConfidenceLowRisk" },
  "low-confidence-low-risk": { kind: "delegation", path: "lowConfidenceLowRisk" },
  "multi-file-refactor": { kind: "delegation", path: "multiFileRefactor" },
  "local-dev-database": { kind: "delegation", path: "localDevDatabase" },
  "staging-deploy": { kind: "delegation", path: "stagingDeploy" },
  "production-deploy": { kind: "delegation", path: "productionDeploy" },
  authz: { kind: "delegation", path: "authzChange" },
  "authz-change": { kind: "delegation", path: "authzChange" },
  "destructive-command": { kind: "delegation", path: "destructiveCommand" },
  "web3-asset-action": { kind: "delegation", path: "web3AssetAction" },
  "secret-to-remote-provider": { kind: "delegation", path: "secretToRemoteProvider" },
  interruption: { kind: "interruption", path: "interruptionPreference" },
  "interruption-preference": { kind: "interruption", path: "interruptionPreference" },
  "execute-feedback": { kind: "collaboration", path: "executeFeedback" },
  "explanation-style": { kind: "collaboration", path: "explanationStyle" },
  "max-plan-steps": { kind: "collaboration", path: "maxPlanSteps" },
  locale: { kind: "collaboration", path: "locale" },
};

/** Normalize CLI delegation value tokens (draft-then-continue → draft_then_continue). */
export function normalizeDelegationToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, "_");
}
