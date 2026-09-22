/**
 * Profile path helpers — profile.json (authority).
 * Default: ~/.cursor/jev-coding-guard/profile.json
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE_DIR_NAME = ".cursor/jev-coding-guard";
export const PROFILE_FILE_NAME = "profile.json";
export const PROFILE_BACKUP_NAME = "profile.json.bak";

/** Optional test / override path for profile.json. */
export const PROFILE_PATH_ENV = "JEV_GUARD_PROFILE_PATH";

export function resolveProfileDir(_env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), PROFILE_DIR_NAME);
}

/**
 * Resolve profile.json path.
 * Tests set JEV_GUARD_PROFILE_PATH; otherwise ~/.cursor/jev-coding-guard/profile.json.
 */
export function resolveProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PROFILE_PATH_ENV]?.trim();
  if (override) return override;
  return join(resolveProfileDir(env), PROFILE_FILE_NAME);
}

export function resolveProfileBackupPath(profilePath: string): string {
  return `${profilePath}.bak`;
}
