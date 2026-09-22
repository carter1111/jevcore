/**
 * P6 — Model Router (harness-only).
 *
 * Maps a P4 `RoutingRecommendation` onto a concrete model/budget selection
 * **inside an evaluation harness we control**. Never changes Cursor / Claude /
 * Codex host model selection. Never claims cost savings without an A/B run.
 */
import type {
  RecommendedContextBudget,
  RecommendedModelTier,
  RoutingRecommendation,
} from "./types.js";

export const MODEL_ROUTER_VERSION = "2026-09-21.1";

/** Fixed catalog entry for harness experiments. */
export interface HarnessModelSpec {
  id: string;
  tier: RecommendedModelTier;
  /** Relative cost weight for offline reporting only (arbitrary units). */
  costWeight: number;
  /** Relative latency weight for offline reporting only. */
  latencyWeight: number;
}

/** Default catalog — replace in experiments; ids are harness-local labels. */
export const DEFAULT_HARNESS_CATALOG: readonly HarnessModelSpec[] = [
  { id: "harness-fast", tier: "fast", costWeight: 1, latencyWeight: 1 },
  { id: "harness-normal", tier: "normal", costWeight: 2, latencyWeight: 2 },
  { id: "harness-reasoning", tier: "reasoning", costWeight: 4, latencyWeight: 3 },
] as const;

export interface HarnessModelSelection {
  version: string;
  modelId: string;
  tier: RecommendedModelTier;
  contextBudget: RecommendedContextBudget;
  planFirst: boolean;
  costWeight: number;
  latencyWeight: number;
  source: "harness";
}

export interface SelectHarnessModelOptions {
  catalog?: readonly HarnessModelSpec[];
  /**
   * Control arm: ignore routing and always pick this tier.
   * Used by A/B harnesses to hold treatment vs fixed baseline.
   */
  forceTier?: RecommendedModelTier;
}

/**
 * Select a harness model from P4 routing (or a forced control tier).
 * Deterministic for a fixed catalog + recommendation.
 */
export function selectHarnessModel(
  routing: RoutingRecommendation | null | undefined,
  options: SelectHarnessModelOptions = {},
): HarnessModelSelection | null {
  const catalog = options.catalog ?? DEFAULT_HARNESS_CATALOG;
  const tier = options.forceTier ?? routing?.recommendedModelTier;
  if (!tier) return null;

  const spec = catalog.find((m) => m.tier === tier) ?? catalog[0];
  if (!spec) return null;

  return {
    version: MODEL_ROUTER_VERSION,
    modelId: spec.id,
    tier: spec.tier,
    contextBudget: routing?.recommendedContextBudget ?? "medium",
    planFirst: routing?.planFirst === true,
    costWeight: spec.costWeight,
    latencyWeight: spec.latencyWeight,
    source: "harness",
  };
}
