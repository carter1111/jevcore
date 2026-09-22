/**
 * Pure mapping: `jev-guard check` exit code → Claude Code PreToolUse decision.
 *
 * Kept free of I/O so unit tests can cover the PRD §4.3 contract without
 * spawning Claude Code or the CLI.
 *
 * @param {number | null | undefined} exitCode
 * @param {{ reason?: string }} [meta]
 * @returns {{
 *   permissionDecision: "allow" | "deny" | "ask",
 *   permissionDecisionReason: string,
 * }}
 */
export function mapCheckExit(exitCode, meta = {}) {
  const reason =
    typeof meta.reason === "string" && meta.reason.trim()
      ? meta.reason.trim()
      : undefined;

  if (exitCode === 0) {
    return {
      permissionDecision: "allow",
      permissionDecisionReason: reason ?? "Jev Guard: no hard-policy match",
    };
  }

  if (exitCode === 1) {
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        reason ?? "Jev Guard: hard policy block (check exit 1)",
    };
  }

  if (exitCode === 2 || exitCode === 3) {
    return {
      permissionDecision: "ask",
      permissionDecisionReason:
        reason ??
        (exitCode === 2
          ? "Jev Guard: approval required (check exit 2)"
          : "Jev Guard: plan/review before proceed (check exit 3)"),
    };
  }

  // exit 4, unknown, null → fail closed
  return {
    permissionDecision: "deny",
    permissionDecisionReason:
      reason ??
      "Jev Guard: check unavailable or failed (fail-closed; check exit 4+)",
  };
}
