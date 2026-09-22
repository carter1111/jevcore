# AGENTS.md — JevCore workspace rules

Use this file when working in the **JevCore** private working tree or the future
public **`carter1111/jevcore`** repository.

Product: **JevCore Agent** · Package/CLI: **`jevcore`** · Site: **https://www.jevcore.io** · X: **https://x.com/JevCoreAgent**

---

## 1. Public vs private (hard rules)

| Surface | Rule |
|---|---|
| **Public GitHub `carter1111/jevcore`** | Clean, usable OSS only. **English-primary** docs and release notes. |
| **Legacy private `jev-coding-guard`** | Stay private forever. **Never** rename + flip to Public. |
| **`DevOps/`** | Local / internal only. **Never** commit to public remotes. |
| **`marketinglandingweb/`** | Website source → private `jevcore-website` only. Not OSS. |
| **HANDOFF / TASKS / PRDs / UX-Function-Improvement / parity plans** | Internal. Never ship in public export. |

**History rule:** Deleting a file from the latest tree does **not** remove it from
Git history. Public shipping uses a **clean export** (no legacy `.git`), not a
visibility flip. See local `DevOps/public-release.md` (not published).

---

## 2. Language

- **Public artifacts** (README, SETUP, architecture, SECURITY, CONTRIBUTING,
  CHANGELOG, GitHub Releases, issue templates): **English**.
- Private notes / `DevOps/` / HANDOFF: Chinese or bilingual OK.
- Do not leave personal absolute paths (`/Users/...`) in files destined for public.

---

## 3. Clean public surface

Before any public cut, the export must pass `DevOps/public-surface-audit.md`:

- Apache-2.0 + NOTICE + TRADEMARKS + SECURITY present  
- No secrets, no marketing tree, no planning docs  
- `npm ci && npm run build && npm test && npm run typecheck` green  
- Stranger can install from README alone  

If unsure whether a file is public-safe: **exclude it** until reviewed.

---

## 4. Development workflow

1. **Implement** in the private working tree.  
2. **Document strategy** in internal docs / `jevcore-internal` — not in public Docs.  
3. **Release** only via the DevOps public-release process (clean export → audit →
   push to `carter1111/jevcore`).  
4. Do **not** merge private `main` history into the public repo.

---

## 5. JevCore MCP / Guard (runtime)

When the JevCore MCP server is connected, use `jev_assess_task`,
`jev_assess_command`, `jev_review_diff`, and optional `jev_guard_report` as
safety preflight for coding work.

- Honor `executionMode` and print the `agent` contract **verbatim** when present.  
- Never treat MCP failure as approval.  
- Never paste secrets, private keys, or `.env` contents into tools.  

Adapter copy for hosts: `adapters/generic/AGENTS.md`.

---

## 6. Naming

| Prefer | Avoid as product name |
|---|---|
| JevCore Agent / `jevcore` | “Jev Coding Guard” as the product |
| JEV Guard = hard-policy **module** | Calling Guard the whole product |
| Public repo `jevcore` | Publishing under `jev-coding-guard` |

Runtime path `~/.cursor/jev-coding-guard/` may remain for compatibility.

---

## 7. License & affiliation

- Public core: **Apache-2.0**.  
- TypeSafe / Jev API is a **separate** service (user’s API key + their terms).  
- JevCore is **not** affiliated with or endorsed by TypeSafe. See NOTICE / TRADEMARKS.

---

## 8. Commits & remotes

- Do not commit `.env*`, keys, SQLite evidence DBs, or `DevOps/`.  
- Do not push to `carter1111/jevcore` without an explicit public-release approval.  
- Prefer small, English commit messages for commits that will land on public `jevcore`.
