/**
 * Format AgentResult for host adapters — verbatim Contract strings only.
 * No host-LLM paraphrase/translate.
 */
import type { AgentResult } from "./types.js";
import { formatValueReceiptLines } from "./receipt.js";
import { shouldPrintReceiptNow, type ReceiptDisplayMode } from "./display.js";
import type { ExecuteFeedback } from "./types.js";
import { AGENT_CONTRACT_PREFIX } from "./prefix.js";

/**
 * Render user-visible Agent Contract text for adapters/rules.
 * Uses deterministic template strings already on the payload.
 */
export function formatAgentVerbatim(
  agent: AgentResult,
  options?: {
    executeFeedback?: ExecuteFeedback;
    /** Force full receipt even on advance+session_summary. */
    forceReceipt?: boolean;
  },
): string {
  const feedback = options?.executeFeedback ?? "session_summary";
  const lines: string[] = [`${AGENT_CONTRACT_PREFIX} ${agent.headline}`];

  if (agent.summary && agent.summary !== agent.headline) {
    lines.push(agent.summary);
  }

  if (agent.status === "pave_way" && agent.plan) {
    lines.push(`Plan (${agent.plan.steps.length} steps):`);
    for (const step of agent.plan.steps) {
      lines.push(`· ${step}`);
    }
  }

  if (agent.status === "your_call" && agent.choices) {
    for (const c of agent.choices) {
      const rec = c.recommended ? " — recommended" : "";
      lines.push(`· ${c.id} — ${c.label} (${c.tradeoff})${rec}`);
    }
  }

  if (agent.status === "safer_path" && agent.rewrite) {
    lines.push(`· ${agent.rewrite.rationale}`);
    lines.push(`· Rewritten: ${agent.rewrite.suggestedTask}`);
    for (const alt of agent.rewrite.alternatives) {
      lines.push(`· You can: ${alt}`);
    }
  }

  const actions = agent.nextActions.filter((a) => a.enabled).map((a) => a.label);
  if (actions.length) {
    lines.push(`Actions: ${actions.join(" | ")}`);
  }

  const printReceipt =
    options?.forceReceipt === true ||
    shouldPrintReceiptNow(agent.status, feedback);
  if (printReceipt) {
    for (const line of formatValueReceiptLines(agent.valueReceipt)) {
      if (!lines.includes(line)) lines.push(line);
    }
  }

  return `${lines.join("\n")}\n`;
}

export type { ReceiptDisplayMode };
