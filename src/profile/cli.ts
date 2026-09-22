/**
 * jevcore profile * — CLI handlers (T05).
 * Agent must not silently rewrite profile; users use this CLI.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { resolvePreferencesDbPath } from "../memory/paths.js";
import {
  parseAndValidateProfileJson,
  ProfileStore,
  ProfileValidationError,
  SETTABLE_FIELDS,
  type ProfilePreset,
} from "./index.js";

function profileUsage(): string {
  return [
    "jevcore profile — manage profile.json (authority)",
    "",
    "Usage:",
    "  jevcore profile init [--force] [--preset cautious|balanced|assertive]",
    "  jevcore profile show [--json]",
    "  jevcore profile validate [path]",
    "  jevcore profile preset cautious|balanced|assertive",
    "  jevcore profile set <field> <value>",
    "  jevcore profile history [--limit N]",
    "  jevcore profile reset [--preset cautious|balanced|assertive]",
    "  jevcore profile export [path]",
    "  jevcore profile import <path>",
    "",
    "Notes:",
    "  • Default path: ~/.cursor/jev-coding-guard/profile.json",
    "  • Override: JEV_GUARD_PROFILE_PATH / JEV_GUARD_PREFERENCES_PATH",
    "  • Hard boundaries (secret→remote, web3 assets) cannot be lowered",
    "  • Writes: validate → temp → chmod 0600 → fsync → rename → backup → revision ledger",
    "  • Learned suggestions never auto-write profile",
    "",
    "Settable fields (examples):",
    "  local-dev-database plan-then-continue",
    "  production-deploy ask",
    "  interruption assertive",
    "  execute-feedback session-summary",
    `  Known: ${Object.keys(SETTABLE_FIELDS).sort().join(", ")}`,
  ].join("\n");
}

function parsePreset(raw: string | undefined): ProfilePreset | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "cautious" || v === "balanced" || v === "assertive") return v;
  throw new ProfileValidationError(`Unknown preset "${raw}" (cautious|balanced|assertive)`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function makeStore(profilePath?: string): ProfileStore {
  return new ProfileStore({
    profilePath,
    memory: { databasePath: resolvePreferencesDbPath() },
  });
}

/**
 * Handle `jevcore profile <subcommand> ...`
 * Exit: 0 ok, 1 validation/hard-boundary, 2 usage.
 */
export function profileCommand(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(profileUsage() + "\n");
    return sub ? 0 : 2;
  }

  try {
    switch (sub) {
      case "init":
        return cmdInit(rest);
      case "show":
        return cmdShow(rest);
      case "validate":
        return cmdValidate(rest);
      case "preset":
        return cmdPreset(rest);
      case "set":
        return cmdSet(rest);
      case "history":
        return cmdHistory(rest);
      case "reset":
        return cmdReset(rest);
      case "export":
        return cmdExport(rest);
      case "import":
        return cmdImport(rest);
      default:
        process.stderr.write(`Unknown profile subcommand: ${sub}\n\n`);
        process.stderr.write(profileUsage() + "\n");
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    return 1;
  }
}

function cmdInit(args: string[]): number {
  const force = hasFlag(args, "--force");
  const preset = parsePreset(flagValue(args, "--preset"));
  const store = makeStore();
  try {
    const result = store.init({ force, preset });
    process.stdout.write(
      `Initialized profile at ${result.path} (revision ${result.profile.profileRevision}` +
        (preset ? `, preset ${preset}` : "") +
        `)\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdShow(args: string[]): number {
  const asJson = hasFlag(args, "--json");
  const store = makeStore();
  try {
    const profile = store.load();
    if (asJson) {
      process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    } else {
      process.stdout.write(`path: ${store.profilePath}\n`);
      process.stdout.write(`schemaVersion: ${profile.schemaVersion}\n`);
      process.stdout.write(`profileRevision: ${profile.profileRevision}\n`);
      process.stdout.write(`updatedAt: ${profile.updatedAt}\n`);
      process.stdout.write(`interruptionPreference: ${profile.interruptionPreference}\n`);
      process.stdout.write("delegation:\n");
      for (const [k, v] of Object.entries(profile.delegation)) {
        process.stdout.write(`  ${k}: ${v}\n`);
      }
      process.stdout.write(
        `learning.autoApplyPreferenceChanges: ${profile.learning.autoApplyPreferenceChanges}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdValidate(args: string[]): number {
  const pathArg = args.find((a) => !a.startsWith("-"));
  if (pathArg) {
    const text = readFileSync(pathArg, "utf8");
    const profile = parseAndValidateProfileJson(text);
    process.stdout.write(
      `OK schemaVersion=${profile.schemaVersion} revision=${profile.profileRevision}\n`,
    );
    return 0;
  }
  const store = makeStore();
  try {
    const profile = store.load();
    process.stdout.write(
      `OK ${store.profilePath} schemaVersion=${profile.schemaVersion} revision=${profile.profileRevision}\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdPreset(args: string[]): number {
  const preset = parsePreset(args[0]);
  if (!preset) {
    process.stderr.write("Usage: jevcore profile preset cautious|balanced|assertive\n");
    return 2;
  }
  const store = makeStore();
  try {
    if (!store.exists()) {
      store.init({ preset });
    } else {
      store.applyPreset(preset);
    }
    const profile = store.load();
    process.stdout.write(
      `Applied preset ${preset} (revision ${profile.profileRevision})\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdSet(args: string[]): number {
  const [field, value] = args;
  if (!field || value === undefined || field === "--help") {
    process.stderr.write("Usage: jevcore profile set <field> <value>\n");
    process.stderr.write(`Fields: ${Object.keys(SETTABLE_FIELDS).sort().join(", ")}\n`);
    return 2;
  }
  const store = makeStore();
  try {
    if (!store.exists()) {
      store.init({});
    }
    const result = store.setField(field, value);
    process.stdout.write(
      `Set ${field}=${value} (revision ${result.profile.profileRevision})\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdHistory(args: string[]): number {
  const limitRaw = flagValue(args, "--limit");
  const limit = limitRaw ? Number(limitRaw) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    process.stderr.write("--limit must be a positive integer\n");
    return 2;
  }
  const store = makeStore();
  try {
    const rows = store.history(limit);
    if (rows.length === 0) {
      process.stdout.write("(no profile revisions in preferences.sqlite)\n");
      return 0;
    }
    for (const row of rows) {
      process.stdout.write(
        `#${row.revision}  ${row.createdAt}  ${row.source}  ${row.summary}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdReset(args: string[]): number {
  const preset = parsePreset(flagValue(args, "--preset")) ?? "balanced";
  const store = makeStore();
  try {
    const result = store.reset(preset);
    process.stdout.write(
      `Reset profile to ${preset} (revision ${result.profile.profileRevision})\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdExport(args: string[]): number {
  const outPath = args.find((a) => !a.startsWith("-"));
  const store = makeStore();
  try {
    const json = store.exportJson();
    if (outPath) {
      writeFileSync(outPath, json, { mode: 0o600 });
      process.stdout.write(`Exported to ${outPath}\n`);
    } else {
      process.stdout.write(json);
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdImport(args: string[]): number {
  const inPath = args.find((a) => !a.startsWith("-"));
  if (!inPath) {
    process.stderr.write("Usage: jevcore profile import <path>\n");
    return 2;
  }
  const text = readFileSync(inPath, "utf8");
  const store = makeStore();
  try {
    const result = store.importJson(text, "imported");
    process.stdout.write(
      `Imported ${inPath} → ${result.path} (revision ${result.profile.profileRevision})\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

export { profileUsage };
