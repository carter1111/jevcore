/**
 * Value receipt builder — always generate; display is separate (display.ts).
 */
import {
  authorityDetail,
  modelAdviceDetail,
  saferPathBoundarySummary,
  statusHeadline,
  yourCallBeyondAuthSummary,
} from "./templates.js";
import type {
  AgentLocale,
  AgentStatus,
  AuthoritySource,
  BoundaryKind,
  ModelAdviceTier,
  ValueReceipt,
  ValueReceiptDid,
  ValueReceiptEvidence,
} from "./types.js";
import { AGENT_CONTRACT_PREFIX } from "./prefix.js";

export interface BuildValueReceiptInput {
  locale: AgentLocale;
  status: AgentStatus;
  authoritySource: AuthoritySource;
  profileRuleId?: string;
  boundaryKind?: BoundaryKind;
  precheckDetail?: string;
  pavedSteps?: number;
  pavedDetail?: string;
  yourCallOptions?: number;
  yourCallDetail?: string;
  saferPathDetail?: string;
  readFirstPaths?: string[];
  modelAdviceTier?: ModelAdviceTier;
  modelAdviceReason?: string;
  jevSkippedDetail?: string;
  multiCheckDetail?: string;
  evidence: ValueReceiptEvidence;
}

function defaultPrecheck(locale: AgentLocale): string {
  return locale === "zh"
    ? "已预检（常见风险信号）"
    : "Prechecked (common risk signals)";
}

function defaultAdvanced(locale: AgentLocale, authority: string): string {
  return locale === "zh" ? `已在授权内推进；授权来源：${authority}` : `Advanced within authorization; authority: ${authority}`;
}

/**
 * Always build a ValueReceipt for the decision (even if display is silent).
 */
export function buildValueReceipt(input: BuildValueReceiptInput): ValueReceipt {
  const { locale, status } = input;
  const authority = authorityDetail(locale, input.authoritySource, input.profileRuleId);
  const did: ValueReceiptDid[] = [];

  let headline = statusHeadline(locale, status);

  if (status === "advance") {
    did.push({
      kind: "precheck",
      detail: input.precheckDetail ?? defaultPrecheck(locale),
    });
    did.push({
      kind: "advanced",
      detail: defaultAdvanced(locale, authority),
    });
  } else if (status === "pave_way") {
    const steps = input.pavedSteps ?? 0;
    did.push({
      kind: "paved",
      steps,
      detail: input.pavedDetail,
    });
  } else if (status === "your_call") {
    headline = yourCallBeyondAuthSummary(locale, input.profileRuleId);
    did.push({
      kind: "your_call",
      options: input.yourCallOptions ?? 0,
      detail: input.yourCallDetail ?? authority,
    });
  } else {
    const kind = input.boundaryKind ?? "data";
    headline = saferPathBoundarySummary(locale, kind);
    did.push({
      kind: "safer_path",
      detail: input.saferPathDetail ?? headline,
    });
  }

  if (input.readFirstPaths && input.readFirstPaths.length > 0) {
    did.push({
      kind: "read_first",
      paths: input.readFirstPaths,
      detail:
        locale === "zh"
          ? `建议先读：${input.readFirstPaths.join(", ")}`
          : `Read first: ${input.readFirstPaths.join(", ")}`,
    });
  }

  if (input.modelAdviceTier) {
    const detail =
      input.modelAdviceReason ?? modelAdviceDetail(locale, input.modelAdviceTier);
    did.push({
      kind: "model_advice",
      tier: input.modelAdviceTier,
      detail,
    });
  }

  if (input.jevSkippedDetail) {
    did.push({ kind: "jev_skipped", detail: input.jevSkippedDetail });
  }

  if (input.multiCheckDetail) {
    did.push({ kind: "multi_check", detail: input.multiCheckDetail });
  }

  return {
    locale,
    headline,
    did,
    evidence: { ...input.evidence },
  };
}

/** Format receipt for verbatim print (when display policy says show). */
export function formatValueReceiptLines(receipt: ValueReceipt): string[] {
  const lines: string[] = [`${AGENT_CONTRACT_PREFIX} ${receipt.headline}`];
  for (const item of receipt.did) {
    switch (item.kind) {
      case "paved":
        lines.push(
          item.detail
            ? `· ${item.detail}`
            : `· paved: ${item.steps} step(s)`,
        );
        break;
      case "your_call":
        lines.push(
          item.detail
            ? `· ${item.detail}`
            : `· your_call: ${item.options} option(s)`,
        );
        break;
      case "model_advice":
        lines.push(`· model advice: ${item.tier} — ${item.detail}`);
        break;
      case "read_first":
        lines.push(`· ${item.detail}`);
        break;
      default:
        lines.push(`· ${item.detail}`);
    }
  }
  const ev = receipt.evidence;
  if (ev.latencyMs != null || ev.inputTokens != null) {
    const parts: string[] = [];
    if (ev.latencyMs != null) parts.push(`${ev.latencyMs}ms`);
    if (ev.inputTokens != null || ev.outputTokens != null) {
      parts.push(`tokens in/out ${ev.inputTokens ?? "?"}/${ev.outputTokens ?? "?"}`);
    }
    if (parts.length) {
      lines.push(
        receipt.locale === "zh" ? `（Jev 本步 ${parts.join(", ")}）` : `(Jev step ${parts.join(", ")})`,
      );
    }
  }
  return lines;
}
