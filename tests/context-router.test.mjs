/**
 * P5 Context Router tests — deterministic, no network, no file-content I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Guard } from "../dist/engine.js";
import {
  applyIdentifierRerank,
  MAX_CONTEXT_PATHS,
  normalizePathId,
  rankContextIds,
  suggestContext,
  suggestContextSync,
  tokenizeTask,
} from "../dist/context-router.js";
import { toDecisionOutput } from "../dist/mcp-server.js";

describe("tokenize / normalize", () => {
  it("drops stopwords and short tokens", () => {
    const t = tokenizeTask("Add the login page to the web app");
    assert.ok(t.includes("login"));
    assert.ok(!t.includes("the"));
    assert.ok(!t.includes("to"));
  });

  it("rejects multiline path ids (content-like)", () => {
    assert.equal(normalizePathId("a.ts\nSECRET=1"), null);
    assert.equal(normalizePathId("src/login.tsx"), "src/login.tsx");
  });
});

describe("rankContextIds", () => {
  it("is stable for a fixed input", () => {
    const ids = ["src/a.ts", "src/login.tsx", "README.md", "src/b.ts"];
    const a = rankContextIds(ids, "update login form", 8);
    const b = rankContextIds(ids, "update login form", 8);
    assert.deepEqual(a.paths, b.paths);
    assert.equal(a.paths[0], "src/login.tsx");
  });

  it("respects hard cap", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const r = rankContextIds(ids, "touch files", 100);
    assert.ok(r.paths.length <= MAX_CONTEXT_PATHS);
  });
});

describe("suggestContextSync", () => {
  it("returns null when no candidates (no fabricate)", () => {
    assert.equal(suggestContextSync({ task: "refactor helpers" }), null);
  });

  it("ranks touched files without reading contents", () => {
    const s = suggestContextSync({
      task: "fix the auth middleware",
      hints: {
        touchedFiles: ["src/ui/button.tsx", "src/auth/middleware.ts", "docs/README.md"],
      },
    });
    assert.ok(s);
    assert.equal(s.source, "deterministic");
    assert.equal(s.paths[0], "src/auth/middleware.ts");
    assert.ok(s.reasonIds.includes("CR-FROM-TOUCHED"));
  });
});

describe("rerank hook", () => {
  it("applyIdentifierRerank never invents paths", () => {
    const base = ["a.ts", "b.ts", "c.ts"];
    const out = applyIdentifierRerank(base, ["c.ts", "evil.ts", "a.ts"]);
    assert.deepEqual(out, ["c.ts", "a.ts", "b.ts"]);
  });

  it("suggestContext can apply identifier-only rerank", async () => {
    const s = await suggestContext(
      {
        task: "work",
        hints: { touchedFiles: ["a.ts", "b.ts", "c.ts"] },
      },
      {
        rerankIdentifiers: (ranked) => [...ranked].reverse(),
      },
    );
    assert.ok(s);
    assert.equal(s.source, "deterministic+rerank");
    assert.deepEqual(s.paths, ["c.ts", "b.ts", "a.ts"]);
  });
});

describe("Guard + MCP wiring", () => {
  it("attaches contextSuggestion on a neutral task", async () => {
    const g = new Guard({
      judge: async () => ({
        kind: "backend",
        kindConfidence: 0.9,
        riskScore: 0.1,
        riskConfidence: 0.9,
        riskFactors: [],
        securityReviewNoul: 0,
        failed: false,
      }),
    });
    const r = await g.decide({
      task: "adjust the shared formatting helper",
      hints: { touchedFiles: ["src/format.ts", "src/util.ts"] },
    });
    assert.equal(r.mode, "execute");
    assert.ok(r.contextSuggestion);
    assert.ok(r.contextSuggestion.paths.includes("src/format.ts"));

    const out = toDecisionOutput(r);
    assert.ok(out.contextSuggestion);
    assert.ok(out.contextSuggestion.paths.length <= MAX_CONTEXT_PATHS);
  });

  it("omits contextSuggestion when no path hints", async () => {
    const g = new Guard({
      judge: async () => ({
        kind: "frontend",
        kindConfidence: 0.95,
        riskScore: 0.1,
        riskConfidence: 0.9,
        riskFactors: [],
        securityReviewNoul: 0,
        failed: false,
      }),
    });
    const r = await g.decide({ task: "Add a button label to a React homepage" });
    assert.equal(r.contextSuggestion, undefined);
  });
});
