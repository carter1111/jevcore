/**
 * Local Guard Evidence — SQLite sink.
 *
 * DESIGN CONSTRAINTS (all mandatory):
 *
 * - **Lazy + asynchronous initialization.** `node:sqlite` is imported and the
 *   database opened on a deferred tick, never during module import and never on
 *   the MCP response path. Storage init cannot delay or alter a decision.
 * - **Non-throwing.** Every public method swallows its own errors. Telemetry can
 *   never change a decision, trigger a provider call, or produce MCP -32603.
 * - **Enqueue-only recording.** `recordDecision` is synchronous and only pushes
 *   to an in-memory array.
 * - **Batch flush.** Flushes after 10 queued events or 1 second, whichever first.
 * - **Never unlink storage.** Maintenance deletes rows, never files.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { migrate } from "./schema.js";
import type { DecisionEvent, TelemetrySink } from "./types.js";
import { TABLE_DECISIONS, TABLE_POLICY_RULES } from "./schema.js";

/** Flush when this many events are queued. */
export const FLUSH_EVENT_THRESHOLD = 10;
/** Flush at least this often, in ms. */
export const FLUSH_INTERVAL_MS = 1_000;
/** SQLite busy timeout in ms. */
export const BUSY_TIMEOUT_MS = 5_000;

export interface SqliteSinkOptions {
  databasePath: string;
  /** Override flush thresholds (tests). */
  flushThreshold?: number;
  flushIntervalMs?: number;
  /** Override the DB opener (tests / fault injection). */
  openDatabase?: (path: string) => DatabaseSync;
}

export class SqliteTelemetrySink implements TelemetrySink {
  readonly enabled = true;

  private readonly dbPath: string;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private readonly openDatabase: (path: string) => DatabaseSync;

  private queue: DecisionEvent[] = [];
  private db: DatabaseSync | undefined;
  private timer: NodeJS.Timeout | undefined;
  private initPromise: Promise<void> | undefined;
  /** The in-flight flush, so `close()` can await it instead of racing it. */
  private inFlightFlush: Promise<void> | undefined;
  private closed = false;
  private writeErrors = 0;

  constructor(options: SqliteSinkOptions) {
    this.dbPath = options.databasePath;
    this.flushThreshold = options.flushThreshold ?? FLUSH_EVENT_THRESHOLD;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.openDatabase = options.openDatabase ?? defaultOpenDatabase;
  }

  /**
   * Enqueue one event. Synchronous, enqueue-only, never throws.
   * Storage initialization is kicked off asynchronously and is NOT awaited.
   */
  recordDecision(event: DecisionEvent): void {
    if (this.closed) return;
    try {
      this.queue.push(event);
      this.ensureInitStarted();
      if (this.queue.length >= this.flushThreshold) {
        void this.flush();
      } else {
        this.ensureTimer();
      }
    } catch {
      this.noteWriteError();
    }
  }

  noteWriteError(): void {
    this.writeErrors += 1;
  }

  writeErrorCount(): number {
    return this.writeErrors;
  }

  /**
   * Flush queued events to SQLite. Never throws.
   * Concurrent callers share the in-flight flush rather than racing it.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.inFlightFlush !== undefined) return this.inFlightFlush;
    this.inFlightFlush = this.doFlush().finally(() => {
      this.inFlightFlush = undefined;
    });
    return this.inFlightFlush;
  }

  private async doFlush(): Promise<void> {
    try {
      await this.ensureInitialized();
      const batch = this.queue.splice(0, this.queue.length);
      if (this.db && batch.length > 0) this.writeBatch(this.db, batch);
    } catch {
      this.noteWriteError();
    }
  }

  /**
   * Flush remaining events and release resources. Never throws.
   * Waits for any in-flight flush, then drains whatever is still queued, so a
   * short-lived process cannot silently drop its final batch.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.clearTimer();
      // Await any flush already running, then drain the remainder.
      if (this.inFlightFlush !== undefined) await this.inFlightFlush;
      if (this.queue.length > 0) await this.flush();
    } catch {
      this.noteWriteError();
    } finally {
      this.closed = true;
      try {
        this.db?.close();
      } catch {
        /* ignore */
      }
      this.db = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private ensureInitStarted(): void {
    if (this.initPromise === undefined) this.initPromise = this.initialize();
  }

  private async ensureInitialized(): Promise<void> {
    this.ensureInitStarted();
    await this.initPromise;
  }

  /**
   * Open + migrate on a deferred tick so that the first MCP decision is never
   * delayed by storage setup.
   */
  private async initialize(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const dir = dirname(this.dbPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdirSync's mode is masked by the umask, so enforce it explicitly.
      chmodSync(dir, 0o700);
      const db = this.openDatabase(this.dbPath);
      // SQLite creates the file with the umask-derived mode (typically 0644);
      // the evidence database must be owner-only.
      chmodSync(this.dbPath, 0o600);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA foreign_keys=ON");
      migrate(db);
      this.db = db;
    } catch {
      this.noteWriteError();
      this.db = undefined;
    }
  }

  private writeBatch(db: DatabaseSync, batch: DecisionEvent[]): void {
    const insertDecision = db.prepare(
      `INSERT OR IGNORE INTO ${TABLE_DECISIONS} (
        decision_id, occurred_at, tool, source, execution_mode, task_domain,
        risk_score, confidence, requires_security_review,
        provider_call_attempted, provider_call_succeeded, provider_failed,
        fell_back, failure_code, guard_latency_ms, provider_latency_ms,
        jev_input_tokens, jev_output_tokens, guard_version, policy_version,
        batch_id, batch_size, batch_strategy
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertRule = db.prepare(
      `INSERT OR IGNORE INTO ${TABLE_POLICY_RULES} (decision_id, policy_rule_id) VALUES (?,?)`,
    );

    db.exec("BEGIN");
    try {
      for (const e of batch) {
        insertDecision.run(
          e.decisionId,
          e.occurredAt,
          e.tool,
          e.source,
          e.executionMode,
          e.taskDomain,
          e.riskScore,
          e.confidence,
          e.requiresSecurityReview ? 1 : 0,
          e.providerCallAttempted ? 1 : 0,
          e.providerCallSucceeded ? 1 : 0,
          e.providerFailed ? 1 : 0,
          e.fellBack ? 1 : 0,
          e.failureCode ?? null,
          e.guardLatencyMs ?? null,
          e.providerLatencyMs ?? null,
          e.jevInputTokens ?? null,
          e.jevOutputTokens ?? null,
          e.guardVersion,
          e.policyVersion,
          e.batchId ?? null,
          e.batchSize ?? null,
          e.batchStrategy ?? null,
        );
        for (const ruleId of e.policyRuleIds) insertRule.run(e.decisionId, ruleId);
      }
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      this.noteWriteError();
    }
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // Do not keep the process alive solely for telemetry.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Default opener. `node:sqlite` is imported lazily so that a disabled-mode
 * process never loads the SQLite module at all.
 *
 * A static `import` would load SQLite at module-evaluation time, which would
 * break the "disabled mode is structurally inert" guarantee. `createRequire`
 * is used because this package is ESM (`"type": "module"`).
 */
const require = createRequire(import.meta.url);

function defaultOpenDatabase(path: string): DatabaseSync {
  const mod = require("node:sqlite") as typeof import("node:sqlite");
  return new mod.DatabaseSync(path);
}
