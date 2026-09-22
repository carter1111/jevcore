# Codex adapter (P2)

Registration snippets for **OpenAI Codex CLI**. Enforcement is **advisory +
CLI gate** — Codex has no documented native blocking hook comparable to Cursor
`beforeShellExecution` or Claude Code `PreToolUse`.

See also: [`Docs/mcp-setup.md`](../../Docs/mcp-setup.md) ·
[`adapters/generic/AGENTS.md`](../generic/AGENTS.md)

---

## Honest limitation

| Layer | Capability |
|---|---|
| MCP tools | Advisory — the model may skip calling them |
| `jev-guard check` | Deterministic — use in CI / wrappers |
| Native hook | **None documented** |

Do not claim parity with Claude Code or Cursor shell gates.

---

## Install (stdio MCP)

1. Build Guard: `cd /ABS/jev-coding-guard && npm run build`
2. Ensure `TYPESAFE_API_KEY` is in the environment Codex inherits (do not put
   the value in `config.toml`).
3. Add to `~/.codex/config.toml` (see [`config.toml.example`](./config.toml.example)):

```toml
[mcp_servers.jev-coding-guard]
command = "/ABS/node"
args = ["/ABS/jev-coding-guard/dist/mcp-server.js"]
startup_timeout_sec = 30.0
env_vars = ["TYPESAFE_API_KEY"]
```

Or:

```bash
codex mcp add jev-coding-guard -- /ABS/node /ABS/jev-coding-guard/dist/mcp-server.js
```

4. Copy [`../generic/AGENTS.md`](../generic/AGENTS.md) guidance into the
   project (or merge into an existing `AGENTS.md`).

## Verify

```bash
codex mcp list
# expect jev-coding-guard with tools:
#   jev_assess_task, jev_assess_command, jev_review_diff, jev_guard_report
node /ABS/jev-coding-guard/dist/cli.js check --json "git status"
```

## Disable / remove

```bash
codex mcp remove jev-coding-guard
# or set enabled = false under [mcp_servers.jev-coding-guard]
```
