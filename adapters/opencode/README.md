# OpenCode adapter (P2)

Registration snippets for **OpenCode**. Enforcement is **advisory + CLI gate**
— no documented native blocking hook.

See: [`Docs/mcp-setup.md`](../../Docs/mcp-setup.md) ·
[`adapters/generic/AGENTS.md`](../generic/AGENTS.md)

---

## Honest limitation

Same as Codex: MCP is advisory; use `jev-guard check` in CI/wrappers for a
deterministic gate. Do not claim Cursor/Claude Code hook parity.

---

## Install

OpenCode V2 prefers `mcp.servers` in `opencode.json` / `opencode.jsonc`
(project or `~/.config/opencode/`).

Copy [`opencode.json.example`](./opencode.json.example), replace `/ABS/…`, and
ensure `TYPESAFE_API_KEY` is in the environment (or use OpenCode’s `{env:NAME}`
form in `environment` if you add one — still do not commit the value).

V1-shaped configs that put servers directly under `mcp` may still load; prefer
the V2 `mcp.servers` shape below.

## Verify

Start OpenCode and confirm tools from `jev-coding-guard` appear, or use the
CLI’s MCP listing if your build exposes one. Also:

```bash
node /ABS/jev-coding-guard/dist/cli.js check --json "git status"
```

## Disable

Set `"disabled": true` on the server entry, or delete it from `opencode.json`.
