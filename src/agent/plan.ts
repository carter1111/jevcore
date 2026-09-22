/**
 * T08 — pave_way planner (deterministic templates; ≤5 steps).
 * Profile interruptionPreference / maxPlanSteps injected later by T07.
 */
import type { AgentLocale, AgentPlan } from "./types.js";

export type InterruptionPreference = "cautious" | "balanced" | "assertive";

export interface BuildPaveWayPlanInput {
  locale?: AgentLocale;
  /** Product default balanced until T07 wires profile. */
  interruptionPreference?: InterruptionPreference;
  /** Cap from profile.collaboration.maxPlanSteps (default 5). */
  maxPlanSteps?: number;
  reasonCodes?: string[];
  complexity?: "small" | "medium" | "large";
  securityReviewNeeded?: boolean;
}

const MAX_STEPS = 5;

function allowStartNow(pref: InterruptionPreference): boolean {
  // cautious → prefer full pave; balanced/assertive may start now.
  return pref !== "cautious";
}

function enSteps(input: BuildPaveWayPlanInput): string[] {
  const codes = input.reasonCodes ?? [];
  const lowConf = codes.some((c) => c === "LOW-CONF" || c.startsWith("LOW-CONF"));
  const steps: string[] = [];
  if (lowConf) {
    steps.push("Clarify scope: which files/APIs are in vs out of this change");
  } else {
    steps.push("Name the intended scope and success check in one sentence");
  }
  steps.push("List touch points (API / UI / data) before editing");
  if (input.complexity === "large" || input.securityReviewNeeded) {
    steps.push("Mark review-sensitive areas (auth, deploy, data) for a human pass");
  }
  steps.push("Make the smallest reversible diff that proves the path");
  steps.push("Verify with a focused check (test, typecheck, or dry-run)");
  return steps;
}

function zhSteps(input: BuildPaveWayPlanInput): string[] {
  const codes = input.reasonCodes ?? [];
  const lowConf = codes.some((c) => c === "LOW-CONF" || c.startsWith("LOW-CONF"));
  const steps: string[] = [];
  if (lowConf) {
    steps.push("澄清范围：哪些文件/API 在本次改动内、哪些不在");
  } else {
    steps.push("用一句话写清目标范围与成功标准");
  }
  steps.push("列出触点（API / UI / 数据）再动手改");
  if (input.complexity === "large" || input.securityReviewNeeded) {
    steps.push("标出需人审的敏感点（权限、部署、数据）");
  }
  steps.push("做最小可逆改动，先验证路径可行");
  steps.push("用聚焦检查验证（测试 / typecheck / dry-run）");
  return steps;
}

/**
 * Build a pave_way plan. Always ≤5 steps; includes assumptions, verify, rollback.
 */
export function buildPaveWayPlan(input: BuildPaveWayPlanInput = {}): AgentPlan {
  const locale = input.locale ?? "en";
  const pref = input.interruptionPreference ?? "balanced";
  const cap = Math.min(MAX_STEPS, Math.max(1, input.maxPlanSteps ?? MAX_STEPS));
  const raw = locale === "zh" ? zhSteps(input) : enSteps(input);
  const steps = raw.slice(0, cap);

  if (locale === "zh") {
    return {
      steps,
      allowStartNow: allowStartNow(pref),
      assumptions: [
        "当前信号不足以直接推进，先降低返工风险",
        pref === "cautious" ? "打断偏好为谨慎：建议走完短计划" : "可在确认后说「现在开始」",
      ],
      verify: ["聚焦检查通过后再扩大改动面"],
      rollbackHint: "保持小步可逆；必要时用版本控制回退本步 diff",
    };
  }

  return {
    steps,
    allowStartNow: allowStartNow(pref),
    assumptions: [
      "Signals are not enough to advance safely without a short pave",
      pref === "cautious"
        ? "Interruption preference is cautious: prefer completing the short plan"
        : 'You can say "start now" after a quick skim',
    ],
    verify: ["Pass a focused check before widening the change"],
    rollbackHint: "Keep the first diff reversible; roll back via VCS if needed",
  };
}
