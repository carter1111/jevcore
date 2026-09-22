# NOTICE — JevCore (`jevcore`)

JevCore Agent Runtime
Copyright 2026 JevCore Contributors

This product is licensed under the Apache License, Version 2.0.
See the LICENSE file in the project root.

## What this license covers

- Source code and documentation **in the public `jevcore` repository**
  (and published npm package `jevcore`, when released).

## What this license does **not** cover

| Item | Notes |
|---|---|
| **TypeSafe / Jev cloud API** | Separate service. Requires your own `TYPESAFE_API_KEY` and compliance with TypeSafe terms. Apache-2.0 does **not** grant API access or usage credits. |
| **Cursor and other IDE hosts** | Independent products. MCP / hook wiring is user configuration. |
| **User secrets & local data** | `.env`, keys, profile, preferences, and opt-in local evidence remain yours. |
| **Website source** | Landing / marketing git repo is **not** part of this OSS distribution. |
| **Trademarks** | See `TRADEMARKS.md`. Apache-2.0 does not grant trademark rights. |

## Third-party dependencies

Runtime packages (each under its own license; see `node_modules/<pkg>/LICENSE` after install):

| Package | Role |
|---|---|
| `@typesafe-ai/sdk` | Client for TypeSafe Jev judgments (optional for live model path) |
| `@modelcontextprotocol/server` | MCP stdio transport |
| `zod` | Schema validation |

Dev-only: `typescript`, `@types/node`.

## Non-affiliation

JevCore is an independent project. It is **not** affiliated with, endorsed by,
or sponsored by TypeSafe. “Jev” is used only to describe compatibility or
integration with TypeSafe’s System One / Jev decision capabilities.

## Local evidence

Opt-in local evidence (`JEV_GUARD_LOCAL_EVIDENCE=1`) stores de-identified
decision metadata on the user’s machine. No remote upload is enabled by default.
