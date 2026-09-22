/**
 * JEVCore Agent Contract layer (v1) — types, templates, receipts, display.
 * MCP wiring is T04; Profile resolver is T07.
 */
export type {
  AgentLocale,
  AgentStatus,
  AuthoritySource,
  AgentNextActionId,
  ModelAdviceTier,
  ExecuteFeedback,
  BoundaryKind,
  AgentAuthority,
  AgentFact,
  AgentNextAction,
  AgentPlan,
  AgentClarification,
  AgentChoice,
  AgentRewrite,
  AgentModelAdvice,
  ValueReceiptDid,
  ValueReceiptEvidence,
  ValueReceipt,
  AgentResult,
} from "./types.js";
export { agentStatusFromExecutionMode } from "./types.js";
export { resolveAgentLocale } from "./locale.js";
export {
  statusHeadline,
  authorityDetail,
  nextActionLabel,
  modelAdviceDetail,
  yourCallBeyondAuthSummary,
  saferPathBoundarySummary,
  defaultNextActionIds,
  buildNextActions,
} from "./templates.js";
export {
  buildValueReceipt,
  formatValueReceiptLines,
  type BuildValueReceiptInput,
} from "./receipt.js";
export {
  receiptDisplayMode,
  shouldPrintReceiptNow,
  type ReceiptDisplayMode,
} from "./display.js";
export {
  buildAgentResult,
  buildAgentResultFromExecutionMode,
  type BuildAgentResultInput,
  type BuiltAgentBundle,
} from "./contract.js";
export {
  composeAgentFromEngineResult,
  type EngineResultForAgent,
  type ComposeAgentOptions,
} from "./from-engine.js";
export {
  buildSaferPathPayload,
  classifySaferBoundary,
  isPolOnlyPrimary,
  type SaferPathInput,
  type SaferPathPayload,
} from "./safer.js";
export {
  resolveModelAdvice,
  selectAdviceTier,
  shouldShowModelAdvice,
  AGENT_MODEL_ADVICE_CATALOG,
  type ModelAdviceVisibility,
  type ResolveModelAdviceInput,
} from "./model-advice.js";
export {
  resolveReadFirst,
  resolveRecommendedSkills,
  MAX_READ_FIRST_PATHS,
} from "./read-first.js";
export {
  buildPaveWayPlan,
  type BuildPaveWayPlanInput,
  type InterruptionPreference,
} from "./plan.js";
export {
  buildYourCallOptions,
  allowSessionGrantForRule,
  type BuildYourCallOptionsInput,
  type YourCallPayload,
  type PriorityId,
} from "./options.js";
export {
  formatAgentNarrative,
  formatAgentReport,
  type AgentReportExtras,
} from "./report.js";
export {
  runAgentDoctor,
  formatAgentDoctor,
  inferEnforcementLevel,
  type AgentDoctorResult,
  type EnforcementLevel,
} from "./doctor.js";
export {
  scanLearnedSuggestions,
  formatSuggestions,
  type SuggestScanResult,
} from "./suggest.js";
export { agentCommand } from "./cli.js";
export { formatAgentVerbatim } from "./verbatim.js";
export { AGENT_CONTRACT_PREFIX } from "./prefix.js";
