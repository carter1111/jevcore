/**
 * T09 — your_call options + grant action wiring (deterministic).
 * Recommendation uses product-default priorities until T07 wires profile.priorities.
 */
import type { AgentChoice, AgentLocale, AgentNextActionId } from "./types.js";
import { buildNextActions } from "./templates.js";

export type PriorityId = "project_quality" | "delivery_speed" | "cost_control";

export interface BuildYourCallOptionsInput {
  locale?: AgentLocale;
  /** Touched profile/policy rule id (e.g. POL-PROD-1 or productionDeploy). */
  profileRuleId?: string;
  reasonCodes?: string[];
  /**
   * Priority order — first entry preferred for recommendation.
   * Default: project_quality → delivery_speed → cost_control.
   */
  priorityOrder?: PriorityId[];
  /** When false, hide approve_session (e.g. production-careful categories). */
  allowSessionGrant?: boolean;
}

export interface YourCallPayload {
  choices: AgentChoice[];
  /** nextActions with grant scopes; profile change + self_handle always offered. */
  nextActions: Array<{ id: AgentNextActionId; label: string; enabled: boolean }>;
  /** One-line fact about touched rule (never POL-only as sole summary). */
  touchedRuleDetail: string;
}

const DEFAULT_PRIORITIES: PriorityId[] = [
  "project_quality",
  "delivery_speed",
  "cost_control",
];

function prefersSafer(order: PriorityId[]): boolean {
  const top = order[0] ?? "project_quality";
  return top === "project_quality" || top === "cost_control";
}

function enChoices(recommendSafer: boolean): AgentChoice[] {
  return [
    {
      id: "A",
      label: "Faster path — proceed with the change now",
      tradeoff: "Faster; confirm target, blast radius, and rollback before you approve",
      reversible: false,
      recommended: !recommendSafer,
    },
    {
      id: "B",
      label: "Safer path — checklist / staging dry-run first",
      tradeoff: "Slower; reviewable and usually reversible before production impact",
      reversible: true,
      recommended: recommendSafer,
    },
  ];
}

function zhChoices(recommendSafer: boolean): AgentChoice[] {
  return [
    {
      id: "A",
      label: "更快路径 — 现在推进该变更",
      tradeoff: "更快；批准前请确认目标、影响面与回滚",
      reversible: false,
      recommended: !recommendSafer,
    },
    {
      id: "B",
      label: "更稳路径 — 先 checklist / staging dry-run",
      tradeoff: "更慢；可复核，生产影响前通常可逆",
      reversible: true,
      recommended: recommendSafer,
    },
  ];
}

function touchedDetail(
  locale: AgentLocale,
  profileRuleId: string | undefined,
  reasonCodes: string[],
): string {
  const id = profileRuleId ?? reasonCodes.find((c) => c.startsWith("POL-"));
  if (locale === "zh") {
    return id
      ? `触及规则：${id} — 已超出当前授权，需你选择一次/会话授权或自行处理。`
      : "已超出当前授权 — 需你选择一次/会话授权、改 profile，或自行处理。";
  }
  return id
    ? `Touched rule: ${id} — beyond current authorization; choose once/session grant or self-handle.`
    : "Beyond current authorization — choose once/session grant, change profile, or self-handle.";
}

/**
 * Build your_call A/B choices + grant nextActions.
 * Learned suggestions never appear here as authority.
 */
export function buildYourCallOptions(
  input: BuildYourCallOptionsInput = {},
): YourCallPayload {
  const locale = input.locale ?? "en";
  const order = input.priorityOrder?.length ? input.priorityOrder : DEFAULT_PRIORITIES;
  const recommendSafer = prefersSafer(order);
  const choices = locale === "zh" ? zhChoices(recommendSafer) : enChoices(recommendSafer);

  const allowSession = input.allowSessionGrant !== false;
  const nextActions = buildNextActions(locale, "your_call", {
    enabled: {
      approve_session: allowSession,
    },
  });

  return {
    choices,
    nextActions,
    touchedRuleDetail: touchedDetail(locale, input.profileRuleId, input.reasonCodes ?? []),
  };
}

/** Heuristic: production-grade rules usually disallow casual session grants. */
export function allowSessionGrantForRule(profileRuleId: string | undefined): boolean {
  if (!profileRuleId) return true;
  const id = profileRuleId.toUpperCase();
  if (id.includes("PROD") || id.includes("WEB3") || id.includes("SECRET")) return false;
  return true;
}
