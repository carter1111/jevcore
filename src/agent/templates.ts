/**
 * Deterministic EN/ZH templates for JEVCore Agent Contract.
 * No host-LLM calls — string tables only.
 */
import type {
  AgentLocale,
  AgentNextActionId,
  AgentStatus,
  AuthoritySource,
  BoundaryKind,
  ModelAdviceTier,
} from "./types.js";

const STATUS_LABEL: Record<AgentLocale, Record<AgentStatus, string>> = {
  en: {
    advance: "I'll advance.",
    pave_way: "I'll pave the way first.",
    your_call: "Your call on this step.",
    safer_path: "I won't take that path for you — here's a safer one.",
  },
  zh: {
    advance: "我来推进。",
    pave_way: "我先帮你铺路。",
    your_call: "这一步由你定方向。",
    safer_path: "这条路不能替你走，我给你换一条。",
  },
};

const AUTHORITY_LABEL: Record<AgentLocale, Record<AuthoritySource, string>> = {
  en: {
    hard_boundary: "hard boundary (service commitment)",
    one_time_grant: "your one-time grant",
    session_grant: "your session grant",
    user_profile: "your profile",
    interruption_preference: "your interruption preference",
    engine_uncertainty: "engine uncertainty",
    product_default: "product default",
  },
  zh: {
    hard_boundary: "硬边界（服务承诺）",
    one_time_grant: "你的一次性授权",
    session_grant: "你的本会话授权",
    user_profile: "你的 profile",
    interruption_preference: "你的打断偏好",
    engine_uncertainty: "引擎不确定",
    product_default: "产品默认",
  },
};

const NEXT_ACTION_LABEL: Record<AgentLocale, Record<AgentNextActionId, string>> = {
  en: {
    continue: "Continue",
    start_now: "Start now",
    approve_once: "Approve once",
    approve_session: "Approve for this session",
    change_profile: "Change profile",
    self_handle: "I'll handle it myself",
    use_safer_path: "Use safer path",
    answer_clarification: "Answer clarification",
  },
  zh: {
    continue: "继续",
    start_now: "现在开始",
    approve_once: "允许一次",
    approve_session: "本会话允许",
    change_profile: "改长期 profile",
    self_handle: "我自己处理",
    use_safer_path: "使用安全路径",
    answer_clarification: "回答澄清问题",
  },
};

const MODEL_TIER_HINT: Record<AgentLocale, Record<ModelAdviceTier, string>> = {
  en: {
    fast: "fast — small change; switch in your host picker if you want (not auto-applied)",
    normal: "normal — ordinary coding model",
    reasoning: "reasoning — harder multi-step judgment",
    max: "max — highest capability; use only when worth the cost",
  },
  zh: {
    fast: "fast — 小改动；请在宿主选择器自行切换（未自动换模）",
    normal: "normal — 常规编码模型",
    reasoning: "reasoning — 更强多步判断",
    max: "max — 最强档；仅在值得时使用",
  },
};

export function statusHeadline(locale: AgentLocale, status: AgentStatus): string {
  return STATUS_LABEL[locale][status];
}

export function authorityDetail(
  locale: AgentLocale,
  source: AuthoritySource,
  profileRuleId?: string,
): string {
  const base = AUTHORITY_LABEL[locale][source];
  if (profileRuleId) {
    return locale === "zh" ? `${base}（规则 ${profileRuleId}）` : `${base} (rule ${profileRuleId})`;
  }
  return base;
}

export function nextActionLabel(locale: AgentLocale, id: AgentNextActionId): string {
  return NEXT_ACTION_LABEL[locale][id];
}

export function modelAdviceDetail(locale: AgentLocale, tier: ModelAdviceTier): string {
  return MODEL_TIER_HINT[locale][tier];
}

export function yourCallBeyondAuthSummary(locale: AgentLocale, profileRuleId?: string): string {
  if (locale === "zh") {
    return profileRuleId
      ? `这一步由你定方向 — 已超出你当前的授权规则（${profileRuleId}）。`
      : "这一步由你定方向 — 已超出你当前的授权规则。";
  }
  return profileRuleId
    ? `Your call — this exceeds your current authorization (${profileRuleId}).`
    : "Your call — this exceeds your current authorization.";
}

export function saferPathBoundarySummary(
  locale: AgentLocale,
  kind: BoundaryKind,
): string {
  if (locale === "zh") {
    return kind === "data"
      ? "数据边界：Agent 不能代办；安全改写已准备。"
      : "委托边界：需要你的授权或亲自处理；安全路径已准备。";
  }
  return kind === "data"
    ? "Data boundary: Agent cannot proceed for you; safer rewrite ready."
    : "Delegation boundary: needs your grant or self-handle; safer path ready.";
}

export function defaultNextActionIds(status: AgentStatus): AgentNextActionId[] {
  switch (status) {
    case "advance":
      return ["continue"];
    case "pave_way":
      return ["start_now", "continue", "change_profile"];
    case "your_call":
      return ["approve_once", "approve_session", "change_profile", "self_handle"];
    case "safer_path":
      return ["use_safer_path", "self_handle"];
  }
}

export function buildNextActions(
  locale: AgentLocale,
  status: AgentStatus,
  opts?: { enabled?: Partial<Record<AgentNextActionId, boolean>> },
): { id: AgentNextActionId; label: string; enabled: boolean }[] {
  return defaultNextActionIds(status).map((id) => ({
    id,
    label: nextActionLabel(locale, id),
    enabled: opts?.enabled?.[id] ?? true,
  }));
}
