#!/usr/bin/env node
/**
 * Multi-platform adapter verification (operator/local).
 *
 * Checks adapter templates, doctor, init dry-run, deterministic check exit
 * codes, and delegates Claude-specific hook tests to verify-claude-adapter.mjs.
 * Never prints credential values.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
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
let failures = 0;

function log(line = "") {
  report.push(line);
  process.stdout.write(`${line}\n`);
}

function pass(label) {
  log(`PASS ${label}`);
}

function fail(label, detail = "") {
  failures += 1;
  log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

log("=== 1. adapter templates ===");
const templates = [
  "adapters/claude-code/mcp.json.example",
  "adapters/claude-code/settings.hooks.json.example",
  "adapters/claude-code/hooks/pretooluse-jev-check.mjs",
  "adapters/codex/config.toml.example",
  "adapters/codex/README.md",
  "adapters/opencode/opencode.json.example",
  "adapters/opencode/README.md",
  "adapters/generic/AGENTS.md",
];
for (const rel of templates) {
  const path = join(root, rel);
  if (existsSync(path)) pass(`template ${rel}`);
  else fail(`template ${rel}`, "missing");
}

log("\n=== 2. doctor ===");
const doc = run([cli, "doctor"]);
log(doc.stdout.trimEnd());
if (doc.status === 0) pass("doctor exit 0");
else fail("doctor", `exit ${doc.status}`);

log("\n=== 3. init dry-run (isolated project) ===");
const scratch = mkdtempSync(join(tmpdir(), "jev-adapters-scratch-"));
const init = run([cli, "init", "--agent", "all", "--project-dir", scratch]);
log(init.stdout.trimEnd());
if (init.status === 0) pass("init dry-run exit 0");
else fail("init dry-run", `exit ${init.status}`);

log("\n=== 4. check exit codes ===");
const cases = [
  { label: "benign", command: "git status", expect: 0 },
  { label: "destructive", command: ["rm", "-rf", "./definitely-do-not-delete"].join(" "), expect: 1 },
  {
    label: "migration",
    command: ["npx", "prisma", "migrate", "dev", "--name", "add_events_table"].join(" "),
    expect: 2,
  },
];
for (const c of cases) {
  const r = run([cli, "check", "--json", c.command]);
  if (r.status === c.expect) pass(`check ${c.label} exit ${c.expect}`);
  else fail(`check ${c.label}`, `status=${r.status} expect=${c.expect}`);
}

log("\n=== 5. Claude adapter (delegated) ===");
const claudeVerify = join(root, "tools", "verify-claude-adapter.mjs");
if (!existsSync(claudeVerify)) {
  fail("verify-claude-adapter.mjs", "missing");
} else {
  const child = spawnSync(node, [claudeVerify], {
    encoding: "utf8",
    cwd: root,
    timeout: 120_000,
  });
  const out = `${child.stdout || ""}${child.stderr || ""}`.trim();
  const hookPass = /PASS hook benign/.test(out) && /PASS hook destructive/.test(out);
  const checkPass = /PASS benign: status=0/.test(out);
  if (child.status === 0 && hookPass && checkPass) pass("verify-claude-adapter");
  else {
    fail("verify-claude-adapter", `exit ${child.status ?? "?"}`);
    if (out) log(out.split("\n").slice(-8).join("\n"));
  }
}

log(`\n=== summary: ${failures === 0 ? "ALL PASS" : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
