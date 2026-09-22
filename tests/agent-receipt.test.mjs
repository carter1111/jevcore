/**
 * T03 — Value receipt builder + display policy.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildValueReceipt,
  formatValueReceiptLines,
  receiptDisplayMode,
  shouldPrintReceiptNow,
  buildAgentResult,
} from "../dist/agent/index.js";

describe("receiptDisplayMode", () => {
  it("always full for non-advance", () => {
    assert.equal(receiptDisplayMode("pave_way", "silent"), "full");
    assert.equal(receiptDisplayMode("your_call", "session_summary"), "full");
    assert.equal(receiptDisplayMode("safer_path", "silent"), "full");
  });
  it("honors executeFeedback for advance", () => {
    assert.equal(receiptDisplayMode("advance", "silent"), "hide");
    assert.equal(receiptDisplayMode("advance", "status_line"), "status_line");
    assert.equal(receiptDisplayMode("advance", "session_summary"), "hide");
    assert.equal(receiptDisplayMode("advance", "detailed"), "full");
  });
});

describe("buildValueReceipt", () => {
  it("always includes did entries for advance", () => {
    const r = buildValueReceipt({
      locale: "en",
      status: "advance",
      authoritySource: "user_profile",
      evidence: { providerCalled: true, hardPolicyShortCircuit: false, latencyMs: 12 },
    });
    assert.ok(r.did.some((d) => d.kind === "precheck"));
    assert.ok(r.did.some((d) => d.kind === "advanced"));
    const lines = formatValueReceiptLines(r);
    assert.ok(lines[0]?.startsWith("JEVCore:"));
  });

  it("zh safer_path marks data boundary", () => {
    const r = buildValueReceipt({
      locale: "zh",
      status: "safer_path",
      authoritySource: "hard_boundary",
      boundaryKind: "data",
      evidence: { providerCalled: false, hardPolicyShortCircuit: true },
    });
    assert.match(r.headline, /数据边界|安全/);
    assert.equal(r.did[0]?.kind, "safer_path");
  });
});

describe("shouldPrintReceiptNow + bundle", () => {
  it("hides advance under session_summary but prints pave_way", () => {
    assert.equal(shouldPrintReceiptNow("advance", "session_summary"), false);
    assert.equal(shouldPrintReceiptNow("pave_way", "session_summary"), true);

    const advance = buildAgentResult({
      status: "advance",
      authoritySource: "product_default",
      executeFeedback: "session_summary",
      evidence: { providerCalled: false, hardPolicyShortCircuit: false },
    });
    assert.equal(advance.printNow, false);

    const pave = buildAgentResult({
      status: "pave_way",
      authoritySource: "engine_uncertainty",
      executeFeedback: "silent",
      pavedSteps: 4,
      plan: { steps: ["a", "b", "c", "d"], allowStartNow: true },
      evidence: { providerCalled: true, hardPolicyShortCircuit: false },
    });
    assert.equal(pave.printNow, true);
    assert.equal(pave.agent.valueReceipt.did.some((d) => d.kind === "paved"), true);
  });
});
