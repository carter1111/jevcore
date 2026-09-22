/**
 * T12 — Learned suggestions (opt-in; never auto-apply / never grant power).
 */
import type { PreferencesMemory } from "../memory/store.js";
import type { LearnedSuggestionRecord } from "../memory/types.js";
import type { ProfileV1 } from "../profile/types.js";
import type { DelegationKey, DelegationMode } from "../profile/types.js";
import { DELEGATION_KEYS } from "../profile/types.js";

export interface SuggestScanResult {
  /** Newly recorded pending suggestions (also persisted). */
  created: LearnedSuggestionRecord[];
  /** Already-pending suggestions. */
  pending: LearnedSuggestionRecord[];
  /** Explicit: this scan never mutates profile.json. */
  autoApplied: false;
}

const CATEGORY_TO_DELEGATION: Record<string, DelegationKey> = {
  local_dev_db: "localDevDatabase",
  localDevDatabase: "localDevDatabase",
  staging_deploy: "stagingDeploy",
  stagingDeploy: "stagingDeploy",
  production_deploy: "productionDeploy",
  productionDeploy: "productionDeploy",
  authz_change: "authzChange",
  authzChange: "authzChange",
  multi_file_refactor: "multiFileRefactor",
  multiFileRefactor: "multiFileRefactor",
};

/**
 * Scan preference event counts and optionally record pending suggestions.
 * Never writes profile.json. Never returns authority.
 */
export function scanLearnedSuggestions(options: {
  memory: PreferencesMemory;
  profile: ProfileV1;
  /** Default: profile.learning.suggestAfterRepeatedPattern */
  threshold?: number;
}): SuggestScanResult {
  if (options.profile.learning.autoApplyPreferenceChanges !== false) {
    // Defense: even if a corrupt profile slipped through, refuse to auto-apply.
  }
  const threshold =
    options.threshold ?? options.profile.learning.suggestAfterRepeatedPattern;
  const counts = options.memory.countPreferenceEventsByCategory();
  const existingPending = options.memory.listSuggestions("pending");
  const pendingKeys = new Set(existingPending.map((s) => s.category));
  const created: LearnedSuggestionRecord[] = [];

  for (const row of counts) {
    if (row.count < threshold) continue;
    const key = (CATEGORY_TO_DELEGATION[row.category] ??
      (DELEGATION_KEYS.includes(row.category as DelegationKey)
        ? (row.category as DelegationKey)
        : undefined)) as DelegationKey | undefined;
    if (!key) continue;
    if (key === "secretToRemoteProvider" || key === "web3AssetAction") continue;
    if (pendingKeys.has(row.category) || pendingKeys.has(key)) continue;

    const current = options.profile.delegation[key];
    // Suggest a slightly more assertive soft mode — user must confirm via profile CLI.
    const proposed: DelegationMode =
      current === "ask"
        ? "plan_then_continue"
        : current === "ask_once"
          ? "ask"
          : current === "plan_then_continue"
            ? "draft_then_continue"
            : current;

    if (proposed === current) continue;

    const rec = options.memory.recordSuggestion({
      category: key,
      currentProfileValue: current,
      proposedProfileValue: proposed,
      evidenceCount: row.count,
      confidenceBucket: row.count >= threshold * 2 ? "high" : "medium",
      createdFromEventRange: `count=${row.count};threshold=${threshold}`,
    });
    created.push(rec);
    pendingKeys.add(key);
  }

  return {
    created,
    pending: options.memory.listSuggestions("pending"),
    autoApplied: false,
  };
}

export function formatSuggestions(result: SuggestScanResult, locale: "en" | "zh" = "en"): string {
  const L: string[] = [];
  if (locale === "zh") {
    L.push("JEVCORE AGENT  ·  学习建议（无执行权，不会自动改 profile）");
    L.push("─".repeat(70));
    L.push(`  新登记 ${result.created.length} · 待处理 ${result.pending.length}`);
    L.push("  接受后请手动: jev-guard profile set <field> <value>");
  } else {
    L.push("JEVCORE AGENT  ·  Learned suggestions (no power; never auto-write profile)");
    L.push("─".repeat(70));
    L.push(`  newly recorded ${result.created.length} · pending ${result.pending.length}`);
    L.push("  To adopt: jev-guard profile set <field> <value> (manual only)");
  }
  if (result.pending.length === 0) {
    L.push(locale === "zh" ? "  （无待处理建议）" : "  (none pending)");
  } else {
    for (const s of result.pending) {
      L.push(
        `  · ${s.suggestionId.slice(0, 8)}…  ${s.category}: ${s.currentProfileValue} → ${s.proposedProfileValue}  (n=${s.evidenceCount}, ${s.confidenceBucket})`,
      );
    }
  }
  L.push(`  autoApplied: ${result.autoApplied}`);
  L.push("");
  return L.join("\n");
}
