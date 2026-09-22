/**
 * T11 — model advice (max) + read-first / skills relay.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_MODEL_ADVICE_CATALOG,
  resolveModelAdvice,
  selectAdviceTier,
  shouldShowModelAdvice,
  resolveReadFirst,
  resolveRecommendedSkills,
  composeAgentFromEngineResult,
} from "../dist/agent/index.js";

describe("model advice catalog", () => {
  it("includes max", () => {
    assert.deepEqual([...AGENT_MODEL_ADVICE_CATALOG], [
      "fast",
      "normal",
      "reasoning",
      "max",
    ]);
  });
});

describe("selectAdviceTier / visibility", () => {
  it("escalates to max for large + approval/block/security", () => {
    assert.equal(
      selectAdviceTier({
        locale: "en",
        routingTier: "reasoning",
        complexity: "large",
        mode: "approval_required",
      }),
      "max",
    );
    assert.equal(
      selectAdviceTier({
        locale: "en",
        routingTier: "normal",
        complexity: "large",
        mode: "execute",
        securityReviewNeeded: true,
      }),
      "max",
    );
    assert.equal(
      selectAdviceTier({
        locale: "en",
        routingTier: "fast",
        complexity: "small",
        mode: "execute",
      }),
      "fast",
    );
  });

  it("when_not_fast hides fast; always shows; never hides all", () => {
    assert.equal(shouldShowModelAdvice("fast", "when_not_fast"), false);
    assert.equal(shouldShowModelAdvice("normal", "when_not_fast"), true);
    assert.equal(shouldShowModelAdvice("max", "never"), false);
    assert.equal(shouldShowModelAdvice("fast", "always"), true);

    const hidden = resolveModelAdvice({
      locale: "en",
      routingTier: "fast",
      complexity: "small",
      mode: "execute",
      visibility: "when_not_fast",
    });
    assert.equal(hidden, undefined);

    const shown = resolveModelAdvice({
      locale: "en",
      routingTier: "reasoning",
      complexity: "large",
      mode: "block",
      visibility: "when_not_fast",
    });
    assert.equal(shown?.tier, "max");
    assert.equal(shown?.hostAutoApplied, false);
    assert.match(shown?.reason ?? "", /max|not auto/i);
  });
});

describe("read-first / skills relay", () => {
  it("caps paths and drops junk", () => {
    const paths = resolveReadFirst([
      "src/a.ts",
      "src/a.ts",
      "x\ny",
      "",
      "src/b.ts",
      ...Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
    ]);
    assert.ok(paths);
    assert.ok(paths.length <= 12);
    assert.equal(paths[0], "src/a.ts");
    assert.ok(!paths.some((p) => p.includes("\n")));
  });

  it("filters skill ids", () => {
    assert.deepEqual(resolveRecommendedSkills(["security", "Bad Skill", "web3"]), [
      "security",
      "web3",
    ]);
  });
});

describe("compose wires advice + readFirst", () => {
  it("attaches max advice and readFirst on large approval path", () => {
    const agent = composeAgentFromEngineResult({
      mode: "approval_required",
      classification: { source: "hard_policy" },
      reasons: [{ code: "POL-PROD-1", detail: "production" }],
      fellBack: false,
      security: { reviewNeeded: true },
      routing: {
        complexity: "large",
        recommendedModelTier: "reasoning",
        recommendedSkillBundle: ["devops", "security"],
      },
      contextSuggestion: { paths: ["src/deploy.ts", "infra/prod.yml"] },
    });
    assert.equal(agent.modelAdvice?.tier, "max");
    assert.equal(agent.modelAdvice?.hostAutoApplied, false);
    assert.deepEqual(agent.readFirst, ["src/deploy.ts", "infra/prod.yml"]);
    assert.deepEqual(agent.recommendedSkills, ["devops", "security"]);
  });
});
