/**
 * Write-gate adapter smoke tests (offline). Spawns the hook with canned stdin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/jev-write-policy-check.mjs", import.meta.url));
const NODE = process.execPath;

function runHook(payload) {
  const r = spawnSync(NODE, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

describe("Write preToolUse gate", () => {
  it("denies Write to a secret path", () => {
    const out = runHook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/project/.env" },
    });
    assert.equal(out.permission, "deny");
    assert.match(out.agent_message ?? "", /POL-SECRETS-1/);
  });

  it("denies Write to a PEM path", () => {
    const out = runHook({
      tool_name: "Write",
      tool_input: { path: "certs/server.pem" },
    });
    assert.equal(out.permission, "deny");
  });

  it("allows ordinary source edits", () => {
    const out = runHook({
      tool_name: "Write",
      tool_input: { file_path: "src/fallback.ts" },
    });
    assert.equal(out.permission, "allow");
  });

  it("asks on authz source edits (approval_required)", () => {
    const out = runHook({
      tool_name: "Write",
      tool_input: { file_path: "src/middleware/auth.ts" },
    });
    assert.equal(out.permission, "ask");
    assert.match(out.agent_message ?? "", /POL-AUTHZ-1/);
  });

  it("allows when no path is present", () => {
    const out = runHook({ tool_name: "Write", tool_input: {} });
    assert.equal(out.permission, "allow");
  });
});
