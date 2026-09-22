/**
 * C-5 batch decision orchestration (Phase A serial + Phase B shared metadata).
 */
import type { EngineResult } from "./engine.js";
import type { GuardInput } from "./types.js";

export const BATCH_DECIDE_VERSION = "2026-09-21.3";
export const DEFAULT_BATCH_MAX_ITEMS = 16;
export const DEFAULT_BATCH_CONCURRENCY = 4;

/** Phase A: one `decide` per item. Phase B: shared `systemOne` when supported. */
export type DecideManyStrategy = "serial" | "shared_system_one";

export interface DecideManyOptions {
  /** Hard cap on batch size. Default 16. Oversized batches throw. */
  maxItems?: number;
  /** Max in-flight `decide` calls (serial strategy). Default 4. */
  concurrency?: number;
  /** Default `serial`; `shared_system_one` when provider supports `judgeMany`. */
  strategy?: DecideManyStrategy;
}

export interface BatchDecisionItem {
  index: number;
  result: EngineResult;
  /** How this item was settled (observability). */
  settledBy?: "hard_policy_preflight" | "provider" | "fallback" | "serial";
}

export interface DecideManyMeta {
  strategy: DecideManyStrategy;
  providerCalls: number;
}

export interface DecideManyResult {
  items: BatchDecisionItem[];
  meta: DecideManyMeta;
}

/** Explicit error when callers exceed `maxItems` (never silent truncate). */
export class BatchTooLargeError extends Error {
  readonly code = "BATCH-TOO-LARGE";
  readonly size: number;
  readonly maxItems: number;

  constructor(size: number, maxItems: number) {
    super(`Batch size ${size} exceeds maxItems ${maxItems}`);
    this.name = "BatchTooLargeError";
    this.size = size;
    this.maxItems = maxItems;
  }
}

/**
 * Phase A — run `decideOne` over `inputs` with a size cap and worker pool.
 * Results are ordered by input index regardless of completion order.
 */
export async function runDecideMany(
  decideOne: (input: GuardInput) => Promise<EngineResult>,
  inputs: readonly GuardInput[],
  options: DecideManyOptions = {},
): Promise<BatchDecisionItem[]> {
  const maxItems = options.maxItems ?? DEFAULT_BATCH_MAX_ITEMS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BATCH_CONCURRENCY);

  if (inputs.length > maxItems) {
    throw new BatchTooLargeError(inputs.length, maxItems);
  }
  if (inputs.length === 0) return [];

  const out: BatchDecisionItem[] = new Array(inputs.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      const result = await decideOne(inputs[i]!);
      out[i] = { index: i, result, settledBy: "serial" };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

/**
 * C-5e — delivery-only stream of serial `decide` results.
 * Yields in **completion** order (hard-policy items tend to finish first).
 * Semantics match `runDecideMany`; this does not change decisions.
 * Not an MCP stream (stdio hosts keep the versioned batch envelope).
 */
export async function* runDecideManyStream(
  decideOne: (input: GuardInput) => Promise<EngineResult>,
  inputs: readonly GuardInput[],
  options: DecideManyOptions = {},
): AsyncGenerator<BatchDecisionItem> {
  const maxItems = options.maxItems ?? DEFAULT_BATCH_MAX_ITEMS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BATCH_CONCURRENCY);

  if (inputs.length > maxItems) {
    throw new BatchTooLargeError(inputs.length, maxItems);
  }
  if (inputs.length === 0) return;

  const queue: BatchDecisionItem[] = [];
  let wake: (() => void) | undefined;
  let waiting = false;
  let pulsed = false;
  let settled = 0;
  let next = 0;
  let failure: unknown;

  function signal(): void {
    pulsed = true;
    if (waiting) {
      waiting = false;
      const fn = wake;
      wake = undefined;
      fn?.();
    }
  }

  function waitForItem(): Promise<void> {
    if (pulsed) {
      pulsed = false;
      return Promise.resolve();
    }
    waiting = true;
    return new Promise<void>((resolve) => {
      wake = () => {
        pulsed = false;
        resolve();
      };
    });
  }

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      try {
        const result = await decideOne(inputs[i]!);
        queue.push({ index: i, result, settledBy: "serial" });
      } catch (err) {
        failure = err;
      } finally {
        settled += 1;
        signal();
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker());
  const all = Promise.all(workers);

  while (settled < inputs.length || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (failure) throw failure;
    if (settled >= inputs.length) break;
    await waitForItem();
  }

  await all;
  if (failure) throw failure;
  while (queue.length > 0) yield queue.shift()!;
}
