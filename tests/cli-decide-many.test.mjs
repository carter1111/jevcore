/**
 * C-5 — `jev-guard decide-many` CLI (offline RuleProvider).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  parseDecideManyInput,
  parseDecideManyStrategy,
  parseDecideManyLive,
} from "../dist/cli.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function runDecideMany(input, args = ["--stdin", "--json"]) {
  return spawnSync(process.execPath, [CLI, "decide-many", ...args], {
    encoding: "utf8",
    input,
  });
}

describe("jev-guard decide-many CLI", () => {
  it("parseDecideManyInput accepts task + hints", () => {
    const r = parseDecideManyInput(
      JSON.stringify([{ task: "rename helper", hints: { touchedFiles: ["src/a.ts"] } }]),
    );
    assert.ok(Array.isArray(r));
    assert.equal(r[0].task, "rename helper");
  });

  it("parseDecideManyStrategy reads serial|shared_system_one", () => {
    assert.equal(parseDecideManyStrategy(["--strategy", "serial"]), "serial");
    assert.equal(parseDecideManyStrategy(["--strategy", "shared_system_one"]), "shared_system_one");
    assert.equal(parseDecideManyStrategy(["--json"]), undefined);
  });

  it("parseDecideManyLive detects --live", () => {
    assert.equal(parseDecideManyLive(["--live"]), true);
    assert.equal(parseDecideManyLive(["--stdin"]), false);
  });

  it("shared_system_one without --live exits 4", () => {
    const r = runDecideMany(JSON.stringify([{ task: "a" }]), [
      "--stdin",
      "--strategy",
      "shared_system_one",
    ]);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /requires --live/);
  });

  it("parseDecideManyInput rejects non-array", () => {
    const r = parseDecideManyInput("{}");
    assert.equal(r.error, "stdin must be a JSON array");
  });

  it("returns exit 0 or 3 for low-risk tasks (never block)", () => {
    const r = runDecideMany(JSON.stringify([{ task: "fix typo in readme" }, { task: "rename local variable" }]));
    assert.ok(r.status === 0 || r.status === 3);
    const body = JSON.parse(r.stdout);
    assert.equal(body.count, 2);
    assert.notEqual(body.items[0].mode, "block");
  });

  it("returns exit 1 when any item blocks", () => {
    const r = runDecideMany(
      JSON.stringify([
        { task: "ordinary edit", hints: { touchedFiles: ["src/util.ts"] } },
        { task: "touch secrets", hints: { touchedFiles: ["credentials/app.json"] } },
      ]),
    );
    assert.equal(r.status, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.items[1].mode, "block");
    assert.ok(body.items[1].reasons.some((x) => x.code === "POL-SECRETS-1"));
  });

  it("returns exit 4 for empty stdin", () => {
    const r = runDecideMany("   ");
    assert.equal(r.status, 4);
  });

  it("returns exit 4 when over max-items", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({ task: `t${i}` }));
    const r = runDecideMany(JSON.stringify(inputs), ["--stdin", "--json", "--max-items", "4"]);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /exceeds maxItems/);
  });

  it("--stream emits NDJSON lines and can still exit 1 on block", () => {
    const r = runDecideMany(
      JSON.stringify([
        { task: "ordinary edit", hints: { touchedFiles: ["src/util.ts"] } },
        { task: "touch secrets", hints: { touchedFiles: ["credentials/app.json"] } },
      ]),
      ["--stdin", "--json", "--stream"],
    );
    assert.equal(r.status, 1);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const rows = lines.map((l) => JSON.parse(l));
    assert.ok(rows.every((x) => x.stream === true));
    assert.ok(rows.some((x) => x.mode === "block"));
  });

  it("--stream rejects shared_system_one", () => {
    const r = runDecideMany(JSON.stringify([{ task: "a" }]), [
      "--stdin",
      "--stream",
      "--live",
      "--strategy",
      "shared_system_one",
    ]);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /serial strategy only/);
  });
});
