// Generate real evidence samples through the LIVE MCP server (real DB path),
// then print the accumulated report. Uses Cursor's real config so data lands
// in ~/.cursor/jev-coding-guard/telemetry.sqlite alongside real usage.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CFG = JSON.parse(readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8"))["mcpServers"]["jev-coding-guard"];
const env = {};
for (const line of readFileSync(CFG.envFile, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const child = spawn(CFG.command, CFG.args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p.resolve(m);
    }
  }
});
const req = (method, params) => {
  const rid = ++id;
  const p = new Promise((r) => pending.set(rid, { resolve: r }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  return p;
};
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sample-gen", version: "1" } });
notify("notifications/initialized", {});

// A realistic mixed workload (de-identified: only decision metadata is stored).
const workload = [
  ["jev_assess_task", { userTask: "Add a button label to a React homepage", repositoryContext: "react web app" }],
  ["jev_assess_task", { userTask: "Add documentation comments to the parser", repositoryContext: "utils" }],
  ["jev_assess_task", { userTask: "Write unit tests for the string helper", repositoryContext: "utils" }],
  ["jev_assess_task", { userTask: "Rewrite the service touching many modules and user data", repositoryContext: "platform" }],
  ["jev_assess_command", { userTask: "Run the linter", repositoryContext: "api", proposedCommand: "npm run lint" }],
  ["jev_assess_command", { userTask: "Clean up build artifacts", repositoryContext: "api", proposedCommand: "npm run clean" }],
  ["jev_assess_command", { userTask: "Apply the local database migration", repositoryContext: "local dev", proposedCommand: "npx prisma migrate dev --name add_events", changedFiles: ["prisma/schema.prisma"] }],
  ["jev_assess_command", { userTask: "Deploy the pending migrations", repositoryContext: "ci", proposedCommand: "pnpm prisma migrate deploy" }],
  ["jev_assess_command", { userTask: "Inspect environment variables", repositoryContext: "api", proposedCommand: "cat .env" }],
  ["jev_assess_command", { userTask: "Push the build to production", repositoryContext: "api", proposedCommand: "git push --force origin main" }],
  ["jev_review_diff", { userTask: "Review the auth middleware change", repositoryContext: "api", changedFiles: ["src/middleware/auth.ts"], diffSummary: "Adds role checks to the auth middleware" }],
  ["jev_review_diff", { userTask: "Review the token approval change", repositoryContext: "web3", changedFiles: ["contracts/Token.sol"], diffSummary: "Adds an approve() call for the spender" }],
  ["jev_review_diff", { userTask: "Review the migration diff", repositoryContext: "api", changedFiles: ["migrations/2026_events.ts"], diffSummary: "Creates the events table and alters user schema" }],
];

console.log("--- decisions being recorded to the LIVE database ---");
for (const [tool, args] of workload) {
  const r = await req("tools/call", { name: tool, arguments: args });
  const d = JSON.parse(r.result.content[0].text);
  console.log(`  ${tool.padEnd(19)} -> ${String(d.executionMode).padEnd(18)} policy=${JSON.stringify(d.selectedPolicyRules ?? [])}`);
}

// Small pause so the async flush lands, then the report.
await new Promise((r) => setTimeout(r, 700));
const rep = await req("tools/call", { name: "jev_guard_report", arguments: { period: "all" } });
process.stdout.write("\n" + rep.result.content[0].text);

child.stdin.end();
child.kill();
process.exit(0);