/**
 * A deterministic, model-free provider used as a fallback when the TypeSafe
 * provider is unavailable or disabled. It makes conservative decisions via
 * keyword heuristics so the guard still returns a useful (and safe) result
 * offline.
 *
 * This is NOT a replacement for the model: it leans toward safer modes
 * (plan_first / approval_required) whenever in doubt.
 *
 * C-3 (2026-09-21): scored domain disambiguation (no bare "token" → web3),
 * path hints, and confidence that reflects match strength — not fixed 0.8/0.6.
 */
import type {
  DecisionProvider,
  GuardInput,
  ModelJudgment,
  RiskFactor,
  TaskKind,
} from "./types.js";

interface DomainSignal {
  kind: TaskKind;
  /** Relative weight for this hit. */
  weight: number;
  /** Source label for confidence (path vs task text). */
  via: "path" | "task";
}

/** Strong web3 signals — deliberately excludes bare "token" (design/auth/lexer). */
const WEB3_TASK =
  /\b(?:web3|smart\s*contracts?|solidity|evm|ethereum|erc-?20|nft|wallet|on-?chain|dapp|链上|(?:proxy\s+)?(?:upgrade|implementation)\s+contract|staking\s+module)\b/i;

const FRONTEND_TASK =
  /\b(?:frontend|ui|ux|web\s+apps?\b|webpage|css|html|react|stylesheet|component|page\s+layout|design\s+tokens?|前端|界面)\b/i;

const BACKEND_TASK =
  /\b(?:backend|api|server|endpoint|service|database|sql|orms?|middleware|session\s+middleware|billing|stripe|jwt|rbac|refund|subscription|login\s+flow|lexer|parser|后端|接口)\b/i;

/** Prefer specific test phrases over bare "test" (avoids "test chain"). */
const TESTING_TASK =
  /\b(?:unit\s+tests?|integration\s+tests?|test\s+coverage|add\s+tests?|spec\s+for|qa\b|测试)\b/i;

const DEVOPS_TASK =
  /\b(?:devops|ci\/cd|\bci\b|\bcd\b|continuous\s+integration|build\s+pipeline|deploy|docker|kubernetes|terraform|github\s+actions?|infra(?:structure)?|provision|git\s+push|force\s+push|rm\s+-rf|printenv|staging\s+area|配置|部署)\b/i;

const RESEARCH_TASK =
  /\b(?:docs?|readme|comment|diagram|typo|spelling|explain|analy[sz]e|compare|contributing\s+guide)\b/i;

function pathSignals(files: readonly string[]): DomainSignal[] {
  const out: DomainSignal[] = [];
  for (const raw of files) {
    const f = raw.replace(/\\/g, "/").toLowerCase();
    if (/\.(sol)$/.test(f) || /\/contracts?\//.test(f)) {
      out.push({ kind: "web3", weight: 3, via: "path" });
    }
    // Do NOT treat bare .ts/.js as frontend — most backend/services use those.
    if (
      /\.(tsx|jsx|css|scss|vue|svelte)$/.test(f) ||
      /\/components?\//.test(f) ||
      /tokens\.css$/.test(f)
    ) {
      out.push({ kind: "frontend", weight: 2, via: "path" });
    }
    if (/\.(test|spec)\.[a-z]+$/.test(f) || /\/__tests__\//.test(f)) {
      out.push({ kind: "testing", weight: 3, via: "path" });
    }
    if (
      /dockerfile|docker-compose|terraform|\.tf$|\/\.github\/workflows\//.test(f) ||
      /kubernetes|helm\//.test(f)
    ) {
      out.push({ kind: "devops", weight: 3, via: "path" });
    }
    if (/prisma|migration|schema\.sql|\.sql$/.test(f)) {
      out.push({ kind: "backend", weight: 2, via: "path" });
    }
    if (/readme|docs?\//.test(f)) {
      out.push({ kind: "research", weight: 2, via: "path" });
    }
  }
  return out;
}

function taskSignals(task: string): DomainSignal[] {
  const out: DomainSignal[] = [];
  if (WEB3_TASK.test(task)) out.push({ kind: "web3", weight: 3, via: "task" });
  if (FRONTEND_TASK.test(task)) out.push({ kind: "frontend", weight: 2, via: "task" });
  if (BACKEND_TASK.test(task)) out.push({ kind: "backend", weight: 2, via: "task" });
  if (TESTING_TASK.test(task)) out.push({ kind: "testing", weight: 3, via: "task" });
  if (DEVOPS_TASK.test(task)) out.push({ kind: "devops", weight: 2, via: "task" });
  if (RESEARCH_TASK.test(task)) out.push({ kind: "research", weight: 2, via: "task" });
  return out;
}

function pickKind(signals: DomainSignal[]): {
  kind: TaskKind;
  kindConfidence: number;
} {
  if (signals.length === 0) {
    return { kind: "general", kindConfidence: 0.45 };
  }

  const scores = new Map<TaskKind, number>();
  for (const s of signals) {
    scores.set(s.kind, (scores.get(s.kind) ?? 0) + s.weight);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  const second = ranked[1];
  const margin = second ? top[1] - second[1] : top[1];

  // Path-backed hits are slightly more trustworthy than task-only keywords.
  const pathBacked = signals.some((s) => s.kind === top[0] && s.via === "path");

  let kindConfidence: number;
  if (margin >= 3 || (margin >= 2 && pathBacked)) kindConfidence = 0.85;
  else if (margin >= 2) kindConfidence = 0.75;
  else if (margin >= 1) kindConfidence = 0.65;
  else kindConfidence = 0.5; // tie → keep a winner but low confidence

  return { kind: top[0], kindConfidence };
}

/** A zero-dependency provider with conservative priors. */
export class RuleProvider implements DecisionProvider {
  /** When false, `judge` reports failure (to exercise the engine fallback). */
  enabled = true;

  async judge(input: GuardInput): Promise<ModelJudgment> {
    if (!this.enabled) return { failed: true };

    const files = input.hints?.touchedFiles ?? [];
    const signals = [...pathSignals(files), ...taskSignals(input.task)];
    const { kind, kindConfidence } = pickKind(signals);

    // Security-ish language feeds risk factors and the security-review noul,
    // but does NOT change `kind` (keeps the public domain contract normalized
    // to the fixed frontend|backend|web3|devops|testing|research|general set).
    // Avoid bare "token" here too — auth/jwt/secret already cover session tokens.
    const securitySigned =
      /\b(?:auth|login|secret|password|jwt|session|api[_-]?key|credential|seed\s+phrase|mnemonic|private\s+key)\b/i.test(
        input.task,
      ) ||
      files.some((f) => /\.env|credentials?|secrets?\//i.test(f));

    const factors: RiskFactor[] = [];
    if (
      /(?:many|all|every|several|multiple|across|全部|多个).*(?:file|module|service)/i.test(
        input.task,
      ) ||
      /\brefactor\b.*\b(?:several|multiple|across|many|shared)\b.*\bmodule/i.test(input.task) ||
      /\.\*\*?\.\*/i.test(input.task)
    ) {
      factors.push("scope");
    }
    if (/delete|remove|drop|rewrite|migrate|breaking|删除|移除/i.test(input.task)) {
      factors.push("destructive");
    }
    if (/data|database|schema|migration|user|profile|privacy|数据|表|数据库/i.test(input.task)) {
      factors.push("data");
    }
    if (securitySigned) {
      factors.push("security");
    }
    if (factors.length === 0) factors.push("unclear");

    const riskScore = factors.length >= 2 ? 0.7 : factors.length === 1 ? 0.4 : 0.2;
    // Stronger factor evidence → slightly higher risk confidence; "unclear"-only stays low.
    const riskConfidence =
      factors.length >= 2 ? 0.75 : factors[0] === "unclear" ? 0.45 : 0.6;

    return {
      kind,
      kindConfidence,
      riskScore,
      riskConfidence,
      riskFactors: factors,
      securityReviewNoul: securitySigned ? 0.9 : 0.1,
      failed: false,
    };
  }
}
