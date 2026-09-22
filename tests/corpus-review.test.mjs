/**
 * Corpus human-review merge helpers (offline).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewQueue,
  mergeApprovedCandidates,
  validateFullCandidate,
} from "../dist/corpus-review.js";

const good = {
  id: "normal-css-class-rename",
  category: "normal",
  task: "Rename a CSS class used only by the settings panel layout",
  touchedFiles: ["web/settings/panel.css"],
  deterministicExpectation: {
    policyRuleIds: [],
    providerCallExpected: "allowed",
    minimumAction: "execute",
  },
  semanticExpectation: {
    expectedKind: "frontend",
    expectedRiskBand: "low",
    minimumAction: "execute",
    expectedSecurityReview: null,
  },
};

describe("corpus review", () => {
  it("validateFullCandidate accepts a complete fixture-shaped candidate", () => {
    assert.deepEqual(validateFullCandidate(good), []);
  });

  it("buildReviewQueue marks URL candidates as screen failures", () => {
    const bad = {
      ...good,
      id: "reject-me-has-url",
      task: "Open https://example.com for the changelog",
    };
    const report = buildReviewQueue({
      candidates: [good, bad],
      existingIds: new Set(),
      offlineModes: new Map([
        ["normal-css-class-rename", "execute"],
        ["reject-me-has-url", "execute"],
      ]),
    });
    assert.equal(report.rejectedByScreen, 1);
    assert.equal(report.readyForHumanReview, 1);
  });

  it("mergeApprovedCandidates only inserts approved screened ids", () => {
    const { fixtures, mergedIds, skipped } = mergeApprovedCandidates({
      existingFixtures: [],
      candidates: [good],
      approvals: {
        reviewer: "operator",
        approvedAt: "2026-09-21T00:00:00.000Z",
        approvedIds: ["normal-css-class-rename", "missing-id"],
      },
    });
    assert.deepEqual(mergedIds, ["normal-css-class-rename"]);
    assert.equal(fixtures.length, 1);
    assert.ok(skipped.some((s) => s.startsWith("missing-id")));
  });
});
