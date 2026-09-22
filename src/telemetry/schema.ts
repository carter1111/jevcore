/**
 * Local Guard Evidence — schema definition and forward-only migrations.
 *
 * The schema stores de-identified metadata only. There is deliberately no
 * column for task text, command text, diff content, paths, repository identity,
 * secrets, content hashes, or raw provider payloads.
 */
import type { DatabaseSync } from "node:sqlite";

/** Current schema version. Increment and add a migration step when changing. */
export const SCHEMA_VERSION = 2;

export const TABLE_DECISIONS = "decisions";
export const TABLE_POLICY_RULES = "decision_policy_rules";
export const TABLE_SCHEMA_META = "schema_meta";

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS ${TABLE_DECISIONS} (
  decision_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  tool TEXT NOT NULL,
  source TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  task_domain TEXT NOT NULL,
  risk_score REAL NOT NULL,
  confidence REAL NOT NULL,
  requires_security_review INTEGER NOT NULL,
  provider_call_attempted INTEGER NOT NULL,
  provider_call_succeeded INTEGER NOT NULL,
  provider_failed INTEGER NOT NULL,
  fell_back INTEGER NOT NULL,
  failure_code TEXT,
  guard_latency_ms INTEGER,
  provider_latency_ms INTEGER,
  jev_input_tokens INTEGER,
  jev_output_tokens INTEGER,
  guard_version TEXT NOT NULL,
  policy_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${TABLE_POLICY_RULES} (
  decision_id TEXT NOT NULL,
  policy_rule_id TEXT NOT NULL,
  PRIMARY KEY (decision_id, policy_rule_id),
  FOREIGN KEY (decision_id) REFERENCES ${TABLE_DECISIONS}(decision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ${TABLE_SCHEMA_META} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_occurred_at ON ${TABLE_DECISIONS}(occurred_at);
CREATE INDEX IF NOT EXISTS idx_decisions_mode ON ${TABLE_DECISIONS}(execution_mode);
CREATE INDEX IF NOT EXISTS idx_decisions_source ON ${TABLE_DECISIONS}(source);
CREATE INDEX IF NOT EXISTS idx_policy_rules_rule ON ${TABLE_POLICY_RULES}(policy_rule_id);
`;

/** Read the recorded schema version (0 when the DB is brand new). */
export function readSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare(`SELECT value FROM ${TABLE_SCHEMA_META} WHERE key = 'schema_version'`)
      .get() as { value?: string } | undefined;
    if (!row?.value) return 0;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // Table does not exist yet on a brand-new database.
    return 0;
  }
}

/**
 * Apply forward-only migrations to reach `SCHEMA_VERSION`.
 *
 * Idempotent: safe to run on every startup. Returns the resulting version.
 */
export function migrate(db: DatabaseSync): number {
  const current = readSchemaVersion(db);

  if (current < 1) {
    db.exec(DDL_V1);
  }

  if (current < 2) {
    db.exec(`
      ALTER TABLE ${TABLE_DECISIONS} ADD COLUMN batch_id TEXT;
      ALTER TABLE ${TABLE_DECISIONS} ADD COLUMN batch_size INTEGER;
      ALTER TABLE ${TABLE_DECISIONS} ADD COLUMN batch_strategy TEXT;
    `);
  }

  db.prepare(
    `INSERT INTO ${TABLE_SCHEMA_META} (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));

  return SCHEMA_VERSION;
}
