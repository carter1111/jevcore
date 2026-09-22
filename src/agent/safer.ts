/**
 * T10 — safer_path rewrite builder.
 * Data vs delegation copy; never POL-* as the sole primary user-facing reason.
 */
import { saferPathBoundarySummary } from "./templates.js";
import type { AgentLocale, AgentRewrite, BoundaryKind } from "./types.js";

/** Policy / reason codes that are hard data / never-delegate boundaries. */
const DATA_BOUNDARY_CODES = [
  "POL-SECRETS-",
  "POL-CI-SECRETS-",
  "POL-WEB3-ASSET-",
  "POL-PII-EGRESS-",
] as const;

export interface SaferPathInput {
  locale?: AgentLocale;
  /** Reason codes from engine (POL-*, PREFLIGHT-BLOCK, …). */
  reasonCodes: string[];
  /** Optional override; otherwise inferred from reasonCodes. */
  boundaryKind?: BoundaryKind;
}

export interface SaferPathPayload {
  boundaryKind: BoundaryKind;
  /** Primary user-facing why (never a bare POL-* id). */
  rationale: string;
  rewrite: AgentRewrite;
  /** Detail line for valueReceipt.did safer_path. */
  receiptDetail: string;
}

function isDataBoundaryCode(code: string): boolean {
  return DATA_BOUNDARY_CODES.some((prefix) => code.startsWith(prefix));
}

/**
 * Classify block reasons into data vs delegation.
 * Secrets / Web3 asset / PII egress → data; other hard blocks → delegation.
 */
export function classifySaferBoundary(reasonCodes: string[]): BoundaryKind {
  if (reasonCodes.some(isDataBoundaryCode)) return "data";
  return "delegation";
}

function primaryPolicyId(reasonCodes: string[]): string | undefined {
  return reasonCodes.find((c) => c.startsWith("POL-"));
}

function dataCopy(locale: AgentLocale, policyId: string | undefined): SaferPathPayload {
  const boundaryKind = "data" as const;
  if (locale === "zh") {
    const rationale =
      "数据边界：内容像真实凭证、密钥或资产操作；Agent 不能代你送给远程或代签。";
    return {
      boundaryKind,
      rationale,
      rewrite: {
        suggestedTask:
          "改用环境变量名/占位符描述需求；不粘贴真实密钥；由你本地轮换或填写。",
        rationale,
        alternatives: [
          "使用轮换清单，亲自处理真实凭证",
          "检查 .gitignore / secret 扫描，确认未入库",
          "在宿主侧自行完成签名或资产操作后，再让 Agent 做无密钥的后续步骤",
        ],
      },
      receiptDetail: policyId
        ? `${saferPathBoundarySummary("zh", "data")}（依据 ${policyId}）`
        : saferPathBoundarySummary("zh", "data"),
    };
  }
  const rationale =
    "Data boundary: looks like a real credential, key material, or asset action; Agent will not send it remotely or sign for you.";
  return {
    boundaryKind,
    rationale,
    rewrite: {
      suggestedTask:
        "Describe the need with env var names / placeholders only; never paste secret values; you rotate or fill locally.",
      rationale,
      alternatives: [
        "Use a rotation checklist and handle the real secret yourself",
        "Check .gitignore / secret scanning so nothing is committed",
        "Complete signing or asset actions yourself, then hand non-secret follow-ups back to Agent",
      ],
    },
    receiptDetail: policyId
      ? `${saferPathBoundarySummary("en", "data")} (per ${policyId})`
      : saferPathBoundarySummary("en", "data"),
  };
}

function delegationCopy(locale: AgentLocale, policyId: string | undefined): SaferPathPayload {
  const boundaryKind = "delegation" as const;
  if (locale === "zh") {
    const rationale =
      "委托边界：该操作不可由 Agent 自动代劳（破坏性/生产级风险）；请你亲自处理或改用更安全的步骤。";
    return {
      boundaryKind,
      rationale,
      rewrite: {
        suggestedTask:
          "把目标改成可逆、可复核的步骤（先 dry-run /  staging / 备份），再考虑是否授权 Agent。",
        rationale,
        alternatives: [
          "你自己在受控环境执行，并保留回滚点",
          "先做只读核查与备份，再开更小范围的变更",
          "若仅为本地无破坏性工作，改写任务后重新评估",
        ],
      },
      receiptDetail: policyId
        ? `${saferPathBoundarySummary("zh", "delegation")}（依据 ${policyId}）`
        : saferPathBoundarySummary("zh", "delegation"),
    };
  }
  const rationale =
    "Delegation boundary: Agent must not auto-run this (destructive / production-grade risk); handle it yourself or use a safer sequence.";
  return {
    boundaryKind,
    rationale,
    rewrite: {
      suggestedTask:
        "Rewrite toward reversible, reviewable steps (dry-run / staging / backup) before asking Agent again.",
      rationale,
      alternatives: [
        "Run it yourself in a controlled environment with a rollback point",
        "Do read-only checks and backups first, then a smaller change",
        "If the real goal is local non-destructive work, rephrase and re-assess",
      ],
    },
    receiptDetail: policyId
      ? `${saferPathBoundarySummary("en", "delegation")} (per ${policyId})`
      : saferPathBoundarySummary("en", "delegation"),
  };
}

/**
 * Build safer_path user-facing rewrite. Primary copy is always prose;
 * policy ids may appear only as secondary evidence in receiptDetail/facts.
 */
export function buildSaferPathPayload(input: SaferPathInput): SaferPathPayload {
  const locale = input.locale ?? "en";
  const kind = input.boundaryKind ?? classifySaferBoundary(input.reasonCodes);
  const policyId = primaryPolicyId(input.reasonCodes);
  return kind === "data" ? dataCopy(locale, policyId) : delegationCopy(locale, policyId);
}

/** True when a string is only a POL-* code (disallowed as sole primary copy). */
export function isPolOnlyPrimary(text: string): boolean {
  const t = text.trim();
  return /^POL-[A-Z0-9-]+$/i.test(t);
}
