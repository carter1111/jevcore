/**
 * Minimal AgentResult builder (T02/T03).
 * Full plan/options/safer payloads land in T08–T10; resolver in T07.
 * T04 wires this into engine/MCP.
 */
import { resolveAgentLocale } from "./locale.js";
import { buildValueReceipt, formatValueReceiptLines } from "./receipt.js";
import { shouldPrintReceiptNow, receiptDisplayMode } from "./display.js";
import { AGENT_CONTRACT_PREFIX } from "./prefix.js";
import {
  authorityDetail,
  buildNextActions,
  statusHeadline,
  yourCallBeyondAuthSummary,
  saferPathBoundarySummary,
} from "./templates.js";
import type {
  AgentLocale,
  AgentResult,
  AgentStatus,
  AuthoritySource,
  BoundaryKind,
  ExecuteFeedback,
  ModelAdviceTier,
  ValueReceiptEvidence,
} from "./types.js";
import { agentStatusFromExecutionMode } from "./types.js";

export interface BuildAgentResultInput {
  locale?: string | null;
  status: AgentStatus;
  authoritySource: AuthoritySource;
  profileRuleId?: string;
  boundaryKind?: BoundaryKind;
  userCanOverride?: boolean;
  allowedScopes?: Array<"once" | "session" | "profile">;
  facts?: AgentResult["facts"];
  plan?: AgentResult["plan"];
  clarification?: AgentResult["clarification"];
  choices?: AgentResult["choices"];
  rewrite?: AgentResult["rewrite"];
  rollbackHint?: string;
  readFirst?: string[];
  recommendedSkills?: string[];
  modelAdviceTier?: ModelAdviceTier;
  modelAdviceReason?: string;
  pavedSteps?: number;
  pavedDetail?: string;
  yourCallOptions?: number;
  saferPathDetail?: string;
  jevSkippedDetail?: string;
  multiCheckDetail?: string;
  precheckDetail?: string;
  evidence: ValueReceiptEvidence;
  executeFeedback?: ExecuteFeedback;
}

export interface BuiltAgentBundle {
  agent: AgentResult;
  locale: AgentLocale;
  /** Whether adapters should print receipt lines now. */
  printNow: boolean;
  displayMode: ReturnType<typeof receiptDisplayMode>;
  /** Verbatim lines when printNow (status_line = headline only). */
  printLines: string[];
}

function summaryFor(
  locale: AgentLocale,
  status: AgentStatus,
  profileRuleId: string | undefined,
  boundaryKind: BoundaryKind | undefined,
  rewriteRationale?: string,
): string {
  if (status === "your_call") return yourCallBeyondAuthSummary(locale, profileRuleId);
  if (status === "safer_path") {
    // Prefer human rewrite rationale over POL-only or bare boundary label.
    if (rewriteRationale && rewriteRationale.trim()) return rewriteRationale;
    return saferPathBoundarySummary(locale, boundaryKind ?? "data");
  }
  return statusHeadline(locale, status);
}

export function buildAgentResult(input: BuildAgentResultInput): BuiltAgentBundle {
  const locale = resolveAgentLocale(input.locale);
  const status = input.status;
  const authoritySource = input.authoritySource;
  const headline =
    status === "your_call"
      ? yourCallBeyondAuthSummary(locale, input.profileRuleId)
      : status === "safer_path"
        ? saferPathBoundarySummary(locale, input.boundaryKind ?? "data")
        : statusHeadline(locale, status);

  const valueReceipt = buildValueReceipt({
    locale,
    status,
    authoritySource,
    profileRuleId: input.profileRuleId,
    boundaryKind: input.boundaryKind,
    precheckDetail: input.precheckDetail,
    pavedSteps: input.pavedSteps ?? input.plan?.steps.length,
    pavedDetail: input.pavedDetail,
    yourCallOptions: input.yourCallOptions ?? input.choices?.length,
    saferPathDetail: input.saferPathDetail ?? input.rewrite?.rationale,
    readFirstPaths: input.readFirst,
    modelAdviceTier: input.modelAdviceTier,
    modelAdviceReason: input.modelAdviceReason,
    jevSkippedDetail: input.jevSkippedDetail,
    multiCheckDetail: input.multiCheckDetail,
    evidence: input.evidence,
  });

  const userCanOverride =
    input.userCanOverride ??
    (authoritySource !== "hard_boundary" && status !== "safer_path");

  const allowedScopes =
    input.allowedScopes ??
    (status === "your_call"
      ? (["once", "session", "profile"] as const)
      : status === "safer_path"
        ? ([] as const)
        : status === "pave_way"
          ? (["session", "profile"] as const)
          : ([] as const));

  const agent: AgentResult = {
    status,
    summary: summaryFor(
      locale,
      status,
      input.profileRuleId,
      input.boundaryKind,
      input.rewrite?.rationale,
    ),
    headline,
    authority: {
      source: authoritySource,
      profileRuleId: input.profileRuleId,
      userCanOverride,
      allowedScopes: [...allowedScopes],
      boundaryKind: input.boundaryKind,
    },
    facts: input.facts ?? [
      {
        code: "AUTHORITY",
        detail: authorityDetail(locale, authoritySource, input.profileRuleId),
      },
    ],
    nextActions: buildNextActions(locale, status, {
      enabled:
        status === "pave_way"
          ? { start_now: input.plan?.allowStartNow ?? true }
          : undefined,
    }),
    plan: input.plan,
    clarification: input.clarification,
    choices: input.choices,
    rewrite: input.rewrite,
    rollbackHint: input.rollbackHint,
    readFirst: input.readFirst,
    recommendedSkills: input.recommendedSkills,
    modelAdvice: input.modelAdviceTier
      ? {
          tier: input.modelAdviceTier,
          reason: input.modelAdviceReason ?? "",
          hostAutoApplied: false,
        }
      : undefined,
    valueReceipt,
  };

  const executeFeedback = input.executeFeedback ?? "session_summary";
  const displayMode = receiptDisplayMode(status, executeFeedback);
  const printNow = shouldPrintReceiptNow(status, executeFeedback);
  const fullLines = formatValueReceiptLines(valueReceipt);
  const printLines =
    displayMode === "status_line" ? [fullLines[0] ?? `${AGENT_CONTRACT_PREFIX} ${headline}`] : fullLines;

  return { agent, locale, printNow, displayMode, printLines };
}

export function buildAgentResultFromExecutionMode(
  mode: "execute" | "plan_first" | "approval_required" | "block",
  input: Omit<BuildAgentResultInput, "status"> & {
    authoritySource?: AuthoritySource;
  },
): BuiltAgentBundle {
  const status = agentStatusFromExecutionMode(mode);
  const authoritySource =
    input.authoritySource ??
    (status === "safer_path"
      ? "hard_boundary"
      : status === "your_call"
        ? "user_profile"
        : status === "pave_way"
          ? "engine_uncertainty"
          : "product_default");
  return buildAgentResult({ ...input, status, authoritySource });
}
