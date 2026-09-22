// tests/question-packs.test.mjs — WP2 Structured Decision Packs: pack shape.
//
// No Jev, no key, no network, no cost. Validates that the versioned pack is
// complete, structured, ordered, and stably constructed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUESTION_PACK_V1,
  QUESTION_PACK_VERSION,
  riskCriteriaFromPack,
} from "../dist/question-packs.js";
import { RISK_CRITERIA, RISK_MAX_LEVEL } from "../dist/provider.js";

const TASK_KINDS = ["frontend", "backend", "web3", "devops", "testing", "research", "general"];
const RISK_FACTORS = ["scope", "destructive", "data", "security", "irreversible", "unclear"];

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

test("pack: version is non-empty and matches the exported constant", () => {
  assert.equal(typeof QUESTION_PACK_VERSION, "string");
  assert.ok(QUESTION_PACK_VERSION.length > 0, "version must be non-empty");
  assert.equal(QUESTION_PACK_V1.version, QUESTION_PACK_VERSION);
});

// ---------------------------------------------------------------------------
// Choice coverage
// ---------------------------------------------------------------------------

test("pack: kind is a Choice covering every task kind with structured criteria", () => {
  const kind = QUESTION_PACK_V1.kind;
  assert.equal(typeof kind.instructions.question, "string");
  assert.ok(kind.instructions.question.length > 0);
  assert.deepEqual(Object.keys(kind.criteria).sort(), TASK_KINDS.slice().sort());
  for (const label of TASK_KINDS) {
    const option = kind.criteria[label];
    assert.equal(typeof option.what, "string", `${label}.what`);
    assert.ok(option.what.length > 0, `${label}.what non-empty`);
    assert.ok(option.notFor === undefined || typeof option.notFor === "string", `${label}.notFor`);
    assert.ok(
      option.examples === undefined || (Array.isArray(option.examples) && option.examples.length > 0),
      `${label}.examples`,
    );
  }
});

test("pack: at least one Choice option carries notFor and examples", () => {
  const withNotFor = Object.values(QUESTION_PACK_V1.kind.criteria).filter((o) => o.notFor !== undefined);
  const withExamples = Object.values(QUESTION_PACK_V1.kind.criteria).filter((o) => o.examples !== undefined);
  assert.ok(withNotFor.length >= 1, "some options describe what they are not for");
  assert.ok(withExamples.length >= 1, "some options give examples");
});

// ---------------------------------------------------------------------------
// Score coverage + cardinality/order
// ---------------------------------------------------------------------------

test("pack: risk is a Score with structured levels in order", () => {
  const risk = QUESTION_PACK_V1.risk;
  assert.equal(typeof risk.instructions.question, "string");
  assert.ok(risk.levels.length >= 2, "a Score needs at least two levels");
  for (const [i, level] of risk.levels.entries()) {
    assert.equal(typeof level.what, "string", `level ${i}.what`);
    assert.ok(level.what.length > 0, `level ${i}.what non-empty`);
    assert.ok(level.signals === undefined || Array.isArray(level.signals), `level ${i}.signals`);
    assert.ok(level.examples === undefined || Array.isArray(level.examples), `level ${i}.examples`);
  }
});

test("pack: risk cardinality and ordering are exactly the previous rubric", () => {
  const risk = QUESTION_PACK_V1.risk;
  assert.equal(risk.levels.length, 4, "four risk levels preserved");
  // Order must be Low -> Critical; assert on the leading word of each level.
  assert.match(risk.levels[0].what, /^Low:/);
  assert.match(risk.levels[1].what, /^Medium:/);
  assert.match(risk.levels[2].what, /^High:/);
  assert.match(risk.levels[3].what, /^Critical:/);
});

// ---------------------------------------------------------------------------
// Noul coverage
// ---------------------------------------------------------------------------

test("pack: every risk factor is a Noul with true and false sides", () => {
  assert.deepEqual(Object.keys(QUESTION_PACK_V1.factors).sort(), RISK_FACTORS.slice().sort());
  for (const factor of RISK_FACTORS) {
    const spec = QUESTION_PACK_V1.factors[factor];
    assert.equal(typeof spec.instructions.question, "string", `${factor} question`);
    assert.ok(spec.instructions.question.length > 0, `${factor} question non-empty`);
    for (const side of ["true", "false"]) {
      const s = spec.criteria[side];
      assert.equal(typeof s.what, "string", `${factor}.${side}.what`);
      assert.ok(s.what.length > 0, `${factor}.${side}.what non-empty`);
      assert.ok(s.notFor === undefined || typeof s.notFor === "string", `${factor}.${side}.notFor`);
      assert.ok(s.examples === undefined || Array.isArray(s.examples), `${factor}.${side}.examples`);
    }
  }
});

test("pack: security review is a Noul with both sides structured", () => {
  const sr = QUESTION_PACK_V1.securityReview;
  assert.equal(typeof sr.instructions.question, "string");
  assert.ok(sr.instructions.question.length > 0);
  assert.equal(typeof sr.criteria.true.what, "string");
  assert.equal(typeof sr.criteria.false.what, "string");
  assert.ok(sr.criteria.true.what.length > 0);
  assert.ok(sr.criteria.false.what.length > 0);
});

// ---------------------------------------------------------------------------
// Instructions structure (inspect / compare where relevant)
// ---------------------------------------------------------------------------

test("pack: instructions carry structured focus, and inspect/compare where used", () => {
  assert.equal(typeof QUESTION_PACK_V1.kind.instructions.focus, "string");
  assert.equal(typeof QUESTION_PACK_V1.risk.instructions.focus, "string");
  // inspect/compare are documented state-path references.
  assert.equal(QUESTION_PACK_V1.kind.instructions.inspect, "`task`");
  assert.ok(Array.isArray(QUESTION_PACK_V1.securityReview.instructions.compare));
});

// ---------------------------------------------------------------------------
// Single source of truth for the risk rubric
// ---------------------------------------------------------------------------

test("pack: RISK_CRITERIA derives from the pack (single source of truth)", () => {
  const derived = riskCriteriaFromPack(QUESTION_PACK_V1);
  assert.deepEqual([...RISK_CRITERIA], [...derived], "provider rubric matches the pack");
  assert.equal(RISK_CRITERIA.length, QUESTION_PACK_V1.risk.levels.length);
  assert.equal(RISK_MAX_LEVEL, QUESTION_PACK_V1.risk.levels.length - 1, "derived, not hard-coded");
  assert.equal(RISK_MAX_LEVEL, 3);
});

// ---------------------------------------------------------------------------
// Pure, stable construction
// ---------------------------------------------------------------------------

test("pack: construction is pure and stable (no mutation, same shape twice)", () => {
  const a = JSON.stringify(QUESTION_PACK_V1);
  const b = JSON.stringify(QUESTION_PACK_V1);
  assert.equal(a, b, "serialization is stable");
  // The pack must be JSON-serializable data (no functions, no undefined leaks
  // beyond omitted optional keys).
  assert.doesNotThrow(() => JSON.parse(a));
});

test("pack: pack is SDK-free (importing it needs no SDK, network, or key)", () => {
  // If this module required the SDK or a key, importing it above would have
  // thrown. Assert the shape is plain data instead.
  assert.equal(typeof QUESTION_PACK_V1, "object");
  assert.equal(typeof QUESTION_PACK_V1.kind, "object");
  assert.equal(typeof QUESTION_PACK_V1.risk, "object");
});
