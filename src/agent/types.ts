/**
 * JEVCore Agent Contract types (v1).
 *
 * Public MCP/result field name is `agent` (AgentResult).
 * Keep ExecutionMode separately for adapter compatibility.
 * Deterministic templates only — no host-LLM prose calls.
 */

export type AgentLocale = "en" | "zh";

/** User-facing Agent states (map from ExecutionMode). */
export type AgentStatus = "advance" | "pave_way" | "your_call" | "safer_path";

export type AuthoritySource =
  | "hard_boundary"
  | "one_time_grant"
  | "session_grant"
  | "user_profile"
  | "interruption_preference"
  | "engine_uncertainty"
  | "product_default";

export type AgentNextActionId =
  | "continue"
  | "start_now"
  | "approve_once"
  | "approve_session"
  | "change_profile"
  | "self_handle"
  | "use_safer_path"
  | "answer_clarification";

export type ModelAdviceTier = "fast" | "normal" | "reasoning" | "max";

export type ExecuteFeedback =
  | "silent"
  | "status_line"
  | "session_summary"
  | "detailed";

export type BoundaryKind = "data" | "delegation";

export interface AgentAuthority {
  source: AuthoritySource;
  profileRuleId?: string;
  userCanOverride: boolean;
  allowedScopes: Array<"once" | "session" | "profile">;
  /** Present when safer_path / your_call should classify the stop. */
  boundaryKind?: BoundaryKind;
}

export interface AgentFact {
  code: string;
  detail: string;
}

export interface AgentNextAction {
  id: AgentNextActionId;
  label: string;
  enabled: boolean;
}

export interface AgentPlan {
  steps: string[];
  allowStartNow: boolean;
  assumptions?: string[];
  verify?: string[];
  rollbackHint?: string;
}

export interface AgentClarification {
  question: string;
  choices?: string[];
}

export interface AgentChoice {
  id: string;
  label: string;
  tradeoff: string;
  reversible: boolean;
  recommended: boolean;
}

export interface AgentRewrite {
  suggestedTask: string;
  rationale: string;
  alternatives: string[];
}

export interface AgentModelAdvice {
  tier: ModelAdviceTier;
  reason: string;
  /** IDE sessions: always false in v1. */
  hostAutoApplied: false;
}

export type ValueReceiptDid =
  | { kind: "precheck"; detail: string }
  | { kind: "advanced"; detail: string }
  | { kind: "paved"; steps: number; detail?: string }
  | { kind: "your_call"; options: number; detail?: string }
  | { kind: "safer_path"; detail: string }
  | { kind: "read_first"; paths?: string[]; detail: string }
  | { kind: "model_advice"; tier: ModelAdviceTier; detail: string }
  | { kind: "jev_skipped"; detail: string }
  | { kind: "multi_check"; detail: string };

export interface ValueReceiptEvidence {
  providerCalled: boolean;
  hardPolicyShortCircuit: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Always generated; display governed by status + executeFeedback. */
export interface ValueReceipt {
  locale: AgentLocale;
  headline: string;
  did: ValueReceiptDid[];
  evidence: ValueReceiptEvidence;
}

/** Public structured result (MCP field: agent). */
export interface AgentResult {
  status: AgentStatus;
  summary: string;
  headline: string;
  authority: AgentAuthority;
  facts: AgentFact[];
  nextActions: AgentNextAction[];
  plan?: AgentPlan;
  clarification?: AgentClarification;
  choices?: AgentChoice[];
  rewrite?: AgentRewrite;
  rollbackHint?: string;
  readFirst?: string[];
  recommendedSkills?: string[];
  modelAdvice?: AgentModelAdvice;
  valueReceipt: ValueReceipt;
}

/** Map internal executionMode → Agent status. */
export function agentStatusFromExecutionMode(
  mode: "execute" | "plan_first" | "approval_required" | "block",
): AgentStatus {
  switch (mode) {
    case "execute":
      return "advance";
    case "plan_first":
      return "pave_way";
    case "approval_required":
      return "your_call";
    case "block":
      return "safer_path";
  }
}
