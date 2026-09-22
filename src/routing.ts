/**
 * P4 — Preflight Router (recommendations only).
 *
 * Derives routing suggestions from signals the Guard **already** produced
 * (domain, risk, mode, confidence, security, factors, file hints). This is
 * deterministic and model-free — it never calls a provider and never claims to
 * force host model/context selection.
 *
 * Provider-backed routing *questions* are deferred: the public question pack is
 * fixed at 10 items (see HANDOFF); expanding it needs a measured corpus gate.
 *
 * Hosts (Cursor / Claude Code / Codex) cannot be forced to honor these fields.
 * Turning recommendations into execution is P6, only inside a harness we own.
 */
import type {
  EngineResultLike,
  GuardInput,
  RoutingRecommendation,
  SkillId,
} from "./types.js";

/** Public skill ids the router may recommend. */
export const ROUTING_SKILLS = [
  "testing",
  "security",
  "web3",
  "devops",
  "frontend",
  "backend",
  "research",
] as const satisfies readonly SkillId[];

/**
 * Build a routing recommendation from a finalized decision.
 * Returns `null` when the decision is too incomplete to recommend without
 * guessing (omit the field — never fabricate).
 */
export function recommendRouting(
  result: EngineResultLike,
  input?: GuardInput,
): RoutingRecommendation | null {
  if (!result || typeof result !== "object") return null;
  const mode = result.mode;
  if (
    mode !== "execute" &&
    mode !== "plan_first" &&
    mode !== "approval_required" &&
    mode !== "block"
  ) {
    return null;
  }
  const kind = result.classification?.kind;
  const riskScore = result.risk?.score;
  const kindConf = result.classification?.confidence;
  const riskConf = result.risk?.confidence;
  if (
    typeof riskScore !== "number" ||
    !Number.isFinite(riskScore) ||
    typeof kindConf !== "number" ||
    !Number.isFinite(kindConf) ||
    typeof riskConf !== "number" ||
    !Number.isFinite(riskConf)
  ) {
    return null;
  }

  const fileCount = input?.hints?.touchedFiles?.length ?? 0;
  const reviewNeeded = result.security?.reviewNeeded === true;
  const factors = Array.isArray(result.risk?.factors) ? result.risk.factors : [];

  const complexity = deriveComplexity({
    mode,
    riskScore,
    fileCount,
    reviewNeeded,
  });
  const recommendedModelTier = deriveModelTier({
    complexity,
    mode,
    kind,
    reviewNeeded,
    riskScore,
  });
  const recommendedContextBudget = complexity; // mirror until measured otherwise
  const recommendedSkillBundle = deriveSkills({
    kind,
    reviewNeeded,
    factors,
  });
  const planFirst =
    mode === "plan_first" ||
    mode === "approval_required" ||
    mode === "block" ||
    kindConf < 0.6 ||
    riskConf < 0.6;

  return {
    complexity,
    recommendedModelTier,
    recommendedContextBudget,
    recommendedSkillBundle,
    planFirst,
    source: "deterministic",
  };
}

function deriveComplexity(args: {
  mode: string;
  riskScore: number;
  fileCount: number;
  reviewNeeded: boolean;
}): "small" | "medium" | "large" {
  if (args.mode === "block" || args.riskScore >= 0.8 || args.fileCount >= 12) {
    return "large";
  }
  if (
    args.mode === "approval_required" ||
    args.mode === "plan_first" ||
    args.riskScore >= 0.45 ||
    args.reviewNeeded ||
    args.fileCount >= 4
  ) {
    return "medium";
  }
  return "small";
}

function deriveModelTier(args: {
  complexity: "small" | "medium" | "large";
  mode: string;
  kind: string | undefined;
  reviewNeeded: boolean;
  riskScore: number;
}): "fast" | "normal" | "reasoning" {
  if (
    args.complexity === "large" ||
    args.mode === "block" ||
    args.kind === "web3" ||
    (args.reviewNeeded && args.riskScore >= 0.5)
  ) {
    return "reasoning";
  }
  if (args.complexity === "medium" || args.mode !== "execute") {
    return "normal";
  }
  return "fast";
}

function deriveSkills(args: {
  kind: string | undefined;
  reviewNeeded: boolean;
  factors: string[];
}): SkillId[] {
  const out = new Set<SkillId>();
  switch (args.kind) {
    case "frontend":
      out.add("frontend");
      break;
    case "backend":
      out.add("backend");
      break;
    case "web3":
      out.add("web3");
      break;
    case "devops":
      out.add("devops");
      break;
    case "testing":
      out.add("testing");
      break;
    case "research":
      out.add("research");
      break;
    default:
      break;
  }
  if (args.reviewNeeded || args.factors.includes("security")) {
    out.add("security");
  }
  if (args.factors.includes("data") && !out.has("backend")) {
    out.add("backend");
  }
  // Stable order matching ROUTING_SKILLS
  return ROUTING_SKILLS.filter((s) => out.has(s));
}
