/**
 * Display policy for value receipts (§8.3).
 * Receipts are always generated; this decides whether to show them now.
 */
import type { AgentStatus, ExecuteFeedback } from "./types.js";

export type ReceiptDisplayMode = "hide" | "status_line" | "full";

/**
 * Non-advance statuses must always show a full outcome.
 * Advance follows executeFeedback.
 */
export function receiptDisplayMode(
  status: AgentStatus,
  executeFeedback: ExecuteFeedback = "session_summary",
): ReceiptDisplayMode {
  if (status !== "advance") return "full";
  switch (executeFeedback) {
    case "silent":
      return "hide";
    case "status_line":
      return "status_line";
    case "session_summary":
      return "hide"; // accumulate for session/weekly; not each turn
    case "detailed":
      return "full";
  }
}

export function shouldPrintReceiptNow(
  status: AgentStatus,
  executeFeedback: ExecuteFeedback = "session_summary",
): boolean {
  return receiptDisplayMode(status, executeFeedback) !== "hide";
}
