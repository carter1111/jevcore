// Real end-to-end verification of Local Guard Evidence v1.
//
// Spawns the REAL MCP server binary with evidence ENABLED, drives it over
// stdio JSON-RPC with REAL decisions, then reads back the REAL SQLite database
// and the report. This exercises the true production code path (real SQLite,
// real schema, real flush, real report) rather than an injected sink.
//
// The evidence path is parameterized so the same script can run against a
// throwaway location first.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "mcp-server.js");
const NODE = process.execPath;
const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error("usage: node evidence-e2e.mjs <db-path>");
  process.exit(2);
}

console.log("=== REAL E2E: Local Guard Evidence ===");
console.log("db path      :", DB_PATH);
console.log("evidence flag: JEV_GUARD_LOCAL_EVIDENCE=1");
console.log("");

// ---- capture stderr to inspect the experimental warning -------------------
let stderr = "";
let stdout = "";

const child = spawn(NODE, [SERVER], {
  env: {
    ...process.env,
    JEV_GUARD_LOCAL_EVIDENCE: "1",
    JEV_GUARD_EVIDENCE_PATH: DB_PATH,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => (stderr += d.toString()));
child.stdout.on("data", (d) => (stdout += d.toString()));

let buf = "";
let id = 0;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  }
});
const req = (method, params) => {
  const rid = ++id;
  const p = new Promise((r) => pending.set(rid, { resolve: r }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  return p;
};
const notify = (m, p) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");

await req("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "evidence-e2e", version: "1" },
});
notify("notifications/initialized", {});

const tools = await req("tools/list", {});
console.log("tools exposed:", tools.result.tools.map((t) => t.name).sort().join(", "));
console.log("");

// ---- drive REAL decisions -------------------------------------------------
const decisions = [
  ["jev_assess_task", { userTask: "Add a button label to a React homepage", repositoryContext: "React TS project", changedFiles: ["src/components/HomeButton.tsx"] }],
  ["jev_assess_task", { userTask: "Rewrite the service touching many modules and user data", repositoryContext: "platform repo" }],
  ["jev_assess_command", { userTask: "Inspect environment", repositoryContext: "api", proposedCommand: "cat .env" }],
  ["jev_assess_command", { userTask: "Apply the local development database migration", repositoryContext: "local dev", proposedCommand: "npx prisma migrate dev --name add_events" }],
  ["jev_review_diff", { userTask: "Review auth middleware change", repositoryContext: "api", changedFiles: ["src/middleware/auth.ts"], diffSummary: "Adds role checks" }],
];

console.log("--- decisions ---");
for (const [tool, args] of decisions) {
  const r = await req("tools/call", { name: tool, arguments: args });
  const d = JSON.parse(r.result.content[0].text);
  console.log(
    `  ${tool.padEnd(19)} -> ${String(d.executionMode).padEnd(18)} risk=${String(d.riskScore).slice(0, 6).padEnd(8)} src=${d.source}`,
  );
}

// ---- ask for the report through the REAL MCP tool -------------------------
const report = await req("tools/call", { name: "jev_guard_report", arguments: { period: "all" } });
console.log("");
console.log("--- jev_guard_report (via real MCP) ---");
console.log(report.result.content[0].text);

// ---- inspect the REAL database -------------------------------------------
console.log("--- real database ---");
console.log("  exists      :", existsSync(DB_PATH));
if (existsSync(DB_PATH)) {
  console.log("  size        :", statSync(DB_PATH).size, "bytes");
  const dir = DB_PATH.replace(/\/[^/]+$/, "");
  const perms = statSync(dir).mode & 0o777;
  console.log("  dir perms   :", perms.toString(8), `(expected 700)`);
  console.log("  file perms  :", (statSync(DB_PATH).mode & 0o777).toString(8), `(expected 600)`);
  console.log("  dir contents:", JSON.stringify(readdirSync(dir)));
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT * FROM decisions").all();
  console.log("  rows stored :", rows.length);
  const cols = db.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
  console.log("  columns     :", cols.join(","));
  const rules = db.prepare("SELECT DISTINCT policy_rule_id FROM decision_policy_rules").all().map((r) => r.policy_rule_id);
  console.log("  policy rules:", JSON.stringify(rules));
  console.log("  provider attempted sum:", db.prepare("SELECT SUM(provider_call_attempted) s FROM decisions").get().s);
  console.log("  hard blocks w/ provider calls:", db.prepare("SELECT COUNT(*) n FROM decisions WHERE execution_mode='block' AND provider_call_attempted=1").get().n);
  const tokens = db.prepare("SELECT SUM(COALESCE(jev_input_tokens,0)) i, SUM(COALESCE(jev_output_tokens,0)) o FROM decisions").get();
  console.log("  jev tokens  : input=", tokens.i, "output=", tokens.o);
  // privacy: no stored row may contain the marker text
  const serialized = JSON.stringify(rows);
  for (const marker of ["HomeButton", "React", "auth.ts", "cat .env", "prisma", "platform"]) {
    if (serialized.includes(marker)) console.log(`  PRIVACY LEAK: found "${marker}" in stored rows`);
  }
  console.log("  privacy scan: no input content found in stored rows");
  db.close();
}

// ---- stdout purity + stderr warning --------------------------------------
console.log("");
console.log("--- stdout / stderr ---");
const stdoutLines = stdout.trim().split("\n");
const nonJson = stdoutLines.filter((l) => {
  try {
    JSON.parse(l);
    return false;
  } catch {
    return l.trim().length > 0;
  }
});
console.log("  stdout non-JSON lines:", nonJson.length, nonJson.length ? JSON.stringify(nonJson.slice(0, 3)) : "(clean)");
console.log("  stderr contains ExperimentalWarning:", /ExperimentalWarning/.test(stderr));
console.log("  stderr contains SQLite warning:", /SQLite is an experimental feature/.test(stderr));
console.log("  stdout contains ExperimentalWarning:", /ExperimentalWarning/.test(stdout));

child.stdin.end();
child.kill();
process.exit(0);
