/**
 * Core types for jev-coding-guard.
 *
 * These types define the *contract* of the decision layer. They are framework-
 * neutral (no SDK types leak through the public API), so the layer can be
 * consumed by any coding agent (Cursor, Codex, OpenCode, CLI, CI) without
 * coupling to TypeSafe internals.
 */

/** Software-development task classes (normalized public contract). */
export type TaskKind =
  | "frontend"
  | "backend"
  | "web3"
  | "devops"
  | "testing"
  | "research"
  | "general";

/** Execution mode decided by the guard. */
export type ExecutionMode =
  | "execute" // safe: proceed autonomously
  | "plan_first" // needs a plan before executing
  | "approval_required" // needs human approval
  | "block"; // must not be executed

/** Why a decision was reached (for auditability). */
export interface DecisionReason {
  code: string;
  detail: string;
}

/** Result of task classification. */
export interface Classification {
  kind: TaskKind;
  /** 0..1 reported confidence */
  confidence: number;
  /**
   * Source of the classification:
   * - `"jev"` — semantic judgment from the model provider
   * - `"rule"` — deterministic fallback provider (e.g. RuleProvider)
   * - `"hard_policy"` — deterministic hard-policy rule (preflight block or override)
   */
  source: "jev" | "rule" | "hard_policy";
}

/** Factors contributing to a risk score. */
export type RiskFactor =
  | "scope" // touches many files / broad surface
  | "destructive" // deletes, rewrites, moves
  | "data" // touches user data / DB schema
  | "security" // auth, secrets, crypto, network
  | "irreversible" // hard to roll back
  | "unclear"; // risk profile is not clear

/** Result of risk scoring. */
export interface RiskScore {
  /** 0 (low) .. 1 (critical), probability-weighted */
  score: number;
  confidence: number;
  factors: RiskFactor[];
}

/** Result of the security-review judgment. */
export interface SecurityReview {
  /** true when an explicit security review is warranted */
  reviewNeeded: boolean;
  /** 0..1 probability that a security review is warranted */
  noul: number;
  findings: string[];
}

/** P4 — recommended task complexity (suggestion only). */
export type RoutingComplexity = "small" | "medium" | "large";

/** P4 — recommended model tier (suggestion only; hosts are not forced). */
export type RecommendedModelTier = "fast" | "normal" | "reasoning";

/** P4 — recommended context budget (suggestion only). */
export type RecommendedContextBudget = "small" | "medium" | "large";

/** P4 — skill ids that may appear in `recommendedSkillBundle`. */
export type SkillId =
  | "testing"
  | "security"
  | "web3"
  | "devops"
  | "frontend"
  | "backend"
  | "research";

/**
 * P4 Preflight Router output. Recommendations only — never a host enforcement
 * signal. Omitted when signals are too incomplete to recommend without guessing.
 */
export interface RoutingRecommendation {
  complexity: RoutingComplexity;
  recommendedModelTier: RecommendedModelTier;
  recommendedContextBudget: RecommendedContextBudget;
  recommendedSkillBundle: SkillId[];
  planFirst: boolean;
  /** P4 v1 is always deterministic from existing decision signals. */
  source: "deterministic";
}

/** P5 — suggested context paths (identifiers only; never a hard limit). */
export interface ContextSuggestion {
  paths: string[];
  source: "deterministic" | "deterministic+rerank";
  reasonIds: string[];
}

/**
 * Minimal shape `recommendRouting` needs — satisfied by `EngineResult` without
 * importing the engine module (avoids cycles).
 */
export interface EngineResultLike {
  classification: Classification;
  risk: RiskScore;
  security: SecurityReview;
  mode: ExecutionMode;
  reasons: Array<{ code: string; detail: string }>;
  fellBack: boolean;
  routing?: RoutingRecommendation;
  /**
   * P6 — harness catalog selection derived from `routing`. Advisory only;
   * Cursor / Claude / Codex are never forced. Omit when routing is omitted.
   */
  modelSelection?: {
    modelId: string;
    tier: RecommendedModelTier;
    contextBudget: RecommendedContextBudget;
    planFirst: boolean;
    source: "harness";
  };
  contextSuggestion?: ContextSuggestion;
}

/** A deterministic, model-free policy rule. Overrides model judgment. */
export interface HardPolicyRule {
  id: string;
  description: string;
  /** Predicate on the task description / metadata. */
  matches: (input: GuardInput) => boolean;
  /** Override to apply when matched. */
  mode: ExecutionMode;
  reason: DecisionReason;
  /**
   * When true, a match also forces `security.reviewNeeded = true`.
   * Used for authorization/authentication work: it must require a security
   * review or approval, but it is NOT a secret exposure.
   */
  requiresSecurityReview?: boolean;
}

/** Input a decision-layer caller provides. */
export interface GuardInput {
  /** The task/request text (instruction, diff summary, PR title, ...). */
  task: string;
  /** Optional structured hints (from the calling agent). */
  hints?: {
    /** Comma-separated list of touched file paths, if known. */
    touchedFiles?: string[] | null;
    /**
     * Optional extra file **identifiers** for P5 context suggestions.
     * Identifiers only — never file contents.
     */
    candidatePaths?: string[] | null;
    /** True when the request explicitly mentions production/deploy. */
    mentionsProd?: boolean | null;
    /** Free-form context (repo, branch, constraints). */
    context?: string | null;
  };
}

/** Raw judgment returned by the model provider (normalized shape). */
export interface ModelJudgment {
  kind?: TaskKind;
  kindConfidence?: number;
  riskScore?: number;
  riskConfidence?: number;
  riskFactors?: RiskFactor[];
  securityReviewNoul?: number;
  /** true when the model call failed or returned unusable output */
  failed?: boolean;
  /**
   * Optional non-secret diagnostic code explaining a failure (e.g.
   * `PROVIDER-INVALID-RISK-SCORE`). Surfaced as a decision reason; never
   * contains input text or credential material.
   */
  failureCode?: string;
  /**
   * Optional token usage reported by the provider SDK. Purely informational —
   * never affects the decision. Consumed only by the telemetry decorator.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /**
   * Internal signal (WP5): a second verification call was attempted and could
   * not produce a usable judgment. It is NOT a decision — the composition layer
   * escalates it to `approval_required` so verification unavailability can never
   * fail open. Never surfaced as public/MCP output.
   */
  verificationFailed?: boolean;
}

/**
 * Optional per-call overrides for a `DecisionProvider.judge` invocation.
 * Used by WP5.1 fan-out Round 1 to pass a focused domain question pack.
 * Providers that ignore options remain valid.
 */
export interface JudgeOptions {
  /**
   * Override the question pack for this call. Internal pack shape — not part of
   * the public MCP/SDK surface. Typed loosely so `types.ts` stays free of pack
   * imports; `TypeSafeProvider` narrows to `QuestionPack`.
   */
  pack?: unknown;
  /** Domain pack id for observability (e.g. "database", "web3"). */
  packId?: string;
  /**
   * Round 1 uses a slim verification question set (risk + security + domain
   * factors only) to cut extra-call latency. Round 0 / default is `"full"`.
   */
  questionSet?: "full" | "verify";
}

/**
 * Provider abstraction: isolates the TypeSafe SDK behind an interface so the
 * decision logic can be tested with a fake provider and swapped later.
 */
export interface DecisionProvider {
  /** Single batched call: classify + risk + security review in one request. */
  judge(input: GuardInput, options?: JudgeOptions): Promise<ModelJudgment>;
}

/**
 * C-5 Phase B — optional shared `systemOne` for many inputs in one HTTP call.
 * Implemented by `TypeSafeProvider`; absent providers fall back to serial decide.
 */
export interface BatchDecisionProvider extends DecisionProvider {
  judgeMany(inputs: readonly GuardInput[], options?: JudgeOptions): Promise<ModelJudgment[]>;
}

/** Type guard for batch-capable providers. */
export function isBatchDecisionProvider(p: DecisionProvider): p is BatchDecisionProvider {
  return typeof (p as BatchDecisionProvider).judgeMany === "function";
}