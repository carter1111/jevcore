/**
 * Local Guard Evidence — instrumented provider decorator.
 *
 * Telemetry is attached at the `DecisionProvider` seam (documented in
 * `architecture.md` §6.4 as the primary extension point) rather than inside the
 * engine. This keeps `engine.ts` and `policy.ts` completely untouched, which is
 * what preserves the existing test suite's validity.
 *
 * The decorator observes:
 *   - whether a provider call was attempted / succeeded / failed
 *   - provider latency
 *   - token usage reported by the SDK
 *
 * It never alters the judgment it returns.
 */
import type {
  BatchDecisionProvider,
  DecisionProvider,
  GuardInput,
  JudgeOptions,
  ModelJudgment,
} from "../types.js";
import { isBatchDecisionProvider } from "../types.js";
import type { ProviderCallRecord } from "./types.js";

export interface ProviderCallObserver {
  /** Called once per provider invocation. Must never throw. */
  observe(record: ProviderCallRecord): void;
}

export class InstrumentedProvider implements BatchDecisionProvider {
  constructor(
    private readonly inner: DecisionProvider,
    private readonly observer: ProviderCallObserver,
  ) {}

  async judgeMany(
    inputs: readonly GuardInput[],
    options?: JudgeOptions,
  ): Promise<ModelJudgment[]> {
    const startedAt = performance.now();
    try {
      const inner = this.inner;
      const judgments = isBatchDecisionProvider(inner)
        ? await inner.judgeMany(inputs, options)
        : await Promise.all(inputs.map((input) => this.judge(input, options)));
      const failed = judgments.some((j) => j.failed === true);
      const usage = judgments.reduce(
        (acc, j) => ({
          inputTokens: (acc.inputTokens ?? 0) + (j.usage?.inputTokens ?? 0),
          outputTokens: (acc.outputTokens ?? 0) + (j.usage?.outputTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 },
      );
      this.safeObserve({
        attempted: true,
        succeeded: !failed,
        failed,
        latencyMs: elapsed(startedAt),
        inputTokens: usage.inputTokens || undefined,
        outputTokens: usage.outputTokens || undefined,
      });
      return judgments;
    } catch {
      this.safeObserve({
        attempted: true,
        succeeded: false,
        failed: true,
        latencyMs: elapsed(startedAt),
        inputTokens: undefined,
        outputTokens: undefined,
      });
      return inputs.map(() => ({ failed: true }));
    }
  }

  async judge(input: GuardInput, options?: JudgeOptions): Promise<ModelJudgment> {
    const startedAt = performance.now();
    let judgment: ModelJudgment;
    try {
      judgment = await this.inner.judge(input, options);
    } catch {
      // Defensive: a provider that throws is still observed as a failure, and
      // the same failure shape is returned so behavior is unchanged.
      this.safeObserve({
        attempted: true,
        succeeded: false,
        failed: true,
        latencyMs: elapsed(startedAt),
        inputTokens: undefined,
        outputTokens: undefined,
      });
      return { failed: true };
    }

    const failed = judgment.failed === true;
    this.safeObserve({
      attempted: true,
      succeeded: !failed,
      failed,
      latencyMs: elapsed(startedAt),
      inputTokens: judgment.usage?.inputTokens,
      outputTokens: judgment.usage?.outputTokens,
    });
    return judgment;
  }

  private safeObserve(record: ProviderCallRecord): void {
    try {
      this.observer.observe(record);
    } catch {
      // Telemetry must never affect a decision.
    }
  }
}

function elapsed(startedAt: number): number | undefined {
  const ms = performance.now() - startedAt;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : undefined;
}
