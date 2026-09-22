/**
 * `jev-guard check` — portable deterministic policy gate (P0).
 *
 * Pure function of one command string + hard policy. Zero provider calls,
 * zero evidence I/O, zero credential requirements.
 *
 * Exit codes (Docs/JevCore_PRD.md §3.3):
 *   0 execute (no rule)
 *   1 block
 *   2 approval_required
 *   3 plan_first / unknown mode
 *   4 malformed input / internal error (fail-closed — never treat as allow)
 */
import { createHash } from "node:crypto";

import { matchPolicy } from "./policy.js";
import type { ExecutionMode, HardPolicyRule } from "./types.js";

export type CheckVerdict = "execute" | "block" | "approval_required" | "plan_first";

export interface CheckResult {
  ok: boolean;
  verdict: CheckVerdict;
  exitCode: 0 | 1 | 2 | 3 | 4;
  ruleId: string | null;
  /** Rule detail only — never the command text. */
  reason: string | null;
  /** Present only when the caller opted in via `--echo-hash`. */
  commandHash?: string;
}

export interface EvaluateCheckOptions {
  /** When true, include sha256 of the command (never the command itself). */
  echoHash?: boolean;
}

/** Map a policy mode (or lack of match) to the portable exit contract. */
export function exitCodeForMode(mode: ExecutionMode | null | undefined): 0 | 1 | 2 | 3 {
  if (mode == null) return 0;
  switch (mode) {
    case "execute":
      return 0;
    case "block":
      return 1;
    case "approval_required":
      return 2;
    case "plan_first":
      return 3;
    default:
      return 3;
  }
}

export function hashCommand(command: string): string {
  const hex = createHash("sha256").update(command, "utf8").digest("hex");
  return `sha256:${hex}`;
}

function verdictFromRule(rule: HardPolicyRule | undefined): CheckVerdict {
  if (!rule) return "execute";
  if (rule.mode === "block") return "block";
  if (rule.mode === "approval_required") return "approval_required";
  if (rule.mode === "plan_first") return "plan_first";
  // Unknown future mode — never silently allow.
  return "plan_first";
}

/**
 * Evaluate one command string against deterministic hard policy.
 * Throws nothing for policy outcomes; callers use {@link failClosed} for I/O errors.
 */
export function evaluateCheck(
  command: string,
  options: EvaluateCheckOptions = {},
): CheckResult {
  const rule = matchPolicy({ task: command });
  const verdict = verdictFromRule(rule);
  const exitCode = exitCodeForMode(rule?.mode ?? null);
  const result: CheckResult = {
    ok: true,
    verdict,
    exitCode,
    ruleId: rule?.id ?? null,
    reason: rule?.reason?.detail ?? null,
  };
  if (options.echoHash) {
    result.commandHash = hashCommand(command);
  }
  return result;
}

/** Explicit fail-closed result for malformed input or internal errors. */
export function failClosed(reason: string): CheckResult {
  return {
    ok: false,
    verdict: "block",
    exitCode: 4,
    ruleId: null,
    reason,
  };
}

/** Serialize for `--json`. Never includes the command text or paths. */
export function formatCheckJson(result: CheckResult): string {
  const body: Record<string, unknown> = {
    ok: result.ok,
    verdict: result.verdict,
    exitCode: result.exitCode,
    ruleId: result.ruleId,
    reason: result.reason,
  };
  if (result.commandHash !== undefined) {
    body.commandHash = result.commandHash;
  }
  return JSON.stringify(body);
}

/** Human-readable one-liner. Never includes the command text. */
export function formatCheckText(result: CheckResult): string {
  if (!result.ok) {
    return `check error (exit ${result.exitCode}): ${result.reason ?? "fail-closed"}`;
  }
  if (result.ruleId) {
    return `check ${result.verdict} (${result.ruleId}): ${result.reason ?? ""}`.trim();
  }
  return `check ${result.verdict}`;
}
