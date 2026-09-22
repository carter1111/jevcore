/**
 * P5 — Jev identifier-only context rerank.
 *
 * A **separate** focused `systemOne` call (not the universal 10-question pack).
 * State contains only `{ task, candidates: string[] }` — never file bodies,
 * diffs, or secrets.
 *
 * Enabled by default when wired; set `JEV_CONTEXT_RERANK=0` to disable.
 * Failures return `null` so the caller keeps the deterministic ranking
 * (never invents paths, never fails open into junk).
 */
import { score, TypeSafeClient, type TypeSafeClientConfig } from "@typesafe-ai/sdk";

import { applyIdentifierRerank, MAX_CONTEXT_PATHS, normalizePathId } from "./context-router.js";

/** Env flag: only `"0"` disables. Unset / any other value → enabled when wired. */
export const CONTEXT_RERANK_ENV_FLAG = "JEV_CONTEXT_RERANK";

export function isContextRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONTEXT_RERANK_ENV_FLAG] !== "0";
}

/** Minimum candidates before paying for a Jev rerank call. */
export const CONTEXT_RERANK_MIN_PATHS = 2;

/** Cap paths sent to Jev (matches suggestion hard cap). */
export const CONTEXT_RERANK_MAX_PATHS = MAX_CONTEXT_PATHS;

export interface ContextReranker {
  /**
   * Return a preferred order of the given identifiers, or `null` on failure.
   * Must not introduce paths outside `paths`.
   */
  rerank(task: string, paths: readonly string[]): Promise<string[] | null>;
}

export interface TypeSafeContextRerankerConfig {
  timeoutMs?: number;
  fetch?: TypeSafeClientConfig["fetch"];
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

const RELEVANCE_LEVELS = [
  {
    what: "Not relevant to the task",
    signals: ["unrelated path", "wrong module"],
    examples: ["unrelated config file for a UI copy tweak"],
  },
  {
    what: "Weakly related",
    signals: ["same area but not the change target"],
    examples: ["sibling util near the file that must change"],
  },
  {
    what: "Relevant",
    signals: ["likely needs to be read or edited"],
    examples: ["module implementing the described behavior"],
  },
  {
    what: "Highly relevant — primary context for the task",
    signals: ["direct match to the requested change"],
    examples: ["the exact source file named or implied by the task"],
  },
] as const;

/**
 * Parse score answers into a descending relevance order of the input paths.
 * Unknown / invalid scores sort last (stable by original index).
 */
export function orderByRelevanceScores(
  paths: readonly string[],
  scores: Readonly<Record<string, number | undefined>>,
): string[] {
  const indexed = paths.map((path, index) => {
    const raw = scores[`rel_${index}`];
    const scoreVal =
      typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;
    return { path, index, scoreVal };
  });
  indexed.sort((a, b) => {
    if (b.scoreVal !== a.scoreVal) return b.scoreVal - a.scoreVal;
    return a.index - b.index;
  });
  return indexed.map((x) => x.path);
}

/** Build one Score question per candidate index (identifiers referenced by path). */
export function buildRerankQuestions(candidateCount: number) {
  const questions: Record<string, ReturnType<typeof score>> = {};
  const n = Math.min(CONTEXT_RERANK_MAX_PATHS, Math.max(0, candidateCount));
  const levels = RELEVANCE_LEVELS.map((level) => ({
    what: level.what,
    signals: [...level.signals],
    examples: [...level.examples],
  }));
  const criteria = levels as unknown as [
    (typeof levels)[number],
    (typeof levels)[number],
    ...(typeof levels)[number][],
  ];
  for (let i = 0; i < n; i++) {
    questions[`rel_${i}`] = score(
      {
        question: `How relevant is candidates[${i}] (a file path identifier) to the coding task?`,
        focus: "Rank context usefulness only. You see path identifiers, not file contents.",
        inspect: `candidates[${i}]`,
        compare: ["task", "candidates"],
      },
      criteria,
    );
  }
  return questions;
}

export class TypeSafeContextReranker implements ContextReranker {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(config: TypeSafeContextRerankerConfig = {}) {
    this.client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      fetch: config.fetch,
      timeout: config.timeoutMs ?? 15_000,
    });
    this.model = config.model ?? "jev-latest";
  }

  async rerank(task: string, paths: readonly string[]): Promise<string[] | null> {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const n = normalizePathId(p);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      cleaned.push(n);
      if (cleaned.length >= CONTEXT_RERANK_MAX_PATHS) break;
    }
    if (cleaned.length < CONTEXT_RERANK_MIN_PATHS) return null;

    const state = {
      task,
      // Identifiers only — never file contents.
      candidates: cleaned,
    };
    const questions = buildRerankQuestions(cleaned.length);

    try {
      const resp = await this.client.systemOne({
        model: this.model,
        state,
        questions,
      });
      const scores: Record<string, number | undefined> = {};
      for (let i = 0; i < cleaned.length; i++) {
        const key = `rel_${i}`;
        const s = resp.answers?.[key]?.score;
        scores[key] = typeof s === "number" && Number.isFinite(s) ? s : undefined;
      }
      // If every score is missing, treat as failure.
      if (Object.values(scores).every((v) => v === undefined)) return null;
      const ordered = orderByRelevanceScores(cleaned, scores);
      return applyIdentifierRerank(cleaned, ordered);
    } catch {
      return null;
    }
  }
}
