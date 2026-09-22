/**
 * Preferences Memory store — preferences.sqlite.
 *
 * INVARIANTS:
 * - Ledger only: never authorizes execution (T07 resolver reads grants; suggestions never grant).
 * - Never stores task/command/diff/prompt/repo/secrets (privacy.ts).
 * - Session grants require expires_at; expired grants are inactive.
 * - Learned suggestions: record accept/dismiss/snooze only — never auto-widen profile here.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { resolvePreferencesDbPath } from "./paths.js";
import {
  assertNoForbiddenKeys,
  assertNoCredentialMaterial,
  assertSafeCategory,
  assertSafeId,
  assertSafeProfileJson,
  MemoryPrivacyError,
} from "./privacy.js";
import {
  migrateMemory,
  MEMORY_SCHEMA_VERSION,
  TABLE_LEARNED_SUGGESTIONS,
  TABLE_OVERRIDE_EVENTS,
  TABLE_PREFERENCE_EVENTS,
  TABLE_PROFILE_REVISIONS,
  TABLE_SESSION_GRANTS,
} from "./schema.js";
import type {
  GrantScope,
  LearnedSuggestionRecord,
  OverrideEventRecord,
  PreferenceEventRecord,
  PreferenceUserAction,
  ProfileRevisionRecord,
  ProfileRevisionSource,
  SessionGrantRecord,
  SuggestionStatus,
  ConfidenceBucket,
} from "./types.js";

export interface PreferencesMemoryOptions {
  databasePath?: string;
  openDatabase?: (path: string) => DatabaseSync;
  /** Clock override for tests (ISO strings / Date). */
  now?: () => Date;
}

export interface CreateGrantInput {
  sessionId: string;
  category: string;
  scope: GrantScope;
  /** Required — session grants must expire. */
  expiresAt: string;
  policyRuleId?: string;
  reasonCode?: string;
  grantId?: string;
  createdAt?: string;
}

export interface CreatePreferenceEventInput {
  category: string;
  decisionMode: string;
  userAction: PreferenceUserAction;
  profileRevision?: number;
  scope?: GrantScope | "profile";
  reasonCode?: string;
  policyRuleId?: string;
  sessionId?: string;
  expiresAt?: string;
  eventId?: string;
  occurredAt?: string;
}

export interface CreateOverrideInput {
  category: string;
  action: PreferenceUserAction;
  policyRuleId?: string;
  reasonCode?: string;
  sessionId?: string;
  eventId?: string;
  occurredAt?: string;
}

export interface CreateSuggestionInput {
  category: string;
  currentProfileValue: string;
  proposedProfileValue: string;
  evidenceCount: number;
  confidenceBucket: ConfidenceBucket;
  createdFromEventRange?: string;
  suggestionId?: string;
  createdAt?: string;
}

export interface CreateRevisionInput {
  profileJson: string;
  summary: string;
  source: ProfileRevisionSource;
  revision?: number;
  createdAt?: string;
}

function defaultOpenDatabase(path: string): DatabaseSync {
  const require = createRequire(import.meta.url);
  const mod = require("node:sqlite") as typeof import("node:sqlite");
  return new mod.DatabaseSync(path);
}

function iso(d: Date): string {
  return d.toISOString();
}

export class PreferencesMemory {
  private readonly dbPath: string;
  private readonly openDatabase: (path: string) => DatabaseSync;
  private readonly now: () => Date;
  private db: DatabaseSync | undefined;
  private closed = false;

  constructor(options: PreferencesMemoryOptions = {}) {
    this.dbPath = options.databasePath ?? resolvePreferencesDbPath();
    this.openDatabase = options.openDatabase ?? defaultOpenDatabase;
    this.now = options.now ?? (() => new Date());
  }

  get databasePath(): string {
    return this.dbPath;
  }

  /** Open (or reuse) DB, migrate, chmod 0600. */
  open(): void {
    if (this.closed) throw new Error("PreferencesMemory is closed");
    if (this.db) return;
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(this.dbPath), 0o700);
    } catch {
      /* best-effort */
    }
    this.db = this.openDatabase(this.dbPath);
    migrateMemory(this.db);
    try {
      chmodSync(this.dbPath, 0o600);
    } catch {
      /* best-effort on platforms that ignore */
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = undefined;
    }
    this.closed = true;
  }

  schemaVersion(): number {
    this.ensureOpen();
    return MEMORY_SCHEMA_VERSION;
  }

  // ---- Grants ------------------------------------------------------------------

  recordGrant(input: CreateGrantInput): SessionGrantRecord {
    this.ensureOpen();
    assertNoForbiddenKeys(input);
    assertSafeCategory(input.category);
    assertSafeId(input.sessionId, "sessionId");
    assertSafeId(input.policyRuleId, "policyRuleId");
    assertSafeId(input.reasonCode, "reasonCode");
    if (input.scope !== "once" && input.scope !== "session") {
      throw new MemoryPrivacyError("grant scope must be once|session");
    }
    if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) {
      throw new MemoryPrivacyError("expiresAt is required and must be ISO datetime");
    }
    const record: SessionGrantRecord = {
      grantId: input.grantId ?? randomUUID(),
      createdAt: input.createdAt ?? iso(this.now()),
      sessionId: input.sessionId,
      category: input.category,
      scope: input.scope,
      expiresAt: input.expiresAt,
      policyRuleId: input.policyRuleId,
      reasonCode: input.reasonCode,
    };
    this.db!.prepare(
      `INSERT INTO ${TABLE_SESSION_GRANTS}
        (grant_id, created_at, session_id, category, scope, expires_at, policy_rule_id, reason_code, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      record.grantId,
      record.createdAt,
      record.sessionId,
      record.category,
      record.scope,
      record.expiresAt,
      record.policyRuleId ?? null,
      record.reasonCode ?? null,
    );
    return record;
  }

  /** Active = not revoked and expires_at > now. */
  listActiveGrants(sessionId: string, at?: Date): SessionGrantRecord[] {
    this.ensureOpen();
    assertSafeId(sessionId, "sessionId");
    const when = iso(at ?? this.now());
    const rows = this.db!
      .prepare(
        `SELECT * FROM ${TABLE_SESSION_GRANTS}
         WHERE session_id = ?
           AND revoked_at IS NULL
           AND expires_at > ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId, when) as Array<Record<string, unknown>>;
    return rows.map(rowToGrant);
  }

  revokeGrant(grantId: string, at?: Date): boolean {
    this.ensureOpen();
    assertSafeId(grantId, "grantId");
    const info = this.db!
      .prepare(
        `UPDATE ${TABLE_SESSION_GRANTS} SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`,
      )
      .run(iso(at ?? this.now()), grantId);
    return Number(info.changes) > 0;
  }

  // ---- Preference / override events -------------------------------------------

  recordPreferenceEvent(input: CreatePreferenceEventInput): PreferenceEventRecord {
    this.ensureOpen();
    assertNoForbiddenKeys(input);
    assertSafeCategory(input.category);
    assertSafeId(input.policyRuleId, "policyRuleId");
    assertSafeId(input.reasonCode, "reasonCode");
    assertSafeId(input.sessionId, "sessionId");
    assertNoCredentialMaterial(input.decisionMode, "decisionMode");
    const record: PreferenceEventRecord = {
      eventId: input.eventId ?? randomUUID(),
      occurredAt: input.occurredAt ?? iso(this.now()),
      profileRevision: input.profileRevision ?? this.latestRevisionNumber(),
      category: input.category,
      decisionMode: input.decisionMode,
      userAction: input.userAction,
      scope: input.scope,
      reasonCode: input.reasonCode,
      policyRuleId: input.policyRuleId,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
    };
    this.db!.prepare(
      `INSERT INTO ${TABLE_PREFERENCE_EVENTS}
        (event_id, occurred_at, profile_revision, category, decision_mode, user_action,
         scope, reason_code, policy_rule_id, session_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.eventId,
      record.occurredAt,
      record.profileRevision,
      record.category,
      record.decisionMode,
      record.userAction,
      record.scope ?? null,
      record.reasonCode ?? null,
      record.policyRuleId ?? null,
      record.sessionId ?? null,
      record.expiresAt ?? null,
    );
    return record;
  }

  recordOverride(input: CreateOverrideInput): OverrideEventRecord {
    this.ensureOpen();
    assertNoForbiddenKeys(input);
    assertSafeCategory(input.category);
    assertSafeId(input.policyRuleId, "policyRuleId");
    assertSafeId(input.reasonCode, "reasonCode");
    assertSafeId(input.sessionId, "sessionId");
    const record: OverrideEventRecord = {
      eventId: input.eventId ?? randomUUID(),
      occurredAt: input.occurredAt ?? iso(this.now()),
      category: input.category,
      action: input.action,
      policyRuleId: input.policyRuleId,
      reasonCode: input.reasonCode,
      sessionId: input.sessionId,
    };
    this.db!.prepare(
      `INSERT INTO ${TABLE_OVERRIDE_EVENTS}
        (event_id, occurred_at, category, action, policy_rule_id, reason_code, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.eventId,
      record.occurredAt,
      record.category,
      record.action,
      record.policyRuleId ?? null,
      record.reasonCode ?? null,
      record.sessionId ?? null,
    );
    return record;
  }

  // ---- Learned suggestions (never grant power) --------------------------------

  /**
   * Record a pending suggestion. Callers must still ask the user to adopt into
   * profile.json — this API never mutates grants or profile authority.
   */
  recordSuggestion(input: CreateSuggestionInput): LearnedSuggestionRecord {
    this.ensureOpen();
    assertNoForbiddenKeys(input);
    assertSafeCategory(input.category);
    assertNoCredentialMaterial(input.currentProfileValue, "currentProfileValue");
    assertNoCredentialMaterial(input.proposedProfileValue, "proposedProfileValue");
    if (input.evidenceCount < 0 || !Number.isFinite(input.evidenceCount)) {
      throw new MemoryPrivacyError("evidenceCount must be a non-negative number");
    }
    const record: LearnedSuggestionRecord = {
      suggestionId: input.suggestionId ?? randomUUID(),
      createdAt: input.createdAt ?? iso(this.now()),
      category: input.category,
      currentProfileValue: input.currentProfileValue,
      proposedProfileValue: input.proposedProfileValue,
      evidenceCount: input.evidenceCount,
      confidenceBucket: input.confidenceBucket,
      status: "pending",
      createdFromEventRange: input.createdFromEventRange,
    };
    this.db!.prepare(
      `INSERT INTO ${TABLE_LEARNED_SUGGESTIONS}
        (suggestion_id, created_at, category, current_profile_value, proposed_profile_value,
         evidence_count, confidence_bucket, status, created_from_event_range, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    ).run(
      record.suggestionId,
      record.createdAt,
      record.category,
      record.currentProfileValue,
      record.proposedProfileValue,
      record.evidenceCount,
      record.confidenceBucket,
      record.createdFromEventRange ?? null,
    );
    return record;
  }

  /**
   * Resolve suggestion status only. `accepted` does NOT write profile or grants —
   * T05/CLI must apply profile separately after user confirmation.
   */
  resolveSuggestion(
    suggestionId: string,
    status: Exclude<SuggestionStatus, "pending">,
    at?: Date,
  ): boolean {
    this.ensureOpen();
    assertSafeId(suggestionId, "suggestionId");
    if (!["accepted", "dismissed", "snoozed", "expired"].includes(status)) {
      throw new MemoryPrivacyError("invalid suggestion status");
    }
    const info = this.db!
      .prepare(
        `UPDATE ${TABLE_LEARNED_SUGGESTIONS}
         SET status = ?, resolved_at = ?
         WHERE suggestion_id = ? AND status = 'pending'`,
      )
      .run(status, iso(at ?? this.now()), suggestionId);
    return Number(info.changes) > 0;
  }

  listSuggestions(status?: SuggestionStatus): LearnedSuggestionRecord[] {
    this.ensureOpen();
    const rows = status
      ? (this.db!
          .prepare(
            `SELECT * FROM ${TABLE_LEARNED_SUGGESTIONS} WHERE status = ? ORDER BY created_at ASC`,
          )
          .all(status) as Array<Record<string, unknown>>)
      : (this.db!
          .prepare(`SELECT * FROM ${TABLE_LEARNED_SUGGESTIONS} ORDER BY created_at ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map(rowToSuggestion);
  }

  /** Aggregate preference events by category (for suggestion thresholds; no task text). */
  countPreferenceEventsByCategory(): Array<{ category: string; count: number }> {
    this.ensureOpen();
    const rows = this.db!
      .prepare(
        `SELECT category AS category, COUNT(*) AS count
         FROM ${TABLE_PREFERENCE_EVENTS}
         GROUP BY category
         ORDER BY count DESC`,
      )
      .all() as Array<{ category: string; count: number }>;
    return rows.map((r) => ({ category: String(r.category), count: Number(r.count) }));
  }

  countSessionGrants(activeOnly = false, at?: Date): number {
    this.ensureOpen();
    if (!activeOnly) {
      const row = this.db!
        .prepare(`SELECT COUNT(*) AS n FROM ${TABLE_SESSION_GRANTS}`)
        .get() as { n: number };
      return Number(row.n);
    }
    const when = iso(at ?? this.now());
    const row = this.db!
      .prepare(
        `SELECT COUNT(*) AS n FROM ${TABLE_SESSION_GRANTS}
         WHERE revoked_at IS NULL AND expires_at > ?`,
      )
      .get(when) as { n: number };
    return Number(row.n);
  }

  countOverrideEvents(): number {
    this.ensureOpen();
    const row = this.db!
      .prepare(`SELECT COUNT(*) AS n FROM ${TABLE_OVERRIDE_EVENTS}`)
      .get() as { n: number };
    return Number(row.n);
  }

  // ---- Profile revisions ------------------------------------------------------

  recordProfileRevision(input: CreateRevisionInput): ProfileRevisionRecord {
    this.ensureOpen();
    assertNoForbiddenKeys(input);
    assertSafeProfileJson(input.profileJson);
    assertNoCredentialMaterial(input.summary, "summary");
    const revision = input.revision ?? this.latestRevisionNumber() + 1;
    const record: ProfileRevisionRecord = {
      revision,
      createdAt: input.createdAt ?? iso(this.now()),
      source: input.source,
      profileJson: input.profileJson,
      summary: input.summary,
    };
    this.db!.prepare(
      `INSERT INTO ${TABLE_PROFILE_REVISIONS}
        (revision, created_at, source, profile_json, summary)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      record.revision,
      record.createdAt,
      record.source,
      record.profileJson,
      record.summary,
    );
    return record;
  }

  latestRevisionNumber(): number {
    this.ensureOpen();
    const row = this.db!
      .prepare(`SELECT MAX(revision) AS m FROM ${TABLE_PROFILE_REVISIONS}`)
      .get() as { m?: number | null } | undefined;
    return typeof row?.m === "number" && Number.isFinite(row.m) ? row.m : 0;
  }

  getProfileRevision(revision: number): ProfileRevisionRecord | undefined {
    this.ensureOpen();
    const row = this.db!
      .prepare(`SELECT * FROM ${TABLE_PROFILE_REVISIONS} WHERE revision = ?`)
      .get(revision) as Record<string, unknown> | undefined;
    return row ? rowToRevision(row) : undefined;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("PreferencesMemory is closed");
    if (!this.db) this.open();
  }
}

function rowToGrant(row: Record<string, unknown>): SessionGrantRecord {
  return {
    grantId: String(row.grant_id),
    createdAt: String(row.created_at),
    sessionId: String(row.session_id),
    category: String(row.category),
    scope: row.scope as GrantScope,
    expiresAt: String(row.expires_at),
    policyRuleId: row.policy_rule_id != null ? String(row.policy_rule_id) : undefined,
    reasonCode: row.reason_code != null ? String(row.reason_code) : undefined,
    revokedAt: row.revoked_at != null ? String(row.revoked_at) : undefined,
  };
}

function rowToSuggestion(row: Record<string, unknown>): LearnedSuggestionRecord {
  return {
    suggestionId: String(row.suggestion_id),
    createdAt: String(row.created_at),
    category: String(row.category),
    currentProfileValue: String(row.current_profile_value),
    proposedProfileValue: String(row.proposed_profile_value),
    evidenceCount: Number(row.evidence_count),
    confidenceBucket: row.confidence_bucket as ConfidenceBucket,
    status: row.status as SuggestionStatus,
    createdFromEventRange:
      row.created_from_event_range != null
        ? String(row.created_from_event_range)
        : undefined,
    resolvedAt: row.resolved_at != null ? String(row.resolved_at) : undefined,
  };
}

function rowToRevision(row: Record<string, unknown>): ProfileRevisionRecord {
  return {
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    source: row.source as ProfileRevisionSource,
    profileJson: String(row.profile_json),
    summary: String(row.summary),
  };
}

export { MemoryPrivacyError };
