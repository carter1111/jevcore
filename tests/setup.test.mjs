/**
 * P3 — jev-guard init / doctor.
 * No network, no real credential values asserted, tmp dirs cleaned up.
 */
import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  credentialPresent,
  detectAgents,
  formatDoctor,
  runDoctor,
  runInit,
} from "../dist/setup.js";

const root = process.cwd();
const CLI = join(root, "dist", "cli.js");

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

function tmpDir(prefix = "jev-setup-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

describe("detectAgents", () => {
  it("finds Cursor when ~/.cursor exists", () => {
    const home = tmpDir();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), "{}\n");
    const agents = detectAgents({ home, cwd: tmpDir() });
    assert.ok(agents.some((a) => a.id === "cursor"));
  });

  it("finds Claude when project .mcp.json exists", () => {
    const home = tmpDir();
    const cwd = tmpDir();
    writeFileSync(join(cwd, ".mcp.json"), "{}\n");
    const agents = detectAgents({ home, cwd });
    assert.ok(agents.some((a) => a.id === "claude"));
  });
});

describe("credentialPresent", () => {
  it("reports env presence without returning the value", () => {
    const r = credentialPresent({ TYPESAFE_API_KEY: "secret-should-not-leak" }, join(tmpDir(), "none.env"));
    assert.equal(r.present, true);
    assert.equal(r.source, "env");
    assert.ok(!JSON.stringify(r).includes("secret-should-not-leak"));
  });

  it("reports absent when unset", () => {
    const r = credentialPresent({ TYPESAFE_API_KEY: "" }, join(tmpDir(), "missing.env"));
    assert.equal(r.present, false);
    assert.equal(r.source, "absent");
  });
});

describe("runDoctor", () => {
  it("is read-only and never prints a credential value", () => {
    const secret = "super-secret-key-value-xyz";
    const result = runDoctor({
      repoRoot: root,
      env: { ...process.env, TYPESAFE_API_KEY: secret },
    });
    const text = formatDoctor(result);
    assert.ok(!text.includes(secret));
    assert.match(text, /value not shown|present in env/i);
    assert.ok(result.checks.some((c) => c.id === "dist-built"));
    assert.ok(result.checks.some((c) => c.id === "credential"));
  });

  it("detects a non-executable hook as FAIL", () => {
    const fakeRepo = tmpDir();
    mkdirSync(join(fakeRepo, "adapters", "claude-code", "hooks"), { recursive: true });
    mkdirSync(join(fakeRepo, "dist"), { recursive: true });
    writeFileSync(join(fakeRepo, "dist", "cli.js"), "// stub\n");
    writeFileSync(join(fakeRepo, "dist", "mcp-server.js"), "// stub\n");
    const hook = join(fakeRepo, "adapters", "claude-code", "hooks", "pretooluse-jev-check.mjs");
    writeFileSync(hook, "#!/usr/bin/env node\n");
    chmodSync(hook, 0o644);
    const result = runDoctor({ repoRoot: fakeRepo, env: { ...process.env } });
    const row = result.checks.find((c) => c.id === "hook-executable");
    assert.ok(row);
    assert.equal(row.severity, "fail");
    assert.match(row.detail, /chmod \+x|not executable/);
  });
});

describe("runInit", () => {
  it("dry-run writes nothing", () => {
    const project = tmpDir();
    const home = tmpDir();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const before = new Set(
      spawnSync("find", [project, "-type", "f"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean),
    );
    const result = runInit({
      repoRoot: root,
      projectDir: project,
      home,
      agent: "claude",
      apply: false,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /dry-run/i);
    const after = spawnSync("find", [project, "-type", "f"], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean);
    assert.deepEqual(after, [...before]);
  });

  it("apply is idempotent for Claude project files", () => {
    const project = tmpDir();
    const home = tmpDir();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const first = runInit({
      repoRoot: root,
      projectDir: project,
      home,
      agent: "claude",
      apply: true,
    });
    assert.equal(first.exitCode, 0, first.text);
    assert.ok(existsSync(join(project, ".mcp.json")));
    assert.ok(existsSync(join(project, ".claude", "settings.json")));
    const settings1 = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    const second = runInit({
      repoRoot: root,
      projectDir: project,
      home,
      agent: "claude",
      apply: true,
    });
    assert.equal(second.exitCode, 0, second.text);
    const settings2 = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    // Second apply must not duplicate PreToolUse bash matchers unboundedly —
    // installer filters prior pretooluse-jev-check entries.
    const count = (settings2.match(/pretooluse-jev-check/g) || []).length;
    assert.ok(count >= 1 && count <= 2, `unexpected hook refs: ${count}`);
    assert.ok(settings2.includes("PreToolUse"));
    assert.ok(settings1.includes("PreToolUse"));
  });
});

test("CLI doctor never echoes TYPESAFE_API_KEY value", () => {
  const secret = "cli-doctor-secret-should-not-appear";
  const res = spawnSync(process.execPath, [CLI, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, TYPESAFE_API_KEY: secret },
  });
  assert.ok(!res.stdout.includes(secret));
  assert.ok(!res.stderr.includes(secret));
});

test("CLI init --help / usage mentions dry-run", () => {
  const res = spawnSync(process.execPath, [CLI, "init", "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /dry-run/i);
});
