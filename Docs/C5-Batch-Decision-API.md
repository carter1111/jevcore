# C-5 Design Note — Batch / Streaming Decision API

**Product:** Jev Coding Guard  
**Candidate:** C-5  
**Status:** Phase A + Phase B **implemented** (2026-09-21).  
**Date:** 2026-09-21  
**Depends on:** existing `Guard.decide`, question packs (WP2), hard policy, fan-out (WP5)

**Shipped (Phase A):** `Guard.decideMany` / `runDecideMany` in `src/batch.ts` —
bounded concurrency over full per-item `decide` (default maxItems **16**,
concurrency **4**). Default strategy **`serial`**.

**Shipped (Phase B):** `strategy: "shared_system_one"` on `decideMany` /
`decideManyWithMeta` when the provider implements `judgeMany` (e.g.
`TypeSafeProvider`). One shared `systemOne` per chunk (max **8** items/chunk).
Preflight hard-blocks skip provider calls per item. Helpers in
`src/provider-batch.ts`. Tests: `tests/batch-shared.test.mjs`.

`jev-guard decide-many --stdin [--live] [--strategy shared_system_one]` —
offline RuleProvider by default; live TypeSafe + shared batch when `--live`.
`jev_assess_task` accepts optional `batchItems` (max 8) → **schemaVersion 2**
envelope (still four MCP tools). Throws `BatchTooLargeError` when over cap.
Tests: `tests/batch-decide.test.mjs`, `tests/batch-shared.test.mjs`,
`tests/mcp-batch.test.mjs`, `tests/cli-decide-many.test.mjs`.
Live measure: `npm run measure:batch:live`.

**Shipped (§7 evidence):** telemetry schema v2 tags each batch item with random
`batchId`, `batchSize`, `batchStrategy`. Tests: `tests/telemetry.test.mjs`,
`tests/telemetry-mcp.test.mjs`.

**Shipped (C-5e, library only):** `Guard.decideManyStream` / `runDecideManyStream`
yields serial results in completion order. Same decisions as `decideMany`.
`shared_system_one` is not streamed (one shared call). **MCP streaming is not
shipped** — stdio hosts keep the schemaVersion 2 envelope.
Corpus batch scenarios remain in `tests/corpus/batch-fixtures.json`.

---

## 1. Problem

Hosts often need many related safety decisions at once, for example:

- a PR’s changed-file list (one sub-task per path or hunk group)
- a commit that mixes auth, migration, and UI files
- a CI job that wants per-command assessments without N serial MCP round-trips

Today each call is `Guard.decide(one GuardInput)` → one provider `systemOne`
(or fan-out graph). Serializing N calls costs ~N× RTT and loses shared context.

C-5’s goal: **decide many items with one (or few) provider round-trips**, while
preserving every Guard invariant.

---

## 2. Non-negotiable invariants

Copied from the approved planning baseline; C-5 must not weaken them.

1. **Hard policy first, per item.** Each batch item runs the same preflight /
   post-judgment policy path as `decide`. A block on item *i* never requires a
   provider call for *i*, and cannot be softened by batch siblings.
2. **Never fail open.** Provider / partial / timeout failure → conservative
   per-item fallback (`plan_first` / policy block), never `execute`.
3. **Public MCP tool count stays four.** No fifth tool. Batch is either:
   - library-only (`Guard.decideMany`), and/or
   - an **optional shape** on existing tools (see §5), not a new tool name.
4. **Privacy.** No persistence of raw task/command/diff/path identity beyond
   existing evidence rules. Batch must not invent a new store.
5. **Fan-out remains policy-gated.** Batch does not force fan-out on; per-item
   fan-out eligibility is unchanged (`JEV_FAN_OUT=0` still disables).

---

## 3. Recommended product shape

### 3.1 Library API (primary)

```ts
interface BatchItem {
  id: string;                 // caller-supplied, opaque, echoed back
  input: GuardInput;          // same contract as decide()
}

interface DecideManyOptions {
  /** Max items accepted (hard cap). Default 20. */
  maxItems?: number;
  /**
   * Provider strategy (see §4). Default "shared_state_parallel".
   * "serial" is the escape hatch / A/B baseline.
   */
  strategy?: "shared_state_parallel" | "serial";
  /** Abort remaining provider work after this many ms (items already
   *  decided by hard policy are kept). */
  timeoutMs?: number;
}

interface BatchItemResult {
  id: string;
  result: EngineResult;       // identical shape to decide()
  /** How this item was settled. */
  settledBy: "hard_policy_preflight" | "provider" | "fallback" | "serial";
}

interface DecideManyResult {
  items: BatchItemResult[];   // same order as input
  meta: {
    strategy: string;
    providerCalls: number;    // 0..few, never N when all blocked
    timedOut: boolean;
  };
}

// Guard.decideMany(items, options?) → DecideManyResult
```

**Ordering:** results mirror input order. Callers must not assume
“riskiest first.”

**Idempotency:** `id` is for correlation only; Guard does not dedupe.

### 3.2 Streaming (phase 2, optional)

A streaming variant is **not** required for v1.

If added later:

- AsyncIterable / callback of `BatchItemResult` as each item settles
  (hard-policy items first, then provider-backed).
- Same final semantics as `decideMany`; streaming is delivery only.
- MCP stdio is a poor fit for partial streams → keep streaming
  **library/CLI only** unless a host explicitly needs it.

**v1 ships batch-only.** Streaming is a follow-up after batch proves useful.

---

## 4. Provider strategy

Today one `decide` → one `systemOne` with the versioned question pack
(classify + risk + security, optionally fan-out Round 1).

For many items, three strategies were considered:

| Strategy | Provider calls | Pros | Cons |
|---|---|---|---|
| **A. Serial** | ≤ N | Trivial, identical semantics | No latency win |
| **B. Shared-state parallel questions** | ~1 (+ fan-out) | True TypeSafe parallel-questions win | Pack / state design; answer wiring |
| **C. One mega-prompt “rank all files”** | 1 | Cheap | Opaque; weak per-item audit; **reject** |

**Choose B as the default target; A as fallback and test baseline.**

### 4.1 Shared-state parallel (B) — sketch

1. **Partition** items:
   - `blocked[]` — hard-policy `block` on preflight → finalize immediately,
     **zero** provider involvement.
   - `needsModel[]` — everything else (including `approval_required` policy
     matches that still want model context for reasons/routing, *or*
     policy-free items).  
     *Precision note:* today `decide` skips the provider only on **block**
     preflight. Batch must mirror that exactly — do not invent a new
     “skip provider on approval_required” path in C-5.
2. Build **one** TypeSafe `state` that lists each remaining item under a
   stable key (`item:<id>`), with the same sanitized fields `decide` would
   send (task text redacted via existing `sanitizeForProvider`).
3. Expand questions: for each item, emit the pack’s Choice/Score/Noul
   questions **namespaced** by `item:<id>` (or pack helper
   `questionsForItem(id, pack)`). Cap total questions (see §6).
4. One `systemOne` call. Map answers back per `id` → per-item
   `ModelJudgment` → run the **same** post path as `decide`
   (compose → policy override → low-conf downgrade → routing).
5. If fan-out would fire for an item, either:
   - **v1 conservative:** run fan-out **serially per eligible item** after
     the shared Round 0 (simpler, correct), or
   - **v1.1:** batch Round 1 verifications in a second shared call.
   Prefer serial fan-out in v1 to avoid a second design front.

### 4.2 Failure modes

| Failure | Per-item behavior |
|---|---|
| Shared call timeout / 5xx | All `needsModel` items → existing provider-failure fallback |
| Missing / invalid answer for one id | That item → fallback; siblings with valid answers still apply |
| Question-count cap exceeded | Split into chunks of K items (still ≪ N serial RTTs); document in meta |
| Empty batch | Return `{ items: [], meta: { providerCalls: 0 } }` |

Partial success is allowed **only** when some items were hard-policy settled
or have valid judgments; never invent `execute` for a missing judgment.

---

## 5. MCP surface (keep four tools)

**Recommendation:** do **not** add `jev_assess_batch`.

Options (pick one at approval time):

| Option | Change | Verdict |
|---|---|---|
| **M0** | Library + CLI only; MCP unchanged | **Preferred for v1** — lowest contract risk |
| **M1** | Allow `changedFiles[]` / multi-line `userTask` on existing tools to mean “assess each file as an item” and return a **list** in the tool result | Breaks today’s single-decision JSON shape — needs a versioned envelope |
| **M2** | New tool | **Forbidden** by invariant §2.3 unless the baseline is formally revised |

**v1 = M0.** Hosts that want batch use the library (or a thin `jev-guard decide-many` CLI). MCP agents keep calling the four tools one task at a time until a later, explicitly approved contract bump.

If a host urgently needs MCP batch later, prefer a **versioned result envelope** on `jev_assess_task` (e.g. `schemaVersion: 2`, `items: [...]`) behind a flag — still not a fifth tool. That is a separate approval.

---

## 6. Limits & cost

| Knob | Default | Rationale |
|---|---|---|
| `maxItems` | **20** | Keeps question expansion bounded; PR-sized |
| Questions per item | same as current pack (full or verify) | No silent pack fork |
| Max questions / call | derive from TypeSafe practical limit; chunk if over | Avoid silent truncation |
| Max input chars / item | reuse existing sanitize / MCP caps | No new secret surface |
| Default timeout | `max(15000, 5000 + 500*nModel)` ms | Soft; tune with WP1-style measure |

Cost: one shared call ≈ 1× pack cost × items in the prompt, not N× full RTTs.
Document that batch can be **more tokens / call** even when **faster wall-clock**.

---

## 7. Evidence & telemetry

- Emit **one evidence event per item** (same schema as today), tagged with
  `batchId` (random, non-identifying) + `batchSize` + `strategy`.
- Do **not** store the full batch payload.
- `providerCalls` in meta is for local reports / tests only.

---

## 8. Testing plan (when implementation is approved)

1. **All hard-policy block** → `providerCalls === 0`, every item `block`.
2. **Mixed** block + ordinary → provider called once; blocks unchanged.
3. **Fake provider** returns namespaced answers → modes match N× `decide`
   on the same fixtures (golden parity suite).
4. **Missing one id** → that item fallback; others intact.
5. **Over maxItems** → reject entire batch (fail closed) or truncate with
   explicit error — **prefer reject** (clearer than silent drop).
6. **Fan-out eligible item inside batch** → still never fails open; v1 serial
   Round 1.
7. Corpus: extend WP3 with 1–2 multi-item fixtures (not 40×N).

---

## 9. Explicit non-goals (v1)

- Cross-item “overall PR risk” rollup score (can be a later pure function).
- Replacing fan-out or question packs.
- Host model forcing / Cursor model routing.
- Streaming MCP.
- Fifth MCP tool.
- Calibrating thresholds (C-2 / C-6) — out of scope.

---

## 10. Phased delivery (after approval)

| Phase | Deliverable | Gate |
|---|---|---|
| **C-5a** | This design approved | User |
| **C-5b** | `Guard.decideMany` + serial strategy + tests | User |
| **C-5c** | Shared-state parallel provider path + chunking | User |
| **C-5d** | Optional CLI `decide-many`; measure latency vs N× decide | User |
| **C-5e** | (Optional) streaming library API | User |
| **C-5f** | (Optional) MCP envelope v2 — separate approval | User |

Do not start C-5b until C-5a is explicitly approved.

---

## 11. Open questions for the approver

1. **MCP:** confirm **M0** (library-only) for v1?
2. **Reject vs truncate** when `items.length > maxItems`? (design recommends reject)
3. **Fan-out in batch v1:** serial per item (recommended) vs batched Round 1?
4. Default `maxItems` 20 — raise/lower for your PR sizes?
5. Should `approval_required` hard-policy items still hit the provider in batch
   (mirror today’s `decide`), or is skipping provider for *all* hard-policy
   matches an intentional C-5 change? (**Recommend: mirror today.**)

---

## 12. Recommendation

Approve **C-5a** (this note) with:

- Library `decideMany`, default strategy shared-state parallel, serial fallback
- MCP unchanged (M0)
- Reject oversize batches
- Serial fan-out in v1
- Mirror single-`decide` preflight semantics (provider skip only on **block**)

Implementation waits for an explicit “implement C-5b” (or “implement C-5”) from
the user.
