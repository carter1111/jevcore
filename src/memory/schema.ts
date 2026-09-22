/**
 * preferences.sqlite schema — Memory v1 (ledger, not authority).
 */
import type { DatabaseSync } from "node:sqlite";

export const MEMORY_SCHEMA_VERSION = 1;

export const TABLE_META = "memory_metadata";
export const TABLE_PREFERENCE_EVENTS = "preference_events";
export const TABLE_SESSION_GRANTS = "session_grants";
export const TABLE_OVERRIDE_EVENTS = "override_events";
export const TABLE_LEARNED_SUGGESTIONS = "learned_suggestions";
export const TABLE_PROFILE_REVISIONS = "profile_revisions";

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS ${TABLE_META} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${TABLE_PREFERENCE_EVENTS} (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  category TEXT NOT NULL,
  decision_mode TEXT NOT NULL,
  user_action TEXT NOT NULL,
  scope TEXT,
  reason_code TEXT,
  policy_rule_id TEXT,
  session_id TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS ${TABLE_SESSION_GRANTS} (
  grant_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  category TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  policy_rule_id TEXT,
  reason_code TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS ${TABLE_OVERRIDE_EVENTS} (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  policy_rule_id TEXT,
  reason_code TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS ${TABLE_LEARNED_SUGGESTIONS} (
  suggestion_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  current_profile_value TEXT NOT NULL,
  proposed_profile_value TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  confidence_bucket TEXT NOT NULL,
  status TEXT NOT NULL,
  created_from_event_range TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS ${TABLE_PROFILE_REVISIONS} (
  revision INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pref_events_cat ON ${TABLE_PREFERENCE_EVENTS}(category);
CREATE INDEX IF NOT EXISTS idx_pref_events_at ON ${TABLE_PREFERENCE_EVENTS}(occurred_at);
CREATE INDEX IF NOT EXISTS idx_grants_session ON ${TABLE_SESSION_GRANTS}(session_id);
CREATE INDEX IF NOT EXISTS idx_grants_expires ON ${TABLE_SESSION_GRANTS}(expires_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON ${TABLE_LEARNED_SUGGESTIONS}(status);
`;

export function readMemorySchemaVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare(`SELECT value FROM ${TABLE_META} WHERE key = 'schema_version'`)
      .get() as { value?: string } | undefined;
    if (!row?.value) return 0;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Forward-only migrate; idempotent. */
export function migrateMemory(db: DatabaseSync): number {
  const current = readMemorySchemaVersion(db);
  if (current < 1) {
    db.exec(DDL_V1);
  }
  db.prepare(
    `INSERT INTO ${TABLE_META} (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(MEMORY_SCHEMA_VERSION));
  return MEMORY_SCHEMA_VERSION;
}
