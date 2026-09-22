# Setup JevCore Agent

Wire **JevCore Agent** (JEV Coding Harness) into the coding agents you already use: Cursor, Claude Code, Codex, OpenCode, and others.

> This is not another “coding model.” It is a **local runtime** for your existing agent: Jev decisions, policy gates, authority, and local evidence.

---

## 1. Set up your TypeSafe credential

Jev judgments need the environment variable **`TYPESAFE_API_KEY`** available to the MCP child process (and optionally to your shell for CLI `--live` paths).

**Never** commit the value, paste it into chat, or put it in tracked MCP JSON/TOML.

### Recommended (Cursor / VS Code stdio `envFile`)

1. Create a file **outside** any git repo:

```bash
mkdir -p ~/.cursor
# Create an empty assignment line — YOU paste the real value in an editor.
# Do not echo or printf a real secret into the terminal history.
printf '%s\n' 'TYPESAFE_API_KEY=' > ~/.cursor/jev-coding-guard.env
chmod 600 ~/.cursor/jev-coding-guard.env
```

2. Open `~/.cursor/jev-coding-guard.env` in your editor and put your TypeSafe key on the right-hand side of `=` (one line, no quotes required unless your value needs them).

3. Point your MCP server entry at that file with **`envFile`** (absolute path), for example in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "jev-coding-guard": {
      "type": "stdio",
      "command": "/ABS/path/to/node",
      "args": ["/ABS/path/to/jevcore/dist/mcp-server.js"],
      "envFile": "/Users/YOU/.cursor/jev-coding-guard.env"
    }
  }
}
```

Replace `/ABS/...` and `/Users/YOU/...` with your real absolute paths. Keep the MCP server id as configured today (often still `jev-coding-guard`).

4. Reload MCP in Cursor (Settings → MCP), then run:

```bash
npx jevcoreagent doctor
# or from a clone:
node dist/cli.js doctor
```

`doctor` reports whether a credential appears **present**; it **never prints** the value.

### Alternative: shell profile (Claude Code, Codex, Continue, …)

Export the variable name in a profile that non-interactive launches also load (e.g. `~/.zshenv`), then reference it with that agent’s interpolation (`${TYPESAFE_API_KEY}`, `${env:TYPESAFE_API_KEY}`, etc.). Prefer **one** place for the value so overlapping exports do not fight.

### Without a credential

- MCP still starts.
- Model judgment falls back to the offline rule provider.
- **Hard policy gates still work** (`check`, hooks, destructive / secret rules).

More host-specific templates: [`Docs/mcp-setup.md`](./Docs/mcp-setup.md).

---

## 2. Install / wire the runtime

```bash
npx jevcoreagent init          # dry-run: show the plan, write nothing
npx jevcoreagent init --apply  # after you confirm, write adapters (where supported)
npx jevcoreagent doctor        # read-only health check: dist / MCP / credentials / hooks
```

| Command | What it does |
|---|---|
| `init` | Detect installed agents and print an install plan; **dry-run by default** |
| `init --apply` | Apply the plan (today `--apply` focuses on supported adapters such as Claude project scope) |
| `doctor` | Read-only diagnostics; **never prints** secret values |

**From source (contributors):** clone, build, then use `node dist/cli.js`:

```bash
git clone https://github.com/carter1111/jevcore
cd jevcore
npm install && npm run build
node dist/cli.js init
node dist/cli.js init --apply --agent claude --project-dir /path/to/your-app
node dist/cli.js doctor
```

Suggested order: **credential file → build/MCP → `doctor` → `init` (dry-run) → `init --apply`**.

---

## 3. Naming (at a glance)

| You hear | Meaning |
|---|---|
| **JevCore Agent** | Product name |
| **`jevcore`** | npm package + **primary CLI** (use this) |
| **`jev-guard`** | Legacy CLI alias; same binary; treat as deprecated in docs |
| **JEV Guard** | The **policy / hard-gate module** inside the product — not the product name |
| Repo / on-disk paths | Still `jev-coding-guard` / `~/.cursor/jev-coding-guard/` for now (decoupled from the CLI brand) |

> **FAQ:** Can I still use `jev-guard`? Yes. The product is **JevCore Agent** — prefer `jevcore`.

Full naming lock: [`Docs/NAMING.md`](./Docs/NAMING.md).

---

## 4. What you get after setup

1. **MCP (exactly 4 read-only tools)** — `jev_assess_task` / `jev_assess_command` / `jev_review_diff` / `jev_guard_report`  
2. **CLI** — `check` / `init` / `doctor` / `profile` / `agent` / `evidence` …  
3. **Local config directory** (name unchanged) — `~/.cursor/jev-coding-guard/` (profile, preferences, telemetry, …)  
4. **Hard boundaries** — real secrets to remote providers, asset signing, etc. **cannot** be relaxed via profile  

Enforcement differs by host (Cursor / Claude can use hooks; Codex / OpenCode are often MCP + CLI). See [`Docs/which-agent.md`](./Docs/which-agent.md).

---

## 5. Useful follow-ups

```bash
jevcore check "git status"              # deterministic gate (no model, no DB writes)
jevcore profile init                    # create profile.json (authority letter)
jevcore profile preset balanced         # cautious | balanced | assertive
jevcore agent doctor                    # Agent-side health narrative
jevcore evidence status                 # local evidence (opt-in separately)
```

Profile detail: [`Docs/JEV-Partner-Profile-Memory.md`](./Docs/JEV-Partner-Profile-Memory.md)  
Runtime blueprint: [`Docs/JEVCore.md`](./Docs/JEVCore.md)

---

## 6. Honest limits / not done yet

- **Published on npm:** [`jevcoreagent@0.1.1`](https://www.npmjs.com/package/jevcoreagent) — `npx jevcoreagent init` works without cloning. Unscoped `jevcore` is taken on npm. CLI bins: `jevcoreagent`, `jevcore`, `jev-guard`.  
- We **do not** auto-switch your host model; we only advise a tier.  
- We **do not** upload your code for training; evidence is local and opt-in.  
- Repo folder / GitHub name / `~/.cursor/jev-coding-guard/` are **not** fully renamed yet (intentional phase C).

---

## 7. Developer entry

Library API, architecture, tests: root [`README.md`](./README.md) · [`architecture.md`](./architecture.md)
