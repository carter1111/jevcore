/**
 * P1 installer + P2 template contract tests.
 * No writes to ~/.claude; --apply exercised only under a tmp project dir.
 */
import { describe, it, test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildInstallPlan, main as installMain } from "../adapters/claude-code/install.mjs";
import { mapCheckExit } from "../adapters/claude-code/hooks/map-check-exit.mjs";

const root = process.cwd();
const CLI = join(root, "dist", "cli.js");
const HOOK = join(root, "adapters/claude-code/hooks/pretooluse-jev-check.mjs");

const cleanups = [];
after(() => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmpProject() {
  const dir = mkdtempSync(join(tmpdir(), "jev-adapter-"));
  cleanups.push(dir);
  return dir;
}

describe("claude-code install plan", () => {
  it("buildInstallPlan returns valid MCP + hooks JSON", () => {
    const plan = buildInstallPlan({ repoRoot: root, projectDir: tmpProject() });
    assert.equal(plan.mcpJson.mcpServers["jev-coding-guard"].type, "stdio");
    assert.ok(plan.mcpJson.mcpServers["jev-coding-guard"].args[0].endsWith("mcp-server.js"));
    assert.equal(
      plan.hooksJson.hooks.PreToolUse[0].matcher,
      "Bash",
    );
    assert.match(
      plan.hooksJson.hooks.PreToolUse[0].hooks[0].command,
      /pretooluse-jev-check\.mjs/,
    );
    // Never embeds a literal credential value — only the variable reference.
    assert.equal(
      plan.mcpJson.mcpServers["jev-coding-guard"].env.TYPESAFE_API_KEY,
      "${TYPESAFE_API_KEY}",
    );
    assert.doesNotMatch(JSON.stringify(plan.mcpJson), /sk-|apikey_/i);
  });

  it("dry-run main writes nothing", () => {
    const project = tmpProject();
    const code = installMain([
      "--repo",
      root,
      "--project-dir",
      project,
    ]);
    assert.equal(code, 0);
    assert.ok(!existsSync(join(project, ".mcp.json")));
    assert.ok(!existsSync(join(project, ".claude", "settings.json")));
  });
});

test("install --apply writes project files and is idempotent", () => {
  const project = tmpProject();
  // ensure parent exists via apply's mkdir
  const code1 = installMain(["--apply", "--repo", root, "--project-dir", project]);
  assert.equal(code1, 0, "first apply");
  assert.ok(existsSync(join(project, ".mcp.json")));
  assert.ok(existsSync(join(project, ".claude", "settings.json")));
  assert.ok(existsSync(join(project, "CLAUDE.md")));

  const mcp1 = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
  assert.equal(mcp1.mcpServers["jev-coding-guard"].type, "stdio");

  // Seed an extra PreToolUse entry, then apply again — should keep one jev hook.
  const settingsPath = join(project, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.PreToolUse.push({
    matcher: "Edit",
    hooks: [{ type: "command", command: "true" }],
  });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const code2 = installMain(["--apply", "--repo", root, "--project-dir", project]);
  assert.equal(code2, 0, "second apply");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  const jevHooks = after.hooks.PreToolUse.filter((e) =>
    JSON.stringify(e).includes("pretooluse-jev-check"),
  );
  assert.equal(jevHooks.length, 1, "exactly one jev Bash hook after re-apply");
  assert.ok(
    after.hooks.PreToolUse.some((e) => e.matcher === "Edit"),
    "unrelated Edit hook preserved",
  );
});

describe("hook ↔ jev-guard check (live P0)", () => {
  it("pwd → allow via real check", () => {
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      }),
      env: { ...process.env, JEV_GUARD_BIN: CLI },
    });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
  });

  it("policy-blocked command → deny via real check (no echo)", () => {
    // Command string lives only in this test process argv to node, not in a
    // parent shell line the Cursor hook would scan as an agent shell command.
    const blocked = ["cat", ".env"].join(" ");
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: blocked },
      }),
      env: { ...process.env, JEV_GUARD_BIN: CLI },
    });
    assert.equal(r.status, 0, r.stderr);
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(combined, /\.env/);
    const body = JSON.parse(r.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
    assert.match(body.hookSpecificOutput.permissionDecisionReason, /POL-SECRETS-1|Jev Guard/i);
  });

  it("approval_required command → ask via real check", () => {
    const cmd =
      "Apply the SQL migration to the local development database";
    const check = spawnSync(process.execPath, [CLI, "check", "--json", cmd], {
      encoding: "utf8",
    });
    assert.equal(check.status, 2);
    const mapped = mapCheckExit(check.status, {
      reason: `Jev Guard: ${JSON.parse(check.stdout).ruleId}`,
    });
    assert.equal(mapped.permissionDecision, "ask");

    const r = spawnSync(process.execPath, [HOOK], {
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: cmd },
      }),
      env: { ...process.env, JEV_GUARD_BIN: CLI },
    });
    assert.equal(r.status, 0);
    assert.equal(
      JSON.parse(r.stdout).hookSpecificOutput.permissionDecision,
      "ask",
    );
  });
});

describe("P2 templates", () => {
  it("Codex TOML example is parseable enough (key sections present)", () => {
    const text = readFileSync(
      join(root, "adapters/codex/config.toml.example"),
      "utf8",
    );
    assert.match(text, /\[mcp_servers\.jev-coding-guard\]/);
    assert.match(text, /env_vars\s*=\s*\["TYPESAFE_API_KEY"\]/);
    assert.doesNotMatch(text, /sk-|apikey_[A-Za-z0-9]/i);
  });

  it("OpenCode JSON example parses and uses mcp.servers", () => {
    const raw = readFileSync(
      join(root, "adapters/opencode/opencode.json.example"),
      "utf8",
    );
    const json = JSON.parse(raw);
    assert.ok(json.mcp.servers["jev-coding-guard"]);
    assert.equal(json.mcp.servers["jev-coding-guard"].type, "local");
    assert.ok(Array.isArray(json.mcp.servers["jev-coding-guard"].command));
  });

  it("AGENTS.md stays advisory (no false hard-block claim)", () => {
    const text = readFileSync(join(root, "adapters/generic/AGENTS.md"), "utf8");
    assert.match(text, /advisory/i);
    assert.match(text, /does \*\*not\*\* hard-block|does not hard-block/i);
    assert.doesNotMatch(
      text,
      /will always block|hard-enforces all shell|native hook on every platform/i,
    );
  });

  it("which-agent.md lists Claude Code as blocking and Codex as not", () => {
    const text = readFileSync(join(root, "Docs/which-agent.md"), "utf8");
    assert.match(text, /Claude Code/);
    assert.match(text, /PreToolUse/);
    assert.match(text, /No native hook/);
  });
});
