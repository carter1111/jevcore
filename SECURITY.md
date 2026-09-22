# Security Policy — JevCore

## Supported versions

Security fixes are accepted against the latest published release on the public
`jevcore` repository (and `main` during alpha).

## Reporting a vulnerability

**Do not** open a public GitHub issue for vulnerabilities that could expose
secrets, enable remote code execution in host integrations, or weaken hard-policy
boundaries.

Please report privately via GitHub Security Advisories on
`https://github.com/carter1111/jevcore` (once the public repo exists), or email
the maintainers listed in the repository profile.

Include:

- Affected version / commit
- Reproduction steps (no real secrets in the report)
- Impact assessment

We aim to acknowledge reports within 7 days.

## Scope notes

- Hard-policy rules (`src/policy.ts`) are intentional safety boundaries; bypass
  proposals that weaken secret / production / destructive / Web3 asset rules
  without a clear safe alternative will be rejected.
- Local evidence is opt-in and must not contain credential material.
- TypeSafe API keys are **user** credentials — never commit them.
