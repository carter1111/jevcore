/**
 * Default guard: TypeSafe provider + default policy + standard thresholds.
 *
 * Reads TYPESAFE_API_KEY from the environment. If the key is absent, the
 * guard still works (falls back to plan_first / hard policy) because the
 * engine degrades gracefully on provider failure.
 */
import { Guard, type EngineConfig, type EngineResult } from "./engine.js";
import { TypeSafeProvider } from "./provider.js";
import type { GuardInput } from "./types.js";

export function defaultGuard(cfg: EngineConfig = {}): Guard {
  return new Guard(provider(), cfg);
}

let _provider: TypeSafeProvider | undefined;

export function provider(): TypeSafeProvider {
  _provider ??= new TypeSafeProvider();
  return _provider;
}

/** One-shot convenience. */
export async function guardOnce(input: GuardInput, cfg: EngineConfig = {}): Promise<EngineResult> {
  return defaultGuard(cfg).decide(input);
}