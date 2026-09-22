# Jev Coding Guard (generic agent guidance)

Copy or merge this into your project's `AGENTS.md` (or equivalent agent
instructions). It is **advisory**: the agent should call the MCP tools below.
It does **not** hard-block shell commands by itself.

For deterministic blocking, use:

- Cursor: `beforeShellExecution` hook
- Claude Code: `PreToolUse` hook (`adapters/claude-code/`)
- Any platform / CI: `jev-guard check` (exit 0/1/2/3/4)

Do not claim that this file alone enforces policy.

---

## MCP tools

When the `jev-coding-guard` MCP server is connected, use:

| Tool | When |
|---|---|
| `jev_assess_task` | Before implementation that may change code, config, infra, auth, payments, Web3, deploy, or git history |
| `jev_assess_command` | Before mutating / high-impact commands |
| `jev_review_diff` | Before declaring sensitive work complete |
| `jev_guard_report` | Optional local evidence summary (opt-in) |

### Decisions (keep `executionMode` + print `agent`)

Internal modes still apply:

- `execute` — proceed normally
- `plan_first` — present a short plan before changing things
- `approval_required` — explain the risk; wait for explicit user approval of that exact action
- `block` — do not execute; do not propose a bypass; state the policy reason; offer a safer alternative

When the tool result includes an **`agent`** object (JEVCore Agent Contract):

1. **Print it verbatim** (headline / summary / plan / choices / rewrite / nextActions /
   valueReceipt lines). Do **not** paraphrase, translate, or regenerate with a host LLM.
2. Map user-facing states: `advance` | `pave_way` | `your_call` | `safer_path`.
3. Honor `nextActions` (approve once/session, self-handle, use safer path, etc.).
4. Never treat `safer_path` as “ignore and continue.”

Helper (library): `formatAgentVerbatim(agent)` from `jev-coding-guard`.

### Commands

Assess before: migrations, deploys, infra, permission changes, package upgrades,
destructive shell, force push / reset / rebase, secret-related commands, Web3
asset actions.

Read-only commands (`git status`, `pwd`, `ls`, reading a source file) do not
need assessment.

If a Guard MCP tool fails, that is **not** approval. Do not continue high-risk
work while assessment is unavailable.

Never expose, paste, log, or send secrets, private keys, seed phrases, API
tokens, or `.env` contents to any tool.

### Optional CLI gate

```sh
jev-guard check --json --stdin   # pipe the command; exit 1/2/4 must not be treated as allow
jev-guard agent doctor           # enforcement honesty + profile/memory
jev-guard agent report           # JEVCore Agent narrative (no host token-savings claims)
```
