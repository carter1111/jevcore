/**
 * Claude Code adapter — pure exit-code mapping + hook privacy smoke.
 * No Claude Code binary, no network, no credentials.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapCheckExit } from "../adapters/claude-code/hooks/map-check-exit.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(
  root,
  "adapters/claude-code/hooks/pretooluse-jev-check.mjs",
);

describe("mapCheckExit (P1 / PRD §4.3)", () => {
  it("exit 0 → allow", () => {
    const d = mapCheckExit(0);
    assert.equal(d.permissionDecision, "allow");
  });

  it("exit 1 → deny", () => {
    const d = mapCheckExit(1);
    assert.equal(d.permissionDecision, "deny");
  });

  it("exit 2 → ask", () => {
    const d = mapCheckExit(2);
    assert.equal(d.permissionDecision, "ask");
  });

  it("exit 3 → ask", () => {
    const d = mapCheckExit(3);
    assert.equal(d.permissionDecision, "ask");
  });

  it("exit 4 → deny (fail-closed)", () => {
    const d = mapCheckExit(4);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /fail-closed/i);
  });

  it("null / undefined → deny (fail-closed)", () => {
    assert.equal(mapCheckExit(null).permissionDecision, "deny");
    assert.equal(mapCheckExit(undefined).permissionDecision, "deny");
  });

  it("unknown exit → deny (fail-closed)", () => {
    assert.equal(mapCheckExit(99).permissionDecision, "deny");
  });

  it("passes through a safe reason without inventing command text", () => {
    const d = mapCheckExit(1, { reason: "Jev Guard: POL-FORCE-PUSH-1" });
    assert.equal(d.permissionDecisionReason, "Jev Guard: POL-FORCE-PUSH-1");
    assert.doesNotMatch(d.permissionDecisionReason, /rm |push |PRIVATE/i);
  });
});

describe("pretooluse-jev-check.mjs", () => {
  it("empty Bash command → allow JSON (no check spawn needed)", () => {
    const r = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "" },
      }),
      encoding: "utf8",
      env: { ...process.env, JEV_GUARD_BIN: "/nonexistent/jev-guard" },
    });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(
      body.hookSpecificOutput.permissionDecision,
      "allow",
    );
  });

  it("missing check binary → deny (fail-closed) and never echoes command", () => {
    const secretish = "cat /tmp/not-a-real-secret-path-xyz";
    const r = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: secretish },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        JEV_GUARD_BIN: "/nonexistent/jev-guard-bin-for-test",
      },
    });
    assert.equal(r.status, 0);
    const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    assert.doesNotMatch(combined, /not-a-real-secret-path-xyz/);
    const body = JSON.parse(r.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      body.hookSpecificOutput.permissionDecisionReason,
      /fail-closed|not found/i,
    );
  });

  it("malformed stdin → deny (fail-closed)", () => {
    const r = spawnSync(process.execPath, [hookPath], {
      input: "{not-json",
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
  });
});
