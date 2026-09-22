/**
 * Memory path helpers — preferences.sqlite (ledger, not authority).
 * Distinct from telemetry.sqlite (what JEV did).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory under home shared with profile.json / telemetry. */
export const MEMORY_DIR_NAME = ".cursor/jev-coding-guard";

export const MEMORY_DB_NAME = "preferences.sqlite";

/** Optional test override for the preferences DB path. */
export const MEMORY_PATH_ENV = "JEV_GUARD_PREFERENCES_PATH";

export function resolveMemoryDir(_env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), MEMORY_DIR_NAME);
}

/**
 * Resolve preferences.sqlite path.
 * Tests set JEV_GUARD_PREFERENCES_PATH; otherwise ~/.cursor/jev-coding-guard/preferences.sqlite.
 */
export function resolvePreferencesDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[MEMORY_PATH_ENV]?.trim();
  if (override) return override;
  return join(resolveMemoryDir(env), MEMORY_DB_NAME);
}
