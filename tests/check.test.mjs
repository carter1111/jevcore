/**
 * P0 — `jev-guard check` contract tests.
 *
 * Covers exit codes 0/1/2/3/4, JSON privacy (no command echo), --stdin,
 * --echo-hash, and that no credential is required.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  evaluateCheck,
  exitCodeForMode,
  failClosed,
  formatCheckJson,
  hashCommand,
} from "../dist/check.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function runCheckCli(args, { input, env } = {}) {
  return spawnSync(process.execPath, [CLI, "check", ...args], {
    encoding: "utf8",
    input: input ?? undefined,
    env: {
      ...process.env,
      // Prove check works with no TypeSafe credential in the child env.
      TYPESAFE_API_KEY: "",
      ...env,
    },
  });
}

describe("exitCodeForMode", () => {
  it("maps modes to 0/1/2/3", () => {
    assert.equal(exitCodeForMode(null), 0);
    assert.equal(exitCodeForMode("execute"), 0);
    assert.equal(exitCodeForMode("block"), 1);
    assert.equal(exitCodeForMode("approval_required"), 2);
    assert.equal(exitCodeForMode("plan_first"), 3);
  });
});

describe("evaluateCheck (pure)", () => {
  it("benign command → execute / exit 0 / no rule", () => {
    const r = evaluateCheck("git status");
    assert.equal(r.ok, true);
    assert.equal(r.verdict, "execute");
    assert.equal(r.exitCode, 0);
    assert.equal(r.ruleId, null);
  });

  it("cat .env → block / POL-SECRETS-1 / exit 1", () => {
    const r = evaluateCheck("cat .env");
    assert.equal(r.verdict, "block");
    assert.equal(r.exitCode, 1);
    assert.equal(r.ruleId, "POL-SECRETS-1");
  });

  it("rm -rf → block / POL-DESTRUCTIVE-CMD-1", () => {
    const r = evaluateCheck("rm -rf /tmp/build");
    assert.equal(r.verdict, "block");
    assert.equal(r.exitCode, 1);
    assert.equal(r.ruleId, "POL-DESTRUCTIVE-CMD-1");
  });

  it("force push main → block / POL-FORCE-PUSH-1", () => {
    const r = evaluateCheck("git push --force origin main");
    assert.equal(r.verdict, "block");
    assert.equal(r.exitCode, 1);
    assert.equal(r.ruleId, "POL-FORCE-PUSH-1");
  });

  it("local migration → approval_required / POL-DB-MIGRATION-1 / exit 2", () => {
    const r = evaluateCheck(
      "Apply the SQL migration to the local development database",
    );
    assert.equal(r.verdict, "approval_required");
    assert.equal(r.exitCode, 2);
    assert.equal(r.ruleId, "POL-DB-MIGRATION-1");
  });

  it("unknown-target migrate deploy → approval_required / POL-DB-DEPLOY-UNKNOWN-1", () => {
    const r = evaluateCheck(
      "Assess the proposed database migration deploy command\nProposed command: pnpm prisma migrate deploy",
    );
    assert.equal(r.verdict, "approval_required");
    assert.equal(r.exitCode, 2);
    assert.equal(r.ruleId, "POL-DB-DEPLOY-UNKNOWN-1");
  });

  it("JSON never contains the command text", () => {
    const cmd = "cat .env && echo UNIQUE_CMD_MARKER_XYZ";
    const json = formatCheckJson(evaluateCheck(cmd));
    assert.doesNotMatch(json, /UNIQUE_CMD_MARKER_XYZ/);
    assert.doesNotMatch(json, /cat \.env/);
    const parsed = JSON.parse(json);
    assert.equal(parsed.ruleId, "POL-SECRETS-1");
    assert.equal(parsed.commandHash, undefined);
  });

  it("--echo-hash adds sha256 without echoing command", () => {
    const cmd = "git status";
    const r = evaluateCheck(cmd, { echoHash: true });
    assert.equal(r.commandHash, hashCommand(cmd));
    assert.equal(
      r.commandHash,
      `sha256:${createHash("sha256").update(cmd, "utf8").digest("hex")}`,
    );
    const json = formatCheckJson(r);
    assert.doesNotMatch(json, /git status/);
    assert.match(json, /"commandHash":"sha256:[a-f0-9]{64}"/);
  });

  it("failClosed is exit 4 and ok:false", () => {
    const r = failClosed("empty command");
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 4);
    assert.equal(r.ruleId, null);
  });
});

describe("jev-guard check CLI", () => {
  it("benign argv → exit 0", () => {
    const r = runCheckCli(["git status"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /execute/);
  });

  it("cat .env → exit 1 + JSON rule id", () => {
    const r = runCheckCli(["--json", "cat .env"]);
    assert.equal(r.status, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.verdict, "block");
    assert.equal(body.ruleId, "POL-SECRETS-1");
    assert.doesNotMatch(r.stdout, /cat \.env/);
  });

  it("rm -rf → exit 1", () => {
    const r = runCheckCli(["rm -rf /"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /POL-DESTRUCTIVE-CMD-1/);
  });

  it("force push → exit 1", () => {
    const r = runCheckCli(["git push --force origin main"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /POL-FORCE-PUSH-1/);
  });

  it("local migration → exit 2", () => {
    const r = runCheckCli([
      "--json",
      "Apply the SQL migration to the local development database",
    ]);
    assert.equal(r.status, 2);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ruleId, "POL-DB-MIGRATION-1");
  });

  it("migrate deploy unknown target → exit 2", () => {
    const r = runCheckCli([
      "--json",
      "Assess the proposed database migration deploy command\nProposed command: pnpm prisma migrate deploy",
    ]);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).ruleId, "POL-DB-DEPLOY-UNKNOWN-1");
  });

  it("--stdin reads the command", () => {
    const r = runCheckCli(["--stdin", "--json"], { input: "pwd" });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).verdict, "execute");
  });

  it("empty argv → exit 4 (fail-closed)", () => {
    const r = runCheckCli([]);
    assert.equal(r.status, 4);
    assert.match(r.stdout, /missing command|fail-closed|error/i);
  });

  it("empty --stdin → exit 4 (fail-closed)", () => {
    const r = runCheckCli(["--stdin", "--json"], { input: "   " });
    assert.equal(r.status, 4);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.exitCode, 4);
  });

  it("--stdin plus argv → exit 4 (ambiguous)", () => {
    const r = runCheckCli(["--stdin", "pwd"]);
    assert.equal(r.status, 4);
  });

  it("works with TYPESAFE_API_KEY unset", () => {
    const r = runCheckCli(["--json", "echo hi"], {
      env: { TYPESAFE_API_KEY: undefined },
    });
    // scrub key from child: spawnSync merges env; delete explicitly
    const r2 = spawnSync(process.execPath, [CLI, "check", "--json", "echo hi"], {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "TYPESAFE_API_KEY"),
      ),
    });
    assert.equal(r2.status, 0);
    assert.equal(JSON.parse(r2.stdout).verdict, "execute");
    void r;
  });

  it("JSON stdout never contains paths from the command", () => {
    const marker = "/Users/nobody/secret-path-MARKER-99";
    const r = runCheckCli(["--json", `ls ${marker}`]);
    // ls of a path is usually execute — still must not echo path if we ever match;
    // for execute path, reason is null; assert marker absent either way.
    assert.doesNotMatch(r.stdout + r.stderr, /secret-path-MARKER-99/);
  });
});

test("usage still works for unknown group (exit 2)", () => {
  const r = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /jev-guard/);
});
