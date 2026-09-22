/**
 * Locale resolution for JEVCore Agent Contract strings.
 */
import type { AgentLocale } from "./types.js";

export function resolveAgentLocale(input?: string | null): AgentLocale {
  if (!input) return "en";
  const lower = input.trim().toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-") || lower === "cn" || lower === "zh_cn") {
    return "zh";
  }
  return "en";
}
