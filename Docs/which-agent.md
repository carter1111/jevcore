# Which agent am I configuring?

Quick map from coding agent → config file → enforcement strength.
Full JSON/TOML shapes: [`mcp-setup.md`](./mcp-setup.md).

| Agent | Config | Top-level key | Blocking gate? | Adapter folder |
|---|---|---|---|---|
| **Cursor** | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `mcpServers` | Yes — `beforeShellExecution` (live in this repo’s Cursor setup) | (global hooks under `~/.cursor/hooks/`) |
| **Claude Code** | `.mcp.json` / `~/.claude.json` (**not** `settings.json` for MCP) | `mcpServers` | Yes — `PreToolUse` | [`adapters/claude-code/`](../adapters/claude-code/) |
| **Codex CLI** | `~/.codex/config.toml` | `[mcp_servers.*]` | No native hook — MCP advisory + `jev-guard check` | [`adapters/codex/`](../adapters/codex/) |
| **OpenCode** | `opencode.json(c)` | `mcp.servers` (V2) | No native hook — MCP advisory + `jev-guard check` | [`adapters/opencode/`](../adapters/opencode/) |
| **VS Code / Copilot** | `.vscode/mcp.json` | **`servers`** | No Guard hook in-repo | see mcp-setup.md |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | No Guard hook in-repo | see mcp-setup.md |
| **Cline** | `~/.cline/mcp.json` | `mcpServers` | No Guard hook in-repo | see mcp-setup.md |
| **Continue** | `config.yaml` | `mcpServers` (array) | No Guard hook in-repo | see mcp-setup.md |

**Portable deterministic gate (every platform):**

```sh
node dist/cli.js check --json "<command>"
# 0 allow · 1 block · 2 approval_required · 3 plan_first · 4 fail-closed
```

**Generic advisory text:** [`adapters/generic/AGENTS.md`](../adapters/generic/AGENTS.md)
