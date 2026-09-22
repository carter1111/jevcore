#!/usr/bin/env node
/**
 * Advisory host integration check. Never prints config values or secrets.
 * Does not write ~/.cursor, ~/.claude, or force a host model.
 *
 * Exit 0 unless a present config file is malformed.
 * Missing optional CLIs are SKIP, not failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let failures = 0;

function pass(msg) {
  console.log(`PASS ${msg}`);
}
function skip(msg) {
  console.log(`SKIP ${msg}`);
}
function advisory(msg) {
  console.log(`ADVISORY ${msg}`);
}
function fail(msg) {
  failures += 1;
  console.log(`FAIL ${msg}`);
}

const mcpPath = join(homedir(), ".cursor", "mcp.json");
if (!existsSync(mcpPath)) {
  skip("cursor mcp.json not present");
} else {
  try {
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8"));
    const servers = cfg?.mcpServers ?? {};
    if (servers["jev-coding-guard"]) pass("cursor mcp.json lists jev-coding-guard");
    else advisory("cursor mcp.json has no jev-coding-guard server entry");
  } catch {
    fail("cursor mcp.json is not valid JSON");
  }
}

const claude = spawnSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 20_000 });
if (claude.error && claude.error.code === "ENOENT") {
  skip("claude CLI not installed");
} else if (claude.status !== 0) {
  advisory("claude mcp list did not exit 0 (operator environment)");
} else {
  const out = `${claude.stdout || ""}`;
  if (/jev-coding-guard/i.test(out) && /connected/i.test(out)) {
    pass("claude mcp lists jev-coding-guard as connected");
  } else if (/jev-coding-guard/i.test(out)) {
    advisory("claude mcp lists jev-coding-guard but not Connected");
  } else {
    advisory("claude mcp list has no jev-coding-guard entry (operator install)");
  }
}

console.log("");
console.log("Hosts are not forced to honor modelSelection. This check does not change config.");
console.log("Host model forcing: BLOCKED (no apply path; advisory modelSelection only).");
console.log(failures === 0 ? "verify-hosts: ok" : "verify-hosts: failed");
process.exit(failures === 0 ? 0 : 1);
