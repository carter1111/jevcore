#!/usr/bin/env node
/**
 * jevcore — JevCore Agent CLI (alias: jev-guard, deprecated).
 *
 * Commands:
 *   jevcore check "<command>"
 *   jevcore check --stdin [--json] [--echo-hash]
 *   jevcore decide-many --stdin [--json] [--stream] [--max-items N] [--live] [--strategy serial|shared_system_one]
 *   jevcore init [--agent <id>] [--apply] [--project-dir <path>]
 *   jevcore doctor
 *   jevcore agent doctor|report|suggest
 *   jevcore profile init|show|validate|preset|set|history|reset|export|import
 *   jevcore evidence status
 *   jevcore evidence purge --before <period> --dry-run
 *   jevcore evidence purge --before <period> --apply
 *   jevcore evidence reset --confirm-delete-local-evidence
 *
 * `check` is a portable deterministic gate (P0): it evaluates one command via
 * the hard-policy module only, never calls a provider, never touches evidence
 * storage, and never requires credentials. `init` / `doctor` (P3) detect agents
 * and diagnose setup; dry-run is default. `profile` manages profile.json authority
 * (T05). Evidence subcommands only ever touch local telemetry storage.
 * Prefer `jevcore`; `jev-guard` remains a bin alias for compatibility.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import {
  evaluateCheck,
  failClosed,
  formatCheckJson,
  formatCheckText,
  type CheckResult,
} from "./check.js";
import { Guard } from "./engine.js";
import { RuleProvider } from "./fallback.js";
import {
  BatchTooLargeError,
  BATCH_DECIDE_VERSION,
  DEFAULT_BATCH_MAX_ITEMS,
  type DecideManyStrategy,
} from "./batch.js";
import type { GuardInput } from "./types.js";
import { TypeSafeProvider } from "./provider.js";
import {
  defaultRepoRoot,
  formatDoctor,
  runDoctor,
  runInit,
  type InitAgentFilter,
} from "./setup.js";
import { profileCommand } from "./profile/cli.js";
import { agentCommand } from "./agent/cli.js";
import { resolveTelemetryConfig, DEFAULT_ADVISORY_BYTES, EVIDENCE_LOCK_NAME } from "./telemetry/config.js";
import { evidenceEnvFromCursorEnvFile, cursorEnvFilePath } from "./telemetry/envfile.js";
import { evidenceStatus, purgeEvidence, resetEvidence } from "./telemetry/maintenance.js";
import { REPORT_PERIODS, type ReportPeriod } from "./telemetry/report.js";
import { dirname, join } from "node:path";

const RESET_CONFIRMATION = "--confirm-delete-local-evidence";

/**
 * The environment the CLI resolves Evidence config against.
 *
 * The MCP server is launched by Cursor with `~/.cursor/jev-coding-guard.env`
 * (via `envFile`). A plain-shell CLI does not inherit that file, so we read
 * the evidence flags from that same envFile — but ONLY when the process env
 * does not already define them. This keeps the CLI and the MCP server aligned
 * in real use, while still allowing an explicit override (e.g. tests that set
 * `JEV_GUARD_LOCAL_EVIDENCE=0` or omit the flag entirely).
 */
function cliEnv(): NodeJS.ProcessEnv {
  const fromFile = evidenceEnvFromCursorEnvFile();
  const overlay: Record<string, string> = {};
  for (const key of Object.keys(fromFile)) {
    const value = fromFile[key];
    if (value !== undefined && process.env[key] === undefined) overlay[key] = value;
  }
  return { ...process.env, ...overlay };
}

/** Lazily resolve `node:sqlite` (ESM-safe) so it loads only when the CLI runs. */
const require = createRequire(import.meta.url);

function openDatabase(path: string): DatabaseSync {
  // Lazily required so the module is only loaded when the CLI actually runs.
  const mod = require("node:sqlite") as typeof import("node:sqlite");
  return new mod.DatabaseSync(path);
}

function usage(): string {
  return [
    "jevcore — JevCore Agent CLI (alias: jev-guard)",
    "",
    "Usage:",
    "  jevcore check \"<command>\"",
    "  jevcore check --stdin [--json] [--echo-hash]",
    "  jevcore check --json \"<command>\"",
    "  jevcore decide-many --stdin [--json] [--stream] [--max-items N] [--live] [--strategy serial|shared_system_one]",
    "  jevcore init [--agent cursor|claude|codex|opencode|all] [--project-dir <path>]",
    "  jevcore init --apply --agent claude --project-dir <path>",
    "  jevcore doctor",
    "  jevcore agent doctor|report|suggest",
    "  jevcore profile init|show|validate|preset|set|history|reset|export|import",
    "  jevcore evidence status",
    "  jevcore evidence purge --before <7d|14d|30d|all> --dry-run",
    "  jevcore evidence purge --before <7d|14d|30d|all> --apply",
    "  jevcore evidence reset --confirm-delete-local-evidence",
    "",
    "check exit codes:",
    "  0  execute (no hard-policy match)",
    "  1  block",
    "  2  approval_required",
    "  3  plan_first / unknown mode",
    "  4  malformed input or internal error (fail-closed — do not treat as allow)",
    "",
    "Notes:",
    "  • Product: JevCore Agent. Prefer `jevcore`; `jev-guard` is a deprecated alias.",
    "  • check never calls a provider, never needs credentials, never writes files.",
    "  • decide-many defaults to offline RuleProvider; --live uses TypeSafe (needs key).",
    "  • decide-many --stream yields NDJSON (--json) or one line per item as each settles (serial only).",
    "  • --strategy shared_system_one requires --live (or a batch-capable provider).",
    "  • check JSON never echoes the command text (optional --echo-hash only).",
    "  • init is dry-run by default; --apply only writes Claude project files (Q4).",
    "  • doctor is read-only and never prints credential values.",
    "  • profile manages ~/.cursor/jev-coding-guard/profile.json (authority); Agent never auto-writes it.",
    "  • Evidence collection is opt-in via JEV_GUARD_LOCAL_EVIDENCE=1.",
    "  • evidence commands only touch telemetry storage.",
  ].join("\n");
}

function readStdinOrEmpty(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function emitCheck(result: CheckResult, asJson: boolean): number {
  if (asJson) {
    process.stdout.write(formatCheckJson(result) + "\n");
  } else {
    process.stdout.write(formatCheckText(result) + "\n");
  }
  return result.exitCode;
}

/**
 * Parse `check` argv. Returns a CheckResult to emit, including fail-closed
 * outcomes for ambiguous or empty input.
 */
export function runCheck(args: string[]): CheckResult {
  const echoHash = args.includes("--echo-hash");
  const useStdin = args.includes("--stdin");
  const positionals = args.filter((a) => !a.startsWith("--"));

  if (useStdin && positionals.length > 0) {
    return failClosed("ambiguous input: pass either --stdin or a command argument, not both");
  }
  if (!useStdin && positionals.length === 0) {
    return failClosed("missing command: pass a command argument or --stdin");
  }
  if (!useStdin && positionals.length > 1) {
    return failClosed("too many arguments: pass a single command string");
  }

  let command: string;
  try {
    command = useStdin ? readStdinOrEmpty() : (positionals[0] ?? "");
  } catch {
    return failClosed("failed to read command input");
  }

  if (typeof command !== "string" || !command.trim()) {
    return failClosed("empty command");
  }

  try {
    return evaluateCheck(command, { echoHash });
  } catch {
    return failClosed("internal check error");
  }
}

/** Convenience for tests: run check and write output. */
function checkCommand(args: string[]): number {
  const asJson = args.includes("--json");
  return emitCheck(runCheck(args), asJson);
}

function bytes(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Column geometry, matching the report formatter's style. */
const LABEL_W = 26;
const RULE_W = LABEL_W + 30;
const INDENT = "  ";
const CONTINUATION_INDENT = "    ";

/** Left label + right-aligned value; long values move to their own line. */
function row(label: string, value: string | number): string {
  const v = String(value);
  if (label.length <= LABEL_W && v.length <= 30) {
    return `${INDENT}${label.padEnd(LABEL_W)}${v.padStart(30)}`;
  }
  return `${INDENT}${label}\n${CONTINUATION_INDENT}${v}`;
}

function statusCommand(): number {
  const config = resolveTelemetryConfig(cliEnv());
  const status = evidenceStatus({
    enabled: config.enabled,
    databasePath: config.databasePath,
    advisoryBytes: config.advisoryBytes || DEFAULT_ADVISORY_BYTES,
    openDatabase,
  });

  const L: string[] = [];
  L.push("JEV CODING GUARD  ·  Local Evidence Status");
  L.push("─".repeat(RULE_W));
  L.push(row("Collection enabled", status.enabled ? "yes" : "no"));
  if (!status.enabled) {
    L.push(`${CONTINUATION_INDENT}opt-in via JEV_GUARD_LOCAL_EVIDENCE=1 (or ${cursorEnvFilePath()})`);
  }
  L.push(row("Database path", status.databasePath || "(not resolved while disabled)"));
  L.push(row("Database exists", status.databaseExists ? "yes" : "no"));
  L.push(row("Database size", bytes(status.databaseBytes)));
  L.push(row("Decisions stored", status.decisionsStored ?? "n/a"));
  L.push(row("Schema version", status.schemaVersion ?? "n/a"));
  L.push(
    row(
      "Date range",
      `${status.dateRange.from ? status.dateRange.from.slice(0, 16).replace("T", " ") : "n/a"} .. ${
        status.dateRange.to ? status.dateRange.to.slice(0, 16).replace("T", " ") : "n/a"
      }`,
    ),
  );
  L.push(
    row(
      "Storage advisory",
      status.storageAdvisory === "ok" ? `OK (${bytes(status.advisoryBytes)} limit)` : `EXCEEDED ${bytes(status.advisoryBytes)}`,
    ),
  );
  L.push(row("Remote upload", "Disabled"));
  L.push("");
  process.stdout.write(L.join("\n"));
  return 0;
}

function parsePeriod(value: string | undefined): ReportPeriod | undefined {
  if (value === undefined) return undefined;
  return (REPORT_PERIODS as readonly string[]).includes(value) ? (value as ReportPeriod) : undefined;
}

function purgeCommand(args: string[]): number {
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  const beforeIdx = args.indexOf("--before");
  const period = parsePeriod(beforeIdx >= 0 ? args[beforeIdx + 1] : undefined);

  if (!period) {
    process.stderr.write(`Error: --before requires one of: ${REPORT_PERIODS.join(", ")}\n\n${usage()}\n`);
    return 2;
  }
  if (dryRun === apply) {
    process.stderr.write("Error: specify exactly one of --dry-run or --apply\n\n" + usage() + "\n");
    return 2;
  }

  const config = resolveTelemetryConfig(cliEnv());
  if (!config.enabled) {
    process.stdout.write(
      "Local evidence is disabled (JEV_GUARD_LOCAL_EVIDENCE is not 1). Nothing to purge.\n",
    );
    return 0;
  }

  const result = purgeEvidence({
    databasePath: config.databasePath,
    lockPath: join(dirname(config.databasePath), EVIDENCE_LOCK_NAME),
    period,
    dryRun,
    openDatabase,
  });

  if (!result.ok) {
    process.stderr.write(`Purge refused: ${describeReason(result.reason)}\n`);
    return 1;
  }

  if (result.dryRun) {
    process.stdout.write(
      [
        "Dry run — nothing was changed.",
        `  Records that WOULD be removed   ${result.deleted}`,
        `  Database size (unchanged)       ${bytes(result.sizeBeforeBytes)}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  process.stdout.write(
    [
      "Purge complete.",
      `  Records deleted                 ${result.deleted}`,
      `  Database size before            ${bytes(result.sizeBeforeBytes)}`,
      `  Database size after             ${bytes(result.sizeAfterBytes)}`,
      `  Remaining date range            ${result.remainingFrom ?? "n/a"} to ${result.remainingTo ?? "n/a"}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function resetCommand(args: string[]): number {
  if (!args.includes(RESET_CONFIRMATION)) {
    process.stderr.write(
      [
        "Error: reset deletes ALL local evidence and requires the exact confirmation flag:",
        "",
        `  jev-guard evidence reset ${RESET_CONFIRMATION}`,
        "",
      ].join("\n"),
    );
    return 2;
  }

  const config = resolveTelemetryConfig(cliEnv());
  if (!config.enabled) {
    process.stdout.write(
      "Local evidence is disabled (JEV_GUARD_LOCAL_EVIDENCE is not 1). Nothing to reset.\n",
    );
    return 0;
  }
  if (!existsSync(config.databasePath)) {
    process.stdout.write("No local evidence database exists. Nothing to reset.\n");
    return 0;
  }

  const result = resetEvidence({
    databasePath: config.databasePath,
    lockPath: join(dirname(config.databasePath), EVIDENCE_LOCK_NAME),
    openDatabase,
  });

  if (!result.ok) {
    process.stderr.write(`Reset refused: ${describeReason(result.reason)}\n`);
    return 1;
  }

  process.stdout.write(
    [
      "Reset complete. All local evidence rows were deleted.",
      `  Records deleted                 ${result.deleted}`,
      `  Database size before            ${bytes(result.sizeBeforeBytes)}`,
      `  Database size after             ${bytes(result.sizeAfterBytes)}`,
      "  Note: the database file itself was preserved (never unlinked).",
      "",
    ].join("\n"),
  );
  return 0;
}

/** Stable, non-sensitive explanations. Never echo paths or error internals. */
function describeReason(reason: string | undefined): string {
  switch (reason) {
    case "database_missing":
      return "no evidence database exists";
    case "lock_held":
      return "another process (a running MCP server) holds the maintenance lock; retry later";
    case "confirmation_required":
      return "the exact confirmation flag was not provided";
    case "nothing_to_delete":
      return "no records matched";
    case "database_error":
      return "the evidence database could not be opened or updated";
    default:
      return "unknown reason";
  }
}

function doctorCommand(): number {
  const result = runDoctor({ repoRoot: defaultRepoRoot() });
  process.stdout.write(formatDoctor(result));
  return result.exitCode;
}

function initCommand(args: string[]): number {
  let apply = false;
  let agent: InitAgentFilter = "all";
  let projectDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") apply = true;
    else if (a === "--agent") {
      const v = args[++i];
      if (!v || !["cursor", "claude", "codex", "opencode", "all"].includes(v)) {
        process.stderr.write("Error: --agent requires cursor|claude|codex|opencode|all\n\n" + usage() + "\n");
        return 2;
      }
      agent = v as InitAgentFilter;
    } else if (a === "--project-dir") {
      const v = args[++i];
      if (!v) {
        process.stderr.write("Error: --project-dir requires a path\n\n" + usage() + "\n");
        return 2;
      }
      projectDir = v;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(usage() + "\n");
      return 0;
    } else {
      process.stderr.write(`Error: unknown init argument: ${a}\n\n` + usage() + "\n");
      return 2;
    }
  }
  if (apply && agent !== "claude" && agent !== "all") {
    process.stderr.write(
      "Error: --apply currently only writes Claude project files. Use --agent claude.\n\n" + usage() + "\n",
    );
    return 2;
  }
  if (apply && agent === "all") {
    // Narrow apply to claude only when detected; avoid accidental multi-agent writes.
    agent = "claude";
  }
  const result = runInit({
    repoRoot: defaultRepoRoot(),
    projectDir,
    agent,
    apply,
  });
  process.stdout.write(result.text);
  return result.exitCode;
}

function parseMaxItems(args: string[]): number | undefined {
  const idx = args.indexOf("--max-items");
  if (idx < 0) return undefined;
  const raw = args[idx + 1];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse `--strategy serial|shared_system_one`. */
export function parseDecideManyStrategy(args: string[]): DecideManyStrategy | undefined {
  const idx = args.indexOf("--strategy");
  if (idx < 0) return undefined;
  const raw = args[idx + 1];
  if (raw === "serial" || raw === "shared_system_one") return raw;
  return undefined;
}

export function parseDecideManyLive(args: string[]): boolean {
  return args.includes("--live");
}

/** Parse decide-many stdin JSON: `[{ task, hints? }, ...]`. */
export function parseDecideManyInput(raw: string): GuardInput[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid JSON on stdin" };
  }
  if (!Array.isArray(parsed)) return { error: "stdin must be a JSON array" };
  const out: GuardInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (item === null || typeof item !== "object") {
      return { error: `item ${i} must be an object` };
    }
    const task = (item as { task?: unknown }).task;
    if (typeof task !== "string" || !task.trim()) {
      return { error: `item ${i} missing non-empty task string` };
    }
    const hints = (item as { hints?: unknown }).hints;
    if (hints !== undefined) {
      if (hints === null || typeof hints !== "object") {
        return { error: `item ${i} hints must be an object when present` };
      }
      out.push({ task, hints: hints as GuardInput["hints"] });
    } else {
      out.push({ task });
    }
  }
  return out;
}

/** C-5 Phase A — offline batch decisions for CI / PR file lists. */
export async function runDecideManyCli(args: string[]): Promise<number> {
  if (!args.includes("--stdin")) {
    process.stderr.write("Error: decide-many requires --stdin (JSON array)\n\n" + usage() + "\n");
    return 4;
  }
  const asJson = args.includes("--json");
  const stream = args.includes("--stream");
  const maxItems = parseMaxItems(args) ?? DEFAULT_BATCH_MAX_ITEMS;
  const live = parseDecideManyLive(args);
  const strategyArg = parseDecideManyStrategy(args);
  const strategy: DecideManyStrategy =
    strategyArg ?? (live ? "shared_system_one" : "serial");
  if (strategy === "shared_system_one" && !live) {
    process.stderr.write(
      "Error: --strategy shared_system_one requires --live (TypeSafeProvider)\n",
    );
    return 4;
  }
  if (stream && strategy === "shared_system_one") {
    process.stderr.write(
      "Error: --stream supports serial strategy only (use default or --strategy serial)\n",
    );
    return 4;
  }
  let raw: string;
  try {
    raw = readStdinOrEmpty();
  } catch {
    process.stderr.write("failed to read stdin\n");
    return 4;
  }
  if (!raw.trim()) {
    process.stderr.write("empty stdin\n");
    return 4;
  }

  const parsed = parseDecideManyInput(raw);
  if (!Array.isArray(parsed)) {
    process.stderr.write(`${parsed.error}\n`);
    return 4;
  }

  const provider = live ? new TypeSafeProvider({ timeoutMs: 45_000 }) : new RuleProvider();
  const guard = new Guard(provider);

  if (stream) {
    return runDecideManyStreamCli(guard, parsed, { maxItems, asJson });
  }

  let batchResult;
  try {
    batchResult = await guard.decideManyWithMeta(parsed, { maxItems, strategy });
  } catch (err) {
    if (err instanceof BatchTooLargeError) {
      process.stderr.write(`${err.message}\n`);
      return 4;
    }
    process.stderr.write("internal decide-many error\n");
    return 4;
  }

  const items = batchResult.items;
  const payload = {
    version: BATCH_DECIDE_VERSION,
    count: items.length,
    meta: batchResult.meta,
    items: items.map(({ index, result, settledBy }) => ({
      index,
      mode: result.mode,
      reasons: result.reasons,
      fellBack: result.fellBack,
      settledBy,
      classification: { kind: result.classification.kind, source: result.classification.source },
    })),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    for (const row of payload.items) {
      const codes = row.reasons.map((r) => r.code).join(", ") || "(none)";
      process.stdout.write(`[${row.index}] ${row.mode}  ${codes}\n`);
    }
  }

  return worstDecideManyExit(payload.items.map((r) => r.mode));
}

function worstDecideManyExit(modes: readonly string[]): number {
  let exit = 0;
  for (const mode of modes) {
    if (mode === "block") return 1;
    if (mode === "approval_required") exit = Math.max(exit, 2);
    else if (mode === "plan_first") exit = Math.max(exit, 3);
  }
  return exit;
}

async function runDecideManyStreamCli(
  guard: Guard,
  inputs: GuardInput[],
  opts: { maxItems: number; asJson: boolean },
): Promise<number> {
  const modes: string[] = [];
  try {
    for await (const { index, result, settledBy } of guard.decideManyStream(inputs, {
      maxItems: opts.maxItems,
      strategy: "serial",
    })) {
      modes[index] = result.mode;
      const row = {
        version: BATCH_DECIDE_VERSION,
        stream: true as const,
        index,
        mode: result.mode,
        reasons: result.reasons,
        fellBack: result.fellBack,
        settledBy,
        classification: { kind: result.classification.kind, source: result.classification.source },
      };
      if (opts.asJson) {
        process.stdout.write(JSON.stringify(row) + "\n");
      } else {
        const codes = result.reasons.map((r) => r.code).join(", ") || "(none)";
        process.stdout.write(`[${index}] ${result.mode}  ${codes}\n`);
      }
    }
  } catch (err) {
    if (err instanceof BatchTooLargeError) {
      process.stderr.write(`${err.message}\n`);
      return 4;
    }
    process.stderr.write("internal decide-many stream error\n");
    return 4;
  }
  return worstDecideManyExit(modes.filter(Boolean));
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const [group, command, ...rest] = argv;

  if (group === "check") {
    // Remaining tokens may be flags and/or the command string.
    const checkArgs = command === undefined ? [] : [command, ...rest];
    return checkCommand(checkArgs);
  }

  if (group === "doctor") {
    return doctorCommand();
  }

  if (group === "agent") {
    const agentArgs = command === undefined ? [] : [command, ...rest];
    return agentCommand(agentArgs);
  }

  if (group === "profile") {
    const profileArgs = command === undefined ? [] : [command, ...rest];
    return profileCommand(profileArgs);
  }

  if (group === "init") {
    const initArgs = command === undefined ? [] : [command, ...rest];
    return initCommand(initArgs);
  }

  if (group === "decide-many") {
    // Async path handled in import.meta.main shim (spawnSync callers wait for process exit).
    return 4;
  }

  if (group === "evidence") {
    if (command === "status") return statusCommand();
    if (command === "purge") return purgeCommand(rest);
    if (command === "reset") return resetCommand(rest);
  }

  process.stderr.write(usage() + "\n");
  // Usage errors for unknown top-level commands stay exit 2 (evidence-era
  // contract). `check` itself uses exit 4 for malformed input.
  return 2;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "decide-many") {
    const dmArgs = argv.slice(1);
    void runDecideManyCli(dmArgs).then((code) => {
      process.exitCode = code;
    });
  } else {
    process.exitCode = main(argv);
  }
}
