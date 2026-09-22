/**
 * Human-review corpus pipeline: screen → offline decide → review queue → merge.
 * Never uploads. Merge requires an approvals file with explicit approvedIds.
 */
import { screenCorpusCandidate, type CorpusCandidate } from "./corpus-screen.js";

export const CORPUS_REVIEW_VERSION = "2026-09-21.1";

export type CorpusAction = "execute" | "plan" | "approve" | "block";

export interface FullCorpusCandidate extends CorpusCandidate {
  category: string;
  deterministicExpectation: {
    policyRuleIds: string[];
    providerCallExpected: "allowed" | "prohibited";
    minimumAction: CorpusAction;
  };
  semanticExpectation: {
    expectedKind: string;
    expectedRiskBand: "low" | "medium" | "high" | "critical";
    minimumAction: CorpusAction;
    expectedSecurityReview: null | "required";
  };
}

export interface CorpusApprovals {
  reviewer: string;
  approvedAt: string;
  approvedIds: string[];
  note?: string;
}

export interface ReviewQueueItem {
  id: string;
  screenOk: boolean;
  screenReasons: string[];
  /** Offline Guard mode with a permissive fake (deterministic path only). */
  offlineMode?: string;
  offlineAction?: CorpusAction;
  labelMatch?: boolean;
  duplicateOfExisting?: boolean;
  candidate: FullCorpusCandidate;
}

export interface ReviewQueueReport {
  version: string;
  screened: number;
  rejectedByScreen: number;
  readyForHumanReview: number;
  duplicates: number;
  items: ReviewQueueItem[];
}

const ACTIONS = new Set(["execute", "plan", "approve", "block"]);
const RISK_BANDS = new Set(["low", "medium", "high", "critical"]);

export function validateFullCandidate(c: unknown): string[] {
  const reasons: string[] = [];
  if (!c || typeof c !== "object") return ["not-object"];
  const o = c as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) reasons.push("missing-id");
  if (typeof o.task !== "string" || !o.task) reasons.push("missing-task");
  if (typeof o.category !== "string" || !o.category) reasons.push("missing-category");
  if (!Array.isArray(o.touchedFiles)) reasons.push("touchedFiles-not-array");
  const d = o.deterministicExpectation as Record<string, unknown> | undefined;
  const s = o.semanticExpectation as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") reasons.push("missing-deterministicExpectation");
  else {
    if (!Array.isArray(d.policyRuleIds)) reasons.push("policyRuleIds");
    if (d.providerCallExpected !== "allowed" && d.providerCallExpected !== "prohibited") {
      reasons.push("providerCallExpected");
    }
    if (!ACTIONS.has(String(d.minimumAction))) reasons.push("deterministic.minimumAction");
  }
  if (!s || typeof s !== "object") reasons.push("missing-semanticExpectation");
  else {
    if (typeof s.expectedKind !== "string") reasons.push("expectedKind");
    if (!RISK_BANDS.has(String(s.expectedRiskBand))) reasons.push("expectedRiskBand");
    if (!ACTIONS.has(String(s.minimumAction))) reasons.push("semantic.minimumAction");
    if (s.expectedSecurityReview !== null && s.expectedSecurityReview !== "required") {
      reasons.push("expectedSecurityReview");
    }
  }
  return reasons;
}

function actionOf(mode: string): CorpusAction {
  if (mode === "block") return "block";
  if (mode === "approval_required") return "approve";
  if (mode === "plan_first") return "plan";
  return "execute";
}

export function buildReviewQueue(args: {
  candidates: readonly FullCorpusCandidate[];
  existingIds: ReadonlySet<string>;
  offlineModes: ReadonlyMap<string, string>;
}): ReviewQueueReport {
  const items: ReviewQueueItem[] = [];
  let rejectedByScreen = 0;
  let ready = 0;
  let duplicates = 0;

  for (const candidate of args.candidates) {
    const schemaReasons = validateFullCandidate(candidate);
    const screen = screenCorpusCandidate(candidate);
    const screenReasons = [...new Set([...schemaReasons, ...screen.reasons])];
    const screenOk = screenReasons.length === 0;
    if (!screenOk) rejectedByScreen += 1;

    const duplicateOfExisting = args.existingIds.has(candidate.id);
    if (duplicateOfExisting) duplicates += 1;

    const offlineMode = args.offlineModes.get(candidate.id);
    const offlineAction = offlineMode ? actionOf(offlineMode) : undefined;
    const labelMatch =
      offlineAction === undefined
        ? undefined
        : offlineAction === candidate.semanticExpectation.minimumAction ||
          // hard-policy may settle approve while semantic expects approve
          offlineAction === candidate.deterministicExpectation.minimumAction;

    if (screenOk && !duplicateOfExisting) ready += 1;

    items.push({
      id: candidate.id,
      screenOk,
      screenReasons,
      offlineMode,
      offlineAction,
      labelMatch,
      duplicateOfExisting,
      candidate,
    });
  }

  return {
    version: CORPUS_REVIEW_VERSION,
    screened: args.candidates.length,
    rejectedByScreen,
    readyForHumanReview: ready,
    duplicates,
    items,
  };
}

/** Merge only ids listed in approvals; never silent insert. */
export function mergeApprovedCandidates(args: {
  existingFixtures: FullCorpusCandidate[];
  candidates: readonly FullCorpusCandidate[];
  approvals: CorpusApprovals;
}): { fixtures: FullCorpusCandidate[]; mergedIds: string[]; skipped: string[] } {
  if (!args.approvals.reviewer || !args.approvals.approvedAt) {
    throw new Error("approvals require reviewer and approvedAt");
  }
  if (!Array.isArray(args.approvals.approvedIds) || args.approvals.approvedIds.length === 0) {
    throw new Error("approvals.approvedIds must be a non-empty array");
  }

  const byId = new Map(args.candidates.map((c) => [c.id, c]));
  const existing = new Set(args.existingFixtures.map((f) => f.id));
  const mergedIds: string[] = [];
  const skipped: string[] = [];
  const out = [...args.existingFixtures];

  for (const id of args.approvals.approvedIds) {
    const c = byId.get(id);
    if (!c) {
      skipped.push(`${id}:not-in-inbox`);
      continue;
    }
    const screen = screenCorpusCandidate(c);
    const schema = validateFullCandidate(c);
    if (!screen.ok || schema.length) {
      skipped.push(`${id}:screen-or-schema`);
      continue;
    }
    if (existing.has(id)) {
      skipped.push(`${id}:duplicate`);
      continue;
    }
    out.push(c);
    existing.add(id);
    mergedIds.push(id);
  }

  return { fixtures: out, mergedIds, skipped };
}
