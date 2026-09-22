/**
 * jev-coding-guard — local stdio MCP server.
 *
 * A minimal MCP adapter over the existing public `jev-coding-guard` library
 * (see `index.ts`). It exposes four read-only tools:
 *
 *   - `jev_assess_task`, `jev_assess_command`, `jev_review_diff` — typed
 *     decisions only (no side effects on the repo, shell, or external systems).
 *   - `jev_guard_report` — a local evidence report; never calls TypeSafe.
 *
 * The MCP layer never executes shell commands, never edits repository files,
 * never deploys, and never reads or exposes `TYPESAFE_API_KEY`.
 *
 * When Local Guard Evidence is explicitly enabled this *process* may
 * asynchronously persist de-identified decision metadata to a user-owned local
 * SQLite database; that never alters a returned decision. See
 * `architecture.md` §13.
 *
 * Design constraints honored here:
 *
 * - **Reuse, do not duplicate.** All semantics live in the public API
 *   (`Guard`, `RuleProvider`, `DEFAULT_POLICY`, `matchPolicy`). This file
 *   contains no policy rules of its own — it only normalizes tool input onto
 *   `GuardInput` and shapes the `EngineResult` back out.
 * - **Hard policy stays authoritative.** The engine applies
 *   `DEFAULT_POLICY` LAST and always wins (see `engine.ts`); nothing in this
 *   layer can override a `block`.
 * - **Fail-safe by construction.** If the model provider is unavailable the
 *   engine falls back deterministically. For ordinary tasks that is
 *   `plan_first`; for deterministically elevated-risk tasks this layer
 *   escalates to `approval_required` (never `block` — a block can only come
 *   from hard policy).
 * - **No secrets in scope.** We never touch environment variables beyond
 *   what `TypeSafeProvider` already does (presence-based via the SDK). No
 *   key value is read, logged, or returned.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as z from "zod/v4";

import { DEFAULT_POLICY, Guard, RuleProvider, TypeSafeProvider } from "./index.js";
import type {
  AgentResult,
  DecisionProvider,
  EngineResult,
  GuardInput,
  HardPolicyRule,
  TaskKind,
} from "./index.js";
import { composeAgentFromEngineResult } from "./agent/from-engine.js";
import { ProfileStore } from "./profile/store.js";
import { PreferencesMemory } from "./memory/store.js";
import { InstrumentedProvider } from "./telemetry/instrumented-provider.js";
import { FanOutProvider, isFanOutEnabled } from "./fan-out.js";
import {
  isContextRerankEnabled,
  TypeSafeContextReranker,
} from "./context-rerank.js";
import { buildReport, type ReportPeriod } from "./telemetry/report.js";
import { formatDisabled, formatReport } from "./telemetry/format.js";
import { formatAgentReport } from "./agent/report.js";
import { startTimer, TelemetrySession } from "./telemetry/session.js";
import type { DecisionTool } from "./telemetry/types.js";

export const MCP_SERVER_NAME = "jev-coding-guard";
export const MCP_SERVER_VERSION = "0.1.0";

/** Deterministic risk at/above which a failed provider escalates to approval. */
export const ELEVATED_RISK_THRESHOLD = 0.7;

/** The 7 normalized task domains (must stay in sync with `types.ts`). */
const TASK_KINDS: TaskKind[] = [
  "frontend",
  "backend",
  "web3",
  "devops",
  "testing",
  "research",
  "general",
];

/** Safe fallback domain when `taskDomain` itself violates its contract. */
const SAFE_FALLBACK_DOMAIN: TaskKind = "general";

/**
 * Boundary fallback reason code. Emitted when the MCP output boundary detects a
 * public numeric field outside its `0..1` contract. Never contains secrets or
 * raw provider payloads — only the field category.
 */
export const MCP_INVALID_DECISION_OUTPUT = "MCP-INVALID-DECISION-OUTPUT";

/** True when `value` is a finite number within the inclusive `[0, 1]` contract. */
function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// ---------------------------------------------------------------------------
// Strict input schemas (zod). The MCP SDK validates tool arguments against
// these before any handler runs; unknown keys are rejected via `.strict()`.
// ---------------------------------------------------------------------------

const CHANGED_FILES_SCHEMA = z
  .array(z.string().min(1).max(10_000))
  .max(10_000)
  .describe("Game/repofiles touched by this change (paths).");

const commonTaskFields = {
  userTask: z
    .string()
    .min(1)
    .max(200_000)
    .describe("The task or request to assess, in plain language."),
  repositoryContext: z
    .string()
    .max(200_000)
    .describe("Repository, branch, or project context for the assessment."),
} as const;

const batchSubTaskSchema = z
  .object({
    userTask: z.string().min(1).max(200_000),
    changedFiles: CHANGED_FILES_SCHEMA.optional(),
  })
  .strict();

const assessTaskInputSchema = z
  .object({
    ...commonTaskFields,
    changedFiles: CHANGED_FILES_SCHEMA.optional(),
    diffSummary: z
      .string()
      .max(200_000)
      .optional()
      .describe("Optional summary of the work already done (for context only)."),
    testSummary: z
      .string()
      .max(200_000)
      .optional()
      .describe("Optional test results/coverage summary (for context only)."),
    /** C-5 Phase B — optional batch (max 8). Returns schemaVersion 2 envelope. */
    batchItems: z
      .array(batchSubTaskSchema)
      .max(8)
      .optional()
      .describe("Optional sub-tasks assessed in one batch (shared_system_one when supported)."),
    batchStrategy: z
      .enum(["serial", "shared_system_one"])
      .optional()
      .describe("Batch provider strategy; default shared_system_one when batchItems set."),
  })
  .strict();

const assessCommandInputSchema = z
  .object({
    ...commonTaskFields,
    proposedCommand: z
      .string()
      .min(1)
      .max(10_000)
      .describe("The exact shell command proposed to execute. Used only as text evidence for the decision; never executed."),
    changedFiles: CHANGED_FILES_SCHEMA.optional(),
  })
  .strict();

const reviewDiffInputSchema = z
  .object({
    ...commonTaskFields,
    changedFiles: CHANGED_FILES_SCHEMA.describe("Required: the files changed by this diff."),
    diffSummary: z
      .string()
      .min(1)
      .max(300_000)
      .describe("Summary of the diff being reviewed."),
    testSummary: z
      .string()
      .max(200_000)
      .optional()
      .describe("Optional test results/coverage summary (for context only)."),
  })
  .strict();

const guardReportInputSchema = z
  .object({
    period: z
      .enum(["7d", "14d", "30d", "all"])
      .describe("Reporting window over local Guard evidence."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Typed decision output (the "same typed decision structure" for all tools).
// ---------------------------------------------------------------------------

const reasonsItemSchema = z.object({
  code: z.string(),
  detail: z.string(),
});

const routingOutputSchema = z.object({
  complexity: z.enum(["small", "medium", "large"]),
  recommendedModelTier: z.enum(["fast", "normal", "reasoning"]),
  recommendedContextBudget: z.enum(["small", "medium", "large"]),
  recommendedSkillBundle: z.array(
    z.enum(["testing", "security", "web3", "devops", "frontend", "backend", "research"]),
  ),
  planFirst: z.boolean(),
  source: z.literal("deterministic"),
});

const modelSelectionOutputSchema = z.object({
  modelId: z.string().min(1).max(128),
  tier: z.enum(["fast", "normal", "reasoning"]),
  contextBudget: z.enum(["small", "medium", "large"]),
  planFirst: z.boolean(),
  source: z.literal("harness"),
});

const agentValueReceiptSchema = z.object({
  locale: z.enum(["en", "zh"]),
  headline: z.string().min(1).max(2000),
  did: z
    .array(
      z
        .object({
          kind: z.enum([
            "precheck",
            "advanced",
            "paved",
            "your_call",
            "safer_path",
            "read_first",
            "model_advice",
            "jev_skipped",
            "multi_check",
          ]),
        })
        .passthrough(),
    )
    .max(32),
  evidence: z.object({
    providerCalled: z.boolean(),
    hardPolicyShortCircuit: z.boolean(),
    latencyMs: z.number().nonnegative().optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
  }),
});

const agentOutputSchema = z.object({
  status: z.enum(["advance", "pave_way", "your_call", "safer_path"]),
  summary: z.string().min(1).max(4000),
  headline: z.string().min(1).max(2000),
  authority: z.object({
    source: z.enum([
      "hard_boundary",
      "one_time_grant",
      "session_grant",
      "user_profile",
      "interruption_preference",
      "engine_uncertainty",
      "product_default",
    ]),
    profileRuleId: z.string().max(128).optional(),
    userCanOverride: z.boolean(),
    allowedScopes: z.array(z.enum(["once", "session", "profile"])).max(3),
    boundaryKind: z.enum(["data", "delegation"]).optional(),
  }),
  facts: z
    .array(z.object({ code: z.string().min(1).max(128), detail: z.string().max(4000) }))
    .max(64),
  nextActions: z
    .array(
      z.object({
        id: z.enum([
          "continue",
          "start_now",
          "approve_once",
          "approve_session",
          "change_profile",
          "self_handle",
          "use_safer_path",
          "answer_clarification",
        ]),
        label: z.string().min(1).max(256),
        enabled: z.boolean(),
      }),
    )
    .max(16),
  plan: z
    .object({
      steps: z.array(z.string().max(1000)).max(5),
      allowStartNow: z.boolean(),
      assumptions: z.array(z.string().max(1000)).max(8).optional(),
      verify: z.array(z.string().max(1000)).max(8).optional(),
      rollbackHint: z.string().max(2000).optional(),
    })
    .optional(),
  clarification: z
    .object({
      question: z.string().max(2000),
      choices: z.array(z.string().max(500)).max(8).optional(),
    })
    .optional(),
  choices: z
    .array(
      z.object({
        id: z.string().max(64),
        label: z.string().max(500),
        tradeoff: z.string().max(2000),
        reversible: z.boolean(),
        recommended: z.boolean(),
      }),
    )
    .max(8)
    .optional(),
  rewrite: z
    .object({
      suggestedTask: z.string().max(4000),
      rationale: z.string().max(4000),
      alternatives: z.array(z.string().max(2000)).max(8),
    })
    .optional(),
  rollbackHint: z.string().max(2000).optional(),
  readFirst: z.array(z.string().max(512)).max(12).optional(),
  recommendedSkills: z.array(z.string().max(64)).max(16).optional(),
  modelAdvice: z
    .object({
      tier: z.enum(["fast", "normal", "reasoning", "max"]),
      reason: z.string().max(2000),
      hostAutoApplied: z.literal(false),
    })
    .optional(),
  valueReceipt: agentValueReceiptSchema,
});

const decisionOutputSchemaBase = z.object({
  taskDomain: z.enum(TASK_KINDS),
  executionMode: z.enum(["execute", "plan_first", "approval_required", "block"]),
  riskScore: z.number().min(0).max(1),
  requiresSecurityReview: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(reasonsItemSchema),
  source: z.enum(["jev", "rule", "hard_policy"]),
  selectedPolicyRules: z.array(z.string()).optional(),
  /** P4 recommendations only — hosts are not forced to honor these. */
  routing: routingOutputSchema.optional(),
  /** P6 harness catalog pick — advisory only; hosts are not forced. */
  modelSelection: modelSelectionOutputSchema.optional(),
  /** P5 context path suggestions — identifiers only; optional. */
  contextSuggestion: z
    .object({
      paths: z.array(z.string().min(1).max(512)).max(12),
      source: z.enum(["deterministic", "deterministic+rerank"]),
      reasonIds: z.array(z.string()).max(16),
    })
    .optional(),
  /** JEVCore Agent Contract — always present; keep executionMode alongside. */
  agent: agentOutputSchema,
});

const decisionOutputSchema = decisionOutputSchemaBase;

const batchItemDecisionSchema = decisionOutputSchemaBase.extend({
  index: z.number().int().min(0),
});

const batchDecisionEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  items: z.array(batchItemDecisionSchema),
  meta: z.object({
    strategy: z.enum(["serial", "shared_system_one"]),
    providerCalls: z.number().int().min(0),
  }),
});

/** jev_assess_task may return v1 single decision or v2 batch envelope. */
const assessTaskOutputSchema = z.union([decisionOutputSchema, batchDecisionEnvelopeSchema]);

/**
 * Typed decision emitted by every MCP tool. Mirrors `EngineResult` in
 * tool-facing shape: `confidence` is the conservative min of the
 * classification and risk confidences (the same signal that drives the
 * engine's low-confidence downgrade).
 */
export interface JevDecision {
  taskDomain: TaskKind;
  executionMode: "execute" | "plan_first" | "approval_required" | "block";
  riskScore: number;
  requiresSecurityReview: boolean;
  confidence: number;
  reasons: Array<{ code: string; detail: string }>;
  source: "jev" | "rule" | "hard_policy";
  selectedPolicyRules?: string[];
  /** P4 Preflight Router — omit when unavailable; never fabricated. */
  routing?: {
    complexity: "small" | "medium" | "large";
    recommendedModelTier: "fast" | "normal" | "reasoning";
    recommendedContextBudget: "small" | "medium" | "large";
    recommendedSkillBundle: Array<
      "testing" | "security" | "web3" | "devops" | "frontend" | "backend" | "research"
    >;
    planFirst: boolean;
    source: "deterministic";
  };
  /** P6 harness catalog pick — omit when unavailable; hosts are not forced. */
  modelSelection?: {
    modelId: string;
    tier: "fast" | "normal" | "reasoning";
    contextBudget: "small" | "medium" | "large";
    planFirst: boolean;
    source: "harness";
  };
  /** P5 Context Router — path identifiers only; omit when unavailable. */
  contextSuggestion?: {
    paths: string[];
    source: "deterministic" | "deterministic+rerank";
    reasonIds: string[];
  };
  /** JEVCore Agent Contract — always present alongside executionMode. */
  agent: AgentResult;
}

export interface JevBatchDecisionEnvelope {
  schemaVersion: 2;
  items: Array<JevDecision & { index: number }>;
  meta: {
    strategy: "serial" | "shared_system_one";
    providerCalls: number;
  };
}

/**
 * Shape the public `EngineResult` into the tool-facing typed decision.
 *
 * Boundary contract: every public numeric field must be a finite number within
 * `[0, 1]`. Valid input is returned unchanged. Invalid input is **never
 * coerced** — instead this returns an explicit, conservative, observable
 * fallback decision carrying `MCP-INVALID-DECISION-OUTPUT`, so the failure is
 * visible to the caller rather than silently hidden by clamping.
 *
 * This function never throws and never produces a protocol error: the returned
 * object always satisfies the MCP output schema.
 */
export function toDecisionOutput(result: EngineResult): JevDecision {
  const invalidFields: string[] = [];

  const riskScore = result.risk.score;
  const riskScoreValid = isUnitInterval(riskScore);
  if (!riskScoreValid) invalidFields.push("riskScore outside public 0..1 contract");

  const kindConfidence = result.classification.confidence;
  const kindConfidenceValid = isUnitInterval(kindConfidence);
  if (!kindConfidenceValid) {
    invalidFields.push("classification confidence outside public 0..1 contract");
  }

  const riskConfidence = result.risk.confidence;
  const riskConfidenceValid = isUnitInterval(riskConfidence);
  if (!riskConfidenceValid) invalidFields.push("risk confidence outside public 0..1 contract");

  const domainValid = TASK_KINDS.includes(result.classification.kind);
  if (!domainValid) invalidFields.push("taskDomain outside fixed domain enum");

  // Any out-of-contract value → explicit observable fallback (never coerced).
  if (invalidFields.length > 0) return boundaryFallback(invalidFields);

  // Both confidences are validated as finite and within [0, 1] here, so the
  // conservative selection below cannot produce an out-of-contract value. This
  // is a deliberate conservative *selection* between two valid values — not a
  // clamp, and not a coercion of invalid data.
  const combinedConfidence = kindConfidence <= riskConfidence ? kindConfidence : riskConfidence;

  const policyRuleIds = result.reasons
    .filter((r) => r.code.startsWith("POL-"))
    .map((r) => r.code);

  return {
    taskDomain: result.classification.kind,
    executionMode: result.mode,
    riskScore,
    requiresSecurityReview: result.security.reviewNeeded,
    confidence: combinedConfidence,
    reasons: result.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    source: result.classification.source,
    ...(policyRuleIds.length ? { selectedPolicyRules: policyRuleIds } : {}),
    ...(result.routing ? { routing: result.routing } : {}),
    ...(result.modelSelection
      ? {
          modelSelection: {
            modelId: result.modelSelection.modelId,
            tier: result.modelSelection.tier,
            contextBudget: result.modelSelection.contextBudget,
            planFirst: result.modelSelection.planFirst,
            source: "harness" as const,
          },
        }
      : {}),
    ...(result.contextSuggestion ? { contextSuggestion: result.contextSuggestion } : {}),
    agent: composeAgentFromEngineResult(result),
  };
}

/**
 * Explicit, conservative boundary fallback for an out-of-contract decision.
 * Conservative by design: requires approval, flags security review, and never
 * asserts `execute`. Details carry only the invalid field *category* — never
 * secret data or raw provider payloads.
 */
function boundaryFallback(categories: string[]): JevDecision {
  const mode = "plan_first" as const;
  const skeleton: EngineResult = {
    classification: { kind: SAFE_FALLBACK_DOMAIN, confidence: 0, source: "rule" },
    risk: { score: 1, confidence: 0, factors: ["unclear"] },
    security: { reviewNeeded: true, noul: 1, findings: [] },
    mode,
    reasons: [
      {
        code: MCP_INVALID_DECISION_OUTPUT,
        detail: `Invalid decision output detected at the MCP boundary: ${categories.join("; ")}`,
      },
    ],
    fellBack: true,
  };
  return {
    taskDomain: SAFE_FALLBACK_DOMAIN,
    executionMode: mode,
    riskScore: 1,
    requiresSecurityReview: true,
    confidence: 0,
    reasons: skeleton.reasons,
    source: "rule",
    agent: composeAgentFromEngineResult(skeleton),
  };
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

export interface McpServerOptions {
  /**
   * Decision provider. Default: `TypeSafeProvider` (reads `TYPESAFE_API_KEY`
   * from the environment via the SDK — presence only, never surfaced).
   * Tests inject a fake provider.
   */
  provider?: DecisionProvider;
  /** Custom hard-policy rules; defaults to the library's `DEFAULT_POLICY`. */
  policy?: HardPolicyRule[];
  /** Timeout for the model provider (default 25 000 ms). */
  timeoutMs?: number;
  /** Deterministic risk threshold for fail-safe escalation (default 0.7). */
  elevatedRiskThreshold?: number;
  /** Optional guard engine thresholds; passed through to `Guard`. */
  engineConfig?: {
    lowConfidenceThreshold?: number;
    planRiskThreshold?: number;
    approvalRiskThreshold?: number;
    securityReviewThreshold?: number;
  };
  /**
   * T07 — inject profile / memory for Effective Profile Resolver.
   * When omitted, MCP best-effort loads ~/.cursor/jev-coding-guard/profile.json
   * if present (never creates it; never fails the server if missing).
   */
  profile?: import("./profile/types.js").ProfileV1 | null;
  sessionId?: string;
  preferencesMemory?: import("./memory/index.js").PreferencesMemory;
  sessionRestrictions?: readonly string[];
  /** Skip auto-load of on-disk profile (tests). */
  skipProfileAutoLoad?: boolean;
  /**
   * Telemetry session. Defaults to one resolved from the environment, which is
   * a no-op unless `JEV_GUARD_LOCAL_EVIDENCE=1`. Tests inject their own.
   */
  telemetry?: TelemetrySession;
  /**
   * WP5 fan-out wrapper. Default: ON (unless `JEV_FAN_OUT=0`).
   * When an explicit `provider` is injected, fan-out is never applied — tests and
   * offline eval keep a single controllable call path. Never a less-safe depth
   * knob: enabling only allows the fixed budget of at most two provider calls.
   */
  fanOut?: boolean;
  /**
   * P5 Jev identifier rerank. Default: ON (unless `JEV_CONTEXT_RERANK=0`).
   * When enabled and ≥2 path candidates exist, Guard may add one focused
   * systemOne call (identifiers only). Injected `provider` tests stay off
   * unless `contextRerank: true` is set explicitly with a live key path.
   */
  contextRerank?: boolean;
}

/**
 * Build an `McpServer` with the read-only decision tools plus the read-only
 * `jev_guard_report` evidence tool.
 *
 * Pure construction — no stdio transport is attached here, so this is testable
 * in-process with `InMemoryTransport` and a fake provider.
 *
 * Note on `readOnlyHint`: the assessment tools are read-only with respect to
 * repository, shell, and external-system side effects. When Local Guard
 * Evidence is explicitly enabled, this *process* may asynchronously persist
 * de-identified metadata; that never alters a returned decision.
 */
export function createJevMcpServer(options: McpServerOptions = {}): McpServer {
  const telemetry = options.telemetry ?? TelemetrySession.fromEnv();
  const baseProvider =
    options.provider ?? new TypeSafeProvider({ timeoutMs: options.timeoutMs ?? 25_000 });
  // Telemetry observes provider calls via the documented DecisionProvider seam,
  // so engine.ts and policy.ts stay untouched.
  const observedProvider = telemetry.enabled
    ? new InstrumentedProvider(baseProvider, {
        observe: (record) => telemetry.recordProviderCall(record),
      })
    : baseProvider;
  // WP5: FanOutProvider is ON by default for the live TypeSafe MCP path
  // (disable with JEV_FAN_OUT=0). Injected providers are never wrapped so
  // tests/offline eval stay single-call. The engine only sees the (possibly
  // merged) judgment — it needs no knowledge of fan-out.
  const fanOutWanted = options.fanOut ?? isFanOutEnabled();
  const provider =
    options.provider || !fanOutWanted
      ? observedProvider
      : new FanOutProvider(observedProvider);

  // P5: Jev identifier rerank — default ON for the live TypeSafe MCP path
  // (disable with JEV_CONTEXT_RERANK=0). Injected providers (tests) stay off
  // unless contextRerank:true is set explicitly.
  const contextRerankWanted =
    options.contextRerank ?? (!options.provider && isContextRerankEnabled());
  const contextReranker = contextRerankWanted
    ? new TypeSafeContextReranker({ timeoutMs: options.timeoutMs ?? 15_000 })
    : undefined;

  let profile = options.profile;
  let preferencesMemory = options.preferencesMemory;
  // Auto-load on-disk profile only for the live MCP path (no injected provider),
  // so unit tests stay deterministic and never touch the user's home profile.
  const autoLoad =
    options.skipProfileAutoLoad !== true &&
    options.profile === undefined &&
    !options.provider;
  if (autoLoad) {
    try {
      const store = new ProfileStore();
      profile = store.tryLoad() ?? null;
      if (profile && !preferencesMemory) {
        preferencesMemory = new PreferencesMemory();
      }
    } catch {
      profile = null;
    }
  }

  const guard = new Guard(provider, {
    ...(options.engineConfig ?? {}),
    policy: options.policy ?? DEFAULT_POLICY,
    ...(contextReranker ? { contextReranker } : {}),
    profile: profile ?? null,
    sessionId: options.sessionId,
    preferencesMemory,
    sessionRestrictions: options.sessionRestrictions,
  });
  const elevatedThreshold = options.elevatedRiskThreshold ?? ELEVATED_RISK_THRESHOLD;

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "jev_assess_task",
    {
      title: "Assess a coding task",
      description:
        "Returns a typed decision (domain, execution mode, risk, security-review need) for a coding task, " +
        "using deterministic hard policy and a Jev model judgment. Read-only: never executes, edits, or deploys.",
      inputSchema: assessTaskInputSchema,
      outputSchema: assessTaskOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const typed = args as TaskToolArgs;
      if (typed.batchItems && typed.batchItems.length > 0) {
        return handleBatchTaskDecision(typed, guard, elevatedThreshold, telemetry);
      }
      return handleDecision(args, guard, elevatedThreshold, buildTaskInput(typed), telemetry, "jev_assess_task");
    },
  );

  server.registerTool(
    "jev_assess_command",
    {
      title: "Assess a proposed shell command",
      description:
        "Returns a typed decision for a proposed shell command. The command is treated as TEXT EVIDENCE ONLY — " +
        "it is never executed, and the server never runs shell commands.",
      inputSchema: assessCommandInputSchema,
      outputSchema: decisionOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      handleDecision(args, guard, elevatedThreshold, buildCommandInput(args), telemetry, "jev_assess_command"),
  );

  server.registerTool(
    "jev_review_diff",
    {
      title: "Review a diff",
      description:
        "Returns a typed decision for a set of changed files and a diff summary. Read-only: no files are read " +
        "or written beyond the evidence the caller supplies.",
      inputSchema: reviewDiffInputSchema,
      outputSchema: decisionOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      handleDecision(args, guard, elevatedThreshold, buildDiffInput(args), telemetry, "jev_review_diff"),
  );

  server.registerTool(
    "jev_guard_report",
    {
      title: "Local Guard evidence report",
      description:
        "Returns a concise report over locally stored, de-identified Guard decision metadata. Read-only: " +
        "never calls TypeSafe, never mutates evidence, and never returns stored payloads. Reports when " +
        "local evidence collection is disabled.",
      inputSchema: guardReportInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => handleReport(args, telemetry),
  );

  return server;
}

/**
 * Build and format the evidence report. Read-only; never calls TypeSafe.
 * When evidence is disabled this returns a clear "disabled" explanation.
 */
async function handleReport(
  rawArgs: unknown,
  telemetry: TelemetrySession,
): Promise<CallToolResult> {
  void rawArgs;
  if (!telemetry.enabled) {
    return { content: [{ type: "text", text: formatDisabled() }] };
  }

  const args = rawArgs as { period?: ReportPeriod } | undefined;
  const period: ReportPeriod = args?.period ?? "7d";

  try {
    // Drain any queued events first so the report reflects decisions taken in
    // this session and the database exists. This is the sink's normal async
    // write path, not a report-driven mutation of stored rows; it never throws.
    await telemetry.flush();

    // Open read-only and aggregate. Any failure degrades to a structured
    // message — never an isError, never a protocol error.
    //
    // NOTE: `node:sqlite` must be resolved in two steps. Chaining
    // `createRequire(...)("node:sqlite").DatabaseSync(...)` throws
    // `TypeError: Cannot call constructor without 'new'`.
    const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(telemetry.dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const model = buildReport(db, {
        period,
        databasePath: telemetry.dbPath,
        advisoryBytes: telemetry.advisoryBytes,
        telemetryWriteErrors: telemetry.writeErrorCount(),
      });
      const extras: {
        activeSessionGrants?: number;
        overrideEvents?: number;
        pendingSuggestions?: number;
        profileRevision?: number;
      } = {};
      try {
        const mem = new PreferencesMemory();
        extras.activeSessionGrants = mem.countSessionGrants(true);
        extras.overrideEvents = mem.countOverrideEvents();
        extras.pendingSuggestions = mem.listSuggestions("pending").length;
        mem.close();
      } catch {
        /* optional ledger */
      }
      try {
        const store = new ProfileStore({ skipRevisionLedger: true });
        if (store.exists()) extras.profileRevision = store.load().profileRevision;
      } catch {
        /* optional profile */
      }
      return {
        content: [{ type: "text", text: formatAgentReport(formatReport(model), model, extras) }],
      };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return {
      content: [
        {
          type: "text",
          text:
            "Jev Coding Guard — Local Guard Evidence\n\n" +
            "Status: Local evidence storage is currently unavailable (not yet initialized or unreadable).\n" +
            "No decision data was read or modified. Guard decisions are unaffected.",
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Input normalization: tool arguments -> public GuardInput (no policy logic)
// ---------------------------------------------------------------------------

/** Not quite a zod-inferred type we want to leak; build the GuardInput directly. */
interface TaskToolArgs {
  userTask: string;
  repositoryContext?: string;
  changedFiles?: string[] | null;
  diffSummary?: string | null;
  testSummary?: string | null;
  batchItems?: Array<{ userTask: string; changedFiles?: string[] | null }> | null;
  batchStrategy?: "serial" | "shared_system_one" | null;
}

interface CommandToolArgs {
  userTask: string;
  repositoryContext?: string;
  proposedCommand: string;
  changedFiles?: string[] | null;
}

interface DiffToolArgs {
  userTask: string;
  repositoryContext?: string;
  changedFiles: string[];
  diffSummary: string;
  testSummary?: string | null;
}

function combineText(parts: Array<[string, string | undefined | null]>): string {
  let out = "";
  for (const [label, value] of parts) {
    const v = value?.trim();
    if (v) out += `\n${label}: ${v}`;
  }
  return out.trim();
}

/** Build GuardInput for one batch sub-task (inherits repository context). */
function buildBatchSubTaskInput(
  parent: TaskToolArgs,
  sub: { userTask: string; changedFiles?: string[] | null },
): GuardInput {
  return {
    task: combineText([
      ["Task", sub.userTask],
      ["Repository context", parent.repositoryContext],
    ]),
    hints: {
      touchedFiles: sub.changedFiles ?? [],
      context: parent.repositoryContext ?? "",
    },
  };
}

/** jev_assess_task -> GuardInput. */
function buildTaskInput(a: TaskToolArgs): GuardInput {
  return {
    task: combineText([
      ["Task", a.userTask],
      ["Repository context", a.repositoryContext],
      ["Diff summary", a.diffSummary],
      ["Test summary", a.testSummary],
    ]),
    hints: {
      touchedFiles: a.changedFiles ?? [],
      context: a.repositoryContext ?? "",
    },
  };
}

/** jev_assess_command -> GuardInput (proposedCommand is evidence text only). */
function buildCommandInput(a: CommandToolArgs): GuardInput {
  return {
    task: combineText([
      ["Task", a.userTask],
      ["Proposed command", a.proposedCommand],
      ["Repository context", a.repositoryContext],
    ]),
    hints: {
      touchedFiles: a.changedFiles ?? [],
      context: a.repositoryContext ?? "",
    },
  };
}

/** jev_review_diff -> GuardInput. */
function buildDiffInput(a: DiffToolArgs): GuardInput {
  return {
    task: combineText([
      ["Task", a.userTask],
      ["Diff summary", a.diffSummary],
      ["Test summary", a.testSummary],
      ["Repository context", a.repositoryContext],
    ]),
    hints: {
      touchedFiles: a.changedFiles,
      context: a.repositoryContext ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// Decision execution with fail-safe escalation
// ---------------------------------------------------------------------------

/**
 * Run one decision through the public guard. When the model provider failed
 * and no hard-policy rule matched (mode is `plan_first`), deterministically
 * re-check risk with the library's own `RuleProvider`: if it is elevated,
 * escalate to `approval_required`. Blocks are never created here — only hard
 * policy can produce `block`.
 */
/** Escalate a provider-failure fallback using RuleProvider (no second model call). */
async function applyFailsafeEscalation(
  elevatedThreshold: number,
  input: GuardInput,
  result: EngineResult,
): Promise<EngineResult> {
  if (!result.fellBack || result.mode !== "plan_first") return result;

  const dealerProvider = new RuleProvider();
  const estimate = await dealerProvider.judge(input);
  if (estimate.failed) return result;

  let escalated = false;
  const next = { ...result, reasons: [...result.reasons] };
  if (typeof estimate.riskScore === "number" && estimate.riskScore >= elevatedThreshold) {
    next.mode = "approval_required";
    next.risk = { ...next.risk, score: estimate.riskScore, factors: estimate.riskFactors ?? next.risk.factors };
    escalated = true;
  }
  if (typeof estimate.securityReviewNoul === "number" && estimate.securityReviewNoul >= 0.7) {
    next.security = {
      ...next.security,
      reviewNeeded: true,
      noul: estimate.securityReviewNoul,
      findings: next.security.findings.includes("Deterministic risk estimate requires security review")
        ? next.security.findings
        : [...next.security.findings, "Deterministic risk estimate requires security review"],
    };
    escalated = true;
  }
  if (escalated) {
    next.reasons.push({
      code: "FAIL-SAFE",
      detail:
        "Model provider unavailable; deterministic risk estimate applied and execution escalated to approval_required",
    });
    // Drop stale agent so compose rebuilds from the escalated mode.
    delete next.agent;
    next.agent = composeAgentFromEngineResult(next);
  }
  return escalated ? next : result;
}

async function decideWithFailsafe(
  guard: Guard,
  elevatedThreshold: number,
  input: GuardInput,
): Promise<EngineResult> {
  const result = await guard.decide(input);
  return applyFailsafeEscalation(elevatedThreshold, input, result);
}

/** C-5 — batch assess_task path (schemaVersion 2). */
async function handleBatchTaskDecision(
  args: TaskToolArgs,
  guard: Guard,
  elevatedThreshold: number,
  telemetry: TelemetrySession,
): Promise<CallToolResult> {
  const items = args.batchItems ?? [];
  const strategy = args.batchStrategy ?? "shared_system_one";
  const inputs = items.map((sub) => buildBatchSubTaskInput(args, sub));
  const elapsed = startTimer();
  try {
    const { items: batchItems, meta } = await guard.decideManyWithMeta(inputs, {
      maxItems: 8,
      strategy,
    });
    const batchId = randomUUID();
    const batchCtx = {
      batchId,
      batchSize: batchItems.length,
      strategy: meta.strategy,
    };
    const outputs: JevBatchDecisionEnvelope = {
      schemaVersion: 2,
      items: [],
      meta,
    };
    for (const row of batchItems) {
      const input = inputs[row.index]!;
      const result = await applyFailsafeEscalation(elevatedThreshold, input, row.result);
      const out = toDecisionOutput(result);
      outputs.items.push({ ...out, index: row.index });
      telemetry.recordDecision(result, "jev_assess_task", elapsed(), batchCtx);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(outputs, null, 2) }],
      structuredContent: outputs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `jev-coding-guard batch error: ${message}` }],
      isError: true,
    };
  }
}

async function handleDecision(
  rawArgs: unknown,
  guard: Guard,
  elevatedThreshold: number,
  input: GuardInput,
  telemetry: TelemetrySession,
  tool: DecisionTool,
): Promise<CallToolResult> {
  // rawArgs is ignored deliberately: the SDK has already validated and typed
  // the arguments against the zod inputSchema before this handler runs.
  void rawArgs;
  const elapsed = startTimer();
  try {
    const result = await decideWithFailsafe(guard, elevatedThreshold, input);
    const output = toDecisionOutput(result);
    // Enqueue-only and non-throwing: telemetry never delays this response.
    telemetry.recordDecision(result, tool, elapsed());
    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `jev-coding-guard error: ${message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// stdio entry point
// ---------------------------------------------------------------------------

/**
 * Serve the standard configuration over stdio. Launched by Cursor through
 * `zsh -lc 'node <repo>/dist/mcp-server.js'` so the locally exported
 * `TYPESAFE_API_KEY` (from `~/.zshenv`) reaches the MCP process.
 */
export function serveStdioEntry(options: McpServerOptions = {}): void {
  const telemetry = options.telemetry ?? TelemetrySession.fromEnv();
  void serveStdio(() => createJevMcpServer({ ...options, telemetry }), {
    onerror: (error) => {
      // stderr is the correct sink for out-of-band server errors; it is not
      // visible to the model and never carries secrets.
      console.error(`[jev-coding-guard mcp] ${error.message}`);
    },
  });

  // Best-effort flush on graceful shutdown. Never blocks or throws.
  if (telemetry.enabled) {
    const shutdown = (): void => {
      void telemetry.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("beforeExit", shutdown);
  }
}

if (import.meta.main) {
  serveStdioEntry();
}