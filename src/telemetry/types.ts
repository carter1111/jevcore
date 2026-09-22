/**
 * Local Guard Evidence — telemetry contracts.
 *
 * These types define what MAY be persisted. They are deliberately narrow:
 * every field is de-identified metadata. No task text, command text, diff
 * content, prompt, path, repository identity, secret, or raw provider payload
 * has a representation here, so such data cannot be stored by construction.
 *
 * See `Docs/Local_Guard_Report.md` §7.6 for the privacy requirements.
 */
import type { ExecutionMode, TaskKind } from "../types.js";

/**
 * Closed union of failure codes that may be persisted.
 *
 * This is intentionally NOT an arbitrary string. A free-text column would
 * invite storing a raw provider exception, and provider errors can echo
 * request fragments. Unknown future codes require a schema change and a
 * migration — that friction is desired.
 */
export type FailureCode =
  | "PREFLIGHT-BLOCK"
  | "PROVIDER-FAIL"
  | "PROVIDER-INVALID-RISK-SCORE"
  | "MCP-INVALID-DECISION-OUTPUT"
  | "LOW-CONF";

export const FAILURE_CODES: readonly FailureCode[] = [
  "PREFLIGHT-BLOCK",
  "PROVIDER-FAIL",
  "PROVIDER-INVALID-RISK-SCORE",
  "MCP-INVALID-DECISION-OUTPUT",
  "LOW-CONF",
] as const;

/** The MCP tool that produced a decision. */
export type DecisionTool = "jev_assess_task" | "jev_assess_command" | "jev_review_diff";

/** Optional batch correlation (C-5 §7). Random UUID; never content-derived. */
export interface BatchEvidenceContext {
  batchId: string;
  batchSize: number;
  strategy: "serial" | "shared_system_one";
}

/** Outcome of a single TypeSafe provider call made during a decision. */
export interface ProviderCallRecord {
  /** A provider call was attempted (the provider's `judge` was entered). */
  attempted: boolean;
  /** The call returned a usable judgment (no `failed` flag). */
  succeeded: boolean;
  /** The call failed (transport error or invalid data). */
  failed: boolean;
  /** Wall-clock duration of the provider call in ms. */
  latencyMs: number | undefined;
  /** Token usage reported by the SDK, when available. */
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/**
 * A de-identified decision event. Exactly these fields are persisted.
 * `decision_id` is a random UUID and is never derived from input content.
 */
export interface DecisionEvent {
  decisionId: string;
  occurredAt: string;
  tool: DecisionTool;
  source: "jev" | "rule" | "hard_policy";
  executionMode: ExecutionMode;
  taskDomain: TaskKind;
  riskScore: number;
  confidence: number;
  requiresSecurityReview: boolean;
  providerCallAttempted: boolean;
  providerCallSucceeded: boolean;
  providerFailed: boolean;
  fellBack: boolean;
  failureCode: FailureCode | undefined;
  guardLatencyMs: number | undefined;
  providerLatencyMs: number | undefined;
  jevInputTokens: number | undefined;
  jevOutputTokens: number | undefined;
  guardVersion: string;
  policyVersion: string;
  policyRuleIds: string[];
  /** Present when the decision was part of a batch (MCP batchItems or library decideMany). */
  batchId?: string;
  batchSize?: number;
  batchStrategy?: "serial" | "shared_system_one";
}

/**
 * Telemetry sink contract.
 *
 * Implementations MUST be non-throwing: every method swallows its own errors so
 * that telemetry can never affect a returned safety decision.
 */
export interface TelemetrySink {
  /**
   * Enqueue one decision event. Synchronous and enqueue-only: it must never
   * block the MCP response path and must never throw.
   */
  recordDecision(event: DecisionEvent): void;
  /**
   * Record an aggregate provider-call error counter tick (in-memory only).
   * Used when the sink itself cannot write.
   */
  noteWriteError(): void;
  /** Best-effort flush of queued events. Never throws. */
  flush(): Promise<void>;
  /** Best-effort flush + release resources. Never throws. */
  close(): Promise<void>;
  /** True when this sink actually persists (Noop returns false). */
  readonly enabled: boolean;
  /** In-memory count of write errors observed by this process. */
  writeErrorCount(): number;
}

/**
 * Telemetry configuration resolved from the environment or injected by tests.
 */
export interface TelemetryConfig {
  enabled: boolean;
  /** Absolute path to the SQLite database. Only read when `enabled`. */
  databasePath: string;
  /** Advisory storage warning threshold in bytes (default 50 MB). */
  advisoryBytes: number;
}
