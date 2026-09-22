# Naming lock — JevCore Agent

**Status:** Locked 2026-09-22 (A+B: package + CLI entry; repo/runtime path deferred)  
**Audience:** product, marketing, engineering, agents continuing this repo  
**Related:** [`SETUP.md`](../SETUP.md)

---

## 1. Locked surface

| Layer | Canonical name | Notes |
|---|---|---|
| **Product** | **JevCore Agent** | User-facing; Logo / H1 / CTA / report voice |
| **Category** | **JEV Coding Harness** | Hero eyebrow: `JEV Coding Harness · local runtime` |
| **npm package** | **`jevcore`** | `package.json` `name` (still `private: true` until publish) |
| **Primary CLI** | **`jevcore`** | User install line: `npx jevcore init` |
| **CLI alias** | **`jev-guard`** | Deprecated; same `dist/cli.js`; do not delete yet |
| **Guard module** | **JEV Guard** | Hard-policy layer **inside** the product — never the product name |
| **Contract field** | **`agent`** | JEVCore Agent Contract on MCP results; keep `executionMode` |
| **Repo / GitHub** | **`jevcore`** (new public repo) | **Do not** flip/rename `jev-coding-guard` — keep legacy private; clean export |
| **Runtime dir** | `~/.cursor/jev-coding-guard/` | Deferred; must not block CLI brand |

```text
User mental model:  I install JevCore Agent → I type jevcore
Engineering truth:  Agent = Setup + Decision + Workflow + Guard + Evidence + Adapter
                    Guard = one module (hard policy), not the whole product
                    jev-guard = old bin alias → same binary
```

---

## 2. What shipped in A+B (2026-09-22)

**In scope**

- `package.json`: `"name": "jevcore"`
- `bin`: `jevcore` + `jev-guard` → `dist/cli.js`
- npm scripts: `jevcore` (+ keep `jev-guard`)
- CLI usage strings prefer `jevcore`
- Landing / README install copy → `npx jevcore init`
- FAQ: `jev-guard` is deprecated alias

**Phase C — at public launch**

- Create **new** public repo **`carter1111/jevcore`** from a clean export (no history flip)
- Keep **`jev-coding-guard`** private forever (legacy history / internal docs)
- Renaming `~/.cursor/jev-coding-guard/` (profile, preferences, telemetry, envFile)
- Renaming MCP server id in existing Cursor `mcp.json` entries
- Changing the four public MCP tool names

---

## 3. Install commands (canonical)

```bash
npx jevcore init
npx jevcore init --apply
npx jevcore doctor
```

From a clone before publish:

```bash
node dist/cli.js init
node dist/cli.js doctor
```

Library import (after install / link):

```ts
import { guardOnce } from "jevcore";
```

---

## 4. Doc update checklist

When copy mentions install or brand, prefer:

| Prefer | Avoid as primary |
|---|---|
| JevCore Agent | “the Guard product” |
| `jevcore` / `npx jevcore init` | `npx jev-guard init` as Hero |
| JEV Guard = module | JEV Guard = product name |
| `jev-coding-guard` = repo/path compat | Presenting it as the user-facing brand |

User setup guide: **[`SETUP.md`](../SETUP.md)** at repo root.
