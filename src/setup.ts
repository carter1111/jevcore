/**
 * P3 — `jev-guard init` / `jev-guard doctor`.
 *
 * Detect agents, print install plans (dry-run by default), and run read-only
 * diagnostics. Never prints credential values. Never touches policy source,
 * Git state, or `~/.claude.json` (Claude user-scope MCP stays a printed CLI
 * command).
 *
 * Q4 (PRD): dry-run is the default; `--apply` only writes project-scoped files
 * via the existing Claude adapter installer.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { cursorEnvFilePath, readEnvFile } from "./telemetry/envfile.js";
import { resolveTelemetryConfig, DEFAULT_ADVISORY_BYTES } from "./telemetry/config.js";
import { evidenceStatus } from "./telemetry/maintenance.js";

const require = createRequire(import.meta.url);

/** Repo root when running from `dist/cli.js` → `../`. */
export function defaultRepoRoot(fromFile = import.meta.url): string {
  return resolve(dirname(fileURLToPath(fromFile)), "..");
}

export type AgentId = "cursor" | "claude" | "codex" | "opencode";

export interface DetectedAgent {
  id: AgentId;
  label: string;
  /** Config paths that exist (never secret values). */
  foundPaths: string[];
  /** Whether a project-scoped write path is available for init --apply. */
  projectApplySupported: boolean;
}

export interface DetectOptions {
  home?: string;
  cwd?: string;
}

/** Look for agent config markers. Pure detection — no writes. */
export function detectAgents(opts: DetectOptions = {}): DetectedAgent[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const found: DetectedAgent[] = [];

  const cursorPaths = [
    join(home, ".cursor", "mcp.json"),
    join(cwd, ".cursor", "mcp.json"),
  ].filter((p) => existsSync(p));
  if (cursorPaths.length || existsSync(join(home, ".cursor"))) {
    found.push({
      id: "cursor",
      label: "Cursor",
      foundPaths: cursorPaths.length ? cursorPaths : [join(home, ".cursor")],
      projectApplySupported: false, // global Cursor MCP is operator-managed
    });
  }

  const claudePaths = [
    join(home, ".claude.json"),
    join(cwd, ".mcp.json"),
    join(cwd, ".claude", "settings.json"),
  ].filter((p) => existsSync(p));
  if (claudePaths.length || existsSync(join(home, ".claude"))) {
    found.push({
      id: "claude",
      label: "Claude Code",
      foundPaths: claudePaths.length ? claudePaths : [join(home, ".claude")],
      projectApplySupported: true,
    });
  }

  const codexPaths = [join(home, ".codex", "config.toml")].filter((p) => existsSync(p));
  if (codexPaths.length || existsSync(join(home, ".codex"))) {
    found.push({
      id: "codex",
      label: "Codex CLI",
      foundPaths: codexPaths.length ? codexPaths : [join(home, ".codex")],
      projectApplySupported: false,
    });
  }

  const opencodePaths = [
    join(cwd, "opencode.json"),
    join(cwd, "opencode.jsonc"),
    join(home, ".config", "opencode", "opencode.json"),
  ].filter((p) => existsSync(p));
  if (opencodePaths.length) {
    found.push({
      id: "opencode",
      label: "OpenCode",
      foundPaths: opencodePaths,
      projectApplySupported: false,
    });
  }

  return found;
}

export type DoctorSeverity = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  severity: DoctorSeverity;
  /** Human detail — must never contain credential values. */
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** Non-zero when any check that blocks normal operation failed. */
  exitCode: 0 | 1;
}

export interface DoctorOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable FS/stat for tests. */
  home?: string;
}

function nodeMajor(version = process.versions.node): number {
  const n = Number.parseInt(version.split(".")[0] ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Presence-only: never returns or logs the key value. */
export function credentialPresent(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = cursorEnvFilePath(),
): { present: boolean; source: "env" | "envFile" | "absent" } {
  const fromEnv = typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim().length > 0;
  if (fromEnv) return { present: true, source: "env" };
  const parsed = readEnvFile(envFilePath);
  const fromFile =
    typeof parsed.TYPESAFE_API_KEY === "string" && parsed.TYPESAFE_API_KEY.trim().length > 0;
  if (fromFile) return { present: true, source: "envFile" };
  return { present: false, source: "absent" };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function openDatabase(path: string) {
  const mod = require("node:sqlite") as typeof import("node:sqlite");
  return new mod.DatabaseSync(path);
}

/** Read-only diagnostics. Never prints credential values. */
export function runDoctor(opts: DoctorOptions = {}): DoctorResult {
  const repoRoot = resolve(opts.repoRoot ?? defaultRepoRoot());
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];

  const distCli = join(repoRoot, "dist", "cli.js");
  const distMcp = join(repoRoot, "dist", "mcp-server.js");
  const distBuilt = existsSync(distCli) && existsSync(distMcp);
  checks.push({
    id: "dist-built",
    label: "dist/ built",
    severity: distBuilt ? "ok" : "fail",
    detail: distBuilt
      ? `found ${distCli} and ${distMcp}`
      : "missing dist/cli.js or dist/mcp-server.js — run npm run build",
  });

  // Syntax/load smoke: node --check avoids starting the MCP stdio loop.
  if (distBuilt) {
    const check = spawnSync(process.execPath, ["--check", distMcp], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const ok = check.status === 0;
    checks.push({
      id: "mcp-syntax",
      label: "MCP server syntax",
      severity: ok ? "ok" : "fail",
      detail: ok ? "node --check dist/mcp-server.js passed" : "mcp-server.js failed syntax check",
    });
  } else {
    checks.push({
      id: "mcp-syntax",
      label: "MCP server syntax",
      severity: "fail",
      detail: "skipped — dist not built",
    });
  }

  const cred = credentialPresent(env);
  checks.push({
    id: "credential",
    label: "TYPESAFE_API_KEY present",
    severity: cred.present ? "ok" : "warn",
    detail: cred.present
      ? `present in ${cred.source} (value not shown)`
      : "absent — provider-backed tools need the key; check still works without it",
  });

  const hook = join(repoRoot, "adapters", "claude-code", "hooks", "pretooluse-jev-check.mjs");
  if (existsSync(hook)) {
    const exec = isExecutable(hook);
    checks.push({
      id: "hook-executable",
      label: "Claude PreToolUse hook executable",
      severity: exec ? "ok" : "fail",
      detail: exec
        ? `${hook} is executable`
        : `${hook} is not executable (chmod +x) — Claude hooks exit 126`,
    });
  } else {
    checks.push({
      id: "hook-executable",
      label: "Claude PreToolUse hook executable",
      severity: "warn",
      detail: "hook script not found in this checkout",
    });
  }

  const major = nodeMajor();
  if (major >= 22) {
    checks.push({
      id: "node-version",
      label: "Node.js version",
      severity: "ok",
      detail: `node ${process.versions.node} (node:sqlite OK)`,
    });
  } else if (major >= 20) {
    checks.push({
      id: "node-version",
      label: "Node.js version",
      severity: "warn",
      detail: `node ${process.versions.node} meets engines (>=20); prefer >=22 for node:sqlite evidence`,
    });
  } else {
    checks.push({
      id: "node-version",
      label: "Node.js version",
      severity: "fail",
      detail: `node ${process.versions.node} — need >= 20 (package engines)`,
    });
  }

  const config = resolveTelemetryConfig(env);
  if (!config.enabled) {
    checks.push({
      id: "evidence",
      label: "Evidence DB",
      severity: "ok",
      detail: "disabled (JEV_GUARD_LOCAL_EVIDENCE is not 1) — OK",
    });
  } else {
    try {
      const status = evidenceStatus({
        enabled: config.enabled,
        databasePath: config.databasePath,
        advisoryBytes: config.advisoryBytes || DEFAULT_ADVISORY_BYTES,
        openDatabase,
      });
      checks.push({
        id: "evidence",
        label: "Evidence DB",
        severity: "ok",
        detail: status.databaseExists
          ? `readable · ${status.decisionsStored ?? 0} decisions · schema ${status.schemaVersion ?? "?"}`
          : "enabled but database file not created yet (OK until first decision)",
      });
    } catch {
      checks.push({
        id: "evidence",
        label: "Evidence DB",
        severity: "warn",
        detail: "enabled but could not read status",
      });
    }
  }

  const exitCode = checks.some((c) => c.severity === "fail") ? 1 : 0;
  return { checks, exitCode };
}

export function formatDoctor(result: DoctorResult): string {
  const L: string[] = [];
  L.push("JEV CODING GUARD  ·  doctor");
  L.push("─".repeat(56));
  for (const c of result.checks) {
    const mark = c.severity === "ok" ? "OK  " : c.severity === "warn" ? "WARN" : "FAIL";
    L.push(`  [${mark}] ${c.label}`);
    L.push(`         ${c.detail}`);
  }
  L.push("");
  L.push(
    result.exitCode === 0
      ? "Result: ready (warnings do not block)."
      : "Result: one or more checks failed — fix FAIL rows before relying on Guard.",
  );
  L.push("");
  return L.join("\n");
}

export type InitAgentFilter = AgentId | "all";

export interface InitOptions {
  repoRoot?: string;
  projectDir?: string;
  agent?: InitAgentFilter;
  apply?: boolean;
  home?: string;
  cwd?: string;
}

export interface InitResult {
  exitCode: number;
  text: string;
  /** Paths that would be / were written (project scope only). */
  plannedWrites: string[];
}

/**
 * Dry-run by default. `--apply` only for Claude project scope via the adapter
 * installer. Codex / OpenCode / Cursor get printed guidance only.
 */
export function runInit(opts: InitOptions = {}): InitResult {
  const repoRoot = resolve(opts.repoRoot ?? defaultRepoRoot());
  const projectDir = resolve(opts.projectDir ?? opts.cwd ?? process.cwd());
  const apply = opts.apply === true;
  const filter = opts.agent ?? "all";
  const detected = detectAgents({ home: opts.home, cwd: projectDir });
  const targets =
    filter === "all" ? detected : detected.filter((a) => a.id === filter);

  const L: string[] = [];
  L.push("JEV CODING GUARD  ·  init" + (apply ? " (--apply)" : " (dry-run)"));
  L.push("─".repeat(56));
  L.push(`  repo     ${repoRoot}`);
  L.push(`  project  ${projectDir}`);
  L.push("");

  if (detected.length === 0) {
    L.push("  No agent configs detected under home / project.");
    L.push("  See Docs/which-agent.md and Docs/mcp-setup.md.");
    L.push("");
    return { exitCode: 0, text: L.join("\n"), plannedWrites: [] };
  }

  L.push("  Detected:");
  for (const a of detected) {
    L.push(`    • ${a.label} (${a.id})`);
    for (const p of a.foundPaths) L.push(`        ${p}`);
  }
  L.push("");

  if (filter !== "all" && targets.length === 0) {
    L.push(`  Agent filter "${filter}" not detected in this environment.`);
    L.push("");
    return { exitCode: 2, text: L.join("\n"), plannedWrites: [] };
  }

  const plannedWrites: string[] = [];
  const list = targets.length ? targets : detected;

  for (const a of list) {
    if (a.id === "claude") {
      const installerPath = join(repoRoot, "adapters", "claude-code", "install.mjs");
      const projectMcpPath = join(projectDir, ".mcp.json");
      const projectSettingsPath = join(projectDir, ".claude", "settings.json");
      const projectClaudeMdPath = join(projectDir, "CLAUDE.md");
      plannedWrites.push(projectMcpPath, projectSettingsPath, projectClaudeMdPath);

      L.push("  Claude Code plan:");
      L.push(`    write  ${projectMcpPath}`);
      L.push(`    write  ${projectSettingsPath}`);
      L.push(`    maybe  ${projectClaudeMdPath} (if missing)`);
      L.push("    never  ~/.claude.json (use printed claude mcp add)");
      L.push(`    hint   export TYPESAFE_API_KEY=…   # presence only — never commit`);
      L.push(`    hint   export JEV_GUARD_BIN=${join(repoRoot, "dist", "cli.js")}`);

      if (!existsSync(installerPath)) {
        L.push("    ERROR adapter installer missing — cannot apply.");
        L.push("");
        return { exitCode: 1, text: L.join("\n"), plannedWrites };
      }

      const argv = [
        installerPath,
        "--repo",
        repoRoot,
        "--project-dir",
        projectDir,
        ...(apply ? ["--apply"] : []),
      ];
      const child = spawnSync(process.execPath, argv, {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (child.stdout) L.push(child.stdout.trimEnd());
      if (child.stderr) L.push(child.stderr.trimEnd());
      const code = child.status ?? 1;
      L.push(
        apply
          ? code === 0
            ? "    applied (project scope)."
            : `    apply failed (exit ${code}).`
          : "    (installer dry-run output above)",
      );
      L.push("");
      if (apply) return { exitCode: code === 0 ? 0 : 1, text: L.join("\n"), plannedWrites };
    } else if (a.id === "cursor") {
      L.push("  Cursor: already covered by global MCP / hooks on this machine when configured.");
      L.push("    See Docs/mcp-setup.md — init does not rewrite ~/.cursor/mcp.json.");
      L.push("");
    } else if (a.id === "codex") {
      L.push("  Codex: copy adapters/codex/config.toml.example into ~/.codex/config.toml");
      L.push("    (advisory MCP + jev-guard check). init does not auto-write TOML.");
      L.push("");
    } else if (a.id === "opencode") {
      L.push("  OpenCode: copy adapters/opencode/opencode.json.example");
      L.push("    init does not auto-write opencode.json.");
      L.push("");
    }
  }

  if (!apply) {
    L.push("  Dry-run only. Re-run with --apply --agent claude --project-dir <app>");
    L.push("  to write Claude project files. Other agents stay print-only (Q4).");
    L.push("");
  }

  return { exitCode: 0, text: L.join("\n"), plannedWrites };
}
