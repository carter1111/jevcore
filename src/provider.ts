/**
 * TypeSafe provider: adapts the official `@typesafe-ai/sdk` to the
 * `DecisionProvider` contract.
 *
 * One batched `systemOne` call produces classify + risk + security judgments.
 * All question definitions live here so the decision logic (in `engine.ts`)
 * stays SDK-free and testable with a fake provider.
 */
import {
  choice,
  noul,
  score,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";

import type {
  BatchDecisionProvider,
  GuardInput,
  JudgeOptions,
  ModelJudgment,
  RiskFactor,
  TaskKind,
} from "./types.js";
import {
  buildBatchState,
  buildBatchQuestions,
  parseBatchJudgments,
  DEFAULT_SHARED_CHUNK_SIZE,
} from "./provider-batch.js";
import {
  QUESTION_PACK_V1,
  riskCriteriaFromPack,
  type ChoiceSpec,
  type NoulSpec,
  type QuestionInstructions,
  type QuestionPack,
  type ScoreSpec,
} from "./question-packs.js";

export interface TypeSafeProviderConfig {
  /** Timeout per attempt in ms. Default 10000. */
  timeoutMs?: number;
  /** Override fetch (tests / transport). Falls back to global fetch. */
  fetch?: TypeSafeClientConfig["fetch"];
  /** Override API key; falls back to TYPESAFE_API_KEY, then SDK default. */
  apiKey?: string;
  /** Override base URL; falls back to TYPESAFE_BASE_URL. */
  baseURL?: string;
  /** Override model; falls back to jev-latest. */
  model?: string;
}

const TASK_KINDS: TaskKind[] = [
  "frontend",
  "backend",
  "web3",
  "devops",
  "testing",
  "research",
  "general",
];

const RISK_FACTORS: RiskFactor[] = [
  "scope",
  "destructive",
  "data",
  "security",
  "irreversible",
  "unclear",
];

/**
 * Ordered risk rubric, derived from the Question Pack so the pack is the single
 * source of truth for level cardinality and ordering.
 *
 * TypeSafe `Score` answers are a *position across these ordered levels* — the
 * raw `score` is a level index in `[0, levels - 1]`, NOT a probability. The
 * public Guard/MCP contract is a normalized `0..1` risk score, so
 * `rawScore / maxLevel` is applied (see `normalizeRiskScore`).
 *
 * INVARIANT: the level count is derived from the pack (never hard-coded), so
 * adding/removing a level keeps normalization correct automatically.
 */
export const RISK_CRITERIA: readonly string[] = riskCriteriaFromPack(QUESTION_PACK_V1);

/** Maximum raw risk level index (levels - 1). Derived, never hard-coded. */
export const RISK_MAX_LEVEL = RISK_CRITERIA.length - 1;

/**
 * Normalize a raw TypeSafe risk `Score` level index into the public `0..1`
 * contract.
 *
 * Returns `undefined` for any invalid provider data (non-finite, negative, or
 * above `RISK_MAX_LEVEL`). Callers must treat `undefined` as a provider
 * failure and fall back deterministically — invalid data is never silently
 * clamped, because clamping would fabricate a safety judgment.
 */
export function normalizeRiskScore(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > RISK_MAX_LEVEL) return undefined;
  const normalized = raw / RISK_MAX_LEVEL;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) return undefined;
  return normalized;
}

// ---------------------------------------------------------------------------
// Question Pack -> SDK question builders
//
// The pack is pure data; these adapters are the only place the SDK's question
// constructors are applied. Structured criteria are passed through as JSON
// objects (supported by the SDK's `EntryType`), so the model sees the
// `what`/`notFor`/`examples` structure rather than a flat sentence.
// ---------------------------------------------------------------------------

/** Turn structured instructions into the SDK's `EntryType` (object form). */
function instructionsToEntry(instructions: QuestionInstructions) {
  const entry: { question: string; focus?: string; inspect?: string; compare?: string[] } = {
    question: instructions.question,
  };
  if (instructions.focus !== undefined) entry.focus = instructions.focus;
  if (instructions.inspect !== undefined) entry.inspect = instructions.inspect;
  if (instructions.compare !== undefined) entry.compare = [...instructions.compare];
  return entry;
}

/** Build the SDK `choice` question from a pack Choice spec. */
function choiceFromSpec(spec: ChoiceSpec) {
  const criteria: Record<string, { what: string; notFor?: string; examples?: string[] }> = {};
  for (const [label, option] of Object.entries(spec.criteria)) {
    const entry: { what: string; notFor?: string; examples?: string[] } = { what: option.what };
    if (option.notFor !== undefined) entry.notFor = option.notFor;
    if (option.examples !== undefined) entry.examples = [...option.examples];
    criteria[label] = entry;
  }
  return choice(instructionsToEntry(spec.instructions), criteria);
}

/** Build the SDK `score` question from a pack Score spec (ordered levels). */
function scoreFromSpec(spec: ScoreSpec) {
  const levels = spec.levels.map((level) => {
    const entry: { what: string; signals?: string[]; examples?: string[] } = { what: level.what };
    if (level.signals !== undefined) entry.signals = [...level.signals];
    if (level.examples !== undefined) entry.examples = [...level.examples];
    return entry;
  });
  // The SDK requires a tuple of at least two ordered levels; the pack guarantees
  // >= 2 (enforced by the pack tests and the Score type).
  const criteria = levels as unknown as [typeof levels[number], typeof levels[number], ...(typeof levels[number])[]];
  return score(instructionsToEntry(spec.instructions), criteria);
}

/** Build the SDK `noul` question from a pack Noul spec. */
function noulFromSpec(spec: NoulSpec) {
  const side = (s: NoulSpec["criteria"]["true"]) => {
    const entry: { what: string; notFor?: string; examples?: string[] } = { what: s.what };
    if (s.notFor !== undefined) entry.notFor = s.notFor;
    if (s.examples !== undefined) entry.examples = [...s.examples];
    return entry;
  };
  return noul(instructionsToEntry(spec.instructions), {
    true: side(spec.criteria.true),
    false: side(spec.criteria.false),
  });
}

/**
 * Build the full, ordered question set from a pack. Preserves the existing
 * question count and names exactly: one `kind` Choice, one `risk` Score, the
 * six risk-factor Nouls, and the `security_review` Noul.
 */
export function buildQuestions(pack = QUESTION_PACK_V1) {
  return {
    kind: choiceFromSpec(pack.kind),
    risk: scoreFromSpec(pack.risk),
    factor_scope: noulFromSpec(pack.factors.scope),
    factor_destructive: noulFromSpec(pack.factors.destructive),
    factor_data: noulFromSpec(pack.factors.data),
    factor_security: noulFromSpec(pack.factors.security),
    factor_irreversible: noulFromSpec(pack.factors.irreversible),
    factor_unclear: noulFromSpec(pack.factors.unclear),
    security_review: noulFromSpec(pack.securityReview),
  };
}

/** Domain-pack id → the factor Nouls Round 1 actually needs to confirm. */
function verifyFactorsForPack(packId?: string): RiskFactor[] {
  switch (packId) {
    case "database":
      return ["data", "irreversible"];
    case "deploy":
      return ["irreversible", "scope"];
    case "authz":
      return ["security"];
    case "web3":
      return ["irreversible", "security"];
    default:
      return ["unclear"];
  }
}

/**
 * Slim Round-1 verification set: risk + security review + 1–2 domain factors.
 * Omits `kind` (Round 0 already classified) to cut extra-call latency.
 */
export function buildVerifyQuestions(pack = QUESTION_PACK_V1, packId?: string) {
  const questions: Record<string, ReturnType<typeof scoreFromSpec> | ReturnType<typeof noulFromSpec>> = {
    risk: scoreFromSpec(pack.risk),
  };
  for (const factor of verifyFactorsForPack(packId)) {
    questions[`factor_${factor}`] = noulFromSpec(pack.factors[factor]);
  }
  questions.security_review = noulFromSpec(pack.securityReview);
  return questions;
}

export class TypeSafeProvider implements BatchDecisionProvider {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(config: TypeSafeProviderConfig = {}) {
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      fetch: config.fetch,
      timeout: config.timeoutMs,
    });
    this.model = config.model ?? "jev-latest";
  }

  async judge(input: GuardInput, options?: JudgeOptions): Promise<ModelJudgment> {
    const state = {
      task: input.task,
      touchedFiles: input.hints?.touchedFiles ?? [],
      mentionsProduction: input.hints?.mentionsProd === true,
      context: input.hints?.context ?? "",
    };

    // WP5.1: Round 1 may pass a focused domain pack; Round 0 / default uses V1.
    const pack =
      options?.pack !== undefined && options.pack !== null
        ? (options.pack as QuestionPack)
        : QUESTION_PACK_V1;
    const questions =
      options?.questionSet === "verify"
        ? (buildVerifyQuestions(pack, options.packId) as unknown as ReturnType<typeof buildQuestions>)
        : buildQuestions(pack);

    try {
      const resp = await this.client.systemOne({ model: this.model, state, questions });
      const a = resp.answers;

      // Risk must be normalized BEFORE it reaches the engine: TypeSafe returns
      // a level index (0..RISK_MAX_LEVEL), while the public contract is 0..1.
      // Invalid data is NOT clamped — it becomes a provider failure so the
      // engine falls back deterministically instead of trusting bad input.
      const riskScore = normalizeRiskScore(a.risk?.score);
      if (riskScore === undefined) {
        // Invalid provider data → provider-failure fallback (never clamped,
        // never allowed to crash the MCP protocol with -32603).
        return { failed: true, failureCode: "PROVIDER-INVALID-RISK-SCORE" };
      }

      const factors: RiskFactor[] = [];
      for (const [key, flag] of [
        ["factor_scope", "scope"],
        ["factor_destructive", "destructive"],
        ["factor_data", "data"],
        ["factor_security", "security"],
        ["factor_irreversible", "irreversible"],
        ["factor_unclear", "unclear"],
      ] as const) {
        const n = a[key]?.noul;
        if (typeof n === "number" && n >= 0.5) factors.push(flag);
      }

      return {
        kind: a.kind?.choice as TaskKind | undefined,
        kindConfidence: a.kind?.confidence,
        riskScore,
        riskConfidence: a.risk?.confidence,
        riskFactors: factors.length ? factors : undefined,
        securityReviewNoul: a.security_review?.noul,
        failed: false,
        // Informational only; consumed by the telemetry decorator. Never
        // affects the decision. The SDK reports these on every response.
        usage: {
          inputTokens: typeof resp.usage?.input_tokens === "number" ? resp.usage.input_tokens : undefined,
          outputTokens: typeof resp.usage?.output_tokens === "number" ? resp.usage.output_tokens : undefined,
        },
      };
    } catch {
      // Provider failure is NOT a decision: caller's fallback handles it.
      return { failed: true };
    }
  }

  /**
   * C-5 Phase B — one shared `systemOne` per chunk (namespaced questions).
   * Chunks automatically when inputs exceed `DEFAULT_SHARED_CHUNK_SIZE`.
   */
  async judgeMany(
    inputs: readonly GuardInput[],
    options?: JudgeOptions,
  ): Promise<ModelJudgment[]> {
    if (inputs.length === 0) return [];

    const pack =
      options?.pack !== undefined && options.pack !== null
        ? (options.pack as QuestionPack)
        : QUESTION_PACK_V1;

    const all: ModelJudgment[] = [];
    for (let offset = 0; offset < inputs.length; offset += DEFAULT_SHARED_CHUNK_SIZE) {
      const chunk = inputs.slice(offset, offset + DEFAULT_SHARED_CHUNK_SIZE);
      const chunkJudgments = await this.judgeManyChunk(chunk, pack, options);
      all.push(...chunkJudgments);
    }
    return all;
  }

  private async judgeManyChunk(
    inputs: readonly GuardInput[],
    pack: QuestionPack,
    options?: JudgeOptions,
  ): Promise<ModelJudgment[]> {
    const state = buildBatchState(inputs);
    const questions =
      options?.questionSet === "verify"
        ? buildBatchQuestions(inputs.length, pack) // verify set not used in v1 batch
        : buildBatchQuestions(inputs.length, pack);

    try {
      const resp = await this.client.systemOne({
        model: this.model,
        state: state as unknown as Parameters<typeof this.client.systemOne>[0]["state"],
        questions: questions as unknown as ReturnType<typeof buildQuestions>,
      });
      return parseBatchJudgments(
        resp.answers as Parameters<typeof parseBatchJudgments>[0],
        inputs.length,
      );
    } catch {
      return inputs.map(() => ({ failed: true }));
    }
  }
}

// Re-export for symmetry with the fake provider.
export { TASK_KINDS, RISK_FACTORS };