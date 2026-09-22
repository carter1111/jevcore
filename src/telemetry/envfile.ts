/**
 * Local Guard Evidence — envFile bridge.
 *
 * The Cursor MCP server loads its environment from a dotenv-style file
 * (`~/.cursor/jev-coding-guard.env`, referenced by `~/.cursor/mcp.json`'s
 * `envFile`). The `jev-guard` CLI runs in a plain shell that does *not* inherit
 * that file, so it would resolve a different (empty) environment than the MCP
 * server.
 *
 * This module lets the CLI read the SAME envFile, so the CLI and the MCP server
 * agree on whether Evidence is enabled. The envFile remains the single source
 * of truth: nothing here writes to it, and it is never created.
 *
 * IMPORTANT (privacy): this module must never leak values. It only reads the
 * `JEV_GUARD_LOCAL_EVIDENCE` flag (and, for the CLI, the evidence path); it is
 * never passed key values and never prints them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EVIDENCE_ENV_FLAG, EVIDENCE_PATH_ENV } from "./config.js";

/** Path to the envFile the Cursor MCP server uses. */
export function cursorEnvFilePath(): string {
  return join(homedir(), ".cursor", "jev-coding-guard.env");
}

/** Parse a dotenv-style `KEY=value` file. Never throws. */
export function readEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (key) out[key] = value;
    }
  } catch {
    // envFile absent/unreadable: treat as no flags.
  }
  return out;
}

/** Only the flags the CLI is allowed to forward. */
const EVIDENCE_KEYS = [EVIDENCE_ENV_FLAG, EVIDENCE_PATH_ENV];

/** Filter a parsed env map down to only the evidence flags. Never forwards credentials. */
export function filterEvidenceEnv(parsed: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of EVIDENCE_KEYS) {
    if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  return out;
}

/**
 * Build an environment overlay from the Cursor envFile.
 *
 * Only the flags the CLI is allowed to read are copied:
 *   - `JEV_GUARD_LOCAL_EVIDENCE` — enable/disable agreement with the MCP server
 *   - `JEV_GUARD_EVIDENCE_PATH`  — test/operator storage override
 *
 * Credentials and any other keys are deliberately NOT copied.
 */
export function evidenceEnvFromCursorEnvFile(): NodeJS.ProcessEnv {
  return filterEvidenceEnv(readEnvFile(cursorEnvFilePath()));
}