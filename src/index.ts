/**
 * jev-coding-guard — a minimal, reusable Jev decision layer for global
 * coding-agent workflow optimization.
 *
 * Public entry point. Re-exports the guard engine, providers, policy rules,
 * and types. The layer is provider-agnostic: swap `TypeSafeProvider` for
 * `RuleProvider` (or any `DecisionProvider`) without touching the decision
 * logic.
 */
export {
  TypeSafeProvider,
  normalizeRiskScore,
  RISK_CRITERIA,
  RISK_MAX_LEVEL,
  type TypeSafeProviderConfig,
} from "./provider.js";
export { RuleProvider } from "./fallback.js";
export { screenCorpusCandidate, screenCorpusCandidates } from "./corpus-screen.js";
export {
  buildReviewQueue,
  mergeApprovedCandidates,
  validateFullCandidate,
  CORPUS_REVIEW_VERSION,
} from "./corpus-review.js";
export { Guard, type EngineConfig, type EngineResult } from "./engine.js";
export {
  runDecideMany,
  runDecideManyStream,
  BatchTooLargeError,
  BATCH_DECIDE_VERSION,
  DEFAULT_BATCH_MAX_ITEMS,
  DEFAULT_BATCH_CONCURRENCY,
  type DecideManyOptions,
  type DecideManyStrategy,
  type BatchDecisionItem,
  type DecideManyResult,
} from "./batch.js";
export {
  buildBatchState,
  buildBatchQuestions,
  parseBatchJudgments,
  BATCH_PROVIDER_VERSION,
  DEFAULT_SHARED_CHUNK_SIZE,
} from "./provider-batch.js";
export {
  calibrateFromDataset,
  gridSearchCalibrationLabels,
  evaluateCalibrationLabels,
  runLiveCalibration,
  aggregateLiveStabilityReports,
  corpusFixtureToLiveCalibration,
  DEFAULT_THRESHOLDS,
  THRESHOLD_CALIBRATE_VERSION,
  type CalibrationReport,
  type GridSearchReport,
  type CalibrationLabelDataset,
  type CalibrationLabelFixture,
  type LiveCalibrationReport,
  type LiveStabilityReport,
  type LiveCalibrationFixture,
  type ThresholdSet,
} from "./threshold-calibrate.js";
export { DEFAULT_POLICY, matchPolicy, redactSecrets, sanitizeForProvider } from "./policy.js";
export { recommendRouting, ROUTING_SKILLS } from "./routing.js";
export {
  selectHarnessModel,
  DEFAULT_HARNESS_CATALOG,
  MODEL_ROUTER_VERSION,
  type HarnessModelSelection,
  type HarnessModelSpec,
  type SelectHarnessModelOptions,
} from "./model-router.js";
export {
  buildEvalManifest,
  EVAL_MANIFEST_VERSION,
  ROUTING_VERSION,
  type EvalVersionManifest,
} from "./eval-manifest.js";
export {
  compareShadowPair,
  summarizeShadowPairs,
  SHADOW_EVAL_VERSION,
  type ShadowDecisionSignals,
  type ShadowPairResult,
  type ShadowSummary,
} from "./shadow-eval.js";
export {
  suggestContext,
  suggestContextSync,
  rankContextIds,
  applyIdentifierRerank,
  MAX_CONTEXT_PATHS,
  DEFAULT_CONTEXT_PATHS,
} from "./context-router.js";
export {
  TypeSafeContextReranker,
  isContextRerankEnabled,
  CONTEXT_RERANK_ENV_FLAG,
  CONTEXT_RERANK_MIN_PATHS,
  orderByRelevanceScores,
} from "./context-rerank.js";
export type { ContextReranker } from "./context-rerank.js";
export type {
  Classification,
  DecisionProvider,
  BatchDecisionProvider,
  DecisionReason,
  ExecutionMode,
  GuardInput,
  HardPolicyRule,
  JudgeOptions,
  ModelJudgment,
  RecommendedContextBudget,
  RecommendedModelTier,
  RiskFactor,
  RiskScore,
  RoutingComplexity,
  RoutingRecommendation,
  ContextSuggestion,
  SecurityReview,
  SkillId,
  TaskKind,
} from "./types.js";
export { isBatchDecisionProvider } from "./types.js";

export {
  agentStatusFromExecutionMode,
  resolveAgentLocale,
  buildAgentResult,
  buildAgentResultFromExecutionMode,
  buildValueReceipt,
  formatValueReceiptLines,
  receiptDisplayMode,
  shouldPrintReceiptNow,
  statusHeadline,
  buildNextActions,
  composeAgentFromEngineResult,
  formatAgentVerbatim,
  AGENT_CONTRACT_PREFIX,
} from "./agent/index.js";
export type {
  AgentResult,
  AgentStatus,
  AgentLocale,
  AuthoritySource,
  ValueReceipt,
  ExecuteFeedback,
  BuiltAgentBundle,
  ModelAdviceTier,
} from "./agent/index.js";

export {
  PreferencesMemory,
  MemoryPrivacyError,
  resolvePreferencesDbPath,
  migrateMemory,
  MEMORY_SCHEMA_VERSION,
} from "./memory/index.js";
export type {
  SessionGrantRecord,
  PreferenceEventRecord,
  LearnedSuggestionRecord,
  ProfileRevisionRecord,
  GrantScope,
  PreferenceUserAction,
} from "./memory/index.js";

export {
  ProfileStore,
  ProfileValidationError,
  createDefaultProfile,
  applyPreset,
  validateProfile,
  parseAndValidateProfileJson,
  resolveProfilePath,
  PROFILE_SCHEMA_VERSION,
  HARD_DELEGATION_KEYS,
  resolveEffectiveProfile,
  inferDelegationKey,
  profileExecuteFeedbackToAgent,
} from "./profile/index.js";
export type {
  ProfileV1,
  ProfilePreset,
  InterruptionPreference,
  DelegationMode,
  ProfileDelegation,
  EffectiveResolution,
  ResolverInput,
} from "./profile/index.js";

/** Convenience: default guard backed by the TypeSafe provider. */
export { defaultGuard } from "./index-guard.js";
