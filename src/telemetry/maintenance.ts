/**
 * Local Guard Evidence — maintenance operations (purge / reset).
 *
 * SAFETY RULE: never unlink `telemetry.sqlite`, `-wal`, `-shm`, or any other
 * evidence storage file. Deleting an open SQLite file "succeeds" on Unix while
 * the holder keeps reading the old inode, so file deletion would appear to work
 * while silently leaving a running MCP server writing to an orphaned file.
 *
 * Instead: acquire an advisory maintenance lock → refuse if a writer holds it →
 * DELETE rows inside a transaction → checkpoint → VACUUM.
 */
import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { acquireMaintenanceLock } from "./lock.js";
import { TABLE_DECISIONS } from "./schema.js";
import type { ReportPeriod } from "./report.js";
import { periodStartIso } from "./report.js";

export interface MaintenanceResult {
  ok: boolean;
  /** Stable, non-sensitive explanation when `ok` is false. */
  reason?:
    | "database_missing"
    | "lock_held"
    | "database_error"
    | "confirmation_required"
    | "nothing_to_delete";
  deleted: number;
  sizeBeforeBytes: number | null;
  sizeAfterBytes: number | null;
  remainingFrom: string | null;
  remainingTo: string | null;
  /** True when this was a dry run (nothing was changed). */
  dryRun: boolean;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function remainingRange(db: DatabaseSync): { from: string | null; to: string | null } {
  const row = db
    .prepare(`SELECT MIN(occurred_at) AS f, MAX(occurred_at) AS t FROM ${TABLE_DECISIONS}`)
    .get() as { f: string | null; t: string | null };
  return { from: row?.f ?? null, to: row?.t ?? null };
}

function countMatching(db: DatabaseSync, sinceIso: string | null): number {
  const row = sinceIso
    ? (db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_DECISIONS} WHERE occurred_at < ?`).get(sinceIso) as {
        n: number;
      })
    : (db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_DECISIONS}`).get() as { n: number });
  return typeof row?.n === "number" ? row.n : 0;
}

/**
 * Purge records older than `period`.
 *
 * `dryRun` is strictly read-only: it opens the database, counts matching rows,
 * and returns without any write, lock, checkpoint, or VACUUM.
 */
export function purgeEvidence(options: {
  databasePath: string;
  lockPath: string;
  period: ReportPeriod;
  dryRun: boolean;
  openDatabase: (path: string) => DatabaseSync;
  now?: Date;
}): MaintenanceResult {
  if (!existsSync(options.databasePath)) {
    return {
      ok: false,
      reason: "database_missing",
      deleted: 0,
      sizeBeforeBytes: null,
      sizeAfterBytes: null,
      remainingFrom: null,
      remainingTo: null,
      dryRun: options.dryRun,
    };
  }

  const since = periodStartIso(options.period, options.now ?? new Date());
  const sizeBefore = fileSize(options.databasePath);

  // ---- Dry run: strictly read-only, no lock, no writes. ----
  if (options.dryRun) {
    let db: DatabaseSync | undefined;
    try {
      db = options.openDatabase(options.databasePath);
      const wouldDelete = countMatching(db, since);
      return {
        ok: true,
        deleted: wouldDelete,
        sizeBeforeBytes: sizeBefore,
        sizeAfterBytes: sizeBefore,
        remainingFrom: null,
        remainingTo: null,
        dryRun: true,
      };
    } catch {
      return {
        ok: false,
        reason: "database_error",
        deleted: 0,
        sizeBeforeBytes: sizeBefore,
        sizeAfterBytes: sizeBefore,
        remainingFrom: null,
        remainingTo: null,
        dryRun: true,
      };
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ---- Apply: requires the advisory lock so we never fight a live writer. ----
  const lock = acquireMaintenanceLock(options.lockPath);
  if (!lock.ok) {
    return {
      ok: false,
      reason: "lock_held",
      deleted: 0,
      sizeBeforeBytes: sizeBefore,
      sizeAfterBytes: sizeBefore,
      remainingFrom: null,
      remainingTo: null,
      dryRun: false,
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = options.openDatabase(options.databasePath);
    db.exec("PRAGMA busy_timeout=5000");

    const deleted = countMatching(db, since);
    if (deleted === 0) {
      return {
        ok: true,
        reason: "nothing_to_delete",
        deleted: 0,
        sizeBeforeBytes: sizeBefore,
        sizeAfterBytes: sizeBefore,
        ...prefix(remainingRange(db)),
        dryRun: false,
      };
    }

    db.exec("BEGIN");
    try {
      if (since) {
        db.prepare(`DELETE FROM ${TABLE_DECISIONS} WHERE occurred_at < ?`).run(since);
      } else {
        db.exec(`DELETE FROM ${TABLE_DECISIONS}`);
      }
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        reason: "database_error",
        deleted: 0,
        sizeBeforeBytes: sizeBefore,
        sizeAfterBytes: sizeBefore,
        remainingFrom: null,
        remainingTo: null,
        dryRun: false,
      };
    }

    reclaimSpace(db);
    return {
      ok: true,
      deleted,
      sizeBeforeBytes: sizeBefore,
      sizeAfterBytes: fileSize(options.databasePath),
      ...prefix(remainingRange(db)),
      dryRun: false,
    };
  } catch {
    return {
      ok: false,
      reason: "database_error",
      deleted: 0,
      sizeBeforeBytes: sizeBefore,
      sizeAfterBytes: sizeBefore,
      remainingFrom: null,
      remainingTo: null,
      dryRun: false,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    lock.handle.release();
  }
}

/**
 * Reset ALL local evidence.
 *
 * Requires the exact confirmation flag (enforced by the caller) and the
 * advisory lock. Deletes rows — never the database file.
 */
export function resetEvidence(options: {
  databasePath: string;
  lockPath: string;
  openDatabase: (path: string) => DatabaseSync;
}): MaintenanceResult {
  if (!existsSync(options.databasePath)) {
    return {
      ok: false,
      reason: "database_missing",
      deleted: 0,
      sizeBeforeBytes: null,
      sizeAfterBytes: null,
      remainingFrom: null,
      remainingTo: null,
      dryRun: false,
    };
  }

  const sizeBefore = fileSize(options.databasePath);
  const lock = acquireMaintenanceLock(options.lockPath);
  if (!lock.ok) {
    return {
      ok: false,
      reason: "lock_held",
      deleted: 0,
      sizeBeforeBytes: sizeBefore,
      sizeAfterBytes: sizeBefore,
      remainingFrom: null,
      remainingTo: null,
      dryRun: false,
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = options.openDatabase(options.databasePath);
    db.exec("PRAGMA busy_timeout=5000");
    const deleted = countMatching(db, null);

    db.exec("BEGIN");
    try {
      db.exec(`DELETE FROM ${TABLE_DECISIONS}`);
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        reason: "database_error",
        deleted: 0,
        sizeBeforeBytes: sizeBefore,
        sizeAfterBytes: sizeBefore,
        remainingFrom: null,
        remainingTo: null,
        dryRun: false,
      };
    }

    reclaimSpace(db);
    return {
      ok: true,
      deleted,
      sizeBeforeBytes: sizeBefore,
      sizeAfterBytes: fileSize(options.databasePath),
      remainingFrom: null,
      remainingTo: null,
      dryRun: false,
    };
  } catch {
    return {
      ok: false,
      reason: "database_error",
      deleted: 0,
      sizeBeforeBytes: sizeBefore,
      sizeAfterBytes: sizeBefore,
      remainingFrom: null,
      remainingTo: null,
      dryRun: false,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    lock.handle.release();
  }
}

function prefix(range: { from: string | null; to: string | null }): {
  remainingFrom: string | null;
  remainingTo: string | null;
} {
  return { remainingFrom: range.from, remainingTo: range.to };
}

/** Checkpoint then VACUUM to reclaim disk space. Best-effort. */
function reclaimSpace(db: DatabaseSync): void {
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    /* ignore */
  }
  try {
    db.exec("VACUUM");
  } catch {
    /* ignore */
  }
}

/** Status snapshot for `jev-guard evidence status`. */
export interface EvidenceStatus {
  enabled: boolean;
  databasePath: string;
  databaseExists: boolean;
  databaseBytes: number | null;
  decisionsStored: number | null;
  schemaVersion: number | null;
  dateRange: { from: string | null; to: string | null };
  advisoryBytes: number;
  storageAdvisory: "ok" | "exceeded";
}

export function evidenceStatus(options: {
  enabled: boolean;
  databasePath: string;
  advisoryBytes: number;
  openDatabase: (path: string) => DatabaseSync;
}): EvidenceStatus {
  const exists = options.databasePath ? existsSync(options.databasePath) : false;
  const base: EvidenceStatus = {
    enabled: options.enabled,
    databasePath: options.databasePath,
    databaseExists: exists,
    databaseBytes: exists ? fileSize(options.databasePath) : null,
    decisionsStored: null,
    schemaVersion: null,
    dateRange: { from: null, to: null },
    advisoryBytes: options.advisoryBytes,
    storageAdvisory:
      exists && (fileSize(options.databasePath) ?? 0) > options.advisoryBytes ? "exceeded" : "ok",
  };

  if (!exists) return base;

  let db: DatabaseSync | undefined;
  try {
    db = options.openDatabase(options.databasePath);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_DECISIONS}`).get() as { n: number };
    const range = remainingRange(db);
    const meta = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined;
    const version = Number.parseInt(meta?.value ?? "", 10);
    return {
      ...base,
      decisionsStored: typeof count?.n === "number" ? count.n : 0,
      schemaVersion: Number.isFinite(version) ? version : null,
      dateRange: { from: range.from, to: range.to },
    };
  } catch {
    return base;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
