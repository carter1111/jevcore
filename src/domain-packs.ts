/**
 * WP5.1 — focused Round-1 domain question packs.
 *
 * Round 0 always uses the universal base pack (`QUESTION_PACK_V1`). When
 * fan-out permits a second call, Round 1 uses one of these focused packs so
 * verification asks domain-specific safety questions instead of repeating the
 * same base pack (self-consistency alone).
 *
 * Selection is deterministic and prefers Round-0 typed signals (kind, factors,
 * security noul, fan-out reason). Lightweight keyword hints on task/command
 * are a tie-breaker only — never stored.
 *
 * Same shape as `QuestionPack` so `buildQuestions()` works unchanged.
 * Not re-exported from `index.ts` (internal, like the base pack).
 */
import type { GuardInput, ModelJudgment, RiskFactor, TaskKind } from "./types.js";
import type { FanOutDecisionReason } from "./fan-out-policy.js";
import { QUESTION_PACK_V1, type QuestionPack } from "./question-packs.js";

/** Version for the domain-pack set. Bump when any pack content changes. */
export const DOMAIN_PACK_VERSION = "2026-09-21.1";

export type DomainPackId =
  | "database"
  | "deploy"
  | "authz"
  | "web3"
  | "uncertainty";

export const DOMAIN_PACK_IDS: readonly DomainPackId[] = [
  "database",
  "deploy",
  "authz",
  "web3",
  "uncertainty",
] as const;

/** Why a particular domain pack was chosen. Closed set for observability. */
export type DomainPackSelectReason =
  | "DP-KIND-WEB3"
  | "DP-FACTOR-SECURITY"
  | "DP-FACTOR-DATA"
  | "DP-KIND-DEVOPS"
  | "DP-HINTS-PROD"
  | "DP-FANOUT-UNCLEAR"
  | "DP-KEYWORD-WEB3"
  | "DP-KEYWORD-AUTHZ"
  | "DP-KEYWORD-DATABASE"
  | "DP-KEYWORD-DEPLOY"
  | "DP-DEFAULT-UNCERTAINTY";

export interface DomainPackSelection {
  id: DomainPackId;
  pack: QuestionPack;
  reason: DomainPackSelectReason;
}

/** Deep-clone the base pack and overlay domain-focused wording. */
function overlayPack(
  id: DomainPackId,
  focus: string,
  riskFocus: string,
  riskSignals: readonly string[],
  factorOverrides: Partial<Record<RiskFactor, { question: string; trueWhat: string; falseWhat: string }>>,
  securityExamples: readonly string[],
): QuestionPack {
  const pack: QuestionPack = structuredClone(QUESTION_PACK_V1);
  pack.version = `${DOMAIN_PACK_VERSION}+${id}`;
  pack.kind.instructions.focus = focus;
  pack.risk.instructions.focus = riskFocus;
  for (const level of pack.risk.levels) {
    level.signals = [...(level.signals ?? []), ...riskSignals];
  }
  for (const [factor, o] of Object.entries(factorOverrides) as Array<
    [RiskFactor, { question: string; trueWhat: string; falseWhat: string }]
  >) {
    const spec = pack.factors[factor];
    spec.instructions.question = o.question;
    spec.criteria.true.what = o.trueWhat;
    spec.criteria.false.what = o.falseWhat;
  }
  pack.securityReview.instructions.focus =
    `Domain verification (${id}): judge whether dedicated security scrutiny is warranted.`;
  pack.securityReview.criteria.true.examples = [...securityExamples];
  return pack;
}

export const DOMAIN_PACK_DATABASE: QuestionPack = overlayPack(
  "database",
  "Verify database / schema / persistence safety for this change.",
  "Judge data-loss, migration, and schema blast radius — not general code risk alone.",
  ["Schema or migration touch", "User data or identity persistence", "Rollback of data change is hard"],
  {
    data: {
      question: "Does this change alter stored data, schema, migrations, or identity records?",
      trueWhat: "Touches migrations, schema, stored user data, or identity",
      falseWhat: "No persistence, schema, or identity impact",
    },
    irreversible: {
      question: "Would a failed or partial data change be hard to roll back cleanly?",
      trueWhat: "Data migration or destructive DDL that is hard to undo",
      falseWhat: "Easily reverted without lasting data impact",
    },
  },
  ["Run a destructive migration", "Drop or rewrite a production table", "Change identity/PII columns"],
);

export const DOMAIN_PACK_DEPLOY: QuestionPack = overlayPack(
  "deploy",
  "Verify deployment / environment / infrastructure safety for this change.",
  "Judge production blast radius, environment targeting, and rollback — not app feature risk alone.",
  ["Production or staging target", "CI/CD or infra change", "Config that affects live traffic"],
  {
    irreversible: {
      question: "Would this deploy or infra change be hard to roll back quickly?",
      trueWhat: "Live environment change that is slow or unsafe to undo",
      falseWhat: "Easily reverted config or non-prod-only change",
    },
    scope: {
      question: "Does this change affect shared infra, many services, or a wide deploy surface?",
      trueWhat: "Broad deploy/infra surface or multi-service impact",
      falseWhat: "Narrow, isolated deploy or config surface",
    },
  },
  ["Deploy to production", "Change CI secrets or cluster IAM", "Alter load-balancer or DNS for live traffic"],
);

export const DOMAIN_PACK_AUTHZ: QuestionPack = overlayPack(
  "authz",
  "Verify authentication / authorization / secrets safety for this change.",
  "Judge identity, access-control, and secret-handling blast radius.",
  ["Authn/authz surface", "Session, token, or permission change", "Secret or credential handling"],
  {
    security: {
      question: "Does this change touch login, permissions, tokens, secrets, or access control?",
      trueWhat: "Touches authn, authz, sessions, tokens, or secrets",
      falseWhat: "No identity or access-control surface",
    },
  },
  ["Change permission checks", "Alter token validation", "Handle credentials or secret material"],
);

export const DOMAIN_PACK_WEB3: QuestionPack = overlayPack(
  "web3",
  "Verify on-chain signing / asset / contract safety for this change.",
  "Judge irreversible asset movement, signing, and upgrade blast radius.",
  ["On-chain write or signing", "Asset transfer or approval", "Contract deploy/upgrade"],
  {
    irreversible: {
      question: "Would this on-chain action be hard or impossible to undo?",
      trueWhat: "Signing, transfer, deploy, or upgrade that cannot be reverted on-chain",
      falseWhat: "Read-only or easily abandoned off-chain prep",
    },
    security: {
      question: "Does this change touch keys, signing, approvals, or privileged contract paths?",
      trueWhat: "Touches keys, signing, approvals, or privileged contract entrypoints",
      falseWhat: "No signing, key, or privileged on-chain surface",
    },
  },
  ["Send or approve tokens", "Deploy or upgrade a contract", "Sign a transaction with a hot key"],
);

export const DOMAIN_PACK_UNCERTAINTY: QuestionPack = overlayPack(
  "uncertainty",
  "Clarify ambiguous risk: what is still unknown about this change?",
  "Judge whether evidence is sufficient to act; prefer escalation when unclear.",
  ["Vague or under-specified request", "Missing file/environment evidence", "Conflicting risk signals"],
  {
    unclear: {
      question: "Is the risk profile still unclear after the first assessment?",
      trueWhat: "Evidence remains insufficient or impact is ambiguous",
      falseWhat: "Impact is now well understood",
    },
  },
  ["Vague high-impact request with no files", "Ambiguous production vs local target"],
);

export const DOMAIN_PACKS: Record<DomainPackId, QuestionPack> = {
  database: DOMAIN_PACK_DATABASE,
  deploy: DOMAIN_PACK_DEPLOY,
  authz: DOMAIN_PACK_AUTHZ,
  web3: DOMAIN_PACK_WEB3,
  uncertainty: DOMAIN_PACK_UNCERTAINTY,
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const WEB3_RE =
  /\b(web3|solidity|smart\s*contract|on[- ]?chain|erc-?\d+|wallet|approve|transfer|deploy\s+contract|upgrade\s+proxy)\b/i;
const AUTHZ_RE =
  /\b(authn|authz|authentication|authorization|oauth|sso|rbac|permission|session\s*token|credential|secret\s*rotat)\b/i;
const DATABASE_RE =
  /\b(migrat|schema|postgres|mysql|mongodb|prisma|drizzle|sql\b|database|ddl|dml)\b/i;
const DEPLOY_RE =
  /\b(deploy|production|staging|kubernetes|terraform|helm|ci\/cd|infra|rollback|canary|blue[- ]?green)\b/i;

export interface SelectDomainPackInput {
  input: GuardInput;
  round0: ModelJudgment;
  /** Fan-out trigger reason, when available. */
  fanOutReason?: FanOutDecisionReason;
}

/**
 * Pick the Round-1 domain pack. Priority (most specific first):
 * web3 → authz → database → deploy → uncertainty.
 */
export function selectDomainPack(args: SelectDomainPackInput): DomainPackSelection {
  const { input, round0, fanOutReason } = args;
  const kind = round0.kind as TaskKind | undefined;
  const factors = round0.riskFactors ?? [];
  const text = [
    input.task,
    input.hints?.context ?? "",
    ...(input.hints?.touchedFiles ?? []),
  ].join("\n");

  if (kind === "web3") {
    return pick("web3", "DP-KIND-WEB3");
  }
  if (factors.includes("security") || (round0.securityReviewNoul ?? 0) >= 0.7) {
    return pick("authz", "DP-FACTOR-SECURITY");
  }
  if (factors.includes("data")) {
    return pick("database", "DP-FACTOR-DATA");
  }
  if (kind === "devops") {
    return pick("deploy", "DP-KIND-DEVOPS");
  }
  if (input.hints?.mentionsProd === true) {
    return pick("deploy", "DP-HINTS-PROD");
  }
  if (fanOutReason === "FO-UNCLEAR-FACTOR" || factors.includes("unclear")) {
    return pick("uncertainty", "DP-FANOUT-UNCLEAR");
  }

  // Keyword tie-breakers (task/command text as evidence only; never stored).
  if (WEB3_RE.test(text)) return pick("web3", "DP-KEYWORD-WEB3");
  if (AUTHZ_RE.test(text)) return pick("authz", "DP-KEYWORD-AUTHZ");
  if (DATABASE_RE.test(text)) return pick("database", "DP-KEYWORD-DATABASE");
  if (DEPLOY_RE.test(text)) return pick("deploy", "DP-KEYWORD-DEPLOY");

  return pick("uncertainty", "DP-DEFAULT-UNCERTAINTY");
}

function pick(id: DomainPackId, reason: DomainPackSelectReason): DomainPackSelection {
  return { id, pack: DOMAIN_PACKS[id], reason };
}
