# JEVCore Agent — Runtime Blueprint

**Product:** JEVCore Agent  
**Category:** JEV Coding Harness  
**npm package / CLI:** `jevcore` (preferred) · alias `jev-guard` (deprecated)  
**Compatibility repo / runtime dir:** `jev-coding-guard` · `~/.cursor/jev-coding-guard/` (rename deferred)  
**Naming lock:** [`Docs/NAMING.md`](./NAMING.md) · user setup: [`SETUP.md`](../SETUP.md)  
**Note:** This blueprint describes the harness runtime. User-facing Agent Contract v1 is specified in `UX-Function-Improvement.md`.

**Status**: Positioning baseline (revised 2026-09-22 naming A+B). Supersedes the earlier
"Guard-first" framing.
**Supersedes**: the previous draft of this file, which framed the product as a
safety tool ("a thing that blocks dangerous commands").

---

## 0. The positioning change

The previous framing was **Guard-first**: the product is a guardrail that
intercepts risky commands.

That framing is not wrong — it is **too small**. It sells an interceptor. What we
are actually building is the layer that makes coding agents *use Jev reliably*.

> **JEVCore Agent** — the user-facing product (JEV Coding Harness) for making coding agents use Jev reliably.
>
> **JEV Guard** — the policy and safety module *inside* the harness runtime.

An **agent harness** is the system *outside the model* that makes an agent
actually work: tool invocation, context, state, run orchestration, constraints,
approvals, and verification. It is not merely an MCP server. It decides what the
agent sees, when it calls which tool, what it is allowed to do, and how mistakes
are handled.

So the product is not:

> "A tool that blocks dangerous commands."

It is:

> "A local runtime that gives any coding agent Jev-powered decisions, a
> configurable workflow, policy gates, and evidence."

Why Jev fits this role: Jev does **not generate text**. It returns **typed
decisions and confidences** for structured questions. That is exactly what a
runtime's fast decision layer needs — task complexity, whether planning is
required, whether security review is needed, which execution mode to take.

---

## 1. Module map

```
JEV Agent Runtime
│
├── Setup Layer
│   ├── JEV credential onboarding
│   ├── Keychain / local credential store
│   ├── Agent adapter installation
│   └── Runtime doctor
│
├── Decision Layer
│   ├── Jev task classification
│   ├── Risk / complexity / domain decisions
│   ├── Confidence and fallback
│   └── Decision receipts
│
├── Workflow Layer
│   ├── Preflight routing
│   ├── Skill selection
│   ├── Context budget suggestion
│   ├── Plan-first decision
│   └── Model / execution-mode recommendation
│
├── Guard Layer
│   ├── Hard policies
│   ├── Risky command gate
│   ├── Secret protection
│   ├── Migration / deploy / auth approval
│   └── Safe fallback
│
├── Evidence Layer
│   ├── Local receipts
│   ├── Runtime telemetry
│   ├── Retry / latency / tool-use signals
│   └── Evaluation harness
│
└── Adapter Layer
    ├── Cursor MCP
    ├── Claude Code hooks
    ├── Codex adapter
    ├── CLI wrapper
    └── CI / GitHub Actions
```

**JEV Guard is the Guard Layer.** It is a module, not the product. This is the
single most important correction in this revision.

---

## 2. What exists today (verified 2026-09-21)

Honest inventory, module by module. "Exists" means implemented and verified;
"partial" means a usable core exists but the module is not complete.

| Layer | Status | What exists |
|---|---|---|
| **Setup** | 🟡 partial | `jev-guard init` / `jev-guard doctor` (P3) — dry-run default; `--apply` writes Claude project files only. Manual Cursor MCP env still common. **No** keychain integration (deferred). |
| **Decision** | ✅ exists | `jev_assess_task` / `jev_assess_command` / `jev_review_diff`; 7-domain classification; normalized `0..1` risk; security-review judgment; confidence gating; **`Guard.decideMany`** (C-5 Phase A). |
| **Workflow** | ✅ exists | P4 Preflight Router (`routing` recommendations); P5 Context Router (`contextSuggestion`); P6 harness `modelSelection` (advisory only — never forces host model). |
| **Guard** | ✅ exists | 22 deterministic hard-policy rules; policy-first preflight (zero provider calls on block); secret protection; graded DB migration/deploy/auth/web3/payment/infra approvals; never-fail-open fallback; Write/Delete preToolUse gate. |
| **Evidence** | ✅ exists | `jev_guard_report` (read-only); local SQLite receipts; latency/token/policy telemetry; `jevcore` CLI (`check`/`init`/`doctor`/`decide-many`/evidence; alias `jev-guard`); privacy invariants. |
| **Adapter** | 🟡 partial | **Cursor**: MCP + global rule + shell + Write hooks. **Claude/Codex/OpenCode**: templates + `init` dry-run + `check` portable gate (P0–P2). Live operator install still required per platform. |

**Net**: Decision, Guard, Evidence, and Workflow routing are real. Setup and
multi-platform live adapter verification remain the gaps.

---

## 3. Adapter Layer — the next product step

The Decision/Guard/Evidence core is already a portable engine: a standard stdio
MCP server plus a CLI. Porting it to another agent is therefore **mostly
registration and guidance**, not reimplementation.

| Platform | Mechanism | Can it enforce? | Work |
|---|---|---|---|
| **Cursor** | MCP (`mcp.json`) + Rule + `beforeShellExecution` hook | **Yes** (hook: deterministic deny/ask) | ✅ done |
| **Claude Code** | MCP + `PreToolUse` hook + `CLAUDE.md` + dry-run installer | **Yes** (hook + `jev-guard check`) | ✅ templates + P1 installer (`adapters/claude-code/`) |
| **Codex** | MCP (local stdio) + `AGENTS.md` guidance | No native hook; tool + instructions only | ✅ templates (`adapters/codex/`) |
| **OpenCode** | Native MCP client support | No native hook | ✅ templates (`adapters/opencode/`) |
| **Pi / Onecode / others** | MCP where supported; otherwise `AGENTS.md` + CLI | Via CLI wrapper / CI only | 🟡 generic `AGENTS.md` + `check` |
| **CI / GitHub Actions** | `jev-guard check` / `decide-many` as a gate | **Yes** — deterministic, final gate before merge/deploy | ✅ `check` shipped; `decide-many` offline batch (C-5 Phase A) |

### 3.1 The enforcement reality (corrected)

An earlier version of this document claimed *"Cursor cannot force; only Claude
Code can."* **That is now out of date.** Cursor exposes a
`beforeShellExecution` hook that runs a local script deterministically and can
return `deny` / `ask`. It is a real gate, not a prompt.

So the honest table is:

| Mechanism | Can it truly force? | Why |
|---|---|---|
| Agent Rule / Skill / `AGENTS.md` | **No** | Prompt-level guidance; the model may ignore it |
| MCP tool | **No** | It offers a callable tool; the model decides whether to call it |
| Agent lifecycle **hook** | **Yes** | The harness executes it; not subject to model choice |
| **CLI wrapper / custom harness** | **Yes** | Your code owns the call path |
| **CI / Git hook** | **Yes** | Deterministic gate before merge/deploy |

This distinction is the core insight: **MCP provides the decision; hooks, CLI
wrappers, and CI provide the enforcement.** The runtime supplies both, per
platform, according to what the platform actually supports.

---

## 4. Why this beats "install the official TypeSafe skill"

The official TypeSafe skill is a **development guide**. It teaches an agent how
to design Jev questions, confidence routing, ranking, fallbacks, and evaluation.
That is genuinely useful — and it is also **instructions, not a runtime**.

```
User installs the skill
  ↓
Agent understands Jev best practices
  ↓
Agent decides on its own:
   whether to call Jev at all?
   how to phrase the questions?
   whether to apply hard policy?
   what thresholds?
   how to evaluate?
```

Failure modes of skill-only:

- The user must understand Jev to design a workflow.
- The agent may simply **not call Jev** (observed in practice: Jev usage stayed 0).
- Behaviour differs across agents.
- No unified policy.
- No token / failure / retry data.
- No enforcement whatsoever.

With the runtime:

```
jev-guard init
  ↓
Detects Cursor / Claude Code / Codex / OpenCode
  ↓
Installs the matching adapter
  ↓
Loads the default coding-safety policy
  ↓
Jev performs preflight decisions
  ↓
The platform executes the corresponding workflow
  ↓
Token / retry / policy / confidence data is recorded
```

**The user does not need to understand Jev.**

### 4.1 Why skill-only burns expensive tokens

This was verified directly on this project: after installing the skill, Jev
usage remained **0**. The agent read the skill, understood it, and then
continued thinking with its own default model — spending expensive tokens on
*management decisions* it was never asked to make:

```
Agent decides task difficulty by itself
Agent decides whether to plan first by itself
Agent decides whether anything is risky by itself
Agent decides whether to load a skill by itself
Agent reads large amounts of repo context by itself
  ↓
Sometimes it decides wrong
  ↓
Retry / rewrite / re-read files (expensive)
```

All of that is the expensive model performing **low-level routing work**. The
point of the runtime is to move that work to Jev:

```
Jev       → fast, cheap, structured low-level judgment
Agent     → the genuinely hard coding, debugging, architecture
```

---

## 5. Calling Jev should be *selective*, not constant

A dashboard that expects "every agent turn has Jev usage" is measuring the wrong
thing. Correct behaviour:

| Task | Should it call Jev? |
|---|---|
| Change button copy | No |
| Small CSS tweak | No |
| Small test fixture | No |
| `.env` / private key | **No Jev needed** — local hard policy blocks it directly |
| `rm -rf /`, force push to main | **No Jev needed** — local hard policy blocks it directly |
| Database migration | Yes, or decided by policy |
| Auth / permission change | Yes |
| Web3 / wallet / token / contract | Yes |
| Large cross-module refactor | Yes |
| Ambiguous requirement | Yes |
| Choosing model / skill / context | Yes |

The goal is therefore:

> "Jev is called **only when routing judgment is actually needed**; ordinary
> tasks cost nothing extra; complex tasks waste fewer expensive-model tokens."

This is already how the Guard Layer behaves: hard policy short-circuits *before*
the provider, so blocks cost **zero** Jev calls. Evidence confirms it — the
report's `Hard blocks with provider calls: 0` line is exactly this invariant.

---

## 6. Roadmap, in dependency order

```
1. Guard          ✅ done (22 rules, Write gate)
2. Agent Adapters 🟡 templates + portable check (Cursor live; others operator-verify)
3. Eval + Telemetry ✅ core done (WP1–WP6, shadow, A/B harness)
4. Preflight Router ✅ done (P4 — recommendations only)
5. Context Router   ✅ done (P5 — identifier ranking)
6. Model Router     ✅ harness done (P6 — advisory modelSelection; no host forcing)
7. Batch decide     ✅ Phase A (`decideMany` / CLI); Phase B (shared systemOne) deferred
```

**Order matters**: without adapters there is no adoption; without real workflow
data (tokens, tool calls, failures, retries) the routers are theory and cannot
prove savings.

### 6.1 Preflight Router — where savings begin

```
User task
  ↓
Jev preflight
  ↓
{
  complexity: "small" | "medium" | "large",
  taskDomain: "frontend" | "backend" | ...,
  executionMode: "execute" | "plan_first" | "approval_required" | "block",
  skillBundle: ["testing", "security"],
  contextBudget: "small" | "medium" | "large",
  modelTier: "fast" | "normal" | "reasoning"
}
  ↓
Coding agent
```

**Honest limits:** inside native Cursor / Claude Code / Codex, an external tool
generally **cannot** force the host to switch models or restrict its internal
context. So early on this layer must emit **recommendations**:

```
recommendedModelTier: fast
recommendedContextBudget: small
```

Only in a harness we control (our own CLI wrapper, an OpenRouter-based runtime,
or a platform with model routing) does the recommendation become **execution**.

### 6.2 Context Router — the most practical token saving

It does not ask Jev to "read the whole repo". It does cheap routing first:

```
User task
  ↓
metadata / path / git diff / symbols
  ↓
retrieval finds Top-K files
  ↓
Jev reranks
  ↓
only the necessary files go to the agent
```

Example:

```
"Change the Login Button styling"
  → src/components/LoginButton.tsx
  → src/styles/login.css
  → do NOT load all of src/auth, API, database, infra
```

### 6.3 Model Router — last, because it needs evidence

```
copy / CSS / test fixture        → fast cheap model
ordinary feature                 → normal coding model
cross-module refactor            → reasoning model
smart contract / auth / migration → reasoning model + security review
```

Highest payoff, highest risk. Do not switch models on intuition; require a
reliable benchmark first.

---

## 7. The runtime workflow (end to end)

```
Task arrives
  ↓
Preflight
  ↓
Policy decision
  ↓
Skill bundle selection
  ↓
Context selection
  ↓
Model tier selection
  ↓
Agent execution
  ↓
Pre-tool safety gate
  ↓
Post-change diff review
  ↓
Telemetry + evaluation
```

The official TypeSafe skill covers only the middle slice — "how to make Jev
judgments". The runtime covers **from task arrival, through agent execution,
through command execution, through diff review, through cost and quality data**.

---

## 8. How to prove the advantage

Do not compare "with skill" vs "without skill". Run three arms:

| Arm | Configuration |
|---|---|
| **A** | Native Cursor / Claude / Codex |
| **B** | Native agent + official TypeSafe skill |
| **C** | Native agent + skill + JEV Runtime (adapter + Guard + Router) |

Measure:

```
task completion rate
human correction count
retry count
tool-call count
erroneous command count
policy false positive / false negative
expensive-model tokens
Jev tokens
total cost
p50 / p95 latency
user confirmation count
```

Only **C** counts as a win if it satisfies all four:

```
task success rate not worse
safety strictly better
total cost lower (or acceptable)
user experience not worse
```

---

## 9. Reference contract notes (corrected)

Two details in the earlier draft were wrong and must not be quoted:

1. **`riskScore` is `0..1`, not `0..4`.** TypeSafe `Score` returns a *level
   index* across the ordered rubric; the runtime normalizes it
   (`raw / maxLevel`). The MCP output schema enforces `min(0).max(1)`, and
   out-of-contract values become an explicit, observable fallback rather than
   being clamped.

2. **Cursor *does* support deterministic enforcement** via
   `beforeShellExecution`. The earlier "Cursor cannot force" claim predates that
   hook and is obsolete.

Current public tool surface (4 tools, all read-only):

```
jev_assess_task      → typed decision for a coding task
jev_assess_command   → typed decision for a proposed shell command (never executed)
jev_review_diff      → typed decision for a changed-file set + diff summary
jev_guard_report     → local evidence report (never calls TypeSafe)
```

Typed decision shape:

```jsonc
{
  "taskDomain": "frontend" | "backend" | "web3" | "devops" | "testing" | "research" | "general",
  "executionMode": "execute" | "plan_first" | "approval_required" | "block",
  "riskScore": 0.0,          // 0..1 (normalized)
  "confidence": 0.0,          // 0..1
  "requiresSecurityReview": false,
  "reasons": [{ "code": "POL-...", "detail": "..." }],
  "source": "jev" | "rule" | "hard_policy",
  "selectedPolicyRules": ["POL-..."]
}
```

---

## 10. Positioning summary

The moat is **not** "we call Jev better". It is:

```
one-command setup
+ cross-agent adapters
+ deterministic enforcement where the platform allows it
+ coding-specific policy
+ preflight / context / model routing
+ eval + telemetry
+ provable token and retry savings
```

**JEV Guard is the safety module. JEV Agent Runtime is the product.**
