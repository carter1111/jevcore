/**
 * T12 — JEVCore Agent narrative report (prove-only; no host token-savings claims).
 */
import type { AgentLocale } from "./types.js";
import type { ReportModel } from "../telemetry/report.js";

export interface AgentReportExtras {
  activeSessionGrants?: number;
  overrideEvents?: number;
  pendingSuggestions?: number;
  profileRevision?: number;
  locale?: AgentLocale;
}

/**
 * Narrative layer on top of Local Guard Evidence aggregates.
 * Never claims host LLM savings, developer-minutes, or prevented incidents.
 */
export function formatAgentNarrative(
  model: ReportModel,
  extras: AgentReportExtras = {},
): string {
  const locale = extras.locale ?? "en";
  const execute = model.outcomes["execute"] ?? 0;
  const plan = model.outcomes["plan_first"] ?? 0;
  const approval = model.outcomes["approval_required"] ?? 0;
  const block = model.outcomes["block"] ?? 0;

  const L: string[] = [];
  if (locale === "zh") {
    L.push("JEVCORE AGENT  ·  本周替你做了什么（可证明项）");
    L.push("─".repeat(70));
    L.push(`  推进（execute/advance 信号）          ${execute}`);
    L.push(`  铺路（plan_first/pave_way）           ${plan}`);
    L.push(`  请你定方向（approval/your_call）      ${approval}`);
    L.push(`  换安全路径（block/safer_path）        ${block}`);
    L.push(`  硬策略短路（未调 provider）           ${model.hardPolicyShortCircuits}`);
    L.push(`  Provider 跳过/回退                    ${model.providerFallbacks}`);
    if (extras.activeSessionGrants != null) {
      L.push(`  当前有效 session grant               ${extras.activeSessionGrants}`);
    }
    if (extras.overrideEvents != null) {
      L.push(`  Override / self-handle 记录          ${extras.overrideEvents}`);
    }
    if (extras.pendingSuggestions != null) {
      L.push(`  待确认的学习建议（无执行权）         ${extras.pendingSuggestions}`);
    }
    if (extras.profileRevision != null) {
      L.push(`  profileRevision                      ${extras.profileRevision}`);
    }
    L.push("");
    L.push("  Jev 用量（仅 Guard 侧，非宿主总 token）：");
    L.push(`    输入 ${model.jevInputTokens} / 输出 ${model.jevOutputTokens}`);
    L.push(
      `    估计成本 $${model.estimatedCostUsd.toFixed(6)}（${model.pricingBasis.split(",")[0]?.trim() ?? "n/a"}）`,
    );
    L.push("");
    L.push("  不会声称：宿主 LLM 省 token、开发者分钟、或「一定阻止了生产事故」。");
    L.push("  MCP 返回 safer_path ≠ 本机所有 shell 都已被物理拦截。");
  } else {
    L.push("JEVCORE AGENT  ·  What we can prove for this period");
    L.push("─".repeat(70));
    L.push(`  Advances (execute signals)              ${execute}`);
    L.push(`  Pave-way (plan_first)                   ${plan}`);
    L.push(`  Your-call (approval_required)           ${approval}`);
    L.push(`  Safer-path (block)                      ${block}`);
    L.push(`  Hard-policy short-circuits              ${model.hardPolicyShortCircuits}`);
    L.push(`  Provider fallbacks                      ${model.providerFallbacks}`);
    if (extras.activeSessionGrants != null) {
      L.push(`  Active session grants                   ${extras.activeSessionGrants}`);
    }
    if (extras.overrideEvents != null) {
      L.push(`  Override / self-handle events           ${extras.overrideEvents}`);
    }
    if (extras.pendingSuggestions != null) {
      L.push(`  Pending learned suggestions (no power)  ${extras.pendingSuggestions}`);
    }
    if (extras.profileRevision != null) {
      L.push(`  profileRevision                         ${extras.profileRevision}`);
    }
    L.push("");
    L.push("  Jev usage (Guard-side only — not host agent totals):");
    L.push(`    in ${model.jevInputTokens} / out ${model.jevOutputTokens}`);
    L.push(
      `    est. cost $${model.estimatedCostUsd.toFixed(6)} (${model.pricingBasis.split(",")[0]?.trim() ?? "n/a"})`,
    );
    L.push("");
    L.push("  We do not claim: host LLM token savings, developer-minutes saved,");
    L.push("  or that production incidents were prevented without evidence.");
    L.push("  MCP safer_path ≠ every shell command is physically blocked on this host.");
  }
  L.push("");
  return L.join("\n");
}

/** Combine Agent narrative + classic evidence report. */
export function formatAgentReport(
  evidenceText: string,
  model: ReportModel,
  extras?: AgentReportExtras,
): string {
  return `${formatAgentNarrative(model, extras)}\n${evidenceText}`;
}
