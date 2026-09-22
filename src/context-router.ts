/**
 * P5 — Context Router (suggestions only).
 *
 * Pipeline:
 *   1. Collect candidate **identifiers** from caller hints only (and optional
 *      local `git diff --name-only` when explicitly enabled).
 *   2. Score / rank deterministically from task tokens vs path segments.
 *   3. Optional identifier-only rerank hook (for a future/provider experiment).
 *
 * Hard rules (PRD §8):
 * - Never reads file **contents** to decide.
 * - Never uploads repository content.
 * - Output is a suggestion; never a security gate.
 * - Empty / ambiguous input → omit suggestion (null), never invent paths.
 * - Hard cap on returned paths.
 *
 * Default Guard/MCP path uses step 1–2 only (zero extra provider calls).
 */
import { spawnSync } from "node:child_process";

import type { ContextSuggestion, GuardInput } from "./types.js";

/** Hard upper bound on suggested paths (PRD §8.3). */
export const MAX_CONTEXT_PATHS = 12;

/** Default suggestion size when the caller does not override. */
export const DEFAULT_CONTEXT_PATHS = 8;

export type ContextReasonId =
  | "CR-FROM-TOUCHED"
  | "CR-FROM-CANDIDATES"
  | "CR-FROM-GIT-DIFF"
  | "CR-TASK-TOKEN"
  | "CR-RERANK";

export interface SuggestContextOptions {
  /** Max paths to return (clamped to MAX_CONTEXT_PATHS). */
  maxPaths?: number;
  /**
   * When true and `cwd` is set, also consider `git diff --name-only` /
   * `git diff --cached --name-only` identifiers. Still never reads file bodies.
   * Default false so MCP assessments do not touch the host git worktree.
   */
  includeGitDiff?: boolean;
  /** Working directory for optional git name-only listing. */
  cwd?: string;
    /**
   * Optional identifier-only rerank. Receives the deterministic ranking.
   * Return a new order, or `null`/`undefined` to keep the deterministic list.
   * Must not invent paths outside the ranked set. Must not receive file bodies.
   */
  rerankIdentifiers?: (
    ranked: readonly string[],
    task: string,
  ) => Promise<string[] | null | undefined> | string[] | null | undefined;
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "and",
  "or",
  "in",
  "on",
  "with",
  "from",
  "into",
  "add",
  "update",
  "fix",
  "change",
  "make",
  "please",
  "this",
  "that",
  "file",
  "files",
  "code",
  "repo",
  "project",
]);

/** Normalize a path-like identifier; drop empties and obvious content blobs. */
export function normalizePathId(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\\/g, "/");
  if (!p || p.length > 512) return null;
  // Reject anything that looks like pasted file content / secrets payloads.
  if (p.includes("\n") || p.includes("\0")) return null;
  if (p.startsWith("./")) p = p.slice(2);
  return p || null;
}

/** Task tokens used for path scoring (deterministic, content-free beyond task text). */
export function tokenizeTask(task: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of task.toLowerCase().split(/[^a-z0-9_]+/g)) {
    if (part.length < 3 || STOP.has(part) || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

function scorePath(path: string, tokens: readonly string[]): number {
  const lower = path.toLowerCase();
  const base = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  let score = 0;
  for (const t of tokens) {
    if (base.includes(t)) score += 3;
    else if (lower.includes(t)) score += 1;
  }
  // Slight preference for source-like extensions when tied via tokens.
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift)$/i.test(base)) score += 0.1;
  return score;
}

/** Collect unique normalized identifiers from GuardInput hints. */
export function collectCandidateIds(input: GuardInput): {
  ids: string[];
  reasonIds: ContextReasonId[];
} {
  const reasonIds: ContextReasonId[] = [];
  const seen = new Set<string>();
  const ids: string[] = [];

  const push = (raw: string | null | undefined, reason: ContextReasonId) => {
    const n = raw ? normalizePathId(raw) : null;
    if (!n || seen.has(n)) return;
    seen.add(n);
    ids.push(n);
    if (!reasonIds.includes(reason)) reasonIds.push(reason);
  };

  for (const f of input.hints?.touchedFiles ?? []) push(f, "CR-FROM-TOUCHED");
  for (const f of input.hints?.candidatePaths ?? []) push(f, "CR-FROM-CANDIDATES");

  return { ids, reasonIds };
}

/** Optional local git name-only listing (identifiers only). Never throws. */
export function gitDiffNameOnly(cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
  ]) {
    try {
      const r = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
      });
      if (r.status !== 0 || !r.stdout) continue;
      for (const line of r.stdout.split("\n")) {
        const n = normalizePathId(line);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Deterministic rank of identifiers. Stable for a fixed input (same scores →
 * lexicographic path order).
 */
export function rankContextIds(
  ids: readonly string[],
  task: string,
  maxPaths: number = DEFAULT_CONTEXT_PATHS,
): { paths: string[]; usedTaskTokens: boolean } {
  const cap = Math.max(0, Math.min(MAX_CONTEXT_PATHS, Math.floor(maxPaths)));
  if (cap === 0 || ids.length === 0) return { paths: [], usedTaskTokens: false };

  const tokens = tokenizeTask(task);
  const scored = ids.map((path, index) => ({
    path,
    index,
    score: scorePath(path, tokens),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return a.index - b.index;
  });

  const usedTaskTokens = tokens.length > 0 && scored.some((s) => s.score >= 1);
  return {
    paths: scored.slice(0, cap).map((s) => s.path),
    usedTaskTokens,
  };
}

/**
 * Apply an identifier-only rerank. Drops unknown paths; preserves relative
 * order of leftovers from the base list. Never invents new identifiers.
 */
export function applyIdentifierRerank(
  base: readonly string[],
  preferred: readonly string[],
): string[] {
  const allowed = new Set(base);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of preferred) {
    const n = normalizePathId(p);
    if (!n || !allowed.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  for (const p of base) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Build a context suggestion, or `null` when there is nothing safe to suggest.
 */
export async function suggestContext(
  input: GuardInput,
  options: SuggestContextOptions = {},
): Promise<ContextSuggestion | null> {
  if (!input || typeof input.task !== "string") return null;

  const maxPaths = options.maxPaths ?? DEFAULT_CONTEXT_PATHS;
  const { ids: fromHints, reasonIds } = collectCandidateIds(input);
  const ids = [...fromHints];

  if (options.includeGitDiff && options.cwd) {
    const gitIds = gitDiffNameOnly(options.cwd);
    const seen = new Set(ids);
    let added = false;
    for (const g of gitIds) {
      if (seen.has(g)) continue;
      seen.add(g);
      ids.push(g);
      added = true;
    }
    if (added && !reasonIds.includes("CR-FROM-GIT-DIFF")) reasonIds.push("CR-FROM-GIT-DIFF");
  }

  if (ids.length === 0) return null;

  const ranked = rankContextIds(ids, input.task, maxPaths);
  if (ranked.paths.length === 0) return null;
  if (ranked.usedTaskTokens && !reasonIds.includes("CR-TASK-TOKEN")) {
    reasonIds.push("CR-TASK-TOKEN");
  }

  let paths = ranked.paths;
  let source: ContextSuggestion["source"] = "deterministic";

  if (options.rerankIdentifiers) {
    try {
      const preferred = await options.rerankIdentifiers(paths, input.task);
      // `null` / `undefined` → keep deterministic (provider failure / skip).
      if (Array.isArray(preferred) && preferred.length > 0) {
        paths = applyIdentifierRerank(paths, preferred).slice(
          0,
          Math.min(MAX_CONTEXT_PATHS, maxPaths),
        );
        source = "deterministic+rerank";
        if (!reasonIds.includes("CR-RERANK")) reasonIds.push("CR-RERANK");
      }
    } catch {
      // Rerank failure → keep deterministic list (never fail open with junk).
    }
  }

  return { paths, source, reasonIds: [...reasonIds] };
}

/** Sync helper for the default engine path (no rerank, no git). */
export function suggestContextSync(
  input: GuardInput,
  maxPaths: number = DEFAULT_CONTEXT_PATHS,
): ContextSuggestion | null {
  const { ids, reasonIds } = collectCandidateIds(input);
  if (ids.length === 0) return null;
  const ranked = rankContextIds(ids, input.task, maxPaths);
  if (ranked.paths.length === 0) return null;
  const reasons = [...reasonIds];
  if (ranked.usedTaskTokens && !reasons.includes("CR-TASK-TOKEN")) {
    reasons.push("CR-TASK-TOKEN");
  }
  return { paths: ranked.paths, source: "deterministic", reasonIds: reasons };
}
