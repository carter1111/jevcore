#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — deterministic Bash gate via `jev-guard check`.
 *
 * Contract (Docs/JevCore_PRD.md §4.3):
 *   check exit 0 → allow
 *   check exit 1 → deny
 *   check exit 2 → ask
 *   check exit 3 → ask
 *   check exit 4 / missing binary / errors → deny (fail-closed)
 *
 * Privacy: never print the command text to stdout/stderr. Reasons may include
 * rule ids from `check --json`, never the raw command.
 *
 * Env:
 *   JEV_GUARD_BIN  — path to `jev-guard` / `dist/cli.js` (required for allow)
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapCheckExit } from "./map-check-exit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function emitDecision(decision) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.permissionDecision,
      permissionDecisionReason: decision.permissionDecisionReason,
    },
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function extractCommand(input) {
  if (!input || typeof input !== "object") return "";
  const toolInput = input.tool_input ?? input.toolInput ?? {};
  if (typeof toolInput.command === "string") return toolInput.command;
  if (typeof input.command === "string") return input.command;
  return "";
}

function resolveBin() {
  const fromEnv = process.env.JEV_GUARD_BIN?.trim();
  if (fromEnv) return fromEnv;
  // Best-effort relative to this adapter when run from a built checkout.
  return join(__dirname, "..", "..", "..", "dist", "cli.js");
}

let input = {};
try {
  const raw = readStdin();
  if (raw.trim()) input = JSON.parse(raw);
} catch {
  emitDecision(
    mapCheckExit(4, {
      reason: "Jev Guard: malformed PreToolUse stdin (fail-closed)",
    }),
  );
}

const command = extractCommand(input);
if (!command.trim()) {
  // Nothing to gate (non-Bash or empty) — do not interfere.
  emitDecision(mapCheckExit(0, { reason: "Jev Guard: empty command" }));
}

const bin = resolveBin();
const nodeExec = process.execPath;

// Prefer `node dist/cli.js check --stdin` when bin is a .js path; else spawn bin.
const isJs = bin.endsWith(".js") || bin.endsWith(".mjs");
const spawnCmd = isJs ? nodeExec : bin;
const spawnArgs = isJs
  ? [bin, "check", "--stdin", "--json"]
  : ["check", "--stdin", "--json"];

let result;
try {
  result = spawnSync(spawnCmd, spawnArgs, {
    input: command,
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });
} catch (e) {
  emitDecision(
    mapCheckExit(4, {
      reason: `Jev Guard: failed to spawn check (${e?.code ?? "error"}; fail-closed)`,
    }),
  );
}

if (result.error) {
  // ENOENT etc.
  emitDecision(
    mapCheckExit(4, {
      reason:
        "Jev Guard: jev-guard check not found — build the repo and set JEV_GUARD_BIN (fail-closed)",
    }),
  );
}

const code =
  typeof result.status === "number" ? result.status : 4;

// Prefer structured reason from --json stdout when present (never echo command).
let reason;
try {
  const out = (result.stdout ?? "").trim();
  if (out.startsWith("{")) {
    const parsed = JSON.parse(out);
    if (typeof parsed.ruleId === "string" && parsed.ruleId) {
      reason = `Jev Guard: ${parsed.ruleId}${
        typeof parsed.reason === "string" && parsed.reason
          ? ` (${parsed.reason})`
          : ""
      }`;
    } else if (typeof parsed.reason === "string" && parsed.reason) {
      reason = `Jev Guard: ${parsed.reason}`;
    }
  }
} catch {
  // ignore JSON parse; mapping still applies
}

// If check subcommand is unknown (P0 not shipped), Node CLI often exits ≠ 0
// with a usage message — treat as fail-closed via mapCheckExit.
emitDecision(mapCheckExit(code, { reason }));
