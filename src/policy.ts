/**
 * Deterministic hard-policy overrides.
 *
 * These rules are model-free: they short-circuit model judgment whenever the
 * task description matches a high-risk pattern. They exist because a decision
 * layer that guards changes must never let a model judgment override an
 * explicit safety rule (e.g. "touches .env → block").
 *
 * Design notes:
 * - Rules are ordered: the first matching rule wins.
 * - A `matches()` predicate MUST be conservative (match broadly, block
 *   sometimes unnecessarily, never let something dangerous fall through).
 * - These rules are the last line of defense; `engine.ts` runs them AFTER the
 *   model judgment so a `block` never gets overridden by a low-risk score.
 *
 * Two calibration principles applied here:
 * - **Secrets blocking requires strong evidence** (secret-like paths, secret
 *   variable/content patterns, credentials directories, or commands that
 *   expose secret values). A bare word like `auth` must NOT trigger a secrets
 *   block — authentication/authorization work is a *security review* concern.
 * - **Database migrations are graded**: an ordinary local/dev migration needs
 *   approval; production or destructive/irreversible migrations are blocked.
 */
import type { GuardInput, HardPolicyRule } from "./types.js";

/**
 * Strong-evidence secret paths. Deliberately does NOT match generic source
 * files such as `auth.ts` / `auth.test.ts` — those are authentication code,
 * not secret material.
 */
const SECRET_PATH_PATTERNS = [
  /(^|[/\\])\.env([^/\\]*)?$/i,
  /(^|[/\\])\.env\.[^/\\]+$/i,
  /(^|[/\\])\.secrets?([/\\]|$)/i,
  /(^|[/\\])secrets?([/\\]|$)/i,
  /(^|[/\\])credentials?([/\\]|$)/i,
  /(^|[/\\])credentials?[a-z0-9_-]*\.(json|ya?ml|ini|txt|env)$/i,
  /(^|[/\\])[^/\\]*\.pem$/i,
  /(^|[/\\])[^/\\]*\.p12$/i,
  /(^|[/\\])[^/\\]*\.pfx$/i,
  /(^|[/\\])id_rsa(\.pub)?$/i,
  /(^|[/\\])id_ed25519(\.pub)?$/i,
  /(^|[/\\])service[_-]?account[^/\\]*\.json$/i,
  /(^|[/\\])firebase[_-]?[^/\\]*\.json$/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.pypirc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])terraform\.tfstate(\.backup)?$/i,
  /(^|[/\\])\.keystore$/i,
  /(^|[/\\])\.jks$/i,
];

/** Secret *content* patterns: variable names and phrases that denote material. */
const SECRET_CONTENT_PATTERNS = [
  /\bprivate[_\s-]?key\b/i,
  /\bapi[_\s-]?key\b/i,
  /\bsecret[_\s-]?key\b/i,
  /\bclient[_\s-]?secret\b/i,
  /\baccess[_\s-]?token\b/i,
  /\brefresh[_\s-]?token\b/i,
  /\bbearer\s+[a-z0-9._-]{8,}/i,
  /\bpassword\b/i,
  /\bpassphrase\b/i,
  /\bseed\s?phrase\b/i,
  /\bmnemonic\b/i,
  /\brecovery[-\s]?phrase\b/i,
  /\bbip-?39\b/i,
  /\b(?:12|24)[-\s]?word\s+(?:seed|mnemonic|phrase)\b/i,
  /\bBEGIN\s+(RSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY\b/i,
  /\bSECRET[_\s-]?[A-Z0-9_]+\b/,
  /\bTOKEN[_\s-]?[A-Z0-9_]+\b/,
  /\bPASSWORD[_\s-]?[A-Z0-9_]+\b/,
  /\b[A-Z0-9_]*API[_\s-]?KEY[A-Z0-9_]*\b/,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/i, // Slack tokens
  /\bsk-[a-z0-9]{16,}\b/i, // API secret keys
  /\bghp_[a-z0-9]{20,}\b/i, // GitHub PAT
];

/** Commands that would print/expose secret values. */
const SECRET_EXPOSURE_COMMANDS = [
  /\bcat\s+[^\n]*\.env/i,
  /\bprintenv\b/i,
  /\benv\s*\|\s*(grep|sort)/i,
  /\becho\s+\$\{?[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD)[A-Z_]*\}?/i,
  /\bopenssl\s+.*-inkey\b/i,
  /\bgit\s+config\s+--get\s+.*(token|key|password)/i,
];

function touchesSecretPath(input: GuardInput): boolean {
  const files = input.hints?.touchedFiles ?? [];
  return files.some((f) => SECRET_PATH_PATTERNS.some((re) => re.test(f)));
}

function mentionsSecretContent(input: GuardInput): boolean {
  const text = input.task;
  // Strip GitHub Actions secret *references* so ordinary workflow wiring
  // (`${{ secrets.API_KEY }}`, `secrets.NPM_TOKEN`) is owned by
  // POL-CI-SECRETS-2 (approval), not blocked here. Exposure/echo of those
  // expressions is still caught by POL-CI-SECRETS-1; real secret *values*
  // (ghp_/sk-/seed phrases/etc.) remain in the haystack and still block.
  const withoutCiRefs = text
    .replace(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/gi, " ")
    .replace(/\bsecrets\.[A-Za-z0-9_]+\b/gi, " ");
  return (
    SECRET_CONTENT_PATTERNS.some((re) => re.test(withoutCiRefs)) ||
    SECRET_EXPOSURE_COMMANDS.some((re) => re.test(text))
  );
}

/** Authentication / authorization *work*: needs security review, not a block. */
const AUTHZ_WORK_PATTERNS = [
  /\b(?:auth|authn|authz|authentication|authorization)\b/i,
  /\b(?:login|log[-\s]?in|sign[-\s]?in|logout)\b/i,
  /\b(?:jwt|oauth|oidc|saml|rbac|acl|permissions?|roles?)\b/i,
  /\b(?:middleware|guard|policy)\b[^\n]*\b(?:auth|access|permission)/i,
  /\bsession\s+(?:handling|management|middleware|store)\b/i,
];

function mentionsAuthzWork(input: GuardInput): boolean {
  const text = input.task;
  const files = input.hints?.touchedFiles ?? [];
  if (AUTHZ_WORK_PATTERNS.some((re) => re.test(text))) return true;
  // Auth source files (e.g. auth.ts, auth.test.ts, middleware/auth.py) are
  // authorization work, not secret material.
  return files.some((f) => /\bauth(?:z|n|entication)?\b/i.test(f) && !/\.(env|pem|key|p12|pfx|jks|keystore)$/i.test(f));
}

function mentionsProdDeploy(input: GuardInput): boolean {
  if (input.hints?.mentionsProd === true) return true;
  const lower = input.task.toLowerCase();
  return /production|prod deploy|to production|deploy to prod|prod-release|rollout|切生产|上线|部署到生产/i.test(lower);
}

/**
 * Explicit production / live database target.
 *
 * Negations are stripped first, so "not production" / "non-prod" must NOT be
 * treated as a production target. The live matcher accepts both "live db" and
 * "live database".
 */
function mentionsProdMigration(input: GuardInput): boolean {
  if (input.hints?.mentionsProd === true) return true;
  const lower = input.task.toLowerCase();
  const withoutNegations = lower
    .replace(/\b(?:not|non[-\s]?|never|no)\s*(?:in\s+|to\s+|on\s+|against\s+)?(?:production|prod)\b/gi, " ")
    .replace(/\bnon[-\s]?prod(?:uction)?\b/gi, " ")
    .replace(/\blocal\s+(?:dev|development|db|database)\b/gi, " ")
    .replace(/\b(?:dev|development|staging|test)\s+environment\b/gi, " ");
  return /\bproduction\b|\bprod\b|\blive\s+(?:db|database)\b|切生产|生产环境|线上/i.test(withoutNegations);
}

/**
 * Explicit local / development database target.
 *
 * Deliberately narrow: a bare migration with no environment is NOT local/dev.
 * `prisma migrate dev` / `migrate reset` are treated as local because they are
 * inherently development-only commands (they generate and apply locally).
 */
function mentionsLocalDbTarget(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  if (/\bmigrate\s+(?:dev|reset)\b/i.test(lower)) return true;
  if (/\b(?:localhost|127\.0\.0\.1)\b/i.test(lower)) return true;
  if (/\blocal\s+(?:dev|development|db|database|env|environment|machine|instance|server)\b/i.test(lower)) {
    return true;
  }
  if (/\b(?:dev|development)\s+(?:db|database|environment)\b/i.test(lower)) return true;
  return false;
}

/**
 * Explicit staging database target. Requires staging to be tied to a database
 * or environment context (so a git "staging area" mention does not match).
 */
function mentionsStagingDbTarget(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  if (/\bpre-?prod(?:uction)?\b/i.test(lower)) return true;
  if (/\b(?:staging|stage|stg)\s+(?:db|database|env|environment|server|instance|cluster)\b/i.test(lower)) {
    return true;
  }
  if (/\b(?:on|in|to|against)\s+(?:the\s+)?(?:staging|stage)\b/i.test(lower)) return true;
  return false;
}

/**
 * Deploy-style migration: applies ALREADY-EXISTING migrations to a target.
 * This is the production/CI-shaped command, as opposed to `migrate dev`, which
 * generates and applies migrations locally.
 */
function mentionsDeployMigration(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  if (/\bmigrate\s+deploy\b/i.test(lower)) return true;
  if (/\bmigrate\s+up\b/i.test(lower)) return true;
  if (/\b(?:apply|run)\s+(?:the\s+)?(?:existing\s+|pending\s+)?migrations?\b/i.test(lower)) return true;
  return false;
}

/** `prisma db push` / schema push (no migration history, can drop data). */
function mentionsSchemaPush(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  const hit = /\bdb\s+push\b/i.test(lower) || /\bschema\s+push\b/i.test(lower);
  if (!hit) return false;
  // Docs-only + no ORM/tool cue → skip (M-PolicyPrecision / FP-PATH).
  if (isDocsOnlyPaths(input) && !/\b(?:prisma|drizzle|sequelize|knex)\b/i.test(input.task)) {
    return false;
  }
  return true;
}

/** `--accept-data-loss` on a schema push → always destructive. */
function mentionsAcceptDataLoss(input: GuardInput): boolean {
  return /--accept-data-loss\b/i.test(input.task);
}

/** Destructive / irreversible SQL or data operations → block. */
function mentionsDestructiveData(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  return (
    /drop\s+(database|table|schema|column|index)/i.test(lower) ||
    /\btruncate\b/i.test(lower) ||
    /delete\s+from\s+\S+/i.test(lower) ||
    /delete\s+all\b/i.test(lower) ||
    /(?:rm\s+-rf|shred)\s+[^\n]*(?:db|data|backup)/i.test(lower) ||
    /破坏性迁移|清空表|删表|删库|不可逆/i.test(lower) ||
    /irreversible\s+migration/i.test(lower)
  );
}

/**
 * Explicit migrate / db-push CLI forms and deploy-style apply/run phrases
 * (always domain-anchored). Matches §12.1.2 A + existing deploy matrix.
 */
const EXPLICIT_MIGRATE_CLI =
  /\bmigrate\s+(?:deploy|dev|reset|up|status|down)\b|\b(?:db|schema)\s+push\b|\b(?:npx|pnpm|yarn|bunx)\s+[^\n]*\bmigrate\b|\b(?:apply|run)\s+(?:the\s+)?(?:existing\s+|pending\s+)?migrations?\b/i;

/**
 * DB / schema tool cues required to treat bare migrat* as a database migration
 * (M-PolicyPrecision domain-anchor).
 */
const DB_MIGRATION_DOMAIN_CUE =
  /\b(?:prisma|drizzle|sequelize|knex|alembic|flyway|liquibase|typeorm|django|sql(?:ite)?|schema|database|postgres(?:ql)?|mysql|mongodb)\b|\bdb\b|数据库|迁移脚本|\b(?:tables?|columns?|indexes)\b/i;

const MIGRATION_LEXEME = /\bmigrat(?:e|ion|ions)\b|迁移/i;

/** All touched paths are docs/prose-only (when hints are present). */
function isDocsOnlyPaths(input: GuardInput): boolean {
  const files = input.hints?.touchedFiles ?? [];
  if (files.length === 0) return false;
  return files.every(
    (f) =>
      /(^|[/\\])docs[/\\]/i.test(f) ||
      /\.(md|mdx|txt|rst)$/i.test(f),
  );
}

/** Paths that imply a real migration / schema tool tree. */
function hasMigrationPathCue(input: GuardInput): boolean {
  const files = input.hints?.touchedFiles ?? [];
  return files.some(
    (f) =>
      /(^|[/\\])(?:prisma[/\\])?migrations?(?:[/\\]|$)/i.test(f) ||
      /(^|[/\\])drizzle[/\\]/i.test(f) ||
      /(?:^|[/\\])schema\.prisma$/i.test(f),
  );
}

/**
 * English rename-sense “migrate … to …” (field/type/json key / identifier),
 * not a database migration. Skipped when a strong DB cue or migrate CLI is present.
 */
function isRenameSenseMigration(text: string): boolean {
  if (EXPLICIT_MIGRATE_CLI.test(text) || DB_MIGRATION_DOMAIN_CUE.test(text)) return false;

  if (
    /\bmigrate\s+(?:the\s+)?(?:field|column(?:\s+name)?|json\s+key|api|type|symbol|name|draft(?:\s+field(?:\s+name)?)?)\s+to\b/i.test(
      text,
    )
  ) {
    return true;
  }

  // migrate to `agent` / 'agent' / "agent"
  if (/\bmigrate\s+to\s+[`'"][A-Za-z_][\w.-]*[`'"]/.test(text)) return true;

  // migrate to agent (bare identifier; exclude env words)
  const bare = text.match(/\bmigrate\s+to\s+([A-Za-z_][\w]*)\b/i);
  if (bare) {
    const id = bare[1]!.toLowerCase();
    const envWords = new Set([
      "production",
      "prod",
      "staging",
      "stage",
      "database",
      "db",
      "local",
      "dev",
      "development",
      "remote",
      "postgres",
      "postgresql",
      "mysql",
    ]);
    if (!envWords.has(id)) return true;
  }
  return false;
}

/**
 * Meta / research discussion of POL-DB-MIGRATION-* or matcher false positives
 * without a proposed migrate command (FP-META).
 *
 * Prose may cite CLI forms (“do not weaken migrate deploy”); that alone must
 * not cancel meta-safety. A real command channel uses `Proposed command:`.
 */
function isMetaDbMigrationDiscussion(input: GuardInput): boolean {
  const text = input.task;
  if (/\bProposed command:/i.test(text)) return false;
  if (hasMigrationPathCue(input)) return false;

  if (/\bPOL-DB-MIGRATION(?:-\d+)?\b/i.test(text)) return true;
  if (/\bfalse[-\s]+positiv/i.test(text) && /\b(?:migrat\w*|polic(?:y|ies)|matchers?)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:explain|discuss|document|research|analyze|tighten|fix)\b/i.test(text) &&
    /\b(?:POL-DB|hard-polic(?:y|ies)|matchers?|false[-\s]+positiv)/i.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * Database migration lexeme, domain-anchored (T01 / M-PolicyPrecision).
 * Bare English “migrate to `agent`”, docs-only migrat* prose, and meta POL-*
 * discussion no longer match. Real prisma/SQL migrate commands still do.
 */
function mentionsMigration(input: GuardInput): boolean {
  const text = input.task;
  if (!MIGRATION_LEXEME.test(text)) return false;

  if (isRenameSenseMigration(text)) return false;
  if (isMetaDbMigrationDiscussion(input)) return false;

  const hasCli = EXPLICIT_MIGRATE_CLI.test(text);
  const hasCue =
    DB_MIGRATION_DOMAIN_CUE.test(text) ||
    hasMigrationPathCue(input) ||
    // Env-qualified migration prose (“… against production/staging”) is DB work
    // even when the word “database” is omitted (existing matrix / REG-6b).
    mentionsProdMigration(input) ||
    mentionsStagingDbTarget(input) ||
    mentionsLocalDbTarget(input);

  // Docs-only paths with no DB/CLI cue → skip (FP-PATH / FP-PAYLOAD-ish).
  if (isDocsOnlyPaths(input) && !hasCli && !hasCue) return false;

  // Domain-anchor: migrat* alone is not enough.
  if (!hasCli && !hasCue) return false;

  return true;
}

/**
 * Destructive filesystem / shell commands that can destroy data or a host.
 * Strong evidence only (explicit destructive flags or device writes).
 */
function mentionsDestructiveCommand(input: GuardInput): boolean {
  const text = input.task;
  return (
    /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+(?:\/|~|\$HOME|\.\.?\/|\*)/i.test(text) ||
    /\brm\s+-[a-z]*[rf][a-z]*\s+/i.test(text) ||
    /\bshred\b/i.test(text) ||
    /\bmkfs(\.\w+)?\b/i.test(text) ||
    /\bdd\s+if=.+\s+of=\/dev\//i.test(text) ||
    /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/i.test(text) || // fork bomb
    /\bchmod\s+-R\s+777\s+\//i.test(text)
  );
}

/** Force-push to a protected branch (main/master/prod/release). */
function mentionsForcePush(input: GuardInput): boolean {
  const text = input.task;
  if (!/\bgit\s+push\b/i.test(text)) return false;
  const forced = /--force(?:-with-lease)?\b|\s-f\b/i.test(text);
  if (!forced) return false;
  return /\b(?:main|master|production|prod|release)\b/i.test(text);
}

/** Any database migration (graded by the rules below). */
function mentionsPayments(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  return /stripe|billing|charge|capture|refund|subscription|price change|billing code|支付|退款|订阅/i.test(lower);
}

/**
 * Web3 asset actions (approve/transfer/sign/bridge/swap/deploy/upgrade).
 *
 * These are **approval-gated, not blocked**: the user may intentionally want to
 * perform them, but an agent must never proceed without explicit approval and a
 * security review. Deliberately does NOT match a bare "token" word, so ordinary
 * frontend work (design tokens, auth tokens) is not swept up.
 */
function mentionsWeb3AssetAction(input: GuardInput): boolean {
  const hay = `${input.task}\n${(input.hints?.touchedFiles ?? []).join("\n")}`;

  // ERC-20 approve / allowance
  if (/\b(?:erc-?20|erc20)\b[^\n]{0,60}\b(?:approve|allowance)\b/i.test(hay)) return true;
  if (/\b(?:approve|allowance)\b[^\n]{0,60}\b(?:erc-?20|erc20|spender|allowance)\b/i.test(hay)) return true;
  if (/\.approve\s*\(|\bapprove\s*\(\s*\w+\s*,/i.test(hay)) return true;

  // Token transfer / send transaction
  if (/\b(?:safe)?transfer(?:From)?\s*\(/i.test(hay)) return true;
  if (/\btransfer\b[^\n]{0,40}\b(?:tokens?|erc-?20|erc20|usdc|usdt|dai|nfts?|assets?|funds?)\b/i.test(hay)) return true;
  if (/\bsend\s*(?:transaction|tx)\b|\bsendTransaction\b|\bsendRawTransaction\b/i.test(hay)) return true;
  if (/\bsend\b[^\n]{0,30}\b(?:eth|tokens?|usdc|usdt|funds?|assets?)\b/i.test(hay)) return true;

  // Wallet signing / wallet transaction actions
  if (/\b(?:signMessage|signTransaction|personal_sign|eth_sign|signTypedData|wallet_sign)\b/i.test(hay)) return true;
  if (/\bwallet\b[^\n]{0,40}\b(?:sign|send|transaction|approve|transfer|connect)\b/i.test(hay)) return true;

  // Bridge / swap / on-chain asset movement
  if (/\b(?:bridge|swap)\b[^\n]{0,40}\b(?:tokens?|assets?|eth|usdc|usdt|funds?|liquidity|chain)\b/i.test(hay)) return true;
  if (/\b(?:swapExact\w*|addLiquidity|removeLiquidity|stake|unstake)\s*\(/i.test(hay)) return true;

  // Smart-contract deployment
  if (/\bdeploy\b[^\n]{0,40}\b(?:contract|solidity|smart[-\s]?contract|erc-?20|erc20|proxy)\b/i.test(hay)) return true;
  if (/\bcontract\s+deployment\b|\bforge\s+create\b|\bhardhat\b[^\n]{0,30}\bdeploy\b/i.test(hay)) return true;

  // Smart-contract upgrade / proxy upgrade
  if (/\bupgrade\b[^\n]{0,40}\b(?:contract|proxy|implementation|beacon|uups)\b/i.test(hay)) return true;
  if (/\b(?:UUPS|TransparentUpgradeableProxy|ProxyAdmin|upgradeTo(?:AndCall)?)\b/i.test(hay)) return true;

  return false;
}

function touchesBroadInfra(input: GuardInput): boolean {
  const lower = input.task.toLowerCase();
  return /k8s|kubernetes|terraform|cloud.?form|infrastructure|provision|dns|firewall|iam role|namespace.*delete/i.test(lower);
}

/** CI/CD config paths (GHA, GitLab, Circle, Azure, Bitbucket). */
function isCiConfigPath(files: readonly string[]): boolean {
  return files.some(
    (f) =>
      /(^|[/\\])\.github[/\\]workflows[/\\]/i.test(f) ||
      /(^|[/\\])\.gitlab-ci\.ya?ml$/i.test(f) ||
      /(^|[/\\])\.circleci[/\\]/i.test(f) ||
      /(^|[/\\])azure-pipelines\.ya?ml$/i.test(f) ||
      /(^|[/\\])bitbucket-pipelines\.ya?ml$/i.test(f),
  );
}

/**
 * C-1: CI/CD workflow secret *exposure* or hardcoding (strong evidence).
 * Ordinary `${{ secrets.NAME }}` references in workflow authoring are
 * approval-gated via POL-CI-SECRETS-2 — not blocked here.
 */
function mentionsCiSecretExposure(input: GuardInput): boolean {
  const text = input.task;
  // Echo / print / log a GitHub Actions secret expression.
  if (
    /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/i.test(text) &&
    /\b(?:echo|printf|printenv|cat|console\.log|Write-Output)\b/i.test(text)
  ) {
    return true;
  }
  const files = input.hints?.touchedFiles ?? [];
  const inCi = isCiConfigPath(files);
  // Hardcoding a secret *value* into a workflow (not a secrets.* reference).
  if (
    inCi &&
    (/\b(?:ghp_|github_pat_|sk-|AKIA|xox[baprs]-)[A-Za-z0-9_-]{8,}/i.test(text) ||
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|password)\s*[:=]\s*['"]?[^\s'"]{8,}/i.test(
        text,
      ))
  ) {
    return true;
  }
  return false;
}

/**
 * C-1: high-risk CI privilege / supply-chain patterns (approval + review).
 * Owns `pull_request_target`, elevated Actions `permissions:`, pipe-to-shell
 * installers in CI paths, and self-hosted runners with secret access — so
 * bare GHA `permissions:` does not fall through as app AUTHZ work.
 */
function mentionsCiPrivilegeRisk(input: GuardInput): boolean {
  if (mentionsCiSecretExposure(input)) return false;
  const text = input.task;
  const files = input.hints?.touchedFiles ?? [];
  const inCi =
    isCiConfigPath(files) ||
    /\b(?:github\s*actions|gitlab\s*ci|circleci|azure\s*pipelines)\b/i.test(text) ||
    /\b\.github[/\\]workflows\b/i.test(text);

  // pull_request_target is a known fork-PR privilege footgun even without secrets.
  if (/\bpull_request_target\b/i.test(text)) return true;

  if (!inCi) return false;

  if (
    /\bpermissions\s*:\s*(?:contents|id-token|packages|actions)\s*:\s*write\b/i.test(text) ||
    /\b(?:contents|id-token|packages|actions)\s*:\s*write\b/i.test(text)
  ) {
    return true;
  }
  if (/\b(?:curl|wget)\b[^\n]{0,120}\|\s*(?:ba)?sh\b/i.test(text)) return true;
  if (/\bself[-\s]?hosted\b/i.test(text) && /\bsecrets?\b/i.test(text)) return true;
  if (/\boidc\b/i.test(text) && /\b(?:aws|gcp|azure|assume[-\s]?role|workload\s+identity)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** C-1: editing CI configs that reference secrets (approval; exposure is POL-CI-SECRETS-1). */
function mentionsCiWorkflowSecretUse(input: GuardInput): boolean {
  if (mentionsCiSecretExposure(input)) return false; // stronger rule owns it
  if (mentionsCiPrivilegeRisk(input)) return false; // privilege rule owns elevated cases
  const text = input.task;
  const files = input.hints?.touchedFiles ?? [];
  const inCi = isCiConfigPath(files);
  if (inCi && /\bsecrets?\b/i.test(text)) return true;
  if (/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/i.test(text)) return true;
  // GitLab / Circle variable-style secret wiring in CI paths
  if (inCi && /\b(?:CI_JOB_TOKEN|CI_DEPLOY_PASSWORD|CIRCLE_TOKEN|\$\{\{\s*env\.)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** C-1: package registry publish commands. */
function mentionsPackagePublish(input: GuardInput): boolean {
  return (
    /\b(?:npm|pnpm|yarn)\s+publish\b/i.test(input.task) ||
    /\btwine\s+upload\b/i.test(input.task) ||
    /\bcargo\s+publish\b/i.test(input.task)
  );
}

/**
 * C-1: infrastructure *destroy* actions — stronger than generic provision.
 * Evaluated before POL-INFRA-1 so destroy is blocked, not merely approval-gated.
 * Allows flags between binary and subcommand (`terraform -chdir=x destroy`).
 * Skips matches that appear only inside quotes (e.g. `rg "kubectl delete"`).
 */
function isInsideQuotes(text: string, index: number): boolean {
  let single = false;
  let dbl = false;
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (c === "'" && !dbl) single = !single;
    else if (c === '"' && !single) dbl = !dbl;
  }
  return single || dbl;
}

function mentionsInfraDestroy(input: GuardInput): boolean {
  const text = input.task;
  const patterns = [
    /\b(?:terraform|terragrunt)\s+(?:-{1,2}\S+\s+)*destroy\b/gi,
    /\bpulumi\s+(?:-{1,2}\S+\s+)*destroy\b/gi,
    /\bhelm\s+(?:-{1,2}\S+\s+)*uninstall\b/gi,
    /\bkubectl\s+(?:-{1,2}\S+\s+)*delete\b/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!isInsideQuotes(text, m.index)) return true;
    }
  }
  return false;
}

/**
 * C-1: bulk personal-data / PII egress or export.
 * Requires both an egress verb and a PII/customer-data object (narrow).
 */
function mentionsPiiEgress(input: GuardInput): boolean {
  const text = input.task;
  const egress =
    /\b(?:export|dump|exfiltrat(?:e|ion)|egress|download\s+all|bulk\s+download)\b/i.test(text);
  const pii =
    /\b(?:pii|personal\s+data|customer\s+data|user\s+emails?|ssn|social\s+security|gdpr\s+export)\b/i.test(
      text,
    );
  return egress && pii;
}

export const DEFAULT_POLICY: HardPolicyRule[] = [
  // --- Blocking rules (strong evidence only) ---
  {
    id: "POL-SECRETS-1",
    description: "Task touches secret/credential material (strong evidence: secret paths, secret content, or secret-exposing commands)",
    matches: (i) => touchesSecretPath(i) || mentionsSecretContent(i),
    mode: "block",
    reason: { code: "POL-SECRETS-1", detail: "Secret/credential material requires human handling" },
  },
  {
    id: "POL-CI-SECRETS-1",
    description: "Task dumps/echoes CI secrets or hardcodes secret values into workflow files",
    matches: mentionsCiSecretExposure,
    mode: "block",
    reason: {
      code: "POL-CI-SECRETS-1",
      detail: "CI/CD secret exposure or hardcoding requires human handling",
    },
  },
  {
    id: "POL-DESTRUCTIVE-CMD-1",
    description: "Task runs a destructive shell command (rm -rf, shred, mkfs, dd to device, fork bomb)",
    matches: mentionsDestructiveCommand,
    mode: "block",
    reason: { code: "POL-DESTRUCTIVE-CMD-1", detail: "Destructive shell command is blocked" },
  },
  {
    id: "POL-INFRA-DESTROY-1",
    description: "Task destroys infrastructure (terraform/pulumi destroy, kubectl delete, helm uninstall)",
    matches: mentionsInfraDestroy,
    mode: "block",
    reason: {
      code: "POL-INFRA-DESTROY-1",
      detail: "Infrastructure destroy/delete is blocked; requires a controlled human process",
    },
  },
  {
    id: "POL-FORCE-PUSH-1",
    description: "Task force-pushes to a protected branch (main/master/prod/release)",
    matches: mentionsForcePush,
    mode: "block",
    reason: { code: "POL-FORCE-PUSH-1", detail: "Force push to a protected branch is blocked" },
  },
  {
    id: "POL-DB-DESTRUCTIVE-1",
    description: "Task performs destructive or irreversible data operations (DROP/TRUNCATE/delete-all/irreversible migration)",
    matches: mentionsDestructiveData,
    mode: "block",
    reason: { code: "POL-DB-DESTRUCTIVE-1", detail: "Destructive/irreversible data operation requires human review" },
  },
  // --- Migration rules, most-specific-first (blocks before approvals) ---
  {
    id: "POL-DB-SCHEMA-PUSH-1",
    description: "`prisma db push` / schema push (can drop data; --accept-data-loss always blocks)",
    matches: (i) => mentionsSchemaPush(i) && mentionsAcceptDataLoss(i),
    mode: "block",
    reason: {
      code: "POL-DB-SCHEMA-PUSH-1",
      detail: "Schema push with --accept-data-loss is blocked; it can destroy data",
    },
  },
  {
    id: "POL-DB-PROD-1",
    description: "Task runs a migration against an explicit production/live database target",
    matches: (i) => (mentionsMigration(i) || mentionsSchemaPush(i)) && mentionsProdMigration(i),
    mode: "block",
    reason: { code: "POL-DB-PROD-1", detail: "Production migration is blocked; requires a controlled release process" },
  },
  {
    id: "POL-DB-DEPLOY-UNKNOWN-1",
    description: "Deploy-style migration (applies existing migrations) with no determinable target environment",
    matches: (i) =>
      mentionsMigration(i) &&
      mentionsDeployMigration(i) &&
      !mentionsProdMigration(i) &&
      !mentionsStagingDbTarget(i) &&
      !mentionsLocalDbTarget(i),
    mode: "approval_required",
    reason: {
      code: "POL-DB-DEPLOY-UNKNOWN-1",
      detail:
        "Target database environment is unknown; explicit human confirmation is required before applying existing migrations",
    },
    requiresSecurityReview: true,
  },
  {
    id: "POL-DB-SCHEMA-PUSH-2",
    description: "`prisma db push` / schema push with an unknown or staging target",
    matches: (i) =>
      mentionsSchemaPush(i) &&
      !mentionsAcceptDataLoss(i) &&
      !mentionsProdMigration(i) &&
      !mentionsLocalDbTarget(i),
    mode: "approval_required",
    reason: {
      code: "POL-DB-SCHEMA-PUSH-2",
      detail: "Schema push requires approval; the target database environment is not clearly local",
    },
    requiresSecurityReview: true,
  },
  {
    id: "POL-DB-SCHEMA-PUSH-3",
    description: "`prisma db push` / schema push against an explicit local/dev database",
    matches: (i) =>
      mentionsSchemaPush(i) &&
      !mentionsAcceptDataLoss(i) &&
      !mentionsProdMigration(i) &&
      mentionsLocalDbTarget(i),
    mode: "approval_required",
    reason: {
      code: "POL-DB-SCHEMA-PUSH-3",
      detail: "Local/development schema push requires approval",
    },
  },
  {
    id: "POL-DB-STAGING-1",
    description: "Migration against an explicit staging/pre-production database target",
    matches: (i) =>
      mentionsMigration(i) &&
      mentionsStagingDbTarget(i) &&
      !mentionsProdMigration(i),
    mode: "approval_required",
    reason: { code: "POL-DB-STAGING-1", detail: "Staging database migration requires approval" },
  },
  {
    id: "POL-DB-MIGRATION-1",
    description: "Explicit local/development database migration",
    matches: (i) =>
      mentionsMigration(i) &&
      mentionsLocalDbTarget(i) &&
      !mentionsProdMigration(i) &&
      !mentionsDestructiveData(i),
    mode: "approval_required",
    reason: { code: "POL-DB-MIGRATION-1", detail: "Local/development database migration requires approval" },
  },
  {
    id: "POL-DB-MIGRATION-2",
    description: "Any database migration whose target environment cannot be positively classified",
    matches: (i) =>
      mentionsMigration(i) &&
      !mentionsProdMigration(i) &&
      !mentionsDestructiveData(i) &&
      !mentionsLocalDbTarget(i) &&
      !mentionsStagingDbTarget(i) &&
      !mentionsDeployMigration(i),
    mode: "approval_required",
    reason: {
      code: "POL-DB-MIGRATION-2",
      detail: "Database migration with an unclassified target environment requires approval",
    },
  },
  {
    id: "POL-PROD-1",
    description: "Task explicitly ships to production or deploys prod (non-migration)",
    matches: mentionsProdDeploy,
    mode: "approval_required",
    reason: { code: "POL-PROD-1", detail: "Production-affecting change requires explicit approval" },
  },
  {
    id: "POL-CI-PRIV-1",
    description:
      "Task uses high-risk CI privilege patterns (pull_request_target, elevated Actions permissions, pipe-to-shell in CI, self-hosted+secrets, cloud OIDC from CI)",
    matches: mentionsCiPrivilegeRisk,
    mode: "approval_required",
    reason: {
      code: "POL-CI-PRIV-1",
      detail: "High-risk CI privilege / supply-chain change requires explicit approval and security review",
    },
    requiresSecurityReview: true,
  },
  {
    id: "POL-CI-SECRETS-2",
    description: "Task edits CI workflows that reference secrets (approval; exposure is POL-CI-SECRETS-1)",
    matches: mentionsCiWorkflowSecretUse,
    mode: "approval_required",
    reason: {
      code: "POL-CI-SECRETS-2",
      detail: "CI/CD workflow secret references require explicit approval and security review",
    },
    requiresSecurityReview: true,
  },
  {
    id: "POL-AUTHZ-1",
    description: "Task changes authentication/authorization behavior (security review, not secret exposure)",
    matches: mentionsAuthzWork,
    mode: "approval_required",
    reason: { code: "POL-AUTHZ-1", detail: "Authentication/authorization change requires security review" },
    requiresSecurityReview: true,
  },
  {
    id: "POL-WEB3-ASSET-1",
    description:
      "Web3 asset action (ERC-20 approve/allowance, token transfer, wallet signing, bridge/swap, contract deployment or upgrade)",
    matches: mentionsWeb3AssetAction,
    mode: "approval_required",
    reason: {
      code: "POL-WEB3-ASSET-1",
      detail: "Web3 asset movement/signing requires explicit approval and security review",
    },
    requiresSecurityReview: true,
  },
  {
    id: "POL-PAY-1",
    description: "Task touches payments/billing",
    matches: mentionsPayments,
    mode: "approval_required",
    reason: { code: "POL-PAY-1", detail: "Payment/billing change requires explicit approval" },
  },
  {
    id: "POL-PUBLISH-1",
    description: "Task publishes a package to a registry (npm/pnpm/yarn publish, twine upload, cargo publish)",
    matches: mentionsPackagePublish,
    mode: "approval_required",
    reason: {
      code: "POL-PUBLISH-1",
      detail: "Package registry publish requires explicit approval",
    },
  },
  {
    id: "POL-PII-EGRESS-1",
    description: "Task exports or dumps personal/customer data (PII egress)",
    matches: mentionsPiiEgress,
    mode: "approval_required",
    reason: {
      code: "POL-PII-EGRESS-1",
      detail: "Personal/customer data export requires explicit approval and security review",
    },
    requiresSecurityReview: true,
  },
  {
    id: "POL-INFRA-1",
    description: "Task touches broad infrastructure provisioning",
    matches: (i) => touchesBroadInfra(i) && !mentionsInfraDestroy(i),
    mode: "approval_required",
    reason: { code: "POL-INFRA-1", detail: "Infrastructure provisioning requires approval" },
  },
];

/**
 * Return the first matching hard-policy rule, or undefined if no rule matches.
 * Rules are evaluated in order; the first match wins.
 */
export function matchPolicy(
  input: GuardInput,
  policy: HardPolicyRule[] = DEFAULT_POLICY,
): HardPolicyRule | undefined {
  for (const rule of policy) {
    if (rule.matches(input)) return rule;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sanitization / redaction (defense in depth before the provider)
// ---------------------------------------------------------------------------

const REDACTION = "[REDACTED_SECRET]";

/**
 * High-precision secret *value* patterns. These are intentionally narrower
 * than `SECRET_CONTENT_PATTERNS` (which drives blocking): we only redact
 * strings that look like actual credential material, so ordinary prose about
 * "password" or "auth" is not mangled.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN[\s\S]*?-----END[^-]*-----/g, // PEM blocks (any type)
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, // API secret keys
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, // bearer credentials
  /\b(?:seed\s?phrase|mnemonic)\s*(?:is|:|=)\s*["']?(?:[a-z]+\s+){5,}[a-z]+/gi, // 6+ word seed phrase
  /^[A-Z0-9_]{0,}[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*\S+/gim, // KEY=value lines
];

/** Redact secret-like values from a single string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTION);
  return out;
}

/**
 * Return a copy of `input` with secret-like values redacted from every field
 * that could be handed to a model provider. Used by the engine after the
 * policy pre-scan and before `provider.judge`, so credential material never
 * leaves the process even when a block did not (yet) apply.
 */
export function sanitizeForProvider(input: GuardInput): GuardInput {
  const hints = input.hints;
  const sanitizedHints =
    hints === undefined
      ? undefined
      : {
          touchedFiles: hints.touchedFiles ?? null,
          candidatePaths: hints.candidatePaths ?? null,
          mentionsProd: hints.mentionsProd ?? null,
          context: hints.context == null ? hints.context : redactSecrets(hints.context),
        };
  return {
    task: redactSecrets(input.task),
    ...(sanitizedHints === undefined ? {} : { hints: sanitizedHints }),
  };
}