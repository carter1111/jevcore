/**
 * FanOutProvider (WP5) — a `DecisionProvider` decorator that may perform ONE
 * extra, focused verification call for uncertain-but-consequential judgments.
 *
 * It sits at the documented `DecisionProvider` seam (architecture.md §6.4), so
 * `engine.ts` needs no knowledge of fan-out — it only sees the merged judgment.
 *
 * Round 1 — focused domain pack (WP5.1). Budget is 2 total, hard-capped.
 * HARD GUARANTEES (Plan §10):
 * - At most `MAX_PROVIDER_CALLS` (2) calls, ever. The default path makes 1.
 * - Hard policy that settles the action prevents the extra call entirely.
 * - Merging is confirmation-based: Round 1 may raise risk/security only when
 *   its confidence meets `FAN_OUT_CONFIRM_FLOOR`. It never lowers Round 0.
 * - A failed second call never fails open: the merged judgment carries
 *   `verificationFailed: true`, which the engine's composition layer escalates
 *   to `approval_required`.
 * - No caller-controlled depth knob exists.
 * - Content-free merge: it only compares bounded signal values.
 * - Round 1 uses `selectDomainPack` (typed signals + keyword tie-break).
 */
import type {
  BatchDecisionProvider,
  DecisionProvider,
  GuardInput,
  JudgeOptions,
  ModelJudgment,
  RiskFactor,
} from "./types.js";
import { isBatchDecisionProvider } from "./types.js";
import {
  decideFanOut,
  MAX_PROVIDER_CALLS,
  type FanOutThresholds,
} from "./fan-out-policy.js";
import { selectDomainPack, type DomainPackId, type DomainPackSelectReason } from "./domain-packs.js";

/**
 * MCP default-on after live enable-gate (2026-09-21.4): unsafeAllow −1,
 * unnecessary 0, p95 ~flat on the 40-fixture corpus. Set `JEV_FAN_OUT=0` to
 * disable. Callers never get a less-safe depth knob — this only allows the
 * fixed budget of at most two provider calls.
 */
export const FAN_OUT_ENV_FLAG = "JEV_FAN_OUT";

/** True unless `JEV_FAN_OUT=0`. Default (unset / any other value) is ON. */
export function isFanOutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FAN_OUT_ENV_FLAG] !== "0";
}

/** Defaults mirroring the engine's thresholds (kept in sync deliberately). */
const DEFAULT_THRESHOLDS: FanOutThresholds = {
  lowConfidenceThreshold: 0.6,
  planRiskThreshold: 0.5,
  approvalRiskThreshold: 0.8,
  securityReviewThreshold: 0.7,
};

export interface FanOutObserveInfo {
  calls: number;
  reason: string;
  verificationFailed: boolean;
  /** WP5.1: which domain pack Round 1 used (absent when only Round 0 ran). */
  packId?: DomainPackId;
  packSelectReason?: DomainPackSelectReason;
}

export interface FanOutProviderOptions {
  thresholds?: FanOutThresholds;
  /** Optional observer for observability; must never throw. */
  onFanOut?: (info: FanOutObserveInfo) => void;
}

/** Take the smaller of two numeric values, tolerating undefined. */
function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (typeof a !== "number") return typeof b === "number" ? b : undefined;
  if (typeof b !== "number") return a;
  return Math.min(a, b);
}

/** Floor at which Round 1 is trusted to escalate Round 0 signals. */
export const FAN_OUT_CONFIRM_FLOOR = 0.6;

/** Merge rule version (confirmation merge; bump independently of trigger policy). */
export const FAN_OUT_MERGE_VERSION = "2026-09-21.4";

/**
 * Merge two judgments with confirmation rules (live A/B 2026-09-21):
 *
 * - Never lower Round 0 risk / security noul.
 * - Escalate those only when Round 1 is at least `FAN_OUT_CONFIRM_FLOOR` confident.
 * - MIN confidence only when kinds disagree. Agreement (or omitted Round 1 kind
 *   from a slim verify set) keeps Round 0 confidence — MIN-on-every-field was
 *   turning execute into plan_first (unnecessary +1).
 * - Do not import Round 1 `unclear` unless Round 0 already had it or risk rose.
 * - failed: only true if BOTH failed.
 */
export function mergeJudgments(round0: ModelJudgment, round1: ModelJudgment): ModelJudgment {
  const kindDisagrees =
    round0.kind !== undefined && round1.kind !== undefined && round0.kind !== round1.kind;

  const r1Conf =
    typeof round1.riskConfidence === "number" && Number.isFinite(round1.riskConfidence)
      ? round1.riskConfidence
      : 0;
  const confirmed = r1Conf >= FAN_OUT_CONFIRM_FLOOR;

  const r0Risk = typeof round0.riskScore === "number" ? round0.riskScore : 0;
  const r1Risk = typeof round1.riskScore === "number" ? round1.riskScore : 0;
  const riskEscalated = confirmed && r1Risk > r0Risk;

  const riskScore = riskEscalated ? r1Risk : round0.riskScore;
  const riskConfidence = riskEscalated
    ? minDefined(round0.riskConfidence, round1.riskConfidence)
    : round0.riskConfidence;

  const r0Sec = round0.securityReviewNoul ?? 0;
  const r1Sec = round1.securityReviewNoul ?? 0;
  const securityReviewNoul =
    confirmed && r1Sec > r0Sec ? r1Sec : round0.securityReviewNoul;

  const factorSet = new Set<RiskFactor>(round0.riskFactors ?? []);
  if (confirmed) {
    for (const f of round1.riskFactors ?? []) {
      if (f === "unclear" && !(round0.riskFactors ?? []).includes("unclear") && !riskEscalated) {
        continue;
      }
      factorSet.add(f);
    }
  }

  return {
    kind: round0.kind,
    kindConfidence: kindDisagrees
      ? minDefined(round0.kindConfidence, round1.kindConfidence)
      : round0.kindConfidence,
    riskScore,
    riskConfidence,
    riskFactors: factorSet.size ? [...factorSet] : undefined,
    securityReviewNoul,
    failed: round0.failed === true && round1.failed === true ? true : false,
    usage: round0.usage ?? round1.usage,
  };
}

export class FanOutProvider implements BatchDecisionProvider {
  private readonly thresholds: FanOutThresholds;

  constructor(
    private readonly inner: DecisionProvider,
    private readonly options: FanOutProviderOptions = {},
  ) {
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  }

  /**
   * C-5 batch — delegate shared `systemOne` to the inner provider.
   * v1: no fan-out Round 1 on batch chunks (conservative; same as engine batch path).
   */
  async judgeMany(
    inputs: readonly GuardInput[],
    options?: JudgeOptions,
  ): Promise<ModelJudgment[]> {
    if (isBatchDecisionProvider(this.inner)) {
      return this.inner.judgeMany(inputs, options);
    }
    const out: ModelJudgment[] = [];
    for (const input of inputs) {
      out.push(await this.judge(input));
    }
    return out;
  }

  async judge(input: GuardInput): Promise<ModelJudgment> {
    // Round 0 — the only call most assessments ever make (universal base pack).
    const round0 = await this.inner.judge(input);

    const decision = decideFanOut({
      input,
      round0,
      thresholds: this.thresholds,
    });

    if (!decision.allowed) {
      this.safeObserve({ calls: 1, reason: decision.reason, verificationFailed: false });
      return round0;
    }

    // Round 1 — focused domain pack (WP5.1). Budget is 2 total, hard-capped.
    const selection = selectDomainPack({
      input,
      round0,
      fanOutReason: decision.reason,
    });
    const observePack = {
      packId: selection.id,
      packSelectReason: selection.reason,
    };

    let round1: ModelJudgment;
    try {
      round1 = await this.inner.judge(input, {
        pack: selection.pack,
        packId: selection.id,
        questionSet: "verify",
      });
    } catch {
      // A throwing provider is a verification failure, never a pass.
      this.safeObserve({
        calls: 2,
        reason: decision.reason,
        verificationFailed: true,
        ...observePack,
      });
      return { ...round0, verificationFailed: true };
    }

    if (round1.failed === true) {
      // Verification unavailable → escalate, never fail open.
      this.safeObserve({
        calls: 2,
        reason: decision.reason,
        verificationFailed: true,
        ...observePack,
      });
      return { ...round0, verificationFailed: true };
    }

    const merged = mergeJudgments(round0, round1);
    this.safeObserve({
      calls: 2,
      reason: decision.reason,
      verificationFailed: false,
      ...observePack,
    });
    return merged;
  }

  private safeObserve(info: FanOutObserveInfo): void {
    // Defensive: observability must never affect a decision.
    if (info.calls > MAX_PROVIDER_CALLS) {
      // Should be unreachable; never let a bug exceed the budget silently.
      return;
    }
    try {
      this.options.onFanOut?.(info);
    } catch {
      /* never throw into the decision path */
    }
  }
}
