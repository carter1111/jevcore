# MCP setup across coding agents

How to register the local **stdio** MCP server for **JevCore Agent** (`jevcore` package;
repo/runtime still `jev-coding-guard`) in common coding agents, and how to inject the
TypeSafe credential **without** putting the value in Git.

> **User setup first:** [`SETUP.md`](../SETUP.md) · naming: [`NAMING.md`](./NAMING.md)  
> **Verified against current docs (2026-09-22).** Agent config formats diverge.
> Copying Cursor JSON into Claude Code / VS Code / Codex / Windsurf often fails
> silently. Use the file path and top-level key for **that** agent.

Related:

- Which agent / enforcement: [`Docs/which-agent.md`](./which-agent.md)
- Claude Code adapter: [`adapters/claude-code/`](../adapters/claude-code/)
- Codex / OpenCode / AGENTS.md: [`adapters/codex/`](../adapters/codex/) · [`adapters/opencode/`](../adapters/opencode/) · [`adapters/generic/AGENTS.md`](../adapters/generic/AGENTS.md)
- Runtime plan: [`Docs/JevCore_PRD.md`](./JevCore_PRD.md)

---

## 0. Prerequisites (every agent)

```bash
git clone <this-repo>
cd jev-coding-guard   # repo folder name (unchanged for now)
npm install
npm run build
# preferred CLI name after link/publish:
#   npx jevcoreagent doctor
# from clone today:
node dist/cli.js doctor
```

You need:

1. An absolute path to `node` (GUI-launched agents often have a thin `PATH`).
2. An absolute path to `dist/mcp-server.js`.
3. The TypeSafe credential available to the MCP **child process** as
   `TYPESAFE_API_KEY` (never commit the value).

Without the credential, the server still starts; Jev calls fall back to the
offline rule provider. Hard policy still works.

---

## 1. Credential injection (GitHub / local users)

**Do not** put the raw key in any committed MCP JSON/TOML.

### Recommended (Cursor / VS Code stdio)

1. Create a file **outside** the repo:

```bash
mkdir -p ~/.cursor
printf 'TYPESAFE_API_KEY=\n' > ~/.cursor/jev-coding-guard.env
chmod 600 ~/.cursor/jev-coding-guard.env
# edit the file and paste your key on the right-hand side of =
```

2. Point the MCP entry at that file with `envFile` (see Cursor / VS Code below).

### Shell profile (Claude Code, Codex, Continue, …)

```bash
# e.g. ~/.zshenv (loaded by non-interactive zsh) or your agent’s documented env source
export TYPESAFE_API_KEY='…'
```

Then reference it from MCP config via that agent’s interpolation syntax
(`${env:TYPESAFE_API_KEY}` in Cursor/VS Code; `${TYPESAFE_API_KEY}` in Claude Code).

### Never

- Commit `.env` / `jev-coding-guard.env` with a real value.
- Paste the key into chat, logs, or MCP tool arguments.
- Duplicate the variable in multiple profile files (later exports win and break
  launches — a known footgun on macOS).

---

## 2. Quick comparison

| Agent | Config file | Top-level key | Format | Stdio fields | Remote URL field | Credential pattern |
|---|---|---|---|---|---|---|
| **Cursor** | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `mcpServers` | JSON | `type`, `command`, `args`, `env`, **`envFile`** | `url` | `envFile` or `${env:NAME}` |
| **Claude Code** | project `.mcp.json`; user/local `~/.claude.json` | `mcpServers` | JSON | `command`, `args`, `env` | **`type` + `url`** (required) | `${VAR}` / `claude mcp add --env` |
| **Codex CLI** | `~/.codex/config.toml` | `[mcp_servers.<name>]` | **TOML** | `command`, `args`, `env` | `url` | `env` / `env_vars` |
| **VS Code / Copilot** | `.vscode/mcp.json` or user MCP config | **`servers`** | JSON | `type`, `command`, `args`, `env`, `envFile` | `type` + `url` | `envFile`, `${env:…}`, or `inputs` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | JSON | `command`, `args`, `env` | **`serverUrl`** | `env` |
| **Cline** | CLI `~/.cline/mcp.json`; IDE via MCP panel | `mcpServers` | JSON | `command`, `args`, `env` | `type: streamableHttp` + `url` | `env` |
| **Continue** | `~/.continue/config.yaml` or `.continue/mcpServers/*` | `mcpServers` (**array**) | **YAML** | `name`, `command`, `args`, `env` | `type` + `url` | `env` / secrets |
| **Claude Desktop** | `claude_desktop_config.json` | `mcpServers` | JSON | `command`, `args`, `env` | `type` + `url` | `env` |

Official docs:

- [Cursor MCP](https://cursor.com/docs/mcp)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex config reference](https://developers.openai.com/codex/config-reference)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Continue MCP](https://docs.continue.dev/customize/deep-dives/mcp)

---

## 3. Per-agent templates

Replace `/ABS/node` and `/ABS/jev-coding-guard` with real absolute paths.

### 3.1 Cursor

```json
{
  "mcpServers": {
    "jev-coding-guard": {
      "type": "stdio",
      "command": "/ABS/node",
      "args": ["/ABS/jev-coding-guard/dist/mcp-server.js"],
      "envFile": "/Users/YOU/.cursor/jev-coding-guard.env"
    }
  }
}
```

Notes:

- Interpolation uses **`${env:NAME}`**, not `${NAME}`.
- `envFile` is **stdio-only**.
- Cursor does **not** honor VS Code `inputs` / `${input:…}` in `mcp.json`.

Verify: Settings → MCP → `jev-coding-guard` connected (4 tools).

---

### 3.2 Claude Code

**Do not** put `mcpServers` in `~/.claude/settings.json` or
`.claude/settings.local.json` — those files ignore it **silently**.

Prefer the CLI (writes the correct file):

```bash
claude mcp add \
  --transport stdio \
  --scope user \
  --env TYPESAFE_API_KEY="${TYPESAFE_API_KEY}" \
  jev-coding-guard -- \
  /ABS/node /ABS/jev-coding-guard/dist/mcp-server.js
```

Or project-shared `.mcp.json` (commit this; do **not** commit the value):

```json
{
  "mcpServers": {
    "jev-coding-guard": {
      "type": "stdio",
      "command": "/ABS/node",
      "args": ["/ABS/jev-coding-guard/dist/mcp-server.js"],
      "env": {
        "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"
      }
    }
  }
}
```

Notes:

- Remote entries with `url` **must** set `"type": "http"` (or `sse` / `ws`).
- Expansion syntax is **`${VAR}`** / `${VAR:-default}` (not `${env:VAR}`).
- Project `.mcp.json` usually needs interactive approval once.

Full adapter (hook + `CLAUDE.md`): see [`adapters/claude-code/`](../adapters/claude-code/).

Verify: `claude mcp list`

---

### 3.3 Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.jev-coding-guard]
command = "/ABS/node"
args = ["/ABS/jev-coding-guard/dist/mcp-server.js"]
startup_timeout_sec = 30.0
env_vars = ["TYPESAFE_API_KEY"]
```

Or inline env map (still prefer sourcing from the host environment):

```toml
[mcp_servers.jev-coding-guard]
command = "/ABS/node"
args = ["/ABS/jev-coding-guard/dist/mcp-server.js"]

[mcp_servers.jev-coding-guard.env]
TYPESAFE_API_KEY = "set-in-host-env-not-here"
```

CLI:

```bash
codex mcp add jev-coding-guard -- /ABS/node /ABS/jev-coding-guard/dist/mcp-server.js
codex mcp list
```

---

### 3.4 VS Code / GitHub Copilot Chat

`.vscode/mcp.json` — top-level key is **`servers`**, not `mcpServers`:

```json
{
  "servers": {
    "jev-coding-guard": {
      "type": "stdio",
      "command": "/ABS/node",
      "args": ["/ABS/jev-coding-guard/dist/mcp-server.js"],
      "envFile": "${userHome}/.cursor/jev-coding-guard.env"
    }
  }
}
```

Optional: use `inputs` + `${input:…}` for a one-time password prompt (VS Code
supports this; Cursor does not).

---

### 3.5 Windsurf

`~/.codeium/windsurf/mcp_config.json` (not `~/.windsurf/…`):

```json
{
  "mcpServers": {
    "jev-coding-guard": {
      "command": "/ABS/node",
      "args": ["/ABS/jev-coding-guard/dist/mcp-server.js"],
      "env": {
        "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"
      }
    }
  }
}
```

Remote servers use **`serverUrl`**, not `url`. Stdio blocks copied from Cursor
usually work; remote blocks do not.

---

### 3.6 Cline

CLI `~/.cline/mcp.json`:

```json
{
  "mcpServers": {
    "jev-coding-guard": {
      "command": "/ABS/node",
      "args": ["/ABS/jev-coding-guard/dist/mcp-server.js"],
      "env": {
        "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Remote: `"type": "streamableHttp"` + `url` + `headers`.

---

### 3.7 Continue

`~/.continue/config.yaml` — `mcpServers` is an **array**:

```yaml
name: Local Config
version: 1.0.0
schema: v1
mcpServers:
  - name: jev-coding-guard
    command: /ABS/node
    args:
      - /ABS/jev-coding-guard/dist/mcp-server.js
    env:
      TYPESAFE_API_KEY: ${TYPESAFE_API_KEY}
```

Continue can also load JSON dropped into `.continue/mcpServers/`.

---

## 4. Common failure modes

| Symptom | Likely cause |
|---|---|
| Server never appears | Wrong file path (Claude: not `settings.json`; Windsurf: not `mcp.json`) |
| VS Code ignores config | Used `mcpServers` instead of `servers` |
| Claude remote URL ignored / error | Missing `"type": "http"` |
| Windsurf remote never connects | Used `url` instead of `serverUrl` |
| `spawn node ENOENT` | GUI PATH; use absolute `node` |
| Tools present but always rule-fallback | Child process never received `TYPESAFE_API_KEY` |
| Cursor key “set” but MCP empty | Env file edited but MCP not toggled/restarted; or duplicate shell exports |

---

## 5. What this server exposes

After a successful connect you should see four tools:

| Tool | Role |
|---|---|
| `jev_assess_task` | Typed task decision |
| `jev_assess_command` | Typed command decision |
| `jev_review_diff` | Pre-complete review for sensitive changes |
| `jev_guard_report` | Opt-in local evidence summary |

The MCP server is **read-only** w.r.t. the repo and shell. It does not execute
commands. Enforcement (blocking shell) is agent-specific: Cursor
`beforeShellExecution`, Claude Code `PreToolUse` (see adapter), etc.
