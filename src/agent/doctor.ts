/**
 * T12 — JEVCore Agent doctor (honesty about enforcement + profile/memory).
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveTelemetryConfig } from "../telemetry/config.js";
import { ProfileStore } from "../profile/store.js";
import { PreferencesMemory } from "../memory/store.js";
import { resolvePreferencesDbPath } from "../memory/paths.js";
import { resolveProfilePath } from "../profile/paths.js";
import { formatDoctor, runDoctor, type DoctorResult } from "../setup.js";

export type EnforcementLevel = "Advisory" | "Guided" | "Enforced" | "Observed";

export interface AgentDoctorSection {
  id: string;
  label: string;
  detail: string;
}

export interface AgentDoctorResult {
  setup: DoctorResult;
  enforcementLevel: EnforcementLevel;
  sections: AgentDoctorSection[];
  exitCode: number;
}

/**
 * Infer host enforcement honesty.
 * MCP-only ≈ Advisory; Claude hook present ≈ Guided; evidence-only ≈ Observed.
 */
export function inferEnforcementLevel(opts: {
  claudeHookPresent: boolean;
  mcpDistPresent: boolean;
  evidenceEnabled: boolean;
}): EnforcementLevel {
  if (opts.claudeHookPresent) return "Guided";
  if (opts.mcpDistPresent && opts.evidenceEnabled) return "Observed";
  if (opts.mcpDistPresent) return "Advisory";
  return "Advisory";
}

export function runAgentDoctor(opts: {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  profilePath?: string;
  preferencesPath?: string;
} = {}): AgentDoctorResult {
  const env = opts.env ?? process.env;
  const setup = runDoctor({ repoRoot: opts.repoRoot, env });
  const sections: AgentDoctorSection[] = [];

  const profilePath = opts.profilePath ?? resolveProfilePath(env);
  const profileStore = new ProfileStore({
    profilePath,
    skipRevisionLedger: true,
  });
  if (profileStore.exists()) {
    try {
      const p = profileStore.load();
      sections.push({
        id: "profile",
        label: "profile.json",
        detail: `present rev=${p.profileRevision} interruption=${p.interruptionPreference} locale=${p.collaboration.locale}`,
      });
    } catch (err) {
      sections.push({
        id: "profile",
        label: "profile.json",
        detail: `present but invalid: ${err instanceof Error ? err.message : "error"}`,
      });
    }
  } else {
    sections.push({
      id: "profile",
      label: "profile.json",
      detail: `absent at ${profilePath} — run: jev-guard profile init`,
    });
  }

  const prefPath = opts.preferencesPath ?? resolvePreferencesDbPath(env);
  if (existsSync(prefPath)) {
    try {
      const mem = new PreferencesMemory({ databasePath: prefPath });
      const grants = mem.countSessionGrants(true);
      const overrides = mem.countOverrideEvents();
      const pending = mem.listSuggestions("pending").length;
      sections.push({
        id: "memory",
        label: "preferences.sqlite",
        detail: `present; active grants=${grants}; overrides=${overrides}; pending suggestions=${pending}`,
      });
      mem.close();
    } catch (err) {
      sections.push({
        id: "memory",
        label: "preferences.sqlite",
        detail: `present but unreadable: ${err instanceof Error ? err.message : "error"}`,
      });
    }
  } else {
    sections.push({
      id: "memory",
      label: "preferences.sqlite",
      detail: `absent at ${prefPath} — created on first grant/revision`,
    });
  }

  const telemetry = resolveTelemetryConfig(env);
  sections.push({
    id: "evidence",
    label: "Local evidence",
    detail: telemetry.enabled
      ? `enabled → ${telemetry.databasePath}`
      : "disabled (set JEV_GUARD_LOCAL_EVIDENCE=1 to opt in)",
  });

  const hookPath = join(
    opts.repoRoot ?? process.cwd(),
    "adapters",
    "claude-code",
    "hooks",
    "pretooluse-jev-check.mjs",
  );
  const claudeHookPresent = existsSync(hookPath);
  const mcpDistPresent = setup.checks.some((c) => c.id === "dist-built" && c.severity === "ok");

  const enforcementLevel = inferEnforcementLevel({
    claudeHookPresent,
    mcpDistPresent,
    evidenceEnabled: telemetry.enabled,
  });

  sections.push({
    id: "enforcement",
    label: "Enforcement level",
    detail: `${enforcementLevel} — MCP safer_path is advisory unless a host hook/gate enforces it`,
  });
  sections.push({
    id: "model-auto",
    label: "IDE model auto-apply",
    detail: "out of v1 — hostAutoApplied always false; switch models in the host picker yourself",
  });

  return {
    setup,
    enforcementLevel,
    sections,
    exitCode: setup.exitCode,
  };
}

export function formatAgentDoctor(result: AgentDoctorResult): string {
  const L: string[] = [];
  L.push(formatDoctor(result.setup).trimEnd());
  L.push("");
  L.push("JEVCORE AGENT");
  L.push("─".repeat(70));
  for (const s of result.sections) {
    L.push(`  ${s.label}`);
    L.push(`    ${s.detail}`);
  }
  L.push("");
  return L.join("\n");
}
