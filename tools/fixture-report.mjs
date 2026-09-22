// Fixture-only sample report generator (NOT a test).
// Builds a temporary database with synthetic decisions and prints the report,
// so the redacted output can be reviewed without touching real evidence.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteTelemetrySink } from "../dist/telemetry/sqlite-sink.js";
import { TelemetrySession } from "../dist/telemetry/session.js";
import { buildReport } from "../dist/telemetry/report.js";
import { formatReport } from "../dist/telemetry/format.js";

const dir = mkdtempSync(join(tmpdir(), "jev-fixture-report-"));
const dbPath = join(dir, "telemetry.sqlite");
const sink = new SqliteTelemetrySink({ databasePath: dbPath, flushThreshold: 1 });
const session = TelemetrySession.withSink(sink, dbPath);

/** Synthetic EngineResult shapes covering every reported category. */
const fixtures = [
  { mode: "execute", source: "jev", rules: [], provider: true, risk: 0.02, tokens: [520, 40] },
  { mode: "execute", source: "jev", rules: [], provider: true, risk: 0.05, tokens: [480, 35] },
  { mode: "plan_first", source: "jev", rules: [], provider: true, risk: 0.64, tokens: [610, 55] },
  { mode: "approval_required", source: "hard_policy", rules: ["POL-DB-MIGRATION-1"], provider: true, risk: 0.23, tokens: [700, 60] },
  { mode: "approval_required", source: "hard_policy", rules: ["POL-DB-DEPLOY-UNKNOWN-1"], provider: true, risk: 0.69, tokens: [690, 58] },
  { mode: "approval_required", source: "hard_policy", rules: ["POL-AUTHZ-1"], provider: true, risk: 0.58, tokens: [640, 52] },
  { mode: "approval_required", source: "hard_policy", rules: ["POL-WEB3-ASSET-1"], provider: true, risk: 0.67, tokens: [720, 66] },
  { mode: "block", source: "hard_policy", rules: ["POL-SECRETS-1"], provider: false, risk: 1 },
  { mode: "block", source: "hard_policy", rules: ["POL-SECRETS-1"], provider: false, risk: 1 },
  { mode: "block", source: "hard_policy", rules: ["POL-DESTRUCTIVE-CMD-1"], provider: false, risk: 1 },
  { mode: "block", source: "hard_policy", rules: ["POL-DB-DESTRUCTIVE-1"], provider: false, risk: 1 },
  { mode: "block", source: "hard_policy", rules: ["POL-DB-PROD-1"], provider: false, risk: 1 },
];

for (const f of fixtures) {
  if (f.provider) {
    session.recordProviderCall({
      attempted: true,
      succeeded: true,
      failed: false,
      latencyMs: 800 + Math.round(Math.random() * 500),
      inputTokens: f.tokens?.[0],
      outputTokens: f.tokens?.[1],
    });
  }
  const result = {
    classification: { kind: "backend", confidence: 0.9, source: f.source },
    risk: { score: f.risk, confidence: 0.9, factors: [] },
    security: { reviewNeeded: f.rules.some((r) => r.includes("AUTHZ") || r.includes("WEB3")), noul: 0.1, findings: [] },
    mode: f.mode,
    reasons: [
      ...f.rules.map((code) => ({ code, detail: "fixture" })),
      ...(f.provider ? [] : [{ code: "PREFLIGHT-BLOCK", detail: "fixture" }]),
    ],
    fellBack: false,
  };
  session.recordDecision(result, "jev_assess_task", 8 + Math.round(Math.random() * 25));
}

await sink.close();

const db = new DatabaseSync(dbPath, { readOnly: true });
const model = buildReport(db, {
  period: "7d",
  databasePath: dbPath,
  advisoryBytes: 50 * 1024 * 1024,
  telemetryWriteErrors: 0,
});
console.log(formatReport(model));
db.close();
rmSync(dir, { recursive: true, force: true });
