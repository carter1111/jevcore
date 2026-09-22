/**
 * C-5 Phase B — shared-state batch provider helpers.
 *
 * Builds one TypeSafe `systemOne` state + namespaced questions for N items.
 * SDK-free mapping/parsing only; HTTP lives in `TypeSafeProvider.judgeMany`.
 */
import type { GuardInput, ModelJudgment, RiskFactor, TaskKind } from "./types.js";
import { buildQuestions, normalizeRiskScore } from "./provider.js";
import { QUESTION_PACK_V1, type QuestionPack } from "./question-packs.js";

export const BATCH_PROVIDER_VERSION = "2026-09-21.1";
/** Max items per shared `systemOne` call (question-count bound). */
export const DEFAULT_SHARED_CHUNK_SIZE = 8;

const FACTOR_KEYS = [
  ["factor_scope", "scope"],
  ["factor_destructive", "destructive"],
  ["factor_data", "data"],
  ["factor_security", "security"],
  ["factor_irreversible", "irreversible"],
  ["factor_unclear", "unclear"],
] as const;

/** Stable id for batch item at index (content-free). */
export function batchItemId(index: number): string {
  return `i${index}`;
}

/** Shared state listing sanitized item fields under `items.<id>`. */
export function buildBatchState(inputs: readonly GuardInput[]): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const id = batchItemId(i);
    items[id] = {
      task: input.task,
      touchedFiles: input.hints?.touchedFiles ?? [],
      mentionsProduction: input.hints?.mentionsProd === true,
      context: input.hints?.context ?? "",
    };
  }
  return { batchVersion: BATCH_PROVIDER_VERSION, items };
}

/** Remap single-item inspect paths to `items.<id>.*` for batch questions. */
function remapQuestionInspect(question: unknown, id: string): unknown {
  const clone = JSON.parse(JSON.stringify(question)) as {
    instructions?: { inspect?: string; compare?: string[]; focus?: string };
  };
  const ins = clone.instructions;
  if (!ins) return clone;
  if (ins.inspect === "`task`") ins.inspect = `\`items.${id}.task\``;
  if (ins.focus?.includes("task")) {
    ins.focus = ins.focus.replace(/\btask\b/g, `items.${id}.task`);
  }
  if (Array.isArray(ins.compare)) {
    ins.compare = ins.compare.map((p) =>
      p === "`task`" ? `\`items.${id}.task\`` : p.replace(/\btask\b/g, `items.${id}.task`),
    );
  }
  return clone;
}

/** Namespaced question set for one batch item (`i0_kind`, `i0_risk`, …). */
export function buildBatchQuestionsForItem(
  id: string,
  pack: QuestionPack = QUESTION_PACK_V1,
): Record<string, unknown> {
  const base = buildQuestions(pack) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(base)) {
    out[`${id}_${key}`] = remapQuestionInspect(q, id);
  }
  return out;
}

/** Merge per-item namespaced questions for a chunk. */
export function buildBatchQuestions(
  itemCount: number,
  pack: QuestionPack = QUESTION_PACK_V1,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < itemCount; i++) {
    Object.assign(out, buildBatchQuestionsForItem(batchItemId(i), pack));
  }
  return out;
}

type AnswerSlice = Record<string, { choice?: string; confidence?: number; score?: number; noul?: number }>;

/** Map one item's prefixed answers → `ModelJudgment`. */
export function parseBatchItemJudgment(
  answers: AnswerSlice,
  id: string,
): ModelJudgment {
  const riskScore = normalizeRiskScore(answers[`${id}_risk`]?.score);
  if (riskScore === undefined) {
    return { failed: true, failureCode: "PROVIDER-INVALID-RISK-SCORE" };
  }

  const factors: RiskFactor[] = [];
  for (const [key, flag] of FACTOR_KEYS) {
    const n = answers[`${id}_${key}`]?.noul;
    if (typeof n === "number" && n >= 0.5) factors.push(flag);
  }

  const kindAns = answers[`${id}_kind`];
  return {
    kind: kindAns?.choice as TaskKind | undefined,
    kindConfidence: kindAns?.confidence,
    riskScore,
    riskConfidence: answers[`${id}_risk`]?.confidence,
    riskFactors: factors.length ? factors : undefined,
    securityReviewNoul: answers[`${id}_security_review`]?.noul,
    failed: false,
  };
}

/** Parse all items in a chunk from one `systemOne` answers object. */
export function parseBatchJudgments(answers: AnswerSlice, itemCount: number): ModelJudgment[] {
  const out: ModelJudgment[] = [];
  for (let i = 0; i < itemCount; i++) {
    out.push(parseBatchItemJudgment(answers, batchItemId(i)));
  }
  return out;
}
