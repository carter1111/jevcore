/**
 * Unit tests for memory + profile path helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MEMORY_DIR_NAME,
  MEMORY_DB_NAME,
  MEMORY_PATH_ENV,
  resolveMemoryDir,
  resolvePreferencesDbPath,
} from "../dist/memory/index.js";
import {
  PROFILE_DIR_NAME,
  PROFILE_FILE_NAME,
  PROFILE_PATH_ENV,
  resolveProfileDir,
  resolveProfilePath,
  resolveProfileBackupPath,
} from "../dist/profile/index.js";

describe("memory path helpers", () => {
  it("resolves default preferences DB under home", () => {
    const env = {};
    assert.equal(resolveMemoryDir(env), join(homedir(), MEMORY_DIR_NAME));
    assert.equal(
      resolvePreferencesDbPath(env),
      join(homedir(), MEMORY_DIR_NAME, MEMORY_DB_NAME),
    );
  });

  it("honors JEV_GUARD_PREFERENCES_PATH override (trimmed)", () => {
    const override = "/tmp/jev-test-preferences.sqlite";
    assert.equal(
      resolvePreferencesDbPath({ [MEMORY_PATH_ENV]: `  ${override}  ` }),
      override,
    );
  });

  it("ignores blank override and falls back to default", () => {
    assert.equal(
      resolvePreferencesDbPath({ [MEMORY_PATH_ENV]: "   " }),
      join(homedir(), MEMORY_DIR_NAME, MEMORY_DB_NAME),
    );
  });
});

describe("profile path helpers", () => {
  it("resolves default profile.json under home", () => {
    const env = {};
    assert.equal(resolveProfileDir(env), join(homedir(), PROFILE_DIR_NAME));
    assert.equal(
      resolveProfilePath(env),
      join(homedir(), PROFILE_DIR_NAME, PROFILE_FILE_NAME),
    );
  });

  it("honors JEV_GUARD_PROFILE_PATH override (trimmed)", () => {
    const override = "/tmp/jev-test-profile.json";
    assert.equal(
      resolveProfilePath({ [PROFILE_PATH_ENV]: `  ${override}  ` }),
      override,
    );
  });

  it("builds backup path from profile path", () => {
    assert.equal(
      resolveProfileBackupPath("/tmp/profile.json"),
      "/tmp/profile.json.bak",
    );
  });
});
