// tests/domain-packs.test.mjs — WP5.1 Round-1 domain packs + selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN_PACK_IDS,
  DOMAIN_PACK_VERSION,
  DOMAIN_PACKS,
  selectDomainPack,
} from "../dist/domain-packs.js";
import { QUESTION_PACK_V1 } from "../dist/question-packs.js";
import { FanOutProvider } from "../dist/fan-out.js";

const RISK_FACTORS = ["scope", "destructive", "data", "security", "irreversible", "unclear"];
const TASK_KINDS = ["frontend", "backend", "web3", "devops", "testing", "research", "general"];

function nearThreshold(overrides = {}) {
  return {
    kind: "backend",
    kindConfidence: 0.9,
    riskScore: 0.55,
    riskConfidence: 0.9,
    riskFactors: [],
    securityReviewNoul: 0.05,
    failed: false,
    ...overrides,
  };
}

test("domain-packs: every id has a pack with distinct version and full shape", () => {
  assert.equal(typeof DOMAIN_PACK_VERSION, "string");
  assert.equal(DOMAIN_PACK_IDS.length, 5);
  for (const id of DOMAIN_PACK_IDS) {
    const pack = DOMAIN_PACKS[id];
    assert.ok(pack, id);
    assert.ok(pack.version.includes(id), pack.version);
    assert.deepEqual(Object.keys(pack.kind.criteria).sort(), TASK_KINDS.slice().sort());
    assert.deepEqual(Object.keys(pack.factors).sort(), RISK_FACTORS.slice().sort());
    assert.ok(pack.risk.levels.length >= 2);
    assert.notEqual(pack.version, QUESTION_PACK_V1.version);
  }
});

test("domain-packs: select by Round-0 kind web3", () => {
  const sel = selectDomainPack({
    input: { task: "refactor a helper" },
    round0: nearThreshold({ kind: "web3" }),
  });
  assert.equal(sel.id, "web3");
  assert.equal(sel.reason, "DP-KIND-WEB3");
});

test("domain-packs: select authz from security factor", () => {
  const sel = selectDomainPack({
    input: { task: "adjust a service" },
    round0: nearThreshold({ riskFactors: ["security"] }),
  });
  assert.equal(sel.id, "authz");
  assert.equal(sel.reason, "DP-FACTOR-SECURITY");
});

test("domain-packs: select database from data factor", () => {
  const sel = selectDomainPack({
    input: { task: "change a module" },
    round0: nearThreshold({ riskFactors: ["data"] }),
  });
  assert.equal(sel.id, "database");
  assert.equal(sel.reason, "DP-FACTOR-DATA");
});

test("domain-packs: select deploy from devops kind", () => {
  const sel = selectDomainPack({
    input: { task: "update a workflow" },
    round0: nearThreshold({ kind: "devops" }),
  });
  assert.equal(sel.id, "deploy");
  assert.equal(sel.reason, "DP-KIND-DEVOPS");
});

test("domain-packs: select deploy from mentionsProd hint", () => {
  const sel = selectDomainPack({
    input: { task: "ship a config tweak", hints: { mentionsProd: true } },
    round0: nearThreshold(),
  });
  assert.equal(sel.id, "deploy");
  assert.equal(sel.reason, "DP-HINTS-PROD");
});

test("domain-packs: select uncertainty from fan-out unclear reason", () => {
  const sel = selectDomainPack({
    input: { task: "do the thing" },
    round0: nearThreshold({ riskFactors: ["unclear"] }),
    fanOutReason: "FO-UNCLEAR-FACTOR",
  });
  assert.equal(sel.id, "uncertainty");
  assert.equal(sel.reason, "DP-FANOUT-UNCLEAR");
});

test("domain-packs: keyword tie-breaker for migration text", () => {
  const sel = selectDomainPack({
    input: { task: "add a prisma migration for users" },
    round0: nearThreshold(),
  });
  assert.equal(sel.id, "database");
  assert.equal(sel.reason, "DP-KEYWORD-DATABASE");
});

test("domain-packs: default to uncertainty when no signal", () => {
  const sel = selectDomainPack({
    input: { task: "rename a local variable" },
    round0: nearThreshold(),
  });
  assert.equal(sel.id, "uncertainty");
  assert.equal(sel.reason, "DP-DEFAULT-UNCERTAINTY");
});

test("domain-packs: FanOutProvider Round 1 passes selected packId", async () => {
  class RecordingProvider {
    calls = [];
    async judge(_input, options) {
      this.calls.push(options ?? null);
      return nearThreshold({ kind: "web3", riskFactors: [] });
    }
  }
  const inner = new RecordingProvider();
  let observed;
  const provider = new FanOutProvider(inner, {
    onFanOut: (info) => {
      observed = info;
    },
  });
  await provider.judge({ task: "review an on-chain path" });
  assert.equal(inner.calls.length, 2);
  assert.equal(inner.calls[0], null, "Round 0 uses default pack (no options)");
  assert.equal(inner.calls[1]?.packId, "web3");
  assert.equal(inner.calls[1]?.questionSet, "verify");
  assert.ok(inner.calls[1]?.pack);
  assert.equal(observed?.packId, "web3");
  assert.equal(observed?.calls, 2);
});
