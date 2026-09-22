/**
 * Profile v1 public surface (T05).
 * Authority: profile.json. Ledger hook: PreferencesMemory.recordProfileRevision.
 */
export { PROFILE_SCHEMA_VERSION } from "./types.js";
export type {
  ProfileV1,
  ProfilePreset,
  InterruptionPreference,
  DelegationMode,
  DelegationKey,
  ProfileDelegation,
  ProfileCollaboration,
  ProfileLearning,
  ProfilePriorities,
  HardDelegationKey,
} from "./types.js";
export {
  HARD_DELEGATION_KEYS,
  DELEGATION_KEYS,
  DELEGATION_MODES,
} from "./types.js";

export { createDefaultProfile, applyPreset, softDelegationDiff } from "./defaults.js";

export {
  validateProfile,
  parseAndValidateProfileJson,
  assertHardBoundaries,
  ProfileValidationError,
  SETTABLE_FIELDS,
  normalizeDelegationToken,
} from "./validate.js";

export {
  PROFILE_DIR_NAME,
  PROFILE_FILE_NAME,
  PROFILE_BACKUP_NAME,
  PROFILE_PATH_ENV,
  resolveProfileDir,
  resolveProfilePath,
  resolveProfileBackupPath,
} from "./paths.js";

export {
  ProfileStore,
  serializeProfile,
  ensureProfileDir,
  type ProfileStoreOptions,
  type WriteProfileResult,
} from "./store.js";

export {
  inferDelegationKey,
  isHardDelegationKey,
  HARD_CATEGORY_KEYS,
} from "./category.js";

export {
  resolveEffectiveProfile,
  profileExecuteFeedbackToAgent,
  type ResolverInput,
  type EffectiveResolution,
  type ResolverAuthorityStep,
} from "./resolver.js";
