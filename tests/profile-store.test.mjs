/**
 * T05 — Profile v1 store + validation + presets + hard boundaries.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyPreset,
  createDefaultProfile,
  HARD_DELEGATION_KEYS,
  parseAndValidateProfileJson,
  ProfileStore,
  ProfileValidationError,
  validateProfile,
} from "../dist/profile/index.js";
import { PreferencesMemory } from "../dist/memory/index.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "jev-profile-"));
}

describe("Profile schema validate", () => {
  it("accepts the default profile", () => {
    const p = createDefaultProfile(() => new Date("2026-09-22T00:00:00.000Z"));
    const v = validateProfile(p);
    assert.equal(v.schemaVersion, 1);
    assert.equal(v.learning.autoApplyPreferenceChanges, false);
    assert.equal(v.delegation.secretToRemoteProvider, "never_delegate");
    assert.equal(v.delegation.web3AssetAction, "never_delegate");
  });

  it("rejects wrong schemaVersion", () => {
    const p = createDefaultProfile();
    assert.throws(
      () => validateProfile({ ...p, schemaVersion: 2 }),
      ProfileValidationError,
    );
  });

  it("rejects autoApplyPreferenceChanges true", () => {
    const p = createDefaultProfile();
    assert.throws(
      () =>
        validateProfile({
          ...p,
          learning: { ...p.learning, autoApplyPreferenceChanges: true },
        }),
      /autoApplyPreferenceChanges/,
    );
  });

  it("rejects invalid JSON text", () => {
    assert.throws(() => parseAndValidateProfileJson("{"), ProfileValidationError);
  });
});

describe("Hard boundaries cannot be lowered", () => {
  for (const key of HARD_DELEGATION_KEYS) {
    it(`rejects ${key} != never_delegate`, () => {
      const p = createDefaultProfile();
      assert.throws(
        () =>
          validateProfile({
            ...p,
            delegation: { ...p.delegation, [key]: "ask" },
          }),
        (err) =>
          err instanceof ProfileValidationError &&
          /Hard boundary/.test(err.message) &&
          err.message.includes(key),
      );
      assert.throws(
        () =>
          validateProfile({
            ...p,
            delegation: { ...p.delegation, [key]: "auto" },
          }),
        ProfileValidationError,
      );
    });
  }

  it("setField rejects lowering secretToRemoteProvider", () => {
    const dir = tmpDir();
    const profilePath = join(dir, "profile.json");
    const dbPath = join(dir, "preferences.sqlite");
    const store = new ProfileStore({
      profilePath,
      memory: { databasePath: dbPath },
    });
    store.init({});
    assert.throws(
      () => store.setField("secret-to-remote-provider", "ask"),
      /Hard boundary|never_delegate/,
    );
    assert.throws(
      () => store.setField("web3-asset-action", "auto"),
      /Hard boundary|never_delegate/,
    );
    const loaded = store.load();
    assert.equal(loaded.delegation.secretToRemoteProvider, "never_delegate");
    assert.equal(loaded.delegation.web3AssetAction, "never_delegate");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Presets (soft only)", () => {
  it("cautious / balanced / assertive adjust soft stops, keep hard keys", () => {
    const base = createDefaultProfile();
    for (const preset of ["cautious", "balanced", "assertive"]) {
      const next = applyPreset(base, preset);
      assert.equal(next.interruptionPreference, preset);
      assert.equal(next.delegation.secretToRemoteProvider, "never_delegate");
      assert.equal(next.delegation.web3AssetAction, "never_delegate");
    }
    const cautious = applyPreset(base, "cautious");
    assert.equal(cautious.delegation.localDevDatabase, "ask");
    const assertive = applyPreset(base, "assertive");
    assert.equal(assertive.delegation.ordinaryCode, "auto");
  });

  it("store.applyPreset persists and bumps revision", () => {
    const dir = tmpDir();
    const store = new ProfileStore({
      profilePath: join(dir, "profile.json"),
      memory: { databasePath: join(dir, "preferences.sqlite") },
    });
    store.init({});
    assert.equal(store.load().profileRevision, 1);
    store.applyPreset("cautious");
    const p = store.load();
    assert.equal(p.interruptionPreference, "cautious");
    assert.equal(p.profileRevision, 2);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Atomic write + revision ledger", () => {
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

  it("writes 0600 profile, backup, and PreferencesMemory revision", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const profilePath = join(dir, "profile.json");
    const dbPath = join(dir, "preferences.sqlite");
    const fixed = new Date("2026-09-22T12:00:00.000Z");
    const store = new ProfileStore({
      profilePath,
      now: () => fixed,
      memory: { databasePath: dbPath, now: () => fixed },
    });

    const r1 = store.init({});
    assert.equal(r1.revisionRecorded, true);
    assert.equal(existsSync(profilePath), true);
    const mode = statSync(profilePath).mode & 0o777;
    assert.equal(mode, 0o600);

    store.applyPreset("assertive");
    assert.equal(existsSync(store.backupPath), true);

    const mem = new PreferencesMemory({ databasePath: dbPath });
    assert.equal(mem.latestRevisionNumber(), 2);
    const rev = mem.getProfileRevision(2);
    assert.ok(rev);
    assert.equal(rev.source, "user_cli");
    assert.match(rev.summary, /preset assertive/);
    const parsed = JSON.parse(rev.profileJson);
    assert.equal(parsed.interruptionPreference, "assertive");
    mem.close();
    store.close();
  });

  it("rejects half-baked overwrite of hard keys via import", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new ProfileStore({
      profilePath: join(dir, "profile.json"),
      memory: { databasePath: join(dir, "preferences.sqlite") },
    });
    store.init({});
    const bad = createDefaultProfile();
    bad.delegation.secretToRemoteProvider = "ask";
    assert.throws(
      () => store.importJson(JSON.stringify(bad)),
      ProfileValidationError,
    );
    assert.equal(store.load().delegation.secretToRemoteProvider, "never_delegate");
    store.close();
  });

  it("does not leave a .tmp after successful write", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new ProfileStore({
      profilePath: join(dir, "profile.json"),
      memory: { databasePath: join(dir, "preferences.sqlite") },
    });
    store.init({});
    const leftovers = readFileSync(join(dir, "profile.json"), "utf8");
    assert.ok(leftovers.includes('"schemaVersion": 1'));
    const names = readdirSync(dir);
    assert.equal(
      names.filter((n) => n.includes(".tmp")).length,
      0,
    );
    store.close();
  });
});

describe("learning never auto-writes", () => {
  it("default and validated profiles keep autoApplyPreferenceChanges false", () => {
    const p = createDefaultProfile();
    assert.equal(p.learning.autoApplyPreferenceChanges, false);
    // Simulate a tampered file on disk — load must reject.
    const dir = tmpDir();
    const path = join(dir, "profile.json");
    const tampered = {
      ...p,
      learning: { ...p.learning, autoApplyPreferenceChanges: true },
    };
    writeFileSync(path, JSON.stringify(tampered));
    const store = new ProfileStore({
      profilePath: path,
      skipRevisionLedger: true,
    });
    assert.throws(() => store.load(), /autoApplyPreferenceChanges/);
    rmSync(dir, { recursive: true, force: true });
  });
});
