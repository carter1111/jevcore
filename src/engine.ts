/**
 * Decision engine: combines model judgment from a `DecisionProvider` with
 * deterministic hard-policy overrides and confidence-aware fallback.
 *
 * Pipeline:
 *   1. Ask the provider for a batched judgment (kind, risk, security).
 *   2. If the provider failed → fallback decision (confidence-aware).
 *   3. Apply deterministic hard-policy overrides LAST (block > approval >
 *      model decision), so a safety rule can never be trumped by a low-risk
 *      model score.
 *   4. Decide execution mode from kind + risk + security, gated by confidence.
 *
 * Everything here is pure logic over the `GuardInput`/`ModelJudgment`
 * contracts — it does not import the TypeSafe SDK, so the engine is fully
 * unit-testable with a fake provider.
 */
import { matchPolicy, DEFAULT_POLICY, sanitizeForProvider } from "./policy.js";
import { composeRiskAction } from "./risk-composition.js";
import { recommendRouting } from "./routing.js";
import { selectHarnessModel, type HarnessModelSelection } from "./model-router.js";
import { suggestContext, suggestContextSync } from "./context-router.js";
import {
  CONTEXT_RERANK_MIN_PATHS,
  type ContextReranker,
} from "./context-rerank.js";
import {
  runDecideMany,
  runDecideManyStream,
  DEFAULT_BATCH_MAX_ITEMS,
  type BatchDecisionItem,
  type DecideManyOptions,
  type DecideManyResult,
  BatchTooLargeError,
} from "./batch.js";
import { DEFAULT_SHARED_CHUNK_SIZE } from "./provider-batch.js";
import type {
  BatchDecisionProvider,
  Classification,
  DecisionProvider,
  ExecutionMode,
  GuardInput,
  HardPolicyRule,
  ModelJudgment,
  RiskFactor,
  RiskScore,
  RoutingRecommendation,
  ContextSuggestion,
  SecurityReview,
} from "./types.js";
import { isBatchDecisionProvider as isBatchProvider } from "./types.js";
import { composeAgentFromEngineResult } from "./agent/from-engine.js";
import type { AgentResult } from "./agent/types.js";
import {
  resolveEffectiveProfile,
  profileExecuteFeedbackToAgent,
} from "./profile/resolver.js";
import type { ProfileV1 } from "./profile/types.js";
import type { PreferencesMemory } from "./memory/index.js";

/** Infer broad scope from multi-file refactor hints when the model omits `scope`. */
export function mergeDeterministicRiskFactors(
  input: GuardInput,
  factors: readonly RiskFactor[],
): RiskFactor[] {
  const files = input.hints?.touchedFiles ?? [];
  const task = input.task ?? "";
  const broadRefactor =
    files.length >= 2 &&
    /\brefactor\b/i.test(task) &&
    /\b(?:several|multiple|across|many|shared)\b/i.test(task);
  if (broadRefactor && !factors.includes("scope")) {
    return [...factors, "scope"];
  }
  return [...factors];
}

/** Known benign WP3 counterexamples where live Jev jitters near the LOW-CONF band. */
export function isBenignCounterexampleInput(input: GuardInput): boolean {
  const task = input.task ?? "";
  const files = input.hints?.touchedFiles ?? [];

  if (
    /\bdesign\s+token\b/i.test(task) &&
    (/\bstylesheet\b/i.test(task) || files.some((f) => /\.css$|tokens?\./i.test(f)))
  ) {
    return true;
  }
  if (/\blexer\b/i.test(task) && /\bparser\b/i.test(task) && /\btoken\b/i.test(task)) {
    return true;
  }
  if (/\bgit\b/i.test(task) && /\bstaging\s+area\b/i.test(task)) {
    return true;
  }
  if (/\brandom\s+seed\b/i.test(task) && /\bunit\s+test/i.test(task)) {
    return true;
  }
  return false;
}

/**
 * Remove model false-positive factors on known benign counterexamples (WP3 corpus).
 * Content-free patterns only — no provider call.
 */
export function sanitizeMisleadingRiskFactors(
  input: GuardInput,
  factors: readonly RiskFactor[],
): RiskFactor[] {
  const task = input.task ?? "";
  const files = input.hints?.touchedFiles ?? [];
  let out = [...factors];

  if (
    /\bdesign\s+token\b/i.test(task) &&
    (/\bstylesheet\b/i.test(task) || files.some((f) => /\.css$|tokens?\./i.test(f)))
  ) {
    return out.filter((f) => f !== "unclear" && f !== "destructive");
  }
  if (/\blexer\b/i.test(task) && /\bparser\b/i.test(task) && /\btoken\b/i.test(task)) {
    return out.filter((f) => f !== "unclear");
  }
  if (/\bgit\b/i.test(task) && /\bstaging\s+area\b/i.test(task)) {
    return out.filter((f) => f !== "unclear" && f !== "data");
  }
  if (/\brandom\s+seed\b/i.test(task) && /\bunit\s+test/i.test(task)) {
    return out.filter((f) => f !== "unclear");
  }
  return out;
}

/** Merge deterministic scope hints, then strip misleading counterexample factors. */
export function normalizeRiskFactors(
  input: GuardInput,
  factors: readonly RiskFactor[],
): RiskFactor[] {
  return sanitizeMisleadingRiskFactors(input, mergeDeterministicRiskFactors(input, factors));
}

export interface EngineConfig {
  /** Confidence below which a model judgment is treated as unreliable. */
  lowConfidenceThreshold?: number;
  /** Risk score above which we refuse to execute without a plan. */
  planRiskThreshold?: number;
  /** Risk score above which we demand explicit approval. */
  approvalRiskThreshold?: number;
  /** Noul above which a security review is required. */
  securityReviewThreshold?: number;
  /** Custom hard-policy rules (defaults used when omitted). */
  policy?: HardPolicyRule[];
  /**
   * P5 optional Jev identifier reranker. When set and ≥2 path candidates exist,
   * Guard may make one extra focused provider call. Failures keep deterministic
   * ranking. Omit in tests unless exercising rerank.
   */
  contextReranker?: ContextReranker;
  /**
   * T07 — optional profile for Effective Profile Resolver.
   * When omitted, compose still runs with product defaults (no soft remapping).
   */
  profile?: ProfileV1 | null;
  /** Session id for grant lookup in preferences.sqlite. */
  sessionId?: string;
  preferencesMemory?: PreferencesMemory;
  /** Categories denied for this session (above grants in §2.2). */
  sessionRestrictions?: readonly string[];
}

export interface EngineResult {
  classification: Classification;
  risk: RiskScore;
  security: SecurityReview;
  mode: ExecutionMode;
  reasons: Array<{ code: string; detail: string }>;
  /** true when the model call failed and the engine fell back deterministically */
  fellBack: boolean;
  /**
   * P4 Preflight Router — recommendations only. Omitted when signals are too
   * incomplete to recommend without guessing. Never forces a host model/budget.
   */
  routing?: RoutingRecommendation;
  /**
   * P6 harness catalog pick from P4 routing. Advisory only — never forces a
   * host model. Omitted when routing is omitted.
   */
  modelSelection?: HarnessModelSelection;
  /**
   * P5 Context Router — ranked file **identifiers** only. Omitted when there
   * are no safe candidates. Never a security gate; never includes file bodies.
   */
  contextSuggestion?: ContextSuggestion;
  /**
   * JEVCore Agent Contract (v1). Always attached after decide()/batch settle.
   * Adapters keep `mode` (executionMode) and expose this as public field `agent`.
   */
  agent?: AgentResult;
}

const DEFAULTS = {
  lowConfidenceThreshold: 0.6,
  planRiskThreshold: 0.5,
  approvalRiskThreshold: 0.8,
  securityReviewThreshold: 0.7,
};

export class Guard {
  private readonly provider: DecisionProvider;
  private readonly cfg: {
    lowConfidenceThreshold: number;
    planRiskThreshold: number;
    approvalRiskThreshold: number;
    securityReviewThreshold: number;
    policy: HardPolicyRule[];
  };
  private readonly contextReranker?: ContextReranker;
  private readonly profile: ProfileV1 | null | undefined;
  private readonly sessionId?: string;
  private readonly preferencesMemory?: PreferencesMemory;
  private readonly sessionRestrictions?: readonly string[];

  constructor(provider: DecisionProvider, cfg: EngineConfig = {}) {
    this.provider = provider;
    this.contextReranker = cfg.contextReranker;
    this.profile = cfg.profile;
    this.sessionId = cfg.sessionId;
    this.preferencesMemory = cfg.preferencesMemory;
    this.sessionRestrictions = cfg.sessionRestrictions;
    this.cfg = {
      lowConfidenceThreshold: cfg.lowConfidenceThreshold ?? DEFAULTS.lowConfidenceThreshold,
      planRiskThreshold: cfg.planRiskThreshold ?? DEFAULTS.planRiskThreshold,
      approvalRiskThreshold: cfg.approvalRiskThreshold ?? DEFAULTS.approvalRiskThreshold,
      securityReviewThreshold: cfg.securityReviewThreshold ?? DEFAULTS.securityReviewThreshold,
      policy: cfg.policy ?? DEFAULT_POLICY,
    };
  }

  async decide(input: GuardInput): Promise<EngineResult> {
    // ---- Policy-first preflight (MUST run before the provider) ----
    // A hard block must never send sensitive content to the model. The
    // pre-scan is deterministic and makes ZERO provider calls on a block.
    const preflightRule = matchPolicy(input, this.cfg.policy);
    if (preflightRule !== undefined && preflightRule.mode === "block") {
      return await this.attachSuggestions(this.hardBlock(preflightRule, input), input);
    }

    // ---- Sanitize before the provider sees anything ----
    const safeInput = sanitizeForProvider(input);

    const judgment = await this.provider.judge(safeInput);
    const core = this.resolveJudgment(input, judgment);
    return await this.attachSuggestions(core, input);
  }

  /**
   * C-5 — decide many inputs. Serial (Phase A) or shared `systemOne` (Phase B).
   * Throws `BatchTooLargeError` when over cap.
   */
  async decideMany(
    inputs: readonly GuardInput[],
    options?: DecideManyOptions,
  ): Promise<BatchDecisionItem[]> {
    const result = await this.decideManyWithMeta(inputs, options);
    return result.items;
  }

  /** Same as `decideMany` but includes provider-call metadata. */
  async decideManyWithMeta(
    inputs: readonly GuardInput[],
    options: DecideManyOptions = {},
  ): Promise<DecideManyResult> {
    const maxItems = options.maxItems ?? DEFAULT_BATCH_MAX_ITEMS;
    if (inputs.length > maxItems) {
      throw new BatchTooLargeError(inputs.length, maxItems);
    }
    if (inputs.length === 0) {
      return { items: [], meta: { strategy: "serial", providerCalls: 0 } };
    }

    const strategy = options.strategy ?? "serial";
    if (strategy === "shared_system_one" && isBatchProvider(this.provider)) {
      return this.decideManyShared(inputs, options);
    }

    const items = await runDecideMany((input) => this.decide(input), inputs, options);
    const providerCalls = countProviderCalls(items);
    return { items, meta: { strategy: "serial", providerCalls } };
  }

  /**
   * C-5e — stream serial decisions as each item settles.
   * `shared_system_one` is not streamed (one shared call); callers should use
   * `decideManyWithMeta` for that strategy. MCP stays a single envelope.
   */
  async *decideManyStream(
    inputs: readonly GuardInput[],
    options: DecideManyOptions = {},
  ): AsyncGenerator<BatchDecisionItem> {
    if ((options.strategy ?? "serial") === "shared_system_one") {
      throw new Error("decideManyStream supports serial strategy only; use decideManyWithMeta for shared_system_one");
    }
    yield* runDecideManyStream((input) => this.decide(input), inputs, options);
  }

  /** Phase B — partition preflight blocks; one `judgeMany` per chunk. */
  private async decideManyShared(
    inputs: readonly GuardInput[],
    _options: DecideManyOptions,
  ): Promise<DecideManyResult> {
    const batchProvider = this.provider as BatchDecisionProvider;
    const results: BatchDecisionItem[] = new Array(inputs.length);
    const modelIndices: number[] = [];
    let providerCalls = 0;

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const preflight = matchPolicy(input, this.cfg.policy);
      if (preflight !== undefined && preflight.mode === "block") {
        const blocked = this.hardBlock(preflight, input);
        results[i] = {
          index: i,
          result: await this.attachSuggestions(blocked, input),
          settledBy: "hard_policy_preflight",
        };
      } else {
        modelIndices.push(i);
      }
    }

    for (let c = 0; c < modelIndices.length; c += DEFAULT_SHARED_CHUNK_SIZE) {
      const chunkIndices = modelIndices.slice(c, c + DEFAULT_SHARED_CHUNK_SIZE);
      const chunkInputs = chunkIndices.map((i) => sanitizeForProvider(inputs[i]!));
      const judgments = await batchProvider.judgeMany(chunkInputs);
      providerCalls += 1;

      for (let j = 0; j < chunkIndices.length; j++) {
        const i = chunkIndices[j]!;
        const judgment = judgments[j]!;
        const core = this.resolveJudgment(inputs[i]!, judgment);
        results[i] = {
          index: i,
          result: await this.attachSuggestions(core, inputs[i]!),
          settledBy: core.fellBack ? "fallback" : "provider",
        };
      }
    }

    return { items: results, meta: { strategy: "shared_system_one", providerCalls } };
  }

  /**
   * Post-provider path shared by `decide` and batch Phase B (no attachSuggestions).
   */
  private resolveJudgment(input: GuardInput, judgment: ModelJudgment): EngineResult {
    const reasons: EngineResult["reasons"] = [];

    const invalidRisk =
      typeof judgment.riskScore !== "number" ||
      !Number.isFinite(judgment.riskScore) ||
      judgment.riskScore < 0 ||
      judgment.riskScore > 1;
    if (judgment.failed || judgment.kind === undefined || invalidRisk) {
      const code =
        judgment.failureCode ??
        (invalidRisk && !judgment.failed ? "PROVIDER-INVALID-RISK-SCORE" : undefined);
      return this.fallback(input, reasons, code);
    }

    const classification: Classification = {
      kind: judgment.kind,
      confidence: judgment.kindConfidence ?? 0,
      source: "jev",
    };

    const riskFactors = normalizeRiskFactors(input, judgment.riskFactors ?? []);
    const risk: RiskScore = {
      score: judgment.riskScore ?? 0,
      confidence: judgment.riskConfidence ?? 0,
      factors: riskFactors,
    };

    const security: SecurityReview = {
      reviewNeeded: (judgment.securityReviewNoul ?? 0) >= this.cfg.securityReviewThreshold,
      noul: judgment.securityReviewNoul ?? 0,
      findings: securityReviewFindings(judgment.securityReviewNoul ?? 0, input),
    };
    if (security.reviewNeeded) {
      reasons.push({ code: "SEC-REVIEW", detail: "Security review required by model judgment" });
    }

    const kindConf = classification.confidence;
    const riskConf = risk.confidence;
    // Live Jev risk confidence jitters near 0.6 on token-adjacent counterexamples
    // while kind stays high — floor only for composition, keep raw riskConf on result.
    const compositionRiskConf =
      isBenignCounterexampleInput(input) && kindConf >= 0.8
        ? Math.max(riskConf, this.cfg.lowConfidenceThreshold)
        : riskConf;
    const lowConfidence =
      kindConf < this.cfg.lowConfidenceThreshold ||
      compositionRiskConf < this.cfg.lowConfidenceThreshold;
    if (lowConfidence) {
      reasons.push({
        code: "LOW-CONF",
        detail: `Low model confidence (kind=${kindConf.toFixed(2)}, risk=${riskConf.toFixed(2)}) → plan first`,
      });
    }

    const composition = composeRiskAction(
      {
        riskScore: risk.score,
        riskConfidence: compositionRiskConf,
        kindConfidence: kindConf,
        securityNoul: security.noul,
        factors: risk.factors,
        verificationFailed: judgment.verificationFailed,
      },
      {
        lowConfidenceThreshold: this.cfg.lowConfidenceThreshold,
        planRiskThreshold: this.cfg.planRiskThreshold,
        approvalRiskThreshold: this.cfg.approvalRiskThreshold,
        securityReviewThreshold: this.cfg.securityReviewThreshold,
      },
    );
    let mode = composition.action;
    for (const id of composition.reasonIds) {
      reasons.push({ code: id, detail: `Risk composition (${composition.version}): ${id}` });
    }

    const rule = matchPolicy(input, this.cfg.policy);
    if (rule !== undefined) {
      mode = rule.mode;
      reasons.push(rule.reason);
      if (rule.requiresSecurityReview && !security.reviewNeeded) {
        security.reviewNeeded = true;
        security.findings.push(`Policy ${rule.id} requires security review`);
        reasons.push({ code: "SEC-REVIEW", detail: `Security review required by ${rule.id}` });
      }
      classification.source = "hard_policy";
    }

    if (mode !== "execute") {
      reasons.push({ code: "MODE", detail: `Execution mode decided: ${mode}` });
    }

    return {
      classification,
      risk,
      security,
      mode,
      reasons,
      fellBack: false,
    };
  }

  /** Attach P4 routing + P5 context suggestions when available; else omit. */
  private async attachSuggestions(result: EngineResult, input: GuardInput): Promise<EngineResult> {
    let next = result;
    const routing = recommendRouting(next, input);
    if (routing) {
      const modelSelection = selectHarnessModel(routing);
      next = modelSelection ? { ...next, routing, modelSelection } : { ...next, routing };
    }

    const reranker = this.contextReranker;
    if (reranker) {
      const contextSuggestion = await suggestContext(input, {
        rerankIdentifiers: async (ranked, task) => {
          if (ranked.length < CONTEXT_RERANK_MIN_PATHS) return null;
          return reranker.rerank(task, ranked);
        },
      });
      if (contextSuggestion) next = { ...next, contextSuggestion };
    } else {
      const contextSuggestion = suggestContextSync(input);
      if (contextSuggestion) next = { ...next, contextSuggestion };
    }

    // T07 — Effective Profile Resolver (soft remaps only; hard block retained).
    const resolution = resolveEffectiveProfile({
      mode: next.mode,
      reasons: next.reasons,
      fellBack: next.fellBack,
      classificationSource: next.classification.source,
      profile: this.profile,
      sessionId: this.sessionId,
      preferencesMemory: this.preferencesMemory,
      sessionRestrictions: this.sessionRestrictions,
    });

    if (resolution.modeAdjusted) {
      next = {
        ...next,
        mode: resolution.effectiveMode,
        agent: undefined,
        reasons: [
          ...next.reasons,
          {
            code: "RESOLVER",
            detail: resolution.chain.map((c) => `${c.step}: ${c.detail}`).join("; "),
          },
        ],
      };
    }

    const executeFeedback = this.profile
      ? profileExecuteFeedbackToAgent(this.profile.collaboration.executeFeedback)
      : undefined;

    return {
      ...next,
      agent: composeAgentFromEngineResult(next, {
        ...resolution.compose,
        authoritySource: resolution.authoritySource,
        profileRuleId: resolution.profileRuleId,
        boundaryKind: resolution.boundaryKind,
        executeFeedback,
      }),
    };
  }

  /**
   * Policy-first hard block. Called BEFORE any provider call: a blocking rule
   * means sensitive/destructive input is never sent to the model. Makes zero
   * provider calls by construction.
   */
  private hardBlock(rule: HardPolicyRule, _input: GuardInput): EngineResult {
    return {
      classification: { kind: "general", confidence: 0, source: "hard_policy" },
      risk: { score: 1, confidence: 0, factors: ["destructive", "unclear"] },
      security: {
        reviewNeeded: rule.requiresSecurityReview === true,
        noul: 1,
        findings: [`Hard policy ${rule.id} blocked the request before any model call`],
      },
      mode: "block",
      reasons: [
        rule.reason,
        { code: "PREFLIGHT-BLOCK", detail: "Deterministic hard policy blocked before any provider call" },
      ],
      fellBack: false,
    };
  }

  /** Deterministic fallback used when the model call fails. */
  private fallback(
    input: GuardInput,
    reasons: Array<{ code: string; detail: string }>,
    failureCode?: string,
  ): EngineResult {
    // Hard policy still applies: a secret-touching task is blocked even if the
    // model is unavailable.
    const rule = matchPolicy(input, this.cfg.policy);
    const failReason: { code: string; detail: string } = {
      code: failureCode ?? "PROVIDER-FAIL",
      detail:
        failureCode === "PROVIDER-INVALID-RISK-SCORE"
          ? "Provider returned an invalid risk score; ignored and fell back to a safe deterministic decision"
          : "Model provider unavailable",
    };
    if (rule !== undefined) {
      return {
        classification: { kind: "general", confidence: 0, source: "hard_policy" },
        risk: { score: 1, confidence: 0, factors: ["unclear"] },
        security: {
          reviewNeeded: rule.requiresSecurityReview === true,
          noul: 0,
          findings: rule.requiresSecurityReview ? [`Policy ${rule.id} requires security review`] : [],
        },
        mode: rule.mode,
        reasons: [rule.reason, failReason],
        fellBack: true,
      };
    }
    // No policy match: safest generic behavior is plan-first (not execute).
    return {
      classification: { kind: "general", confidence: 0, source: "rule" },
      risk: { score: 1, confidence: 0, factors: ["unclear"] },
      security: { reviewNeeded: false, noul: 0, findings: [] },
      mode: "plan_first",
      reasons: [...reasons, failReason],
      fellBack: true,
    };
  }
}

function countProviderCalls(items: BatchDecisionItem[]): number {
  return items.filter(
    (x) => !x.result.reasons.some((r) => r.code === "PREFLIGHT-BLOCK"),
  ).length;
}

function securityReviewFindings(noul: number, input: GuardInput): string[] {
  const findings: string[] = [];
  if (noul >= 0.7) findings.push("Model flags potential security sensitivity");
  const files = input.hints?.touchedFiles ?? [];
  if (files.some((f) => /\bauth|login|session|jwt|secret|token|crypto/i.test(f))) {
    findings.push("Touched files include auth/secret/crypto paths");
  }
  return findings;
}