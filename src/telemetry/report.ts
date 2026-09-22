/**
 * Local Guard Evidence — report aggregation.
 *
 * Read-only. Never calls TypeSafe. Never returns raw stored payloads — only
 * aggregates over de-identified metadata.
 */
import { statSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describePricing, estimateCostUsd, type JevPriceEntry } from "./pricing.js";
import { TABLE_DECISIONS, TABLE_POLICY_RULES } from "./schema.js";

export type ReportPeriod = "7d" | "14d" | "30d" | "all";

export const REPORT_PERIODS: readonly ReportPeriod[] = ["7d", "14d", "30d", "all"] as const;

export interface ReportModel {
  period: ReportPeriod;
  sinceIso: string | null;
  /** Decision activity */
  guardDecisions: number;
  jevProviderCalls: number;
  hardPolicyShortCircuits: number;
  /** Workflow outcomes */
  outcomes: Record<string, number>;
  /** Safety actions keyed by policy rule id */
  safetyActions: Record<string, number>;
  /** Reliability */
  hardBlocksWithProviderCalls: number;
  providerFallbacks: number;
  boundaryFallbacks: number;
  /** Performance */
  guardP50Ms: number | null;
  guardP95Ms: number | null;
  providerP50Ms: number | null;
  providerP95Ms: number | null;
  /** Jev usage */
  jevInputTokens: number;
  jevOutputTokens: number;
  estimatedCostUsd: number;
  pricingBasis: string;
  /** Storage */
  decisionsStored: number;
  dateRange: { from: string | null; to: string | null };
  databaseBytes: number | null;
  advisoryBytes: number;
  storageAdvisory: "ok" | "exceeded";
  /** Diagnostics */
  telemetryWriteErrors: number;
  totalAgentTokenSavings: "not_enough_controlled_evidence";
}

/** ISO timestamp for the start of a period, or null for `all`. */
export function periodStartIso(period: ReportPeriod, now: Date = new Date()): string | null {
  if (period === "all") return null;
  const days = period === "7d" ? 7 : period === "14d" ? 14 : 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

/**
 * Build the report model from the database. Read-only.
 * Throws only if the DB itself is unusable — the caller decides how to surface
 * that (the MCP tool returns a structured "unavailable" message).
 */
export function buildReport(
  db: DatabaseSync,
  options: {
    period: ReportPeriod;
    databasePath: string;
    advisoryBytes: number;
    telemetryWriteErrors: number;
    priceEntry?: JevPriceEntry;
  },
): ReportModel {
  const since = periodStartIso(options.period);
  const where = since ? "WHERE occurred_at >= ?" : "";
  const params: SQLInputValue[] = since ? [since] : [];

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(provider_call_attempted) AS attempted,
         SUM(provider_call_succeeded) AS succeeded,
         SUM(fell_back) AS fell_back,
         SUM(CASE WHEN provider_call_attempted = 0 AND source = 'hard_policy' THEN 1 ELSE 0 END) AS short_circuits,
         SUM(CASE WHEN execution_mode = 'block' AND provider_call_attempted = 1 THEN 1 ELSE 0 END) AS hard_block_with_calls,
         SUM(COALESCE(jev_input_tokens, 0)) AS in_tokens,
         SUM(COALESCE(jev_output_tokens, 0)) AS out_tokens
       FROM ${TABLE_DECISIONS} ${where}`,
    )
    .get(...params) as Record<string, number | null>;

  const outcomes = rowsToCounts(
    db
      .prepare(`SELECT execution_mode AS k, COUNT(*) AS n FROM ${TABLE_DECISIONS} ${where} GROUP BY execution_mode`)
      .all(...params),
  );

  const safetyActions = rowsToCounts(
    db
      .prepare(
        `SELECT r.policy_rule_id AS k, COUNT(*) AS n
         FROM ${TABLE_POLICY_RULES} r
         JOIN ${TABLE_DECISIONS} d ON d.decision_id = r.decision_id
         ${since ? "WHERE d.occurred_at >= ?" : ""}
         GROUP BY r.policy_rule_id`,
      )
      .all(...params),
  );

  const guardP50 = percentile(db, "guard_latency_ms", 0.5, where, params);
  const guardP95 = percentile(db, "guard_latency_ms", 0.95, where, params);
  const providerP50 = percentile(db, "provider_latency_ms", 0.5, where, params);
  const providerP95 = percentile(db, "provider_latency_ms", 0.95, where, params);

  const range = db
    .prepare(`SELECT MIN(occurred_at) AS from_ts, MAX(occurred_at) AS to_ts FROM ${TABLE_DECISIONS} ${where}`)
    .get(...params) as { from_ts: string | null; to_ts: string | null };

  const storedTotal = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_DECISIONS}`).get() as { n: number };

  const inputTokens = num(totals?.in_tokens);
  const outputTokens = num(totals?.out_tokens);

  let databaseBytes: number | null = null;
  try {
    databaseBytes = statSync(options.databasePath).size;
  } catch {
    databaseBytes = null;
  }

  return {
    period: options.period,
    sinceIso: since,
    guardDecisions: num(totals?.total),
    jevProviderCalls: num(totals?.attempted),
    hardPolicyShortCircuits: num(totals?.short_circuits),
    outcomes,
    safetyActions,
    hardBlocksWithProviderCalls: num(totals?.hard_block_with_calls),
    providerFallbacks: num(totals?.fell_back),
    boundaryFallbacks: countBoundaryFallbacks(db, where, params),
    guardP50Ms: guardP50,
    guardP95Ms: guardP95,
    providerP50Ms: providerP50,
    providerP95Ms: providerP95,
    jevInputTokens: inputTokens,
    jevOutputTokens: outputTokens,
    estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens, options.priceEntry),
    pricingBasis: describePricing(options.priceEntry),
    decisionsStored: storedTotal?.n ?? 0,
    dateRange: { from: range?.from_ts ?? null, to: range?.to_ts ?? null },
    databaseBytes,
    advisoryBytes: options.advisoryBytes,
    storageAdvisory:
      databaseBytes !== null && databaseBytes > options.advisoryBytes ? "exceeded" : "ok",
    telemetryWriteErrors: options.telemetryWriteErrors,
    totalAgentTokenSavings: "not_enough_controlled_evidence",
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rowsToCounts(rows: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const r = row as { k?: string | null; n?: number };
    if (typeof r.k === "string") out[r.k] = num(r.n);
  }
  return out;
}

/** Nearest-rank percentile over non-null latency values. */
function percentile(
  db: DatabaseSync,
  column: string,
  fraction: number,
  where: string,
  params: SQLInputValue[],
): number | null {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${TABLE_DECISIONS} ${where ? `${where} AND` : "WHERE"} ${column} IS NOT NULL`,
    )
    .get(...params) as { n: number };
  const n = num(row?.n);
  if (n === 0) return null;

  const offset = Math.min(n - 1, Math.max(0, Math.ceil(fraction * n) - 1));
  const hit = db
    .prepare(
      `SELECT ${column} AS v FROM ${TABLE_DECISIONS} ${where ? `${where} AND` : "WHERE"} ${column} IS NOT NULL
       ORDER BY ${column} ASC LIMIT 1 OFFSET ?`,
    )
    .get(...params, offset) as { v: number | null };
  return typeof hit?.v === "number" ? hit.v : null;
}

/**
 * Boundary fallbacks are decisions that were replaced by the MCP boundary
 * fallback. They are identified by their failure code, not by stored text.
 */
function countBoundaryFallbacks(db: DatabaseSync, where: string, params: SQLInputValue[]): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${TABLE_DECISIONS}
       ${where ? `${where} AND` : "WHERE"} failure_code = 'MCP-INVALID-DECISION-OUTPUT'`,
    )
    .get(...params) as { n: number };
  return num(row?.n);
}
