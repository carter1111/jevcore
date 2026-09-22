/**
 * Local Guard Evidence — session wiring.
 *
 * Owns the sink lifecycle and converts an `EngineResult` into a persisted
 * `DecisionEvent`. This is the ONLY module that knows how a decision maps onto
 * stored metadata, so the privacy rules live in one reviewable place.
 *
 * INVARIANTS:
 * - Disabled mode returns a session backed by `NoopTelemetrySink` and never
 *   touches the home directory, the filesystem, or SQLite.
 * - Recording never throws and never blocks the MCP response path.
 * - No field derived from task/command/diff/prompt content is ever recorded.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { EngineResult } from "../engine.js";
import { isEvidenceEnabled, resolveTelemetryConfig, EVIDENCE_LOCK_NAME } from "./config.js";
import { dirname, join } from "node:path";
import { NOOP_TELEMETRY_SINK } from "./noop-sink.js";
import { SqliteTelemetrySink } from "./sqlite-sink.js";
import type {
  BatchEvidenceContext,
  DecisionEvent,
  DecisionTool,
  FailureCode,
  ProviderCallRecord,
  TelemetrySink,
} from "./types.js";
import { FAILURE_CODES } from "./types.js";

/** Guard version recorded with each event. */
export const GUARD_VERSION = "0.1.0";
/** Policy version recorded with each event. Bump when DEFAULT_POLICY changes. */
export const POLICY_VERSION = "2026-09-21.c1";

/** Narrow a reason code to the closed failure-code union, or undefined. */
function toFailureCode(reasons: Array<{ code: string }>): FailureCode | undefined {
  for (const reason of reasons) {
    const match = FAILURE_CODES.find((code) => code === reason.code);
    if (match) return match;
  }
  return undefined;
}

export class TelemetrySession {
  private readonly sink: TelemetrySink;
  private lastProviderCall: ProviderCallRecord | undefined;
  private readonly databasePath: string;
  /** Retained for report assembly by the MCP tool. */
  readonly advisoryBytes: number;

  private constructor(sink: TelemetrySink, databasePath: string, advisoryBytes: number) {
    this.sink = sink;
    this.databasePath = databasePath;
    this.advisoryBytes = advisoryBytes;
  }

  /** Build the session from the environment. Never throws. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TelemetrySession {
    try {
      const config = resolveTelemetryConfig(env);
      if (!config.enabled) {
        // Disabled: no path resolved, no artifact, no SQLite module load.
        return new TelemetrySession(NOOP_TELEMETRY_SINK, "", config.advisoryBytes);
      }
      const sink = new SqliteTelemetrySink({ databasePath: config.databasePath });
      return new TelemetrySession(sink, config.databasePath, config.advisoryBytes);
    } catch {
      return new TelemetrySession(NOOP_TELEMETRY_SINK, "", 50 * 1024 * 1024);
    }
  }

  /** Build a session around an injected sink (tests). */
  static withSink(sink: TelemetrySink, databasePath: string, advisoryBytes = 50 * 1024 * 1024): TelemetrySession {
    return new TelemetrySession(sink, databasePath, advisoryBytes);
  }

  get enabled(): boolean {
    return this.sink.enabled;
  }

  get dbPath(): string {
    return this.databasePath;
  }

  /** Path to the advisory maintenance lock (only meaningful when enabled). */
  lockPath(): string {
    return this.databasePath ? join(dirname(this.databasePath), EVIDENCE_LOCK_NAME) : "";
  }

  /** Record an observed provider call. Never throws. */
  recordProviderCall(record: ProviderCallRecord): void {
    if (!this.enabled) return;
    // WP5: a decision may make up to two provider calls (fan-out). Aggregate
    // them with "any-call" semantics so the first call's observation is not
    // lost by the second. Aggregation is conservative: any success counts as
    // success, any failure counts as failure, latency is summed, tokens summed.
    const prev = this.lastProviderCall;
    if (!prev) {
      this.lastProviderCall = { ...record };
      return;
    }
    this.lastProviderCall = {
      attempted: prev.attempted || record.attempted,
      succeeded: prev.succeeded || record.succeeded,
      failed: prev.failed || record.failed,
      latencyMs:
        prev.latencyMs === undefined && record.latencyMs === undefined
          ? undefined
          : (prev.latencyMs ?? 0) + (record.latencyMs ?? 0),
      inputTokens:
        prev.inputTokens === undefined && record.inputTokens === undefined
          ? undefined
          : (prev.inputTokens ?? 0) + (record.inputTokens ?? 0),
      outputTokens:
        prev.outputTokens === undefined && record.outputTokens === undefined
          ? undefined
          : (prev.outputTokens ?? 0) + (record.outputTokens ?? 0),
    };
  }

  /**
   * Record one decision. Synchronous, enqueue-only, never throws.
   * The `input` parameter is accepted but NEVER read — no content is persisted.
   */
  recordDecision(
    result: EngineResult,
    tool: DecisionTool,
    guardLatencyMs: number | undefined,
    batch?: BatchEvidenceContext,
  ): void {
    if (!this.enabled) return;
    try {
      const provider = this.lastProviderCall;
      this.lastProviderCall = undefined;

      const event: DecisionEvent = {
        decisionId: randomUUID(),
        occurredAt: new Date().toISOString(),
        tool,
        source: result.classification.source,
        executionMode: result.mode,
        taskDomain: result.classification.kind,
        riskScore: result.risk.score,
        confidence: Math.min(result.classification.confidence, result.risk.confidence),
        requiresSecurityReview: result.security.reviewNeeded,
        providerCallAttempted: provider?.attempted ?? false,
        providerCallSucceeded: provider?.succeeded ?? false,
        providerFailed: provider?.failed ?? false,
        fellBack: result.fellBack,
        failureCode: toFailureCode(result.reasons),
        guardLatencyMs,
        providerLatencyMs: provider?.latencyMs,
        jevInputTokens: provider?.inputTokens,
        jevOutputTokens: provider?.outputTokens,
        guardVersion: GUARD_VERSION,
        policyVersion: POLICY_VERSION,
        policyRuleIds: result.reasons
          .filter((r: { code: string }) => r.code.startsWith("POL-"))
          .map((r: { code: string }) => r.code),
        ...(batch
          ? {
              batchId: batch.batchId,
              batchSize: batch.batchSize,
              batchStrategy: batch.strategy,
            }
          : {}),
      };
      this.sink.recordDecision(event);
    } catch {
      this.sink.noteWriteError();
    }
  }

  writeErrorCount(): number {
    try {
      return this.sink.writeErrorCount();
    } catch {
      return 0;
    }
  }

  async flush(): Promise<void> {
    try {
      await this.sink.flush();
    } catch {
      /* never throws */
    }
  }

  async close(): Promise<void> {
    try {
      await this.sink.close();
    } catch {
      /* never throws */
    }
  }
}

/** Monotonic millisecond timer helper. */
export function startTimer(): () => number {
  const t0 = performance.now();
  return () => Math.max(0, Math.round(performance.now() - t0));
}

/** True when the evidence directory exists (used by CLI status). */
export function evidenceEnabledInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEvidenceEnabled(env);
}

/** Read the schema version recorded in the database, or null. */
export function readRecordedSchemaVersion(databasePath: string): number | null {
  try {
    // Read-only probe via the module, opened and closed immediately.
    // Two-step resolution: the chained form throws
    // `TypeError: Cannot call constructor without 'new'`.
    const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      const n = Number.parseInt(row?.value ?? "", 10);
      return Number.isFinite(n) ? n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Best-effort read of the guard version file, for CLI display. */
export function readGuardVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? GUARD_VERSION;
  } catch {
    return GUARD_VERSION;
  }
}
