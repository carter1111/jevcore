#!/usr/bin/env node
/**
 * tools/fan-out-measure.mjs — fixture-only fan-out measurement (item 2).
 *
 * Runs the golden corpus under FanOutProvider with an uncertain fake so Round 1
 * can trigger when hard policy does not settle. Reports allow rates, reasons,
 * and domain pack selection — content-free JSON only.
 *
 * Fixture-only fan-out measurement (does not mutate MCP defaults).
 *
 *   node tools/fan-out-measure.mjs
 *   npm run measure:fan-out
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Guard } from "../dist/engine.js";
import { FanOutProvider } from "../dist/fan-out.js";
import { decideFanOut, FAN_OUT_POLICY_VERSION } from "../dist/fan-out-policy.js";
import { selectDomainPack, DOMAIN_PACK_VERSION } from "../dist/domain-packs.js";
import { matchPolicy } from "../dist/policy.js";
import { buildEvalManifest } from "../dist/eval-manifest.js";

const CORPUS = JSON.parse(
  readFileSync(new URL("../tests/corpus/fixtures.json", import.meta.url), "utf8"),
);

class UncertainFakeProvider {
  calls = 0;
  lastOptions = null;
  async judge(_input, options) {
    this.calls += 1;
    this.lastOptions = options ?? null;
    return {
      kind: "backend",
      kindConfidence: 0.85,
      riskScore: 0.55,
      riskConfidence: 0.85,
      riskFactors: ["unclear"],
      securityReviewNoul: 0.2,
      failed: false,
    };
  }
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

async function main() {
  const fixtures = CORPUS.fixtures ?? [];
  const thresholds = {
    lowConfidenceThreshold: 0.6,
    planRiskThreshold: 0.5,
    approvalRiskThreshold: 0.8,
    securityReviewThreshold: 0.7,
  };

  const reasons = Object.create(null);
  const packIds = Object.create(null);
  const packSelectReasons = Object.create(null);
  let allowed = 0;
  let denied = 0;
  let hardPolicySettled = 0;
  const observations = [];

  const inner = new UncertainFakeProvider();
  const fanOutObs = [];
  const provider = new FanOutProvider(inner, {
    thresholds,
    onFanOut: (info) => fanOutObs.push(info),
  });
  const guard = new Guard(provider);

  const t0 = performance.now();

  for (const f of fixtures) {
    const input = {
      task: f.task,
      hints: {
        touchedFiles: f.changedFiles ?? f.touchedFiles ?? [],
        context: f.repositoryContext ?? null,
      },
    };

    // Policy settle check (content-free outcome: boolean + rule id only).
    const rule = matchPolicy(input);
    if (rule) hardPolicySettled += 1;

    // Round-0-shaped judgment for decideFanOut (same as uncertain fake).
    const round0 = {
      kind: "backend",
      kindConfidence: 0.85,
      riskScore: 0.55,
      riskConfidence: 0.85,
      riskFactors: ["unclear"],
      securityReviewNoul: 0.2,
      failed: false,
    };
    const decision = decideFanOut({ input, round0, thresholds });
    bump(reasons, decision.reason);
    if (decision.allowed) {
      allowed += 1;
      const sel = selectDomainPack({ input, round0, fanOutReason: decision.reason });
      bump(packIds, sel.id);
      bump(packSelectReasons, sel.reason);
    } else {
      denied += 1;
    }

    fanOutObs.length = 0;
    inner.calls = 0;
    const result = await guard.decide(input);
    const obs = fanOutObs[fanOutObs.length - 1];
    observations.push({
      id: f.id,
      mode: result.mode,
      fanOutAllowed: decision.allowed,
      fanOutReason: decision.reason,
      providerCalls: inner.calls,
      packId: obs?.packId ?? null,
      packSelectReason: obs?.packSelectReason ?? null,
      hardPolicyId: rule?.id ?? null,
    });
  }

  const n = fixtures.length;
  const report = {
    generatedAt: new Date().toISOString(),
    purpose:
      "Fixture-only fan-out measurement (MCP default ON separately; this tool always wraps).",
    versions: {
      ...buildEvalManifest(),
      fanOutPolicyVersion: FAN_OUT_POLICY_VERSION,
      domainPackVersion: DOMAIN_PACK_VERSION,
    },
    live: false,
    fixtureCount: n,
    elapsedMs: Math.round(performance.now() - t0),
    rates: {
      fanOutAllowed: n === 0 ? 0 : allowed / n,
      fanOutDenied: n === 0 ? 0 : denied / n,
      hardPolicySettled: n === 0 ? 0 : hardPolicySettled / n,
    },
    counts: {
      allowed,
      denied,
      hardPolicySettled,
    },
    distributions: {
      fanOutReasons: reasons,
      domainPackIds: packIds,
      domainPackSelectReasons: packSelectReasons,
    },
    samples: observations,
    limitations: [
      "Offline uncertain fake — not live Jev.",
      "Does not mutate MCP wiring; default-on is `isFanOutEnabled()` (opt out JEV_FAN_OUT=0).",
      "Hard-policy fixtures deny Round 1 by design (FO-HARD-POLICY-SETTLED).",
      "Default-on still requires live corpus evidence + explicit approval.",
    ],
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
