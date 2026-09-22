# jevcore

**Product:** [JevCore Agent](./Docs/JEVCore.md) (JEV Coding Harness)  
**Setup (users):** **[`SETUP.md`](./SETUP.md)** — `npx jevcoreagent init`  
**Naming lock:** [`Docs/NAMING.md`](./Docs/NAMING.md)  
**npm package:** `jevcore` (formerly `jev-coding-guard`; still `private: true`, unpublished)  
**CLI:** `jevcore` (preferred) · `jev-guard` (deprecated alias → same `dist/cli.js`)  
**GitHub (target):** [`jevcore`](https://github.com/carter1111/jevcore) · **Runtime dir (compat):** `~/.cursor/jev-coding-guard/`  
**License:** [Apache-2.0](./LICENSE) · [NOTICE](./NOTICE.md) · [Trademarks](./TRADEMARKS.md) · [Security](./SECURITY.md)  
**Site:** [jevcore.io](https://www.jevcore.io) · **X:** [@JevCoreAgent](https://x.com/JevCoreAgent)

Minimal, reusable **Jev decision layer** for global coding-agent workflow
optimization. It turns a software-development request into a small set of
structured judgments — task classification, risk scoring, execution-mode
decision, and security-review judgment — backed by TypeSafe's System One
model (Jev), with deterministic hard-policy overrides and confidence-aware
fallback.

**This is developer tooling only.** It is not a product feature; it contains
no application code, imports, assumptions, documentation references, or
product logic of any host application. It is intended to eventually support
Cursor, Codex, OpenCode, CLI tools, MCP, or CI. A **local stdio MCP server**
(3 read-only decision tools + 1 read-only evidence-report tool) is built in
`src/mcp-server.ts`; IDE/CI integration beyond that is still future work.

## What it decides

Given a task description (and optional hints such as touched file paths), the
guard returns:

| Output | Type | Meaning |
|---|---|---|
| `classification` | `{ kind, confidence, source }` | Task domain: `frontend / backend / web3 / devops / testing / research / general` |
| `risk` | `{ score, confidence, factors }` | Risk 0..1 (probability-weighted) + contributing factors |
| `security` | `{ reviewNeeded, noul, findings }` | Whether a dedicated security review is warranted |
| `mode` | `execute \| plan_first \| approval_required \| block` | The recommended execution mode |
| `routing` (optional) | `{ complexity, recommendedModelTier, … }` | P4 suggestions only — hosts are **not** forced |

### Public task-domain contract

The `kind` field is **exactly** one of:

```
frontend | backend | web3 | devops | testing | research | general
```

(Note: the value is `testing`, not `test`.) Security/authorization sensitivity
is **not** a domain — it is captured by the risk factors and the security-review
gate, so the domain contract stays normalized.

Decisions are composed in `engine.ts`:

```
input ──► PREFLIGHT hard policy ──► (block? return, ZERO model calls)
              │ no block
              ▼
        sanitize/redact ──► Jev judgment (batch) ──► confidence gate ──►
              mode ──► deterministic hard-policy OVERRIDE (always wins)
              │
              ▼
        attach P4 routing recommendations (omit if signals incomplete)
```

- **Policy runs first (preflight).** A `block` rule returns immediately with
  `source: "hard_policy"` and **zero provider calls** — secrets (private keys,
  seed phrases, `.env` values, PEM blocks, credential values) and destructive
  commands never reach TypeSafe.
- **Secret-like values are redacted** (`[REDACTED_SECRET]`) from everything the
  provider could see, even when no block applies.
- **Low confidence** never executes: `execute` is downgraded to `plan_first`.
- **Hard policy** (secrets / destructive commands / force push / destructive DB /
  prod migration / payments / infra) always wins over the model — a model saying
  "safe" can never override a policy rule.
- **Provider failure** degrades gracefully to `plan_first` (or `block` if a
  hard-policy rule matches).

## Layout

```
src/
  types.ts        contracts (no SDK types leak through)
  provider.ts     TypeSafe provider (official @typesafe-ai/sdk, one batch call)
  fallback.ts     RuleProvider (zero-dependency offline provider)
  policy.ts       deterministic hard-policy rules + matchPolicy
  engine.ts       Guard: composes judgment + policy + confidence fallback
  index.ts        public entry point
  index-guard.ts  defaultGuard()/guardOnce() convenience
  mcp-server.ts   local stdio MCP server (4 read-only tools)
  cli.ts          `jevcore check` / `decide-many` / `init` / `doctor` + evidence CLI
                  (`jev-guard` = deprecated bin alias)
  check.ts        portable deterministic gate (P0 exit-code contract)
  telemetry/      opt-in local evidence (sinks, report, maintenance, lock)
tests/
  engine.test.mjs                engine unit tests (fake provider, no network)
  mcp-server.test.mjs            MCP tests (in-process InMemoryTransport)
  preflight.test.mjs             policy-first preflight + secret redaction
  risk-normalization.test.mjs    risk-score normalization + boundary fallback
  web3-policy.test.mjs           POL-WEB3-ASSET-1
  db-environment-policy.test.mjs environment-aware DB policy
  telemetry.test.mjs             evidence storage, privacy, report, maintenance
  telemetry-concurrency.test.mjs multi-process writers, locks, report-during-write
  telemetry-mcp.test.mjs         evidence wired into the MCP server
  cli-evidence.test.mjs          `jevcore evidence` CLI behavior
  check.test.mjs                 P0 `jev-guard check` exit-code + privacy
  claude-adapter.test.mjs        P1 Claude Code hook exit→decision map
```

## Usage

### CLI — portable check (P0)

```sh
npm run build
node dist/cli.js check "git status"              # exit 0
node dist/cli.js check --json --stdin            # pipe a command; JSON on stdout
# exit 1 = block, 2 = approval_required, 3 = plan_first, 4 = fail-closed error
```

`check` never needs credentials, never calls Jev, never writes files. JSON
output never echoes the command (optional `--echo-hash` only).

### CLI — init / doctor (P3)

```sh
# Preferred (after publish / local link):
npx jevcoreagent init
npx jevcoreagent init --apply
npx jevcoreagent doctor

# From a clone today:
node dist/cli.js doctor                          # read-only diagnostics
node dist/cli.js init                            # detect agents + dry-run plan
node dist/cli.js init --apply --agent claude --project-dir /path/to/app

# Deprecated alias (same binary):
#   jev-guard …
```

`init` defaults to dry-run (Q4). `--apply` only writes Claude **project** files
via `adapters/claude-code/install.mjs` — never `~/.claude.json`, never key values.
`doctor` never prints credential values (presence only).

### Quick (default TypeSafe provider)

```ts
import { guardOnce } from "jevcoreagent";

// TYPESAFE_API_KEY must be set (or pass apiKey to TypeSafeProvider)
const result = await guardOnce({
  task: "Add login page to the web app",
  hints: { touchedFiles: ["web/login.tsx"] },
});

console.log(result.mode); // "execute" | "plan_first" | "approval_required" | "block"
console.log(result.classification.kind); // "frontend"
```

### Bring your own provider

The engine only depends on the `DecisionProvider` interface, so you can swap
the real TypeSafe client for the offline `RuleProvider` or your own:

```ts
import { Guard, RuleProvider } from "jevcoreagent";

const guard = new Guard(new RuleProvider());
const r = await guard.decide({ task: "Add docs for the API" });
```

### Configuration

```ts
new Guard(provider, {
  lowConfidenceThreshold: 0.6,    // below this: execute → plan_first
  planRiskThreshold: 0.5,         // at/above: plan_first
  approvalRiskThreshold: 0.8,     // at/above: approval_required
  securityReviewThreshold: 0.7,   // noul at/above → security review required
  policy: DEFAULT_POLICY,         // or custom HardPolicyRule[]
});
```

## TypeSafe provider details

The provider makes **one batched** `systemOne` call per decision:

- `kind` — `Choice` over the 7 task domains (frontend / backend / web3 / devops / testing / research / general)
- `risk` — `Score` over 4 ordered risk levels (Low → Critical). **The raw answer is a
  level index in `[0, 3]`, not a probability.** `provider.ts` normalizes it to the
  public `0..1` contract via `rawScore / RISK_MAX_LEVEL`, where `RISK_MAX_LEVEL` is
  derived from `RISK_CRITERIA.length - 1` (never hard-coded). Invalid raw values
  (non-finite, `< 0`, `> maxLevel`) are **not clamped** — they become a provider
  failure (`PROVIDER-INVALID-RISK-SCORE`) so the engine falls back deterministically.
- `factor_scope/destructive/data/security/irreversible/unclear` — parallel
  `Noul`s; factors with noul ≥ 0.5 are reported
- `security_review` — `Noul` (review required?)

Following the TypeSafe skill guidance: independent questions are asked in the
same call (they run in parallel and can't see each other), each question asks
one narrow judgment, and code owns the workflow.

The provider is injectable with a custom `fetch` for tests and a custom
`timeoutMs` (default 10 000). If the call fails, `judge` returns
`{ failed: true }` and the engine falls back deterministically — it never
blocks on the model.

## Hard-policy rules (deterministic, model-free)

| Rule | Trigger (strong evidence) | Override |
|---|---|---|
| `POL-SECRETS-1` | secret-like paths (`.env`, `*.pem`, `id_rsa`, `credentials/`, `.npmrc`, `*.tfstate`), secret content (`PRIVATE_KEY`, `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, seed phrase/mnemonic/bip39/recovery phrase, `BEGIN … PRIVATE KEY`, `sk-…`/`ghp_…`), or secret-exposing commands (`cat .env`, `printenv`, `echo $…SECRET…`) | `block` (preflight) |
| `POL-CI-SECRETS-1` | CI/CD secret *exposure* or hardcoding (`echo ${{ secrets.* }}`, or token-shaped values like `AKIA…`/`github_pat_…` in `.github/workflows/*`; bare `ghp_`/`sk-` literals are usually owned by `POL-SECRETS-1`) | `block` (preflight) |
| `POL-DESTRUCTIVE-CMD-1` | destructive shell commands (`rm -rf`, `shred`, `mkfs`, `dd … of=/dev/…`, fork bomb) | `block` (preflight) |
| `POL-INFRA-DESTROY-1` | infrastructure destroy (`terraform destroy`, `pulumi destroy`, `kubectl delete`, `helm uninstall`) | `block` (preflight) |
| `POL-FORCE-PUSH-1` | `git push --force` to a protected branch (`main`/`master`/`prod`/`release`) | `block` (preflight) |
| `POL-DB-DESTRUCTIVE-1` | destructive/irreversible data ops (`DROP`/`TRUNCATE`/`DELETE FROM`/`delete all`/irreversible migration) | `block` (preflight) |
| `POL-DB-SCHEMA-PUSH-1` | `prisma db push` with `--accept-data-loss` | `block` (preflight) |
| `POL-DB-PROD-1` | migration/schema push against explicit **production / live database** | `block` (preflight) |
| `POL-DB-DEPLOY-UNKNOWN-1` | deploy-style migration with **unknown target environment** | `approval_required` + **security review forced** |
| `POL-DB-SCHEMA-PUSH-2` | `prisma db push` with unknown/staging target | `approval_required` + **security review forced** |
| `POL-DB-SCHEMA-PUSH-3` | `prisma db push` against explicit **local/dev** | `approval_required` |
| `POL-DB-STAGING-1` | migration against explicit **staging** | `approval_required` |
| `POL-DB-MIGRATION-1` | migration against explicit **local/dev** target | `approval_required` |
| `POL-DB-MIGRATION-2` | migration with unclassifiable target environment | `approval_required` |
| `POL-PROD-1` | ships to production / deploy to prod | `approval_required` |
| `POL-CI-PRIV-1` | high-risk CI privilege (`pull_request_target`, elevated Actions `permissions:`/`id-token: write`, `curl\|bash` in CI paths, self-hosted+secrets, cloud OIDC from CI) | `approval_required` + **security review forced** |
| `POL-CI-SECRETS-2` | CI/CD workflow secret *references* (`${{ secrets.NAME }}`, or CI config paths + secrets wording; GHA / GitLab / Circle / Azure / Bitbucket) — exposure is `POL-CI-SECRETS-1` | `approval_required` + **security review forced** |
| `POL-AUTHZ-1` | authentication/authorization work (`auth*`, `login`, `jwt`, `oauth`, `rbac`, `permissions`, auth source files) | `approval_required` + **security review forced** |
| `POL-WEB3-ASSET-1` | web3 asset actions (ERC-20 approve/allowance, token transfer, wallet signing, bridge/swap, contract deploy or upgrade) | `approval_required` + **security review forced** |
| `POL-PAY-1` | stripe/billing/refund/subscription | `approval_required` |
| `POL-PUBLISH-1` | package registry publish (`npm`/`pnpm`/`yarn publish`, `twine upload`, `cargo publish`) | `approval_required` |
| `POL-PII-EGRESS-1` | bulk personal/customer data export or dump (egress verb + PII object) | `approval_required` + **security review forced** |
| `POL-INFRA-1` | k8s/terraform/infrastructure provisioning (non-destroy) | `approval_required` |

Rules with mode `block` run in a **preflight** pass before the provider, so they
make zero model calls and report `source: "hard_policy"`. Rules are evaluated in
order; the first match wins and **cannot be overridden by the model**.

**Calibration notes (contract-and-policy correction pass):**

- A bare `auth` word or an `auth.ts` / `auth.test.ts` file is **authorization
  work**, not secret material — it requires a security review/approval
  (`POL-AUTHZ-1`), and is **not** blocked by `POL-SECRETS-1`.
- Secrets blocking requires **strong evidence** (secret paths, secret content
  patterns, or commands that expose secret values).
- Migrations are **graded by environment**:
  explicit local/dev → `approval_required`; explicit staging → `approval_required`;
  deploy-style with an **unknown target** → `approval_required` + forced security
  review; explicit production/live → `block`; destructive/`--accept-data-loss` → `block`.
- An **unknown target is never labelled "local/dev"** — that ambiguity is called out
  explicitly (`POL-DB-DEPLOY-UNKNOWN-1`) and requires human confirmation.
- CI workflow secret *references* (`${{ secrets.NAME }}`) are **approval + review**
  (`POL-CI-SECRETS-2`), not a block. Echoing/logging those expressions or
  hardcoding token *values* into workflows is **blocked** (`POL-CI-SECRETS-1`).
- High-risk CI privilege patterns (`pull_request_target`, elevated Actions
  permissions, pipe-to-shell installers in CI paths, self-hosted+secrets, cloud
  OIDC from CI) are **approval + review** (`POL-CI-PRIV-1`), and take precedence
  over app-level `POL-AUTHZ-1` when they match.
- Infrastructure *destroy* (`terraform destroy`, `kubectl delete`, …) is **blocked**
  (`POL-INFRA-DESTROY-1`); ordinary provision stays `POL-INFRA-1` approval.

## MCP server (local stdio)

`src/mcp-server.ts` is a minimal MCP adapter over the library. It exposes four
read-only tools — three decision tools plus one evidence-report tool. All four
return decisions or reports only; none executes, edits, or deploys.

| Tool | Input | Output |
|---|---|---|
| `jev_assess_task` | `userTask`, `repositoryContext`, `changedFiles?`, `diffSummary?`, `testSummary?` | typed decision |
| `jev_assess_command` | `userTask`, `repositoryContext`, `proposedCommand`, `changedFiles?` | typed decision (command is TEXT EVIDENCE ONLY) |
| `jev_review_diff` | `userTask`, `repositoryContext`, `changedFiles`, `diffSummary`, `testSummary?` | typed decision |
| `jev_guard_report` | `period: "7d" \| "14d" \| "30d" \| "all"` | local evidence report (never calls TypeSafe) |

```json
{
  "taskDomain": "backend",
  "executionMode": "approval_required",
  "riskScore": 0.5,
  "requiresSecurityReview": false,
  "confidence": 0.9,
  "reasons": [{ "code": "POL-DB-MIGRATION-1", "detail": "Database migration requires approval" }],
  "source": "jev",
  "selectedPolicyRules": ["POL-DB-MIGRATION-1"]
}
```

Safety properties (built in, not configured):

- **Decisions only.** The decision tools never run shell commands, never read or
  write files, never deploy, and never expose `TYPESAFE_API_KEY`.
- **Hard policy is authoritative.** The engine applies `DEFAULT_POLICY` LAST;
  a `block` can never be overridden.
- **Fail-safe by construction.** If the model provider fails, ordinary tasks
  fall back to `plan_first`, deterministically elevated-risk tasks escalate to
  `approval_required`, and `block` is produced **only** by hard policy.

## Local Guard Evidence (opt-in)

An **opt-in, local-only** evidence layer answers "what did Guard actually do?".
It is **disabled by default** and, when disabled, creates no directory,
database, WAL file, or any other artifact — disabled mode is structurally inert
(a `NoopTelemetrySink` is injected, so no code path can write).

Enable it with a user-level flag, then restart the MCP server:

```sh
JEV_GUARD_LOCAL_EVIDENCE=1
```

When enabled, de-identified decision metadata is persisted **asynchronously**
to `~/.cursor/jev-coding-guard/telemetry.sqlite` (dir `0700`, file `0600`,
WAL mode, `busy_timeout`). Persistence never blocks or alters a decision.

**What is never stored:** task text, command text, diff content, prompts,
context, file/repo/path/branch identity, Git URL, database URL, wallet address,
transaction data, secrets, keys, key-derived values, content hashes or
fingerprints, raw provider payloads, and raw provider error messages.

**Report it** with the read-only `jev_guard_report` tool (periods `7d`/`14d`/
`30d`/`all`), which never calls TypeSafe and never returns stored payloads.

**Manage it** with the local CLI (never touches policy, Cursor config, keys,
`.env`, Rules, source, or Git):

```sh
jevcore evidence status
jevcore evidence purge --before 30d --dry-run
jevcore evidence purge --before 30d --apply
jevcore evidence reset --confirm-delete-local-evidence
# alias: jev-guard evidence …
```

> **Safety rule:** purge/reset **never unlink** the database, WAL, or SHM files
> (deleting an open SQLite file "succeeds" on Unix while the holder keeps the
> old inode). They take an advisory lock, refuse if a writer holds it, delete
> rows in a transaction, then checkpoint and `VACUUM`.

> **Runtime note:** `node:sqlite` is used from the existing Node runtime — no
> third-party dependency. It is marked experimental and emits an
> `ExperimentalWarning` **on stderr only**, which does not contaminate the
> stdio MCP protocol stream. No warning suppression is applied.

### Architectural amendment

Guard decisions never execute shell commands, modify repositories, modify
project files, mutate external systems, or perform network side effects other
than the configured TypeSafe provider call.

When Local Guard Evidence is explicitly enabled, the MCP server process may
asynchronously persist de-identified decision metadata to a user-owned local
SQLite database. This persistence is local-only, opt-in, best-effort, and must
never affect a returned safety decision.

The assessment tools' `readOnlyHint: true` means read-only **with respect to
repository, shell, and external-system side effects** — not zero local
persistence.

Run it:

```sh
npm run build                          # requires dist/ first
node dist/mcp-server.js                # stdio server (needs TYPESAFE_API_KEY for live model)
```

Launch on macOS so the environment `TYPESAFE_API_KEY` (e.g. from
`~/.zshenv`) reaches the process:

```sh
zsh -lc 'node /ABS/PATH/TO/jevcore/dist/mcp-server.js'
```

Tests drive the real server in-process over `@modelcontextprotocol/server`'s
`InMemoryTransport` with a fake provider — no network, no subprocess, no API
key (see `tests/mcp-server.test.mjs`, 15 cases).

### Multi-agent MCP setup

Exact file paths, top-level JSON/TOML keys, and credential injection patterns
for Cursor, Claude Code, Codex, VS Code, Windsurf, Cline, and Continue:

→ [`Docs/mcp-setup.md`](Docs/mcp-setup.md)

Which agent / enforcement strength:

→ [`Docs/which-agent.md`](Docs/which-agent.md)

Claude Code adapter (MCP + hook + dry-run installer):

→ [`adapters/claude-code/`](adapters/claude-code/)

Codex / OpenCode / generic `AGENTS.md`:

→ [`adapters/codex/`](adapters/codex/) · [`adapters/opencode/`](adapters/opencode/) · [`adapters/generic/AGENTS.md`](adapters/generic/AGENTS.md)

### Global Cursor configuration (APPLIED 2026-09-21)

> **Status: APPLIED.** The MCP server entry was added to the global Cursor MCP
> config and the rule below was added as a global Always Apply rule
> (`~/.cursor/rules/jev-coding-guard.mdc`). A backup of the prior `mcp.json` was
> saved as `~/.cursor/mcp.json.backup-20260921-000601`.

**1. Global MCP server config JSON** (add under Cursor → Settings → MCP →
**global** server config, e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jev-coding-guard": {
      "command": "zsh",
      "args": ["-lc", "node /ABS/PATH/TO/jevcore/dist/mcp-server.js"],
      "type": "stdio",
      "env": {}
    }
  }
}
```

Why `zsh -lc`: on macOS, `~/.zshenv` is sourced by every zsh instance, so the
locally exported `TYPESAFE_API_KEY` reaches the MCP server process without ever
being stored in it.

**2. Server launch command (exact, what Cursor spawns):**

```sh
zsh -lc "node /ABS/PATH/TO/jevcore/dist/mcp-server.js"
```

**3. Filesystem path (exact):**

```
/ABS/PATH/TO/jevcore/dist/mcp-server.js
```

**4. How to disable / remove it:**

- In Cursor: open **Settings → MCP**, find the `jev-coding-guard` server, and
  toggle it **off** (or click **Remove**) — no code change needed, the server
  is just not launched.
- Or delete the `jev-coding-guard` entry from the global `mcp.json` shown above.
- Or `unset TYPESAFE_API_KEY` in your shell — the server still runs; provider
  failure just falls back to `plan_first` / `approval_required` / policy `block`.

**5. Global User Rule** — written to `~/.cursor/rules/jev-coding-guard.mdc`
(`alwaysApply: true`). The file is the source of truth; the text below is
reproduced for reference:

```markdown
## jev-coding-guard decision layer

For normal low-risk coding tasks, work normally.

Before suggesting or executing a command involving secrets, .env files,
production, migrations, auth, permissions, payments, wallet/token actions,
smart contracts, destructive commands, force pushes, or infrastructure,
call jev_assess_command first.

Before large cross-module or ambiguous work, call jev_assess_task first.

Before completing a large, cross-module, security-sensitive,
authentication-related, migration-related, payment-related, wallet-related,
token-related, infrastructure-related, or smart-contract change, call
jev_review_diff before declaring the work complete.

Treat MCP output as decision support; never treat it as execution permission.

If executionMode is approval_required:
explain the decision and ask for explicit user approval before proceeding.

If executionMode is block:
do not execute the action.
Explain the blocking policy rule and offer a safe alternative.
Do not ask for approval to bypass a block.
```

## Development

```sh
npm install
npm run build   # tsc → dist/
npm test        # node --test (engine + mcp tests)

Node.js >= 20 required (so has @typesafe-ai/sdk and @modelcontextprotocol/server).
```

Tests run against `dist/` (the compiled output) with a **fake provider** — no
network, no API key, no real TypeSafe calls.

## Explicitly out of scope

- Product logic (task routing, user conversation, emotion classification)
- Any **executing** integration beyond the read-only stdio MCP server:
  IDE extension, skill router, deployment automation, autonomous command
  execution, git hooks, CI
- Imports of / dependencies on any host product's code