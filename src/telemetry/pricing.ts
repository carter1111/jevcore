/**
 * Local Guard Evidence — versioned Jev pricing table.
 *
 * Cost is NEVER stored. Storing a figure would bake a stale claim into
 * permanent records as pricing drifts. Instead we store token counts and
 * compute estimated cost at report time from this dated table, and the report
 * states the basis explicitly.
 */
export interface JevPriceEntry {
  /** Model identifier as reported by the SDK (e.g. `jev-1.12`). */
  model: string;
  /** ISO date this price became effective. */
  effectiveFrom: string;
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

/**
 * Known pricing. Append entries; never rewrite history.
 * `outputPer1M: 0` reflects the published Jev rate where output is not billed.
 */
export const JEV_PRICING: readonly JevPriceEntry[] = [
  { model: "jev-1.12", effectiveFrom: "2026-09-01", inputPer1M: 0.042, outputPer1M: 0.0 },
] as const;

/** The entry used for reporting when the model is unknown. */
export function currentPriceEntry(table: readonly JevPriceEntry[] = JEV_PRICING): JevPriceEntry {
  return table[table.length - 1];
}

/**
 * Estimated USD cost for the given token totals, using the current entry.
 * Returns 0 for non-finite or negative inputs rather than NaN.
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  entry: JevPriceEntry = currentPriceEntry(),
): number {
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (inTok / 1_000_000) * entry.inputPer1M + (outTok / 1_000_000) * entry.outputPer1M;
}

/** Human-readable pricing basis for the report. */
export function describePricing(entry: JevPriceEntry = currentPriceEntry()): string {
  return `${entry.model}, $${entry.inputPer1M}/1M in, effective ${entry.effectiveFrom}`;
}
