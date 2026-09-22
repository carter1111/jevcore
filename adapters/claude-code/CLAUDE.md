# Jev Coding Guard (Claude Code)

Use the `jev-coding-guard` MCP tools as the required safety preflight for
coding work. A separate `PreToolUse` Bash hook may also enforce deterministic
hard policy via `jevcore check` (alias `jev-guard check`) — that gate is
independent of this file.

## Task assessment

Before starting implementation work that may change source code,
configuration, infrastructure, database schemas, authentication,
payments, Web3 behavior, deployment settings, or repository history,
call `jev_assess_task`.

## Command assessment

Before executing any potentially mutating or high-impact command, call
`jev_assess_command`.

Examples include database migrations, deploys, infrastructure changes,
permission changes, package installation or upgrade, destructive shell
commands, force push, reset, rebase, commands involving secrets, and
on-chain/Web3 asset actions.

For read-only commands such as `git status`, `pwd`, `ls`, or reading a
source file, no command assessment is required.

## Diff review

Before declaring a task complete, call `jev_review_diff` when the changes
involve database migrations, authentication/authorization, security-sensitive
behavior, payments, Web3/on-chain behavior, infrastructure, deployment, or
permissions.

## After every assess / review — show Contract verbatim

Tool results include `executionMode` **and** `agent` (JEVCore Agent Contract).

1. **Print a JEVCore block from `agent` only** — `JEVCore: ` + `agent.headline`, then
   plan / choices / rewrite / `Actions:` from the payload. Do **not** paraphrase
   or shorten the prefix to `JEV:`. Do **not** restate a conflicting
   `executionMode` / `POL-*` after the block.
2. Then gate work with `executionMode` (must match the same assess result):
   - `execute` / `advance` — proceed
   - `plan_first` / `pave_way` — show plan; wait before large edits unless user approved
   - `approval_required` / `your_call` — wait for explicit user choice
   - `block` / `safer_path` — do not execute or bypass; offer the rewritten path only

Never execute when `approval_required` / `your_call` until the user explicitly
approves that exact action. Never execute when `block` / `safer_path`.

If a Guard MCP tool fails, do not treat that failure as approval to proceed.
Explain that the safety assessment failed. Do not continue with high-risk
actions while the assessment is unavailable.

Do not expose, paste, log, or send secrets, private keys, seed phrases,
API tokens, or `.env` contents to any tool.
