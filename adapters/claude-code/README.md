# Claude Code adapter (P1 templates)

Installer **templates** for Claude Code: MCP registration, a blocking
`PreToolUse` hook, and advisory `CLAUDE.md`.

> **Status:** templates only. They do **not** write to `~/.claude.json` or
> `~/.claude/settings.json` for you. Copy / adapt paths, then register.
>
> **Depends on P0:** the hook shells out to `jev-guard check` (shipped). Set
> `JEV_GUARD_BIN` to `dist/cli.js` or a `jev-guard` on `PATH`. If the binary is
> missing, the hook **fails closed** (deny).
>
> **Q3 (resolved 2026-09-21):** Claude Code `PreToolUse` **can block** — via
> exit code `2`, or exit `0` + JSON `permissionDecision: "deny"|"ask"|"allow"`.
> See [Hooks](https://code.claude.com/docs/en/hooks).

Also read: [`Docs/mcp-setup.md`](../../Docs/mcp-setup.md) for multi-agent MCP JSON.

---

## Layout

```
adapters/claude-code/
  README.md                      ← this file
  mcp.json.example               ← project-scope MCP fragment
  settings.hooks.json.example    ← hooks block for settings.json
  CLAUDE.md                      ← advisory guidance (copy into project or ~/.claude/)
  hooks/
    pretooluse-jev-check.mjs     ← PreToolUse command hook
    map-check-exit.mjs           ← pure exit→decision map (unit-tested)
```

---

## 1. Install MCP (stdio)

Prefer the CLI (writes the correct config file — **not** `settings.json`):

```bash
# Build first
cd /ABS/jev-coding-guard && npm run build

# User scope (all projects)
claude mcp add \
  --transport stdio \
  --scope user \
  --env TYPESAFE_API_KEY="${TYPESAFE_API_KEY}" \
  jev-coding-guard -- \
  /ABS/node /ABS/jev-coding-guard/dist/mcp-server.js
```

Or copy [`mcp.json.example`](./mcp.json.example) to the **project root** as
`.mcp.json`, replace `/ABS/…`, and approve the server when Claude Code prompts.

**Wrong place (silent no-op):** `mcpServers` inside `~/.claude/settings.json` or
`.claude/settings.local.json`.

Verify:

```bash
claude mcp list
```

You should see `jev-coding-guard` with four tools.

Disable / remove:

```bash
claude mcp remove jev-coding-guard
# or delete the entry from ~/.claude.json / .mcp.json
```

---

## 2. Install the PreToolUse hook (blocking)

1. Keep the hook script in this repo (or copy it somewhere stable).
2. Make it executable: `chmod +x adapters/claude-code/hooks/pretooluse-jev-check.mjs`
3. Merge [`settings.hooks.json.example`](./settings.hooks.json.example) into
   **project** `.claude/settings.json` or **user** `~/.claude/settings.json`.
4. Set `JEV_GUARD_BIN` to the `jev-guard` entry (after `npm run build`):

```bash
export JEV_GUARD_BIN=/ABS/jev-coding-guard/dist/cli.js
# or, once on PATH: export JEV_GUARD_BIN=jev-guard
```

### Exit-code mapping (PRD §4.3)

| `jev-guard check` exit | Hook `permissionDecision` |
|---|---|
| 0 | `allow` |
| 1 | `deny` (block) |
| 2 | `ask` |
| 3 | `ask` |
| 4 / missing binary / parse error | `deny` (fail-closed) |

The hook:

- Runs only for **Bash** (matcher in the settings example).
- Never prints the command text (only rule ids / short reasons).
- Does **not** call the TypeSafe provider (deterministic gate only).
- Uses exit `0` + JSON decisions so `ask` works (exit `2` alone is deny-only).

---

## 3. Advisory guidance (`CLAUDE.md`)

Copy [`CLAUDE.md`](./CLAUDE.md) to the project root (or merge into
`~/.claude/CLAUDE.md`). This mirrors the Cursor global rule: MCP preflight for
tasks/commands/diffs. It is **advisory**; the hook is the hard gate for Bash.

---

## 4. Verify

1. Dry-run the installer (writes nothing):

```bash
node adapters/claude-code/install.mjs --repo /ABS/jev-coding-guard
```

2. Optional project apply:

```bash
node adapters/claude-code/install.mjs --apply \
  --repo /ABS/jev-coding-guard \
  --project-dir /ABS/your-app
```

3. `claude mcp list` → server healthy (after `claude mcp add` or project approve).
4. Ask Claude to run a harmless command (`pwd`) → should proceed.
5. Unit tests (no Claude Code UI required):

```bash
node --test tests/claude-adapter.test.mjs tests/adapter-install.test.mjs
```

---

## 5. Enforcement honesty

| Layer | Capability |
|---|---|
| MCP tools | Advisory typed decisions (task / command / diff / report) |
| `PreToolUse` Bash hook | **Blocking** deterministic policy via `jev-guard check` |
| `CLAUDE.md` | Advisory procedural guidance |

This is stronger than Codex/AGENTS.md-only setups (P2), and comparable in spirit
to Cursor’s `beforeShellExecution` gate — but the config files and protocols
differ. Do not assume one JSON fragment works everywhere.

Installer: [`install.mjs`](./install.mjs) (dry-run by default; never writes
`~/.claude.json`).
