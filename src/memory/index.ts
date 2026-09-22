/**
 * Memory v1 — preferences.sqlite ledger (grants, overrides, revisions, suggestions).
 * Not authority; T07 resolver consumes grants. Suggestions never grant power.
 */
export {
  MEMORY_DIR_NAME,
  MEMORY_DB_NAME,
  MEMORY_PATH_ENV,
  resolveMemoryDir,
  resolvePreferencesDbPath,
} from "./paths.js";
export {
  MEMORY_SCHEMA_VERSION,
  migrateMemory,
  readMemorySchemaVersion,
  TABLE_META,
  TABLE_PREFERENCE_EVENTS,
  TABLE_SESSION_GRANTS,
  TABLE_OVERRIDE_EVENTS,
  TABLE_LEARNED_SUGGESTIONS,
  TABLE_PROFILE_REVISIONS,
} from "./schema.js";
export {
  PreferencesMemory,
  MemoryPrivacyError,
  type PreferencesMemoryOptions,
  type CreateGrantInput,
  type CreatePreferenceEventInput,
  type CreateOverrideInput,
  type CreateSuggestionInput,
  type CreateRevisionInput,
} from "./store.js";
export {
  assertNoForbiddenKeys,
  assertNoCredentialMaterial,
  assertSafeCategory,
  assertSafeId,
  assertSafeProfileJson,
} from "./privacy.js";
export type {
  GrantScope,
  PreferenceUserAction,
  SuggestionStatus,
  ConfidenceBucket,
  ProfileRevisionSource,
  SessionGrantRecord,
  PreferenceEventRecord,
  OverrideEventRecord,
  LearnedSuggestionRecord,
  ProfileRevisionRecord,
} from "./types.js";
export { MEMORY_FORBIDDEN_FIELD_NAMES } from "./types.js";
