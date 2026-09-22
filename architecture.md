# jevcore — Architecture

> **Status**: Active  
> **Product**: JevCore Agent · **npm/CLI**: `jevcore` (alias `jev-guard`)  
> **Repo / runtime (compat)**: `jev-coding-guard` · `~/.cursor/jev-coding-guard/`  
> **Naming**: [`Docs/NAMING.md`](./Docs/NAMING.md) · setup: [`SETUP.md`](./SETUP.md)  
> **Version**: v0.7.0 (WP5 fan-out default ON; P6 advisory modelSelection; P4/P5 routers)
> **Scope**: The decision-layer architecture of this package — module boundaries,
> the decision pipeline, the public contracts, and the invariants a future change must
> preserve. **Not** a task backlog or release checklist.
> **Audience**: any agent continuing this work.

---

## 1. Purpose

`jevcore` (repo folder still `jev-coding-guard`) is a **minimal, reusable decision layer for global coding-agent
workflow optimization**. Given a software-development request, it returns structured
judgments a coding agent can act on:

- task **domain** classification
- **risk** scoring
- **execution-mode** decision (`execute | plan_first | approval_required | block`)
- **security-review** judgment
- **routing recommendations** (P4 — optional; hosts are not forced)

It is **developer tooling**, not a product feature. It contains **no application code,
imports, or assumptions** from any host product. It does not integrate with Cursor,
Codex, OpenCode, MCP, or CI yet — that is future work (see §8).

The model (TypeSafe Jev / System One) supplies **programmable common sense**; **code
owns the workflow**. Jev returns typed judgments and probabilities, never generated
text. Deterministic policy always outranks the model.

---

## 2. Module map

```
src/
  types.ts        Public contracts (framework-neutral; no SDK types leak)
  provider.ts     TypeSafeProvider — official @typesafe-ai/sdk adapter (1 batched call)
  fallback.ts     RuleProvider — zero-dependency offline provider (keyword heuristics)
  policy.ts       Deterministic hard-policy rules + matchPolicy
  risk-composition.ts  WP4 risk-signal composition + confidence routing
  routing.ts           P4 Preflight Router (recommendations only)
  context-router.ts    P5 Context Router (path-id suggestions; no file bodies)
  fan-out-policy.ts    WP5 decideFanOut (narrow trigger; content-free)
  fan-out.ts           WP5 FanOutProvider decorator (MCP default ON; JEV_FAN_OUT=0 disables)
  domain-packs.ts      WP5.1 Round-1 domain question packs + selection
  eval-manifest.ts     WP6 version pin for offline/shadow exports
  shadow-eval.ts       WP6 shadow-mode decision comparison (content-free)
  model-router.ts      P6 harness-only model/budget selection
  engine.ts       Guard — composes judgment + policy + confidence fallback + routing
  index.ts        Public entry point (re-exports)
  index-guard.ts  defaultGuard() / guardOnce() convenience wiring
  mcp-server.ts   Local stdio MCP server — 3 decision tools + jev_guard_report
  cli.ts          `jevcore` check / init / doctor / evidence (alias `jev-guard`)
  telemetry/
    types.ts                DecisionEvent, closed FailureCode union, TelemetrySink
    config.ts               opt-in flag + lazy path resolution (inert when disabled)
    noop-sink.ts            structural no-op (the default)
    sqlite-sink.ts          queue, batch flush, WAL, migrations, lazy node:sqlite
    schema.ts               schema + forward-only migrations
    report.ts               read-only aggregation
    format.ts               report text rendering
    pricing.ts              versioned, dated Jev price table
    maintenance.ts          purge / reset / status (never unlinks)
    lock.ts                 advisory maintenance lock
    instrumented-provider.ts DecisionProvider decorator (telemetry seam)
    session.ts              wiring: EngineResult → DecisionEvent
tests/
  engine.test.mjs                engine unit tests (fake provider; no network)
  mcp-server.test.mjs            MCP tests (in-process InMemoryTransport)
  preflight.test.mjs             policy-first preflight + redaction
  risk-normalization.test.mjs    risk normalization + boundary fallback
  web3-policy.test.mjs           POL-WEB3-ASSET-1
  db-environment-policy.test.mjs environment-aware DB policy
  telemetry.test.mjs             evidence storage, privacy, report, maintenance
  telemetry-concurrency.test.mjs multi-process writers, locks, read-during-write
  telemetry-mcp.test.mjs         evidence wired into the MCP server
  cli-evidence.test.mjs          `jev-guard evidence` CLI behavior
```

### Dependency direction (must not be violated)

```
index / index-guard
      │
      ▼
   engine  ──────────►  policy
      │                  │
      ▼                  ▼
  types  ◄──────────────┘   (types depends on nothing)

  provider ──► types        (provider imports the SDK; nothing imports provider except index-guard)
  fallback ──► types        (zero external deps)
  mcp-server ──► index      (MCP adapter imports only the public entry point
              │              + the MCP SDK; NO imports of provider internals)
              ├──► telemetry/session  (wiring; Noop when disabled)
              ▼
       @modelcontextprotocol/server, zod   (runtime deps)

  telemetry/sqlite-sink ──► telemetry/schema, telemetry/types
        └── node:sqlite resolved lazily via createRequire (never loaded when disabled)
  telemetry/maintenance ──► telemetry/lock, telemetry/schema
  cli ──► telemetry/maintenance, telemetry/config, telemetry/report
```

**Invariants:**

- `types.ts` imports **nothing** from the project or the SDK.
- `engine.ts` and `policy.ts` **must not** import the TypeSafe SDK — they operate
  purely on `DecisionProvider` / `GuardInput` contracts. This is what makes the
  decision logic unit-testable without network.
- **`engine.ts` and `policy.ts` must not import telemetry.** Evidence is attached
  at the `DecisionProvider` seam by a decorator, never inside the engine.
- Only `telemetry/sqlite-sink.ts`, `telemetry/session.ts`, `cli.ts`, and
  `mcp-server.ts` (report tool) may touch `node:sqlite`, and always lazily.
- Only `provider.ts` may import `@typesafe-ai/sdk`.
- `mcp-server.ts` **must not** import `@typesafe-ai/sdk` directly and **must not**
  contain its own policy rules — it reuses the public API (`Guard`,
  `RuleProvider`, `DEFAULT_POLICY`) and contains no `matches()` predicates of its
  own. Any `block` can only originate from `policy.ts`.
- `mcp-server.ts` is the **only** file allowed to import
  `@modelcontextprotocol/server` / `zod` (keeps the decision layer pure).

**Contract invariants (must not be broken):**

- **`riskScore` is always `0..1`.** TypeSafe `Score` returns a *level index*
  across `RISK_CRITERIA` (4 levels → `[0, 3]`); `normalizeRiskScore()` in
  `provider.ts` divides by `RISK_MAX_LEVEL` (derived, never hard-coded). The MCP
  output schema stays `min(0).max(1)` and must never be widened.
- **Invalid provider data is never clamped.** Non-finite / out-of-range values
  become a provider failure (`PROVIDER-INVALID-RISK-SCORE`) → deterministic safe
  fallback. `engine.ts` also rejects out-of-contract `riskScore` from any provider.
- **The MCP boundary never silently coerces.** `toDecisionOutput()` validates
  `risk.score`, `classification.confidence`, `risk.confidence`, the combined
  confidence, and `taskDomain`. Any violation returns an explicit fallback
  (`plan_first`, `riskScore: 1`, `confidence: 0`, `requiresSecurityReview: true`,
  `MCP-INVALID-DECISION-OUTPUT`) — never `-32603`, never `clamp01`.
- **No migration may reach `execute`.** Every migration/schema-push path resolves
  to `block` or `approval_required`; unknown targets stay `approval_required`
  (`POL-DB-MIGRATION-2`, `POL-DB-DEPLOY-UNKNOWN-1`).
- **Blocking rules precede the approval rules they override.** Enforced by an
  ordering-contract test.

---

## 3. Decision pipeline

`Guard.decide(input)`:

```
0. PREFLIGHT: matchPolicy(input)                    → if mode === "block":
                                                       return hard_policy block
                                                       (ZERO provider calls)
1. input = sanitizeForProvider(input)               → redact secret-like values
2. provider.judge(sanitized)                        → ModelJudgment (batched)
3. if judgment.failed or missing kind/risk          → deterministic fallback (§5)
4. build classification / risk / security           (from the judgment)
5. if security noul ≥ threshold                     → reasons += SEC-REVIEW
6. if kindConf or riskConf < lowConfidence          → mark low-confidence
7. mode = modeFromJudgment(kind, risk, security) (§4)
8. policyRule = matchPolicy(input)                  → HARD OVERRIDE (always wins)
     └ if rule.requiresSecurityReview                → force security.reviewNeeded
     └ classification.source = "hard_policy"
9. if low-confidence and mode == "execute"          → downgrade to plan_first
10. return { classification, risk, security, mode, reasons, fellBack }
```

### 3.1 Batch decisions (C-5)

**Phase A (serial):** `Guard.decideMany` with `strategy: "serial"` (default) runs
`runDecideMany` — bounded concurrency, cap 16, per-item full `decide` pipeline.

**Phase B (shared):** `strategy: "shared_system_one"` when the provider implements
`judgeMany` (`TypeSafeProvider` + `src/provider-batch.ts`): one namespaced
`systemOne` per chunk (max 8 items), preflight blocks still zero provider calls.

CLI: `jev-guard decide-many --stdin` (offline `RuleProvider`, serial only).

> **WP4 note:** step 7 is now performed by the deterministic risk-signal
> composition layer (`risk-composition.ts`, §14), which can preserve or escalate
> but never downgrade. Step 8 (hard policy) still runs after it and always wins.

### Ordering guarantees

- **Policy runs FIRST (preflight).** A blocking rule short-circuits before the
  provider is called at all, so sensitive content (private keys, seed phrases,
  `.env` values, PEM blocks, credential values) and destructive operations are
  **never sent to TypeSafe**. `source: "hard_policy"`, zero provider calls.
- **Sanitization before the provider.** Even when no block applies, every field
  the provider could see is passed through `sanitizeForProvider()`, which
  redacts secret-like values (`[REDACTED_SECRET]`).
- **Hard policy is applied AGAIN LAST** and always wins. A model judgment of
  "low risk" can never override a `block` rule.
- **Confidence alone never escalates.** Low confidence on its own only downgrades
  `execute → plan_first`; it never turns `execute` into `block`. It *may*
  escalate to `approval_required` only when **combined with a risk/security
  signal** (WP4, Plan §9): security-sensitive + low confidence, or an
  `irreversible` factor + low confidence.
- **Risk-signal composition can only preserve or escalate.** The composition
  layer (`risk-composition.ts`) never lowers an action, and the hard-policy
  override is applied after it, so a policy outcome is never downgraded.
- **Provider failure is not a decision.** It is handled by the fallback (§5), which
  still applies hard policy.

---

## 4. Execution-mode derivation

`modeFromJudgment(kind, riskScore, securityNeeded, planThreshold, approvalThreshold)`:

| Condition | Mode |
|---|---|
| `riskScore ≥ approvalRiskThreshold` (default 0.8) | `approval_required` |
| `riskScore ≥ planRiskThreshold` (default 0.5) | `plan_first` |
| `securityNeeded` (noul ≥ 0.7) | `plan_first` |
| otherwise | `execute` |

> The former `kind === "security" → plan_first` special case was **removed** in the
> contract-correction pass: the public domain contract has no `security` domain, so
> security sensitivity is expressed through the risk factors and the security gate.

### Default thresholds (`engine.ts` DEFAULTS)

| Config key | Default | Meaning |
|---|---|---|
| `lowConfidenceThreshold` | 0.6 | below → `execute` downgraded to `plan_first` |
| `planRiskThreshold` | 0.5 | at/above → `plan_first` |
| `approvalRiskThreshold` | 0.8 | at/above → `approval_required` |
| `securityReviewThreshold` | 0.7 | security noul at/above → review required |

All thresholds are **overridable per `Guard`** and must be calibrated on the user's
own data and consequences (they are defaults, not universal rules).

---

## 5. Fallback (provider failure)

When `judge` returns `{ failed: true }` or omits required fields:

1. `matchPolicy(input)` still runs. If a rule matches → return that rule's mode
   (respecting `requiresSecurityReview`), with `fellBack: true`.
2. Otherwise → `mode: "plan_first"` (never `execute`), `classification.source: "rule"`.

**Rationale:** the guard must never fail open. Losing the model must not enable
autonomous execution.

---

## 6. Public contracts

### 6.1 Task-domain contract (normalized, exact)

```ts
type TaskKind =
  | "frontend" | "backend" | "web3" | "devops" | "testing" | "research" | "general";
```

- The value is **`testing`**, not `test`.
- There is **no `security` domain** — authorization sensitivity is carried by risk
  factors + the security-review gate, keeping the domain set normalizable.
- Any future change to this set is a **contract change** and must update: `types.ts`,
  the provider Choice criteria, `RuleProvider`, tests, README, and public exports
  **together**.

### 6.2 Execution mode

```ts
type ExecutionMode = "execute" | "plan_first" | "approval_required" | "block";
```

### 6.3 `GuardInput`

```ts
interface GuardInput {
  task: string;
  hints?: {
    touchedFiles?: string[] | null;
    mentionsProd?: boolean | null;
    context?: string | null;
  };
}
```

### 6.4 `DecisionProvider` (the seam)

```ts
interface DecisionProvider {
  judge(input: GuardInput): Promise<ModelJudgment>;
}
```

Everything above `DecisionProvider` is provider-agnostic. This is the primary
extension point: swap `TypeSafeProvider` ↔ `RuleProvider` ↔ a custom provider
without touching `engine.ts`/`policy.ts`.

### 6.5 `HardPolicyRule`

```ts
interface HardPolicyRule {
  id: string;
  description: string;
  matches: (input: GuardInput) => boolean;
  mode: ExecutionMode;
  reason: DecisionReason;
  requiresSecurityReview?: boolean;  // force security.reviewNeeded on match
}
```

---

## 7. Deterministic hard policy

Rules are **model-free**, ordered, first-match-wins, and cannot be overridden by the
model. They are the last line of defense.

| Rule | Trigger (strong evidence) | Mode | Forces review |
|---|---|---|---|
| `POL-SECRETS-1` | secret-like paths (`.env`, `*.pem`, `id_rsa`, `credentials/`, `.npmrc`, `*.tfstate`, …), secret content (`PRIVATE_KEY`, `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, seed phrase/mnemonic/bip39/recovery phrase/12–24-word, `BEGIN … PRIVATE KEY`, `sk-…`, `ghp_…`), or secret-exposing commands (`cat .env`, `printenv`, `echo $…SECRET…`) | `block` (preflight) | — |
| `POL-CI-SECRETS-1` | CI/CD secret *exposure* or hardcoding (`echo ${{ secrets.* }}`, or token-shaped values like `AKIA…`/`github_pat_…` in `.github/workflows/*`; bare `ghp_`/`sk-` literals are usually owned by `POL-SECRETS-1`) | `block` (preflight) | — |
| `POL-DESTRUCTIVE-CMD-1` | destructive shell commands (`rm -rf`, `shred`, `mkfs`, `dd … of=/dev/…`, fork bomb, `chmod -R 777 /`) | `block` (preflight) | — |
| `POL-INFRA-DESTROY-1` | infrastructure destroy (`terraform destroy`, `pulumi destroy`, `kubectl delete`, `helm uninstall`) | `block` (preflight) | — |
| `POL-FORCE-PUSH-1` | `git push --force` / `--force-with-lease` to a protected branch (`main`/`master`/`prod`/`release`) | `block` (preflight) | — |
| `POL-DB-DESTRUCTIVE-1` | `DROP`/`TRUNCATE`/`DELETE FROM`/`delete all`/irreversible migration | `block` (preflight) | — |
| `POL-DB-SCHEMA-PUSH-1` | `prisma db push` / schema push with `--accept-data-loss` | `block` (preflight) | — |
| `POL-DB-PROD-1` | migration/schema push against explicit **production / prod / live database** (or `mentionsProd: true`) | `block` (preflight) | — |
| `POL-DB-DEPLOY-UNKNOWN-1` | deploy-style migration (`migrate deploy`, `migrate up`, "apply existing migrations") with **no determinable environment** | `approval_required` | **yes** |
| `POL-DB-SCHEMA-PUSH-2` | `prisma db push` with unknown or staging target | `approval_required` | **yes** |
| `POL-DB-SCHEMA-PUSH-3` | `prisma db push` against explicit local/dev | `approval_required` | — |
| `POL-DB-STAGING-1` | migration against explicit **staging / pre-prod** | `approval_required` | — |
| `POL-DB-MIGRATION-1` | migration against explicit **local/dev** target | `approval_required` | — |
| `POL-DB-MIGRATION-2` | migration whose target environment cannot be positively classified | `approval_required` | — |
| `POL-PROD-1` | ships to production / deploy prod (non-migration) | `approval_required` | — |
| `POL-CI-PRIV-1` | high-risk CI privilege (`pull_request_target`, elevated Actions permissions / `id-token: write`, pipe-to-shell in CI, self-hosted+secrets, cloud OIDC from CI) | `approval_required` | **yes** |
| `POL-CI-SECRETS-2` | CI/CD workflow secret *references* (`${{ secrets.NAME }}`, or CI config paths + secrets wording; GHA/GitLab/Circle/Azure/Bitbucket) — exposure is `POL-CI-SECRETS-1` | `approval_required` | **yes** |
| `POL-AUTHZ-1` | auth/authorization work (`auth*`, `login`, `jwt`, `oauth`, `rbac`, `permissions`, auth source files) | `approval_required` | **yes** |
| `POL-WEB3-ASSET-1` | web3 asset actions: ERC-20 approve/allowance, token transfer/send tx, wallet signing, bridge/swap, contract deployment or upgrade (`UUPS`/proxy/`upgradeTo`) | `approval_required` | **yes** |
| `POL-PAY-1` | stripe/billing/refund/subscription | `approval_required` | — |
| `POL-PUBLISH-1` | package registry publish (`npm`/`pnpm`/`yarn publish`, `twine upload`, `cargo publish`) | `approval_required` | — |
| `POL-PII-EGRESS-1` | bulk personal/customer data export or dump (egress verb + PII object) | `approval_required` | **yes** |
| `POL-INFRA-1` | k8s/terraform/infrastructure provisioning (non-destroy) | `approval_required` | — |

Rules with mode `block` are evaluated in a **preflight** pass before the provider
is called (zero provider calls, `source: "hard_policy"`). All rules are also
re-evaluated after judgment as the final authority.

### Calibration principles (binding)

1. **Secrets blocking requires strong evidence.** A bare `auth` word or an
   `auth.ts`/`auth.test.ts` file is *authorization work*, not secret material →
   `POL-AUTHZ-1` (approval + review), **not** `POL-SECRETS-1` (block).
2. **Migrations are graded by target environment.** Explicit local/dev →
   `approval_required`; explicit staging → `approval_required`; deploy-style with
   an **unknown target** → `approval_required` + **forced security review**;
   explicit production/live → `block`; destructive/`--accept-data-loss` → `block`.
   An unknown target is **never** described as "local/dev".
3. **`db push` and `migrate` are distinct.** `prisma db push` pushes schema state
   and does not use migration files, so it must never match a
   `POL-DB-MIGRATION-*` rule — it has its own `POL-DB-SCHEMA-PUSH-*` family.
4. **A migration must never reach `execute`.** Any migration whose environment
   cannot be positively classified still requires approval (`POL-DB-MIGRATION-2`).
5. **A `matches()` predicate must be conservative**: match broadly, block sometimes
   unnecessarily, never let something dangerous fall through.

---

## 8. Explicit non-goals (current phase)

**Authorized 2026-09-20:** a local, read-only **stdio MCP server**
(`src/mcp-server.ts`) exposing exactly the three decision tools. It is the only
MCP surface.

**Authorized 2026-09-21:** a **global Cursor `beforeShellExecution` hook**
(`~/.cursor/hooks.json` + `~/.cursor/hooks/jev-policy-check.mjs`) that
hard-enforces `matchPolicy` on shell commands. It lives outside this repo and
introduces no new policy — see §12.

**Authorized 2026-09-21:** an **opt-in, local-only Local Guard Evidence** layer
(4th MCP tool `jev_guard_report`, `src/telemetry/*`, `jev-guard` CLI). It
**amends** the previous zero-file-side-effect claim — see §13.

Do **not** add, unless a future task explicitly authorizes it:

- Cursor / Codex / OpenCode integration or global Cursor configuration beyond
  the read-only stdio MCP, the deterministic shell gate (§12), and the local
  evidence storage (§13) (config writes require explicit user approval)
- Skill routing
- Deployment automation
- Autonomous command execution
- Git hooks / CI
- Any production integration
- Any import of / dependency on a host product's code
- Any file/shell/network side effects from the MCP layer **other than** the
  opt-in local evidence persistence in §13

---

## 9. Tech stack & constraints

| Item | Value |
|---|---|
| Runtime | Node.js ≥ 20 (required by `@typesafe-ai/sdk`) |
| Language | TypeScript, `strict`, `NodeNext`, `verbatimModuleSyntax` |
| Module type | ESM (`"type": "module"`) |
| Runtime deps | `@typesafe-ai/sdk`, `@modelcontextprotocol/server` (MCP v2), `zod` |
| Dev deps | `typescript`, `@types/node` |
| SQLite | `node:sqlite` from the existing runtime — **no new dependency** |
| Test runner | Node built-in `node:test` (no vitest — avoids the vite/esbuild audit surface) |
| Audit status | 0 vulnerabilities (8 packages) |

### Why no vitest

The initial `vitest` install pulled in `vite`/`esbuild`/`@vitest/mocker` with 5 known
advisories (incl. 1 critical) that could only be fixed by a breaking major upgrade.
Switching to the built-in `node:test` removed that chain. MCP tests drive the real
server in-process via `InMemoryTransport` — still no vitest, still 0 vulnerabilities.

---

## 10. Testing strategy

- Tests import **built `dist/`** output (so `npm run build` is a test prerequisite).
- A **fake provider** drives the engine — no network, no API key, no real SDK calls.
- Coverage focuses on: classification passthrough, mode derivation per risk band,
  the security gate, low-confidence downgrade, provider-failure fallback, every
  hard-policy rule, and **regression cases**.
- The real `TypeSafeProvider` is smoke-tested manually (needs `TYPESAFE_API_KEY`);
  it is never exercised in the automated suite. Locking it with an injected
  `fetch` remains a follow-up.
- MCP tests drive the **real** `McpServer` in-process over `InMemoryTransport`
  with a fake provider — no sockets, no subprocess, no network. They prove:
  typed decisions from all four tools, no shell execution / no repo-file writes
  (probe-file assertions), hard-policy blocks preserved at the boundary, and
  fail-safe fallback behavior.
- **Evidence tests always use a per-run tmpdir.** The real `~/.cursor` path is
  never touched, and disabled-mode tests assert the filesystem stays untouched.
- **Concurrency tests spawn real child processes** to prove multi-writer
  durability, report-read-during-write, safe lock refusal, and stale-lock reclaim.
- **The `ExperimentalWarning` from `node:sqlite` is stderr-only** and is
  deliberately not suppressed; tests assert stdout purity where relevant.
- **Preflight tests count provider calls** — a hard block must make **zero**.
- **Risk-normalization tests** cover the exact `[0,3] → [0,1]` mapping, invalid
  raw values (`<0`, `>maxLevel`, `NaN`, `Infinity`), and the explicit MCP boundary
  fallback.
- **DB-policy tests** cover the full environment matrix plus an
  **ordering-contract** test (every blocking migration rule precedes the approval
  rules it overrides).

Test files: `engine` · `mcp-server` · `preflight` · `risk-normalization` ·
`web3-policy` · `db-environment-policy` (**175 cases** total).

---

## 11. Change control

| Change type | Requirements |
|---|---|
| New task domain / renamed domain | Contract change → update types + provider criteria + RuleProvider + tests + README + exports together |
| New policy rule | Add to `DEFAULT_POLICY` **in the correct precedence slot**; add a test proving its mode; document it in §7 + README; update the ordering-contract test |
| New threshold | Add to `DEFAULTS` + `EngineConfig`; document in §4 |
| New MCP tool | Add to `mcp-server.ts` with a zod `inputSchema` + `outputSchema`, a test in `mcp-server.test.mjs`, and README docs; must remain read-only (no exec / file / deploy) |
| New MCP input field | Update the zod schema (strict), the `buildXInput` normalizer, and the corresponding test |
| New provider | Implement `DecisionProvider`; must not require changes in `engine.ts`/`policy.ts` |
| Changing the risk rubric | Update `RISK_CRITERIA` (normalization derives from it automatically); update the normalization tests |
| Integration (MCP/IDE/CI) | **Out of scope** until explicitly authorized |

---

## 12. Global shell-command gate (Cursor `beforeShellExecution` hook)

> **Status**: live (2026-09-21). Lives **outside this repo** in `~/.cursor/`.

This is the first **hard-enforcement** surface: it turns the deterministic hard
policy from an advisory decision into an actual block on shell commands, for
**every workspace and every agent** on the machine.

```
~/.cursor/hooks.json
  ├─ beforeShellExecution
  │    └─ node ~/.cursor/hooks/jev-policy-check.mjs
  │         └─ matchPolicy({ task: <command>, hints: {} })
  └─ preToolUse (matcher: Write|Delete)
       └─ node ~/.cursor/hooks/jev-write-policy-check.mjs
            └─ matchPolicy({ task: "Write <path>", hints: { touchedFiles: [path] } })
```

Canonical script in-repo: `hooks/jev-write-policy-check.mjs` (copy to `~/.cursor/hooks/` after changes).

### 12.1 Mapping (the whole policy surface, no new rules)

| `matchPolicy` result | Hook output | Effect |
|---|---|---|
| no rule matches | `{"permission":"allow"}` | command runs normally |
| `rule.mode === "block"` | `{"permission":"deny", …}` | command is **not** executed |
| `rule.mode === "approval_required"` | `{"permission":"ask", …}` | user must confirm |
| any other mode (future-proof) | `{"permission":"ask", …}` | never silently allowed |
| internal error / `dist` missing | `{"permission":"allow", …}` | **fail-open** + warning |

The hook **introduces no policy of its own** — it is a thin adapter over
`policy.ts`. Adding or changing a rule in `policy.ts` (then `npm run build`)
automatically changes the gate. This preserves the invariant that *any `block`
can only originate from `policy.ts`* (§2).

### 12.2 Design constraints (binding — learned from a failed first attempt)

The hook runs **synchronously on every shell command**, which forces three
requirements:

1. **Deterministic.** The verdict for a given command must not vary run to run.
   Hard enforcement cannot be probabilistic.
2. **Fast.** Measured budget ~45 ms/command (node startup + one local import).
   A multi-second gate is unusable on a per-command path.
3. **Non-disruptive.** An unmatched command (the overwhelming majority) must pass
   without user interaction or latency spikes.

**Rejected design (recorded so it is not retried):** routing each command through
the LLM-backed MCP tool `jev_assess_command` (spawn MCP server + Jev call). It
violated all three constraints — 3–7 s latency (once >60 s), probabilistic
verdicts that flagged harmless commands (`date +%s` → `plan_first`), and with
`failClosed: true` it denied every non-whitelisted command in every workspace
whenever the check was slow or broken. Obsolete scripts
(`~/.cursor/hooks/jev-before-shell-execution.sh`, `jev-mcp-assess.mjs`) were
deleted in the 2026-09-21 integration cleanup.

**Write/Delete gate (2026-09-21):** `preToolUse` with matcher `Write|Delete`
closes the shell-only blind spot (editing secret paths never hit
`beforeShellExecution`). Same fail-open + `matchPolicy` adapter. Note: Cursor's
`permission: "ask"` on `preToolUse` is not reliably enforced today — `block`
still **deny**s; `approval_required` returns `ask` plus an agent_message.

**Fail-open is deliberate.** `failClosed: false`: a broken global check must not
be able to stall all work machine-wide. The trade-off is explicit — a `dist/`
build problem degrades the gate to a no-op (with a warning) rather than a
total outage. Deterministic fail-open beats a global denial-of-service.

### 12.3 Layer separation (the architectural point)

| Layer | Engine | Latency | Nature | Role |
|---|---|---|---|---|
| **Gate** (this hook, global) | `matchPolicy` | ~45 ms | deterministic | hard enforcement of *unambiguous* danger |
| **Advisory** (MCP tools) | Jev model | 3–7 s | probabilistic | on-demand judgment for *ambiguous / high-level* tasks |

Hard policy is deterministic and belongs on the synchronous path; the model is
probabilistic and belongs on the on-demand path. **Do not merge the layers.**

### 12.4 Verification

End-to-end through the live hook: `npm --version` → allow; `rm -rf …` → deny
(`POL-DESTRUCTIVE-CMD-1`); `npx prisma migrate dev` → ask
(`POL-DB-MIGRATION-1`); `pnpm prisma migrate deploy` → ask
(`POL-DB-DEPLOY-UNKNOWN-1`); `git push --force origin main` → deny
(`POL-FORCE-PUSH-1`); `terraform apply` → ask (`POL-INFRA-1`); simulated missing
`dist/policy.js` → allow + fail-open warning.

### 12.5 Operational notes

- The hook is a **global Cursor config write** and requires explicit user approval
  to change (§8).
- `chmod +x` matters: a non-executable hook script exits 126. With
  `failClosed: false` that fails open (silently allowing everything), which is how
  the first end-to-end test wrongly passed. Verify the exec bit after any edit.
- Use an **absolute node path** in `hooks.json` (not `env node`): the hook
  environment's `PATH` is not guaranteed to include nvm's node.
- `POL-DESTRUCTIVE-CMD-1` matches **all** `rm -rf`, including harmless temp
  cleanup. This is intentional conservative over-blocking (§7 principle 5); do not
  loosen it just to allow `rm -rf /tmp/...`.
- Cursor watches `hooks.json` and reloads on save; check **Settings → Hooks** if it
  does not fire.

---

## 13. Local Guard Evidence (opt-in, local-only)

> **Status**: live (2026-09-21). This section **amends** the former
> zero-file-side-effect claim.

```
mcp-server.ts
  ├─ jev_guard_report ──────────────► telemetry/report.ts   (read-only, no Jev)
  ├─ TelemetrySession ──────────────► telemetry/sqlite-sink.ts
  └─ InstrumentedProvider ──────────► DecisionProvider decorator (engine untouched)

cli.ts (jev-guard evidence status|purge|reset) ──► telemetry/maintenance.ts
```

### 13.1 The amended contract

> Guard decisions never execute shell commands, modify repositories, modify
> project files, mutate external systems, or perform network side effects other
> than the configured TypeSafe provider call.
>
> When Local Guard Evidence is explicitly enabled, the MCP server process may
> asynchronously persist de-identified decision metadata to a user-owned local
> SQLite database. This persistence is local-only, opt-in, best-effort, and must
> never affect a returned safety decision.

`readOnlyHint: true` on the assessment tools therefore means read-only **with
respect to repository, shell, and external-system side effects** — not zero local
persistence. `jev_guard_report` is read-only in every sense.

### 13.2 Structural inertness (disabled mode)

Disabled is the default and is inert **by construction, not by condition**:

- `resolveTelemetryConfig()` returns `enabled: false` with an **empty** database
  path and never calls `homedir()`.
- `NoopTelemetrySink` is injected — no code path from it reaches the filesystem,
  SQLite, timers, or the home directory.
- `node:sqlite` is resolved through `createRequire(import.meta.url)` **inside**
  the opener, so a disabled process never even loads the SQLite module.

Verified: a full decision cycle while disabled leaves the filesystem untouched.

### 13.3 Non-blocking write path

```
Guard computes decision
→ response returned immediately
→ event enqueued in memory (synchronous, enqueue-only)
→ background flush after 10 events or 1 s, whichever first
→ best-effort flush on SIGINT/SIGTERM/beforeExit
```

Losing the final unflushed events on abrupt termination is accepted. Every sink
method swallows its own errors: telemetry can never alter a decision, trigger a
provider call, or produce MCP `-32603`.

### 13.4 Instrumentation seam

Telemetry attaches at the `DecisionProvider` interface (§6.4) via
`InstrumentedProvider`, so **`engine.ts` and `policy.ts` are untouched**. The
decorator observes attempted/succeeded/failed, provider latency, and token usage
(additive `ModelJudgment.usage`, populated from the SDK result).

### 13.5 Privacy invariants

- **Closed failure-code union only** — `PREFLIGHT-BLOCK`, `PROVIDER-FAIL`,
  `PROVIDER-INVALID-RISK-SCORE`, `MCP-INVALID-DECISION-OUTPUT`, `LOW-CONF`. An
  arbitrary `TEXT` column would invite storing a raw provider exception.
- **`decision_id` is `crypto.randomUUID()`** and must never be content-derived.
- **No cost stored.** Tokens are stored; cost is computed at report time from a
  versioned, dated table (`telemetry/pricing.ts`) and the basis is printed.
- Never stored: task/command/diff/prompt/context text, paths, repo/branch/Git
  identity, DB URL, wallet address, transaction data, secrets, keys, content
  hashes, raw provider payloads or error messages.

### 13.6 Maintenance safety (never unlink)

Deleting an open SQLite file "succeeds" on Unix while the holder keeps the old
inode, so file deletion would silently leave a server writing to an orphan.
**Evidence maintenance (`purge` / `reset`, via the `jev-guard` CLI) therefore
never unlinks** `telemetry.sqlite`, `-wal`, `-shm`, or the lock. `purge --apply`
/ `reset` instead: acquire an advisory lock (non-blocking) → refuse safely if a
writer holds it → transactional `DELETE` → checkpoint → `VACUUM`.
`purge --dry-run` is strictly read-only.

This is the concurrency-safety responsibility of the **evidence maintenance
path** — not of the global Cursor shell gate (§12), which neither reads, writes,
nor manages `telemetry.sqlite` in any way.

Verified: 4 concurrent writers × 50 rows = 200/200 with zero errors; a report
read succeeds during active writes; a held lock causes a safe refusal; a stale
lock from a dead process is reclaimed.

### 13.7 Runtime note

`node:sqlite` comes from the existing runtime — **no new dependency**. It is
experimental and emits an `ExperimentalWarning` on **stderr only**, which does
not contaminate the stdio JSON-RPC stream. Suppression is deliberately **not**
applied (no `--disable-warning`, no `process.removeAllListeners`). A future
public installer may add the flag to its generated launch command; that is out of
scope here.

---

## 14. Risk-signal composition & confidence routing (WP4)

> **Status**: live (2026-09-21). Replaces the former single-threshold mode
> derivation with a versioned, deterministic composition layer.

```
risk-composition.ts   RISK_COMPOSITION_VERSION = "2026-09-21.1"
  composeRiskAction(signals, thresholds) -> { action, reasonIds, escalated, signalsUsed }
```

### 14.1 Routing table (Plan §9)

| Condition | Action |
|---|---|
| `riskScore >= approvalRiskThreshold` (0.8) | `approval_required` |
| `riskScore >= planRiskThreshold` (0.5) | `plan_first` |
| security review needed (noul >= 0.7) | at least `plan_first` |
| security review needed **+ low confidence** | `approval_required` (**escalation**) |
| `irreversible` factor **+ low confidence** | `approval_required` (**escalation**) |
| low confidence alone | `execute → plan_first` (downgrade only) |
| `verificationFailed` (WP5) | at least `approval_required` (`RC-VERIFICATION-FAILED`) |
| otherwise | `execute` |

### 14.2 Binding invariants

1. **Composition can only preserve or escalate.** It never lowers an action.
2. **Hard policy runs after composition and always wins.** A composition result
   can never downgrade a `block` or `approval_required` policy outcome.
3. **Confidence alone never escalates.** Escalation requires a risk/security
   signal *combined with* low confidence (rows 4–5 above).
4. **Composition never produces `block`.** Only hard policy can block.
5. **Content-free.** `signalsUsed` holds bounded numeric values, factor names,
   and booleans only — no task/command/diff/path/secret data.
6. **Deterministic and pure.** Same signals → same result; inputs are not mutated.
7. **Thresholds are provisional** until corpus-calibrated (Plan §9 calibration
   rule). Do not claim calibration without that evidence.

### 14.3 Change control

| Change | Requirements |
|---|---|
| New composition rule | Add to `composeRiskAction`; add a test; document here; bump `RISK_COMPOSITION_VERSION` |
| New threshold | Add to `CompositionThresholds` + `EngineConfig`; document in §4 and here |
| New reason ID | Add to `CompositionReasonId` union + `COMPOSITION_REASON_IDS` (closed set) |

**Tests**: `tests/risk-composition.test.mjs` (unit) and
`tests/confidence-routing.test.mjs` (engine-level, including hard-policy
precedence).

---

## 15. Conditional fan-out & self-consistency (WP5)

> **Status**: live default-on (2026-09-21.4 enable gate). Round 1 uses WP5.1
> domain packs + slim verify questions + confirmation merge. Disable with
> `JEV_FAN_OUT=0` or `createJevMcpServer({ fanOut: false })`. Injected test
> providers are never wrapped.

```
fan-out-policy.ts   FAN_OUT_POLICY_VERSION = "2026-09-21.3"
  decideFanOut({ input, round0, thresholds }) -> { allowed, reason, ... }
domain-packs.ts     DOMAIN_PACK_VERSION = "2026-09-21.1"
  selectDomainPack({ input, round0, fanOutReason }) -> { id, pack, reason }
fan-out.ts
  FanOutProvider(inner) — at most MAX_PROVIDER_CALLS (2)
  isFanOutEnabled()     — true unless JEV_FAN_OUT=0
  mergeJudgments()      — confirmation merge (FAN_OUT_MERGE_VERSION 2026-09-21.4)
  Round 1              — slim verify question set + domain pack
```

### 15.1 Budget & trigger (narrow)

| Rule | Behavior |
|---|---|
| Default assessment | Exactly **1** provider call |
| Uncertain + consequential | At most **1** verification call (total ≤ 2) |
| Hard policy already settles | No second call (`FO-HARD-POLICY-SETTLED`) |
| Round 0 provider failed | No second call (fallback handles it) |
| Low risk + high conf + no unclear + not security-sensitive | No second call |
| `unclear` **and** (near-threshold / low-conf / risk≥plan / security-sensitive) | Second call allowed |
| `unclear` alone at low risk + high conf | **No** second call (2026-09-21.3 live A/B tightening) |
| security-sensitive+low-conf / near threshold (±0.15) | Second call allowed |
| Round 1 pack | WP5.1 `selectDomainPack` (typed signals first, keyword tie-break) |
| Round 1 fail/throw | `verificationFailed` → composition `RC-VERIFICATION-FAILED` → `approval_required` |
| Caller depth knob | **None** (budget is a code constant) |

Round 1 uses a focused domain pack (database / deploy / authz / Web3 /
uncertainty). Selection prefers Round-0 kind/factors/security signals; task
keyword hints are tie-breakers only and are never stored.

### 15.2 Wiring (default ON)

```
TypeSafeProvider
  └─ InstrumentedProvider (when evidence enabled)
       └─ FanOutProvider   ← default; JEV_FAN_OUT=0 or options.fanOut=false disables
            └─ Guard
```

Injected `options.provider` is never fan-out-wrapped (tests / offline eval).

### 15.3 Binding invariants

1. Fan-out never **lowers** Round 0 risk/security. It **raises** them only when
   Round 1 confidence ≥ `FAN_OUT_CONFIRM_FLOOR` (0.6). MIN confidence applies
   only on kind disagreement — not on every field.
2. Round 1 uses a slim verify question set (risk + security + 1–2 factors).
2. Verification unavailability never fails open.
3. Hard policy preflight and post-composition override are unchanged.
4. Public MCP output does not expose `verificationFailed`, fan-out reasons, or call counts.
5. Telemetry aggregates dual-call latency/tokens when evidence is on; still content-free.

**Enable gate (met 2026-09-21.4):** live 40-fixture compare showed unsafeAllow −1,
unnecessary 0, p95 ~flat. MCP default-on; opt out with `JEV_FAN_OUT=0`.

**Tests**: `tests/fan-out-policy.test.mjs`, `tests/fan-out.test.mjs`,
`tests/domain-packs.test.mjs`.

---

## 16. Context Router (P5)

> **Status**: live (2026-09-21). Suggestions only — never a security gate.
> Jev identifier rerank is **ON by default** for the live MCP TypeSafe path
> (`JEV_CONTEXT_RERANK=0` disables). Adds up to **one** extra focused
> `systemOne` call when ≥2 path candidates exist (~+provider RTT latency).

```
context-router.ts
  suggestContextSync(input) -> deterministic ranking
  suggestContext(input, { rerankIdentifiers? })
context-rerank.ts
  TypeSafeContextReranker — separate Score-per-path call
  state = { task, candidates: string[] }  // identifiers ONLY
  MAX / MIN path gates; fail → keep deterministic
```

- Candidates come from caller `touchedFiles` / `candidatePaths` (identifiers only).
- Optional `git diff --name-only` only when explicitly enabled (off in default MCP).
- Injected test providers do **not** auto-enable Jev rerank.
- Omitted when no safe candidates (never fabricated).

**P4 measurement (P6 precondition):** `npm run measure:routing` →
`tools/routing-measure.mjs` (offline corpus distributions).

**WP6 / P6 eval tools (2026-09-21):**
- `npm run eval:shadow` → `tools/shadow-eval.mjs` (control vs fan-out treatment)
- `npm run measure:fan-out` → `tools/fan-out-measure.mjs` (fixture-only)
- `npm run eval:ab` → `tools/ab-harness.mjs` (P6 A/B harness; host selection unchanged)

No upload, no training, no savings claim without a documented live host A/B.

---

## 17. WP6 offline evaluation readiness & P6 A/B harness

> **Status**: live offline (2026-09-21). Shadow / measure / A/B tools are
> fixture-only. MCP fan-out is default ON (`JEV_FAN_OUT=0` disables).

```
eval-manifest.ts   buildEvalManifest() — version pins
shadow-eval.ts     compareShadowPair / summarizeShadowPairs
model-router.ts    selectHarnessModel() — harness catalog only
tools/shadow-eval.mjs
tools/fan-out-measure.mjs
tools/ab-harness.mjs
```

### 17.1 Non-goals (still)

- No upload of task/command/diff/repo content
- No silent training / no online learned safety actions
- No Cursor / Claude / Codex host model selection changes
- No default-on fan-out (measure only)

### 17.2 Fixture measurements (2026-09-21, offline fake)

| Tool | Key result |
|---|---|
| `eval:shadow` | 40/40 identical modes; treatmentStricterOrEqualRate=1; treatment calls 41 vs control 31 |
| `measure:fan-out` | allowed 10/40 (0.25); denied 30 FO-HARD-POLICY-SETTLED; packs all `uncertainty` |
| `eval:ab` | bothSelected 40; tierDisagreeRate 0.475; treatment tiers reasoning=9/normal=21/fast=10 |

**Tests**: `tests/eval-manifest.test.mjs`, `tests/shadow-eval.test.mjs`,
`tests/model-router.test.mjs`.
