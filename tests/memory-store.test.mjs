/**
 * T06 — Memory v1 preferences.sqlite + privacy invariants.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PreferencesMemory,
  MemoryPrivacyError,
  MEMORY_SCHEMA_VERSION,
} from "../dist/memory/index.js";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "jev-memory-"));
  return { dir, path: join(dir, "preferences.sqlite") };
}

describe("PreferencesMemory schema + grants", () => {
  const dirs = [];

  after(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("migrates and records schema version", () => {
    const { dir, path } = tmpDb();
    dirs.push(dir);
    const mem = new PreferencesMemory({ databasePath: path });
    mem.open();
    assert.equal(mem.schemaVersion(), MEMORY_SCHEMA_VERSION);
    assert.equal(existsSync(path), true);
    mem.close();
  });

  it("requires expires_at on session grants and drops expired", () => {
    const { dir, path } = tmpDb();
    dirs.push(dir);
    const fixed = new Date("2026-09-22T12:00:00.000Z");
    const mem = new PreferencesMemory({
      databasePath: path,
      now: () => fixed,
    });
    assert.throws(
      () =>
        mem.recordGrant({
          sessionId: "sess-1",
          category: "local_dev_db",
          scope: "session",
          expiresAt: "",
        }),
      MemoryPrivacyError,
    );

    mem.recordGrant({
      sessionId: "sess-1",
      category: "local_dev_db",
      scope: "session",
      expiresAt: "2026-09-22T13:00:00.000Z",
    });
    mem.recordGrant({
      sessionId: "sess-1",
      category: "staging_deploy",
      scope: "once",
      expiresAt: "2026-09-22T11:00:00.000Z", // already expired
    });

    const active = mem.listActiveGrants("sess-1");
    assert.equal(active.length, 1);
    assert.equal(active[0].category, "local_dev_db");

    const later = mem.listActiveGrants("sess-1", new Date("2026-09-22T14:00:00.000Z"));
    assert.equal(later.length, 0);
    mem.close();
  });

  it("revokeGrant deactivates without deleting", () => {
    const { dir, path } = tmpDb();
    dirs.push(dir);
    const mem = new PreferencesMemory({ databasePath: path });
    const g = mem.recordGrant({
      sessionId: "s",
      category: "local_dev_db",
      scope: "once",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(mem.revokeGrant(g.grantId), true);
    assert.equal(mem.listActiveGrants("s").length, 0);
    mem.close();
  });
});

describe("privacy invariants", () => {
  it("rejects forbidden keys on write inputs", () => {
    const { path, dir } = tmpDb();
    const mem = new PreferencesMemory({ databasePath: path });
    assert.throws(
      () =>
        mem.recordPreferenceEvent({
          category: "local_dev_db",
          decisionMode: "your_call",
          userAction: "approve_once",
          task: "migrate production",
        }),
      (err) => err instanceof MemoryPrivacyError && /Forbidden field/.test(err.message),
    );
    assert.throws(
      () =>
        mem.recordOverride({
          category: "x",
          action: "self_handle",
          command: "rm -rf /",
        }),
      MemoryPrivacyError,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects credential material in stored strings", () => {
    const { path, dir } = tmpDb();
    const mem = new PreferencesMemory({ databasePath: path });
    assert.throws(
      () =>
        mem.recordProfileRevision({
          source: "user_cli",
          summary: "ok",
          profileJson: JSON.stringify({
            schemaVersion: 1,
            note: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
          }),
        }),
      MemoryPrivacyError,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid category / prose-as-category", () => {
    const { path, dir } = tmpDb();
    const mem = new PreferencesMemory({ databasePath: path });
    assert.throws(
      () =>
        mem.recordGrant({
          sessionId: "s",
          category: "run the migration against staging please",
          scope: "session",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      MemoryPrivacyError,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("suggestions never grant", () => {
  it("accepting a suggestion does not create grants", () => {
    const { path, dir } = tmpDb();
    const mem = new PreferencesMemory({ databasePath: path });
    const s = mem.recordSuggestion({
      category: "local_dev_db",
      currentProfileValue: "ask",
      proposedProfileValue: "allow_session",
      evidenceCount: 5,
      confidenceBucket: "medium",
    });
    assert.equal(mem.resolveSuggestion(s.suggestionId, "accepted"), true);
    assert.equal(mem.listActiveGrants("any-session").length, 0);
    const listed = mem.listSuggestions("accepted");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "accepted");
    // No API on PreferencesMemory applies suggestion → profile authority.
    assert.equal(typeof mem.recordGrant, "function");
    assert.equal("applySuggestionAsGrant" in mem, false);
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("profile revisions + preference events", () => {
  it("stores revision and links preference events to revision number", () => {
    const { path, dir } = tmpDb();
    const mem = new PreferencesMemory({ databasePath: path });
    const rev = mem.recordProfileRevision({
      source: "user_cli",
      summary: "init balanced preset",
      profileJson: JSON.stringify({
        schemaVersion: 1,
        interruptionPreference: "balanced",
        delegation: { local_dev_db: "ask" },
      }),
    });
    assert.equal(rev.revision, 1);
    const ev = mem.recordPreferenceEvent({
      category: "local_dev_db",
      decisionMode: "your_call",
      userAction: "approve_session",
      scope: "session",
      sessionId: "sess-a",
    });
    assert.equal(ev.profileRevision, 1);
    assert.equal(mem.getProfileRevision(1)?.summary, "init balanced preset");
    mem.close();
    // mode bits best-effort (may be platform-dependent)
    if (process.platform !== "win32" && existsSync(path)) {
      const mode = statSync(path).mode & 0o777;
      assert.ok(mode === 0o600 || mode === 0o640 || mode === 0o644);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
