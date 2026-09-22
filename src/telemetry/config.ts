/**
 * Local Guard Evidence — configuration.
 *
 * INVARIANT (structural inertness): when evidence is disabled, this module
 * must NOT resolve or access the home directory, must NOT create any artifact,
 * and must NOT open SQLite. The home path is only computed lazily inside
 * `resolveTelemetryConfig()` *after* the enable flag has been confirmed.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { TelemetryConfig } from "./types.js";

/** Environment flag that opts in to local evidence collection. */
export const EVIDENCE_ENV_FLAG = "JEV_GUARD_LOCAL_EVIDENCE";

/** Optional test/operator override for the database path (used by tests). */
export const EVIDENCE_PATH_ENV = "JEV_GUARD_EVIDENCE_PATH";

/** Advisory storage warning threshold: 50 MB. Never triggers deletion. */
export const DEFAULT_ADVISORY_BYTES = 50 * 1024 * 1024;

/** Directory (under the user's home) that holds evidence storage. */
export const EVIDENCE_DIR_NAME = ".cursor/jev-coding-guard";

/** Database file name. */
export const EVIDENCE_DB_NAME = "telemetry.sqlite";

/** Advisory maintenance lock file name (never deleted while held). */
export const EVIDENCE_LOCK_NAME = "telemetry.lock";

/** True when the opt-in flag is set to exactly "1". */
export function isEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVIDENCE_ENV_FLAG] === "1";
}

/**
 * Resolve the evidence directory. Only called when evidence is enabled.
 * Tests override the whole database path instead of the directory.
 */
export function resolveEvidenceDir(): string {
  return join(homedir(), EVIDENCE_DIR_NAME);
}

/**
 * Resolve telemetry configuration.
 *
 * When disabled this returns `enabled: false` with an EMPTY database path and
 * never touches the home directory — so no path is even computed, let alone
 * accessed. Callers must use `NoopTelemetrySink` in that case.
 */
export function resolveTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  if (!isEvidenceEnabled(env)) {
    return { enabled: false, databasePath: "", advisoryBytes: DEFAULT_ADVISORY_BYTES };
  }
  const override = env[EVIDENCE_PATH_ENV];
  const databasePath =
    typeof override === "string" && override.length > 0
      ? override
      : join(resolveEvidenceDir(), EVIDENCE_DB_NAME);
  return { enabled: true, databasePath, advisoryBytes: DEFAULT_ADVISORY_BYTES };
}
