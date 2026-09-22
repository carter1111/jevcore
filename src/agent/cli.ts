/**
 * jevcore agent * — report / doctor / suggest (T12).
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { resolveTelemetryConfig, DEFAULT_ADVISORY_BYTES } from "../telemetry/config.js";
import { buildReport, REPORT_PERIODS, type ReportPeriod } from "../telemetry/report.js";
import { formatDisabled, formatReport } from "../telemetry/format.js";
import { PreferencesMemory } from "../memory/store.js";
import { resolvePreferencesDbPath } from "../memory/paths.js";
import { ProfileStore } from "../profile/store.js";
import { formatAgentReport } from "./report.js";
import { formatAgentDoctor, runAgentDoctor } from "./doctor.js";
import { formatSuggestions, scanLearnedSuggestions } from "./suggest.js";

const require = createRequire(import.meta.url);

function openDatabase(path: string): DatabaseSync {
  const mod = require("node:sqlite") as typeof import("node:sqlite");
  return new mod.DatabaseSync(path);
}

function agentUsage(): string {
  return [
    "jevcore agent — JEVCore Agent report / doctor / suggestions",
    "",
    "Usage:",
    "  jevcore agent doctor",
    "  jevcore agent report [--period 7d|14d|30d|all] [--locale en|zh]",
    "  jevcore agent suggest [--locale en|zh]",
    "",
    "Notes:",
    "  • Suggestions never auto-write profile.json (autoApplied always false)",
    "  • Report never claims host LLM token savings",
    "  • doctor states enforcement honesty (Advisory/Guided/Observed/Enforced)",
  ].join("\n");
}

function parsePeriod(args: string[]): ReportPeriod {
  const idx = args.indexOf("--period");
  const raw = idx >= 0 ? args[idx + 1] : "7d";
  if (raw && (REPORT_PERIODS as readonly string[]).includes(raw)) {
    return raw as ReportPeriod;
  }
  return "7d";
}

function parseLocale(args: string[]): "en" | "zh" {
  const idx = args.indexOf("--locale");
  const raw = idx >= 0 ? args[idx + 1] : undefined;
  return raw === "zh" ? "zh" : "en";
}

function agentDoctorCommand(): number {
  const result = runAgentDoctor();
  process.stdout.write(formatAgentDoctor(result));
  return result.exitCode;
}

function agentReportCommand(args: string[]): number {
  const period = parsePeriod(args);
  const locale = parseLocale(args);
  const config = resolveTelemetryConfig();

  let evidenceText: string;
  let model = null as ReturnType<typeof buildReport> | null;

  if (!config.enabled) {
    evidenceText = formatDisabled();
  } else if (!existsSync(config.databasePath)) {
    evidenceText = formatDisabled();
  } else {
    try {
      const db = openDatabase(config.databasePath);
      try {
        model = buildReport(db, {
          period,
          databasePath: config.databasePath,
          advisoryBytes: config.advisoryBytes ?? DEFAULT_ADVISORY_BYTES,
          telemetryWriteErrors: 0,
        });
        evidenceText = formatReport(model);
      } finally {
        db.close();
      }
    } catch {
      evidenceText = "Local evidence report unavailable (database unreadable).\n";
    }
  }

  const extras: {
    activeSessionGrants?: number;
    overrideEvents?: number;
    pendingSuggestions?: number;
    profileRevision?: number;
    locale: "en" | "zh";
  } = { locale };

  try {
    const mem = new PreferencesMemory({ databasePath: resolvePreferencesDbPath() });
    if (existsSync(mem.databasePath)) {
      extras.activeSessionGrants = mem.countSessionGrants(true);
      extras.overrideEvents = mem.countOverrideEvents();
      extras.pendingSuggestions = mem.listSuggestions("pending").length;
    }
    mem.close();
  } catch {
    /* optional */
  }

  try {
    const store = new ProfileStore({ skipRevisionLedger: true });
    if (store.exists()) {
      extras.profileRevision = store.load().profileRevision;
    }
  } catch {
    /* optional */
  }

  if (model) {
    process.stdout.write(formatAgentReport(evidenceText, model, extras));
  } else {
    // Still print narrative zeros when evidence is off.
    const empty = {
      period,
      sinceIso: null,
      guardDecisions: 0,
      jevProviderCalls: 0,
      hardPolicyShortCircuits: 0,
      outcomes: {},
      safetyActions: {},
      hardBlocksWithProviderCalls: 0,
      providerFallbacks: 0,
      boundaryFallbacks: 0,
      guardP50Ms: null,
      guardP95Ms: null,
      providerP50Ms: null,
      providerP95Ms: null,
      jevInputTokens: 0,
      jevOutputTokens: 0,
      estimatedCostUsd: 0,
      pricingBasis: "n/a",
      decisionsStored: 0,
      dateRange: { from: null, to: null },
      databaseBytes: null,
      advisoryBytes: DEFAULT_ADVISORY_BYTES,
      storageAdvisory: "ok" as const,
      telemetryWriteErrors: 0,
      totalAgentTokenSavings: "not_enough_controlled_evidence" as const,
    };
    process.stdout.write(formatAgentReport(evidenceText, empty, extras));
  }
  return 0;
}

function agentSuggestCommand(args: string[]): number {
  const locale = parseLocale(args);
  const store = new ProfileStore();
  if (!store.exists()) {
    process.stderr.write("No profile.json — run: jevcore profile init\n");
    return 2;
  }
  const profile = store.load();
  const mem = new PreferencesMemory();
  try {
    const result = scanLearnedSuggestions({ memory: mem, profile });
    process.stdout.write(formatSuggestions(result, locale));
    return 0;
  } finally {
    mem.close();
    store.close();
  }
}

/** CLI entry for `jevcore agent …`. */
export function agentCommand(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(agentUsage() + "\n");
    return sub ? 0 : 2;
  }
  if (sub === "doctor") return agentDoctorCommand();
  if (sub === "report") return agentReportCommand(rest);
  if (sub === "suggest") return agentSuggestCommand(rest);
  process.stderr.write(`Unknown agent subcommand: ${sub}\n\n${agentUsage()}\n`);
  return 2;
}
