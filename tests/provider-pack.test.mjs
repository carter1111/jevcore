// tests/provider-pack.test.mjs — WP2: prove structured criteria reach the SDK.
//
// Uses the installed SDK's supported injectable `fetch` boundary
// (`TypeSafeClientConfig.fetch`) to capture the OUTGOING request body without
// any network, key, or cost. This also closes the long-standing gap that the
// provider layer had no deterministic automated test (TASKS.md C-4).
//
// No Jev, no TYPESAFE_API_KEY, no network, no cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeSafeProvider, buildQuestions, buildVerifyQuestions, RISK_CRITERIA } from "../dist/provider.js";
import { QUESTION_PACK_V1 } from "../dist/question-packs.js";

// ---------------------------------------------------------------------------
// Injectable-fetch harness
// ---------------------------------------------------------------------------

/**
 * A fake `fetch` that records the request body and returns a real `Response`
 * (Node's global `Response`), so the SDK's `bufferResponse`/`clone()`/`text()`
 * path works exactly as it does against the network — without any network.
 */
function captureFetch(canned) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: String(input), body, headers: init?.headers });
    return new Response(JSON.stringify(canned), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

/** A canned response shaped like a real `systemOne` result. */
function cannedAnswers(overrides = {}) {
  return {
    model: "jev-test",
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      kind: { type: "choice", choice: "backend", confidence: 0.9, probabilities: { backend: 0.9 } },
      risk: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: { 1: 0.8 } },
      factor_scope: { type: "noul", noul: 0.1 },
      factor_destructive: { type: "noul", noul: 0.1 },
      factor_data: { type: "noul", noul: 0.1 },
      factor_security: { type: "noul", noul: 0.1 },
      factor_irreversible: { type: "noul", noul: 0.1 },
      factor_unclear: { type: "noul", noul: 0.1 },
      security_review: { type: "noul", noul: 0.1 },
      ...overrides,
    },
  };
}

function providerWith(fetchImpl) {
  return new TypeSafeProvider({ apiKey: "test-key-not-real", fetch: fetchImpl, timeoutMs: 5_000 });
}

/** Parse the captured request body into an object. */
function parseBody(calls) {
  assert.equal(calls.length, 1, "exactly one HTTP call");
  assert.equal(typeof calls[0].body, "string", "request body is a JSON string");
  return JSON.parse(calls[0].body);
}

// ---------------------------------------------------------------------------
// The structured pack reaches the outgoing request
// ---------------------------------------------------------------------------

test("provider-pack: structured Choice criteria reach the SDK request body", async () => {
  const { fetchImpl, calls } = captureFetch(cannedAnswers());
  const provider = providerWith(fetchImpl);

  const judgment = await provider.judge({ task: "add a REST endpoint" });
  assert.equal(judgment.failed, false);

  const body = parseBody(calls);
  const kind = body.questions.kind;
  assert.equal(kind.type, "choice");

  // Structured instructions arrive as an object with question + focus + inspect.
  assert.equal(typeof kind.instructions, "object", "instructions is structured, not a bare string");
  assert.equal(typeof kind.instructions.question, "string");
  assert.equal(typeof kind.instructions.focus, "string");
  assert.equal(kind.instructions.inspect, "`task`");

  // Structured per-option criteria arrive with what/notFor/examples.
  const backend = kind.criteria.backend;
  assert.equal(typeof backend, "object", "option criteria is structured");
  assert.equal(typeof backend.what, "string");
  assert.equal(typeof backend.notFor, "string");
  assert.ok(Array.isArray(backend.examples) && backend.examples.length > 0);

  // Every task kind is present.
  assert.deepEqual(
    Object.keys(kind.criteria).sort(),
    ["backend", "devops", "frontend", "general", "research", "testing", "web3"],
  );
});

test("provider-pack: structured Score levels reach the SDK request body, in order", async () => {
  const { fetchImpl, calls } = captureFetch(cannedAnswers());
  await providerWith(fetchImpl).judge({ task: "x" });

  const risk = parseBody(calls).questions.risk;
  assert.equal(risk.type, "score");
  assert.equal(typeof risk.instructions, "object");
  assert.ok(Array.isArray(risk.criteria), "score criteria is an array (ordered rubric)");
  assert.equal(risk.criteria.length, 4, "four levels preserved");
  assert.equal(risk.criteria.length, RISK_CRITERIA.length, "matches the derived rubric");
  assert.equal(typeof risk.criteria[0].what, "string");
  assert.match(risk.criteria[0].what, /^Low:/);
  assert.match(risk.criteria[3].what, /^Critical:/);
  assert.ok(Array.isArray(risk.criteria[0].signals));
});

test("provider-pack: structured Noul true/false criteria reach the SDK request body", async () => {
  const { fetchImpl, calls } = captureFetch(cannedAnswers());
  await providerWith(fetchImpl).judge({ task: "x" });

  const q = parseBody(calls).questions;
  for (const name of [
    "factor_scope",
    "factor_destructive",
    "factor_data",
    "factor_security",
    "factor_irreversible",
    "factor_unclear",
    "security_review",
  ]) {
    assert.equal(q[name].type, "noul", `${name} is a Noul`);
    assert.equal(typeof q[name].instructions, "object", `${name} instructions structured`);
    assert.equal(typeof q[name].criteria.true.what, "string", `${name}.true.what`);
    assert.equal(typeof q[name].criteria.false.what, "string", `${name}.false.what`);
  }
  // security_review carries a compare reference.
  assert.ok(Array.isArray(q.security_review.instructions.compare));
});

test("provider-pack: question count and names are preserved exactly (9 questions)", async () => {
  const { fetchImpl, calls } = captureFetch(cannedAnswers());
  await providerWith(fetchImpl).judge({ task: "x" });

  const q = parseBody(calls).questions;
  assert.deepEqual(
    Object.keys(q).sort(),
    [
      "factor_data",
      "factor_destructive",
      "factor_irreversible",
      "factor_scope",
      "factor_security",
      "factor_unclear",
      "kind",
      "risk",
      "security_review",
    ],
    "no questions added or removed",
  );
  assert.equal(Object.keys(q).length, 9);
});

test("provider-pack: state is passed through unchanged (task + hints)", async () => {
  const { fetchImpl, calls } = captureFetch(cannedAnswers());
  await providerWith(fetchImpl).judge({
    task: "add a login page",
    hints: { touchedFiles: ["web/login.tsx"], mentionsProd: true, context: "ctx" },
  });

  const body = parseBody(calls);
  assert.equal(body.state.task, "add a login page");
  assert.deepEqual(body.state.touchedFiles, ["web/login.tsx"]);
  assert.equal(body.state.mentionsProduction, true);
  assert.equal(body.state.context, "ctx");
});

// ---------------------------------------------------------------------------
// buildQuestions is a pure builder over the pack
// ---------------------------------------------------------------------------

test("provider-pack: buildVerifyQuestions is slim (no kind, domain factors only)", () => {
  const q = buildVerifyQuestions(QUESTION_PACK_V1, "web3");
  assert.equal(q.kind, undefined);
  assert.ok(q.risk);
  assert.ok(q.security_review);
  assert.ok(q.factor_irreversible);
  assert.ok(q.factor_security);
  assert.equal(q.factor_data, undefined);
  assert.ok(Object.keys(q).length <= 4);
});

test("provider-pack: buildQuestions is pure (same input -> same serialized shape)", () => {
  const a = JSON.stringify(buildQuestions(QUESTION_PACK_V1));
  const b = JSON.stringify(buildQuestions(QUESTION_PACK_V1));
  assert.equal(a, b);
});

test("provider-pack: buildQuestions reflects a modified pack (pack drives the request)", () => {
  // Prove the pack is the source of truth: change one option's `what` and see it
  // appear in the built questions. No network, no provider call.
  const modified = structuredClone(QUESTION_PACK_V1);
  modified.kind.criteria.backend.what = "SENTINEL-BACKEND-WHAT";
  const built = buildQuestions(modified);
  assert.equal(built.kind.criteria.backend.what, "SENTINEL-BACKEND-WHAT");
  // The unmodified pack is untouched (no shared mutation).
  assert.notEqual(QUESTION_PACK_V1.kind.criteria.backend.what, "SENTINEL-BACKEND-WHAT");
});

// ---------------------------------------------------------------------------
// Answer mapping is unchanged by the pack refactor
// ---------------------------------------------------------------------------

test("provider-pack: answer mapping is unchanged (risk normalization still applies)", async () => {
  const { fetchImpl } = captureFetch(cannedAnswers({ risk: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} } }));
  const judgment = await providerWith(fetchImpl).judge({ task: "x" });
  assert.equal(judgment.failed, false);
  assert.equal(judgment.kind, "backend");
  assert.equal(judgment.riskScore, 1, "raw level 3 / RISK_MAX_LEVEL 3 = 1");
});

test("provider-pack: invalid risk score still yields a provider failure (no clamping)", async () => {
  const { fetchImpl } = captureFetch(cannedAnswers({ risk: { type: "score", score: 99, confidence: 0.9, legend: {}, probabilities: {} } }));
  const judgment = await providerWith(fetchImpl).judge({ task: "x" });
  assert.equal(judgment.failed, true);
  assert.equal(judgment.failureCode, "PROVIDER-INVALID-RISK-SCORE");
});

test("provider-pack: no network, no key, no live Jev (fetch is fully injected)", async () => {
  // If the provider reached the real network this test would hang or fail; the
  // injected fetch resolves synchronously from canned data.
  const { fetchImpl, calls } = captureFetch(cannedAnswers());
  const provider = new TypeSafeProvider({ fetch: fetchImpl, timeoutMs: 1_000 }); // no apiKey on purpose
  const judgment = await provider.judge({ task: "x" });
  assert.equal(judgment.failed, false, "works with an injected fetch and no real key");
  assert.equal(calls.length, 1, "exactly one injected call");
  assert.match(calls[0].url, /systemone/i, "hit the systemOne endpoint");
});
