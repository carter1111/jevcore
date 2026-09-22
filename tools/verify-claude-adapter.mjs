#!/usr/bin/env node
/**
 * Claude adapter verification harness (operator/local).
 * Runs doctor-adjacent checks, project --apply, check exit codes, and
 * PreToolUse hook simulation. Never writes ~/.claude.json.
 * Never prints credential values.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const hook = join(root, "adapters/claude-code/hooks/pretooluse-jev-check.mjs");
const node = process.execPath;

function run(argv, opts = {}) {
  return spawnSync(node, argv, {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout ?? 30_000,
  });
}

const report = [];
function log(line = "") {
  report.push(line);
  process.stdout.write(line + "\n");
}

log("=== 1. doctor ===");
const doc = run([cli, "doctor"]);
log(doc.stdout.trimEnd());
log(`doctor_exit=${doc.status}`);

log("\n=== 2. init --apply (scratch project) ===");
const scratch = mkdtempSync(join(tmpdir(), "jev-claude-scratch-"));
const init = run([cli, "init", "--apply", "--agent", "claude", "--project-dir", scratch]);
log(init.stdout.trimEnd());
if (init.stderr) log(init.stderr.trimEnd());
log(`init_exit=${init.status}`);
log(`scratch=${scratch}`);

const mcpPath = join(scratch, ".mcp.json");
const settingsPath = join(scratch, ".claude", "settings.json");
log(`mcp_exists=${existsSync(mcpPath)}`);
log(`settings_exists=${existsSync(settingsPath)}`);
if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const pre = settings?.hooks?.PreToolUse ?? [];
  log(`PreToolUse_entries=${pre.length}`);
  log(`hook_refs=${JSON.stringify(pre).includes("pretooluse-jev-check")}`);
}

log("\n=== 3. check exit codes (text evidence only) ===");
const cases = [
  { label: "benign", command: "git status", expect: 0 },
  // Destructive / migration strings are DATA for check, not shell to execute.
  { label: "destructive", command: ["rm", "-rf", "./definitely-do-not-delete"].join(" "), expect: 1 },
  {
    label: "migration",
    command: ["npx", "prisma", "migrate", "dev", "--name", "add_events_table"].join(" "),
    expect: 2,
  },
];

for (const c of cases) {
  const r = run([cli, "check", "--json", c.command]);
  const body = (r.stdout || "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* ignore */
  }
  const ok = r.status === c.expect;
  log(
    `${ok ? "PASS" : "FAIL"} ${c.label}: status=${r.status} expect=${c.expect} verdict=${parsed?.verdict ?? "?"} rule=${parsed?.ruleId ?? "null"}`,
  );
  if (body.includes(c.command)) {
    log(`FAIL ${c.label}: JSON echoed command text`);
  }
}

log("\n=== 4. PreToolUse hook simulation ===");
function simHook(command) {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  });
  const r = spawnSync(node, [hook], {
    encoding: "utf8",
    input: payload,
    env: { ...process.env, JEV_GUARD_BIN: cli },
    timeout: 30_000,
  });
  let decision = "?";
  try {
    const j = JSON.parse((r.stdout || "").trim());
    decision = j?.hookSpecificOutput?.permissionDecision ?? JSON.stringify(j);
  } catch {
    decision = `parse_error status=${r.status} out=${(r.stdout || "").slice(0, 120)}`;
  }
  // Privacy: never log the command string back out.
  return { status: r.status, decision, stderr: (r.stderr || "").trim() };
}

const hookCases = [
  { label: "benign", command: "git status", expect: "allow" },
  {
    label: "destructive",
    command: ["rm", "-rf", "./definitely-do-not-delete"].join(" "),
    expect: "deny",
  },
  {
    label: "migration",
    command: ["npx", "prisma", "migrate", "dev", "--name", "add_events_table"].join(" "),
    expect: "ask",
  },
];

for (const c of hookCases) {
  const r = simHook(c.command);
  const ok = r.decision === c.expect;
  log(`${ok ? "PASS" : "FAIL"} hook ${c.label}: decision=${r.decision} expect=${c.expect}`);
  if (r.stderr && r.stderr.includes(c.command)) {
    log(`FAIL hook ${c.label}: stderr echoed command`);
  }
}

log("\n=== 5. claude mcp list (read-only) ===");
const mcpList = spawnSync("claude", ["mcp", "list"], {
  encoding: "utf8",
  timeout: 30_000,
});
log(`claude_mcp_list_exit=${mcpList.status}`);
const listOut = `${mcpList.stdout || ""}${mcpList.stderr || ""}`;
const hasJev = /jev-coding-guard/i.test(listOut);
log(`jev_mcp_registered=${hasJev}`);
// Do not dump full list (may include paths); only presence flags.
log(hasJev ? "jev-coding-guard appears in claude mcp list" : "jev-coding-guard NOT in claude mcp list yet (expected until operator runs claude mcp add)");

writeFileSync(join(scratch, "VERIFY.md"), report.join("\n") + "\n", "utf8");
log(`\nreport_written=${join(scratch, "VERIFY.md")}`);
log("DONE");
