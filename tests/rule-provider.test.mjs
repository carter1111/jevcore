/**
 * C-3 — RuleProvider fidelity: domain disambiguation, confidence, corpus agreement.
 * Offline only (no network).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RuleProvider } from "../dist/fallback.js";

const CORPUS = JSON.parse(
  readFileSync(new URL("./corpus/fixtures.json", import.meta.url), "utf8"),
);

describe("RuleProvider C-3 fidelity", () => {
  const p = new RuleProvider();

  it("does not classify design/auth/lexer token wording as web3", async () => {
    const cases = [
      {
        task: "Rename the design token color variables in the stylesheet",
        files: ["web/tokens.css"],
        kind: "frontend",
      },
      {
        task: "Refactor the auth token refresh logic in the session middleware",
        files: ["src/middleware/session.ts"],
        kind: "backend",
      },
      {
        task: "Add a token to the lexer for the parser grammar",
        files: ["src/lexer.ts"],
        kind: "backend",
      },
    ];
    for (const c of cases) {
      const j = await p.judge({
        task: c.task,
        hints: { touchedFiles: c.files },
      });
      assert.equal(j.failed, false);
      assert.equal(j.kind, c.kind, c.task);
      assert.notEqual(j.kind, "web3", c.task);
    }
  });

  it("classifies strong web3 tasks as web3 (erc20 / solidity)", async () => {
    const erc = await p.judge({
      task: "Add an erc20 approve call for the settlement contract",
      hints: { touchedFiles: ["contracts/Settlement.sol"] },
    });
    assert.equal(erc.kind, "web3");
    assert.ok((erc.kindConfidence ?? 0) >= 0.75);

    const sol = await p.judge({
      task: "Deploy the new solidity contract to the test chain",
      hints: { touchedFiles: ["contracts/Staking.sol"] },
    });
    assert.equal(sol.kind, "web3", "must not prefer testing from 'test chain'");
  });

  it("uses path hints for devops / testing / research", async () => {
    const devops = await p.judge({
      task: "Enable dependency caching in the continuous integration pipeline",
      hints: { touchedFiles: [".github/workflows/ci.yml"] },
    });
    assert.equal(devops.kind, "devops");

    const testing = await p.judge({
      task: "Add a unit test for the date formatting helper",
      hints: { touchedFiles: ["src/dates.test.ts"] },
    });
    assert.equal(testing.kind, "testing");

    const research = await p.judge({
      task: "Fix a typo in the contributing guide",
      hints: { touchedFiles: ["docs/CONTRIBUTING.md"] },
    });
    assert.equal(research.kind, "research");
  });

  it("varies kindConfidence with match strength (not a fixed 0.8)", async () => {
    const strong = await p.judge({
      task: "Upgrade the proxy implementation contract for the staking module",
      hints: { touchedFiles: ["contracts/Staking.sol"] },
    });
    const weak = await p.judge({ task: "Improve the system" });
    assert.equal(strong.kind, "web3");
    assert.equal(weak.kind, "general");
    assert.ok((strong.kindConfidence ?? 0) > (weak.kindConfidence ?? 0));
    assert.ok((weak.kindConfidence ?? 1) <= 0.5);
  });

  it("agrees with corpus expectedKind on a high share of fixtures (offline)", async () => {
    let comparable = 0;
    let agree = 0;
    const misses = [];
    for (const f of CORPUS.fixtures) {
      const expected = f.semanticExpectation?.expectedKind;
      if (!expected) continue;
      comparable += 1;
      const j = await p.judge({
        task: f.task,
        hints: {
          touchedFiles: f.touchedFiles ?? f.changedFiles ?? [],
          context: f.repositoryContext ?? null,
        },
      });
      if (j.kind === expected) agree += 1;
      else misses.push({ id: f.id, expected, got: j.kind });
    }
    assert.ok(comparable >= 30, `expected many labeled fixtures, got ${comparable}`);
    const rate = agree / comparable;
    // Floor: C-3 target — clear improvement over prior bare-token false positives.
    assert.ok(
      rate >= 0.7,
      `RuleProvider corpus kind agreement ${agree}/${comparable}=${rate.toFixed(3)}; misses=${JSON.stringify(misses)}`,
    );
  });
});
