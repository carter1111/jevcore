#!/usr/bin/env node
/**
 * Claude Code adapter installer (P1).
 *
 * Default: dry-run — print the exact JSON and shell commands; write nothing.
 *   node adapters/claude-code/install.mjs
 *   node adapters/claude-code/install.mjs --repo /path/to/jev-coding-guard
 *
 * Apply (project scope only — writes into the target project, not ~/.claude):
 *   node adapters/claude-code/install.mjs --apply --project-dir /path/to/your/app
 *
 * User-scope MCP registration is always printed as a `claude mcp add …`
 * command; this script never writes `~/.claude.json` (use the Claude CLI).
 *
 * Never prints credential values — only variable names / envFile paths.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(__dirname);
const DEFAULT_REPO = resolve(__dirname, "..", "..");

/**
 * @param {{
 *   repoRoot?: string,
 *   projectDir?: string,
 *   nodePath?: string,
 * }} [opts]
 */
export function buildInstallPlan(opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? DEFAULT_REPO);
  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const nodePath = opts.nodePath ?? process.execPath;
  const mcpServer = join(repoRoot, "dist", "mcp-server.js");
  const hookScript = join(ADAPTER_ROOT, "hooks", "pretooluse-jev-check.mjs");
  const cliJs = join(repoRoot, "dist", "cli.js");
  const claudeMdSrc = join(ADAPTER_ROOT, "CLAUDE.md");

  const mcpJson = {
    mcpServers: {
      "jev-coding-guard": {
        type: "stdio",
        command: nodePath,
        args: [mcpServer],
        env: {
          TYPESAFE_API_KEY: "${TYPESAFE_API_KEY}",
        },
      },
    },
  };

  const hooksJson = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `${nodePath} ${hookScript}`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };

  const claudeMcpAdd = [
    "claude mcp add",
    "--transport stdio",
    "--scope user",
    '--env TYPESAFE_API_KEY="${TYPESAFE_API_KEY}"',
    "jev-coding-guard --",
    nodePath,
    mcpServer,
  ].join(" \\\n  ");

  return {
    repoRoot,
    projectDir,
    nodePath,
    mcpServer,
    hookScript,
    cliJs,
    claudeMdSrc,
    mcpJson,
    hooksJson,
    claudeMcpAdd,
    projectMcpPath: join(projectDir, ".mcp.json"),
    projectSettingsPath: join(projectDir, ".claude", "settings.json"),
    projectClaudeMdPath: join(projectDir, "CLAUDE.md"),
    envHints: [
      `export TYPESAFE_API_KEY=…   # presence only — never commit the value`,
      `export JEV_GUARD_BIN=${cliJs}`,
    ],
    verifyCommands: [
      "claude mcp list",
      `${nodePath} ${cliJs} check --json "git status"`,
      `test -x ${hookScript} || chmod +x ${hookScript}`,
    ],
    removeCommands: [
      "claude mcp remove jev-coding-guard",
      `# then delete the PreToolUse block from ${join(projectDir, ".claude", "settings.json")}`,
    ],
  };
}

function parseArgs(argv) {
  const out = {
    apply: false,
    repoRoot: DEFAULT_REPO,
    projectDir: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--repo") out.repoRoot = argv[++i];
    else if (a === "--project-dir") out.projectDir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function mergeHooksIntoSettings(existing, hooksFragment) {
  const base =
    existing && typeof existing === "object" ? structuredClone(existing) : {};
  if (!base.hooks || typeof base.hooks !== "object") base.hooks = {};
  const pre = Array.isArray(base.hooks.PreToolUse) ? base.hooks.PreToolUse : [];
  const incoming = hooksFragment.hooks.PreToolUse;
  // Drop any prior matcher:"Bash" entries that already call pretooluse-jev-check
  // so --apply is idempotent.
  const filtered = pre.filter((entry) => {
    const hooks = entry?.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some(
      (h) =>
        typeof h?.command === "string" &&
        h.command.includes("pretooluse-jev-check"),
    );
  });
  base.hooks.PreToolUse = [...filtered, ...incoming];
  return base;
}

function printPlan(plan) {
  const L = [];
  L.push("JEV Coding Guard — Claude Code adapter install plan");
  L.push("(dry-run by default; pass --apply to write project files)");
  L.push("");
  L.push(`repo:         ${plan.repoRoot}`);
  L.push(`project:      ${plan.projectDir}`);
  L.push(`mcp server:   ${plan.mcpServer} ${existsSync(plan.mcpServer) ? "[ok]" : "[MISSING — run npm run build]"}`);
  L.push(`hook script:  ${plan.hookScript}`);
  L.push(`check binary: ${plan.cliJs} ${existsSync(plan.cliJs) ? "[ok]" : "[MISSING]"}`);
  L.push("");
  L.push("--- project .mcp.json ---");
  L.push(JSON.stringify(plan.mcpJson, null, 2));
  L.push("");
  L.push("--- project .claude/settings.json hooks fragment ---");
  L.push(JSON.stringify(plan.hooksJson, null, 2));
  L.push("");
  L.push("--- preferred user-scope MCP (Claude CLI; not written by this script) ---");
  L.push(plan.claudeMcpAdd);
  L.push("");
  L.push("--- environment (values not printed) ---");
  for (const h of plan.envHints) L.push(`  ${h}`);
  L.push("");
  L.push("--- verify ---");
  for (const c of plan.verifyCommands) L.push(`  ${c}`);
  L.push("");
  L.push("--- remove ---");
  for (const c of plan.removeCommands) L.push(`  ${c}`);
  L.push("");
  process.stdout.write(L.join("\n"));
}

function applyProject(plan) {
  if (!existsSync(plan.mcpServer) || !existsSync(plan.cliJs)) {
    process.stderr.write(
      "Refuse --apply: dist/ not built. Run: npm run build\n",
    );
    return 1;
  }

  writeFileSync(plan.projectMcpPath, JSON.stringify(plan.mcpJson, null, 2) + "\n", {
    mode: 0o644,
  });

  const settingsDir = dirname(plan.projectSettingsPath);
  mkdirSync(settingsDir, { recursive: true });
  let existing = {};
  if (existsSync(plan.projectSettingsPath)) {
    try {
      existing = JSON.parse(readFileSync(plan.projectSettingsPath, "utf8"));
    } catch {
      process.stderr.write(
        `Refuse --apply: ${plan.projectSettingsPath} is not valid JSON\n`,
      );
      return 1;
    }
  }
  const merged = mergeHooksIntoSettings(existing, plan.hooksJson);
  writeFileSync(
    plan.projectSettingsPath,
    JSON.stringify(merged, null, 2) + "\n",
    { mode: 0o644 },
  );

  if (!existsSync(plan.projectClaudeMdPath) && existsSync(plan.claudeMdSrc)) {
    writeFileSync(
      plan.projectClaudeMdPath,
      readFileSync(plan.claudeMdSrc, "utf8"),
      { mode: 0o644 },
    );
  }

  try {
    chmodSync(plan.hookScript, 0o755);
  } catch {
    /* best-effort */
  }

  process.stdout.write(
    [
      "Applied (project scope):",
      `  wrote ${plan.projectMcpPath}`,
      `  wrote ${plan.projectSettingsPath}`,
      existsSync(plan.projectClaudeMdPath)
        ? `  CLAUDE.md present at ${plan.projectClaudeMdPath}`
        : `  (CLAUDE.md not copied)`,
      "",
      "Still required (manual):",
      "  1. export TYPESAFE_API_KEY in the environment Claude Code inherits",
      `  2. export JEV_GUARD_BIN=${plan.cliJs}`,
      "  3. approve project MCP servers when Claude Code prompts",
      "  4. OR run the printed `claude mcp add …` for user scope",
      "",
    ].join("\n"),
  );
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(String(e?.message ?? e) + "\n");
    return 2;
  }
  if (args.help) {
    process.stdout.write(
      [
        "Usage:",
        "  node adapters/claude-code/install.mjs [--repo <path>] [--project-dir <path>]",
        "  node adapters/claude-code/install.mjs --apply --project-dir <path>",
        "",
        "Default is dry-run (print only). --apply writes project .mcp.json,",
        ".claude/settings.json, and CLAUDE.md if missing. It never writes ~/.claude.json.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const plan = buildInstallPlan({
    repoRoot: args.repoRoot,
    projectDir: args.projectDir,
  });
  printPlan(plan);
  if (!args.apply) {
    process.stdout.write(
      "(dry-run complete — re-run with --apply --project-dir <app> to write)\n",
    );
    return 0;
  }
  return applyProject(plan);
}

if (import.meta.main) {
  process.exitCode = main();
}
