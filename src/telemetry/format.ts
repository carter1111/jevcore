/**
 * Local Guard Evidence — report text formatting.
 *
 * Rendered as structured **plain text** for Cursor display. Deliberately no
 * Markdown and no ANSI escape codes: Cursor's documentation does not specify how
 * MCP tool text is rendered (whether Markdown is parsed, whether ANSI is
 * interpreted), so the report must read well under *either* interpretation.
 * Visual hierarchy comes from uppercase titles, section rules, and strict column
 * alignment — all of which survive both plain-text and Markdown rendering.
 *
 * Language is kept accurate per `Docs/Local_Guard_Report.md` §11.3: no incident,
 * time-saving, or token-saving claims.
 */
import type { ReportModel } from "./report.js";

const PERIOD_LABEL: Record<string, string> = {
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  all: "All retained evidence",
};

/** Column geometry. Labels are padded left, values right-aligned. */
const LABEL_W = 34;
const VALUE_W = 34;
const RULE_W = LABEL_W + VALUE_W + 2;
const INDENT = "  ";
const CONTINUATION_INDENT = "    ";

/** Friendly labels for policy rules. Kept within LABEL_W where possible. */
const SAFETY_LABELS: Record<string, string> = {
  "POL-DB-DESTRUCTIVE-1": "Destructive data ops blocked",
  "POL-DB-SCHEMA-PUSH-1": "Destructive schema pushes",
  "POL-DB-PROD-1": "Production/live DB blocked",
  "POL-DB-DEPLOY-UNKNOWN-1": "Unknown-target DB deploys",
  "POL-DB-SCHEMA-PUSH-2": "Unknown-target schema pushes",
  "POL-DB-SCHEMA-PUSH-3": "Local schema pushes gated",
  "POL-DB-STAGING-1": "Staging DB migrations gated",
  "POL-DB-MIGRATION-1": "Local DB migrations gated",
  "POL-DB-MIGRATION-2": "Unclassified migrations gated",
  "POL-SECRETS-1": "Sensitive inputs blocked",
  "POL-DESTRUCTIVE-CMD-1": "Destructive commands blocked",
  "POL-FORCE-PUSH-1": "Force push to protected branch",
  "POL-AUTHZ-1": "Auth/authorization gated",
  "POL-WEB3-ASSET-1": "Web3 asset actions gated",
  "POL-PAY-1": "Payment/billing changes gated",
  "POL-INFRA-1": "Infrastructure changes gated",
  "POL-PROD-1": "Production deploys gated",
};

function pct(value: number | null): string {
  return value === null ? "n/a" : `${value} ms`;
}

function bytes(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** Shorten a long price basis to a stable, readable form for the value column. */
function pricingModel(basis: string): string {
  return basis.split(",")[0]?.trim() ?? basis;
}

/**
 * Build a report line.
 *
 * - Short label + short value → aligned single line.
 * - Anything that would overflow → label on its own line (no trailing padding),
 *   value indented below.
 *
 * This guarantees no two fields ever collide, regardless of label length.
 */
function row(label: string, value: string | number): string {
  const v = String(value);
  if (label.length <= LABEL_W && v.length <= VALUE_W) {
    return `${INDENT}${label.padEnd(LABEL_W)}${v.padStart(VALUE_W)}`;
  }
  return `${INDENT}${label}\n${CONTINUATION_INDENT}${v}`;
}

function section(title: string): string {
  return `\n${title}\n${"─".repeat(RULE_W)}`;
}

export function formatReport(model: ReportModel): string {
  const label = PERIOD_LABEL[model.period] ?? model.period;
  const L: string[] = [];

  // ---- header -------------------------------------------------------------
  L.push("JEV CODING GUARD  ·  Local Guard Evidence");
  L.push("─".repeat(RULE_W));
  L.push(`${INDENT}${label}`);
  L.push(`${INDENT}Scope: all local Guard decisions`);
  L.push(`${INDENT}Collection: local-only; no task, command, diff, or source content stored`);

  // ---- decision activity --------------------------------------------------
  L.push(section("DECISION ACTIVITY"));
  L.push(row("Guard decisions", model.guardDecisions));
  L.push(row("Jev provider calls", model.jevProviderCalls));
  L.push(row("Hard-policy short circuits", model.hardPolicyShortCircuits));

  // ---- workflow outcomes --------------------------------------------------
  L.push(section("WORKFLOW OUTCOMES"));
  for (const key of ["execute", "plan_first", "approval_required", "block"]) {
    L.push(row(key, model.outcomes[key] ?? 0));
  }

  // ---- safety actions -----------------------------------------------------
  L.push(section("SAFETY ACTIONS"));
  const entries = Object.entries(model.safetyActions).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    L.push(`${INDENT}(none in this period)`);
  } else {
    for (const [ruleId, count] of entries) {
      L.push(row(SAFETY_LABELS[ruleId] ?? ruleId, count));
    }
  }

  // ---- privacy & reliability ---------------------------------------------
  L.push(section("PRIVACY & RELIABILITY"));
  // The zero-provider-call invariant is the single most important line in the
  // report; flag it explicitly when it holds.
  L.push(
    row(
      "Hard blocks with provider calls",
      model.hardBlocksWithProviderCalls === 0 ? `0  OK` : `${model.hardBlocksWithProviderCalls}  CHECK`,
    ),
  );
  L.push(row("Provider fallbacks", model.providerFallbacks));
  L.push(row("MCP boundary fallbacks", model.boundaryFallbacks));
  L.push(row("Telemetry write errors", model.telemetryWriteErrors));

  // ---- performance --------------------------------------------------------
  L.push(section("GUARD PERFORMANCE"));
  L.push(row("Guard decision p50", pct(model.guardP50Ms)));
  L.push(row("Guard decision p95", pct(model.guardP95Ms)));
  L.push(row("Jev provider p50", pct(model.providerP50Ms)));
  L.push(row("Jev provider p95", pct(model.providerP95Ms)));

  // ---- cost ---------------------------------------------------------------
  L.push(section("JEV OPERATING COST"));
  L.push(row("Input tokens", model.jevInputTokens.toLocaleString("en-US")));
  L.push(row("Output tokens", model.jevOutputTokens.toLocaleString("en-US")));
  L.push(row("Estimated Jev cost", usd(model.estimatedCostUsd)));
  L.push(
    row(
      "Cost per provider call",
      model.jevProviderCalls > 0 ? usd(model.estimatedCostUsd / model.jevProviderCalls) : "n/a",
    ),
  );
  L.push(row("Pricing basis", pricingModel(model.pricingBasis)));
  L.push(`${CONTINUATION_INDENT}${model.pricingBasis}`);

  // ---- storage ------------------------------------------------------------
  L.push(section("LOCAL EVIDENCE STORAGE"));
  L.push(row("Decisions stored", model.decisionsStored));
  L.push(
    row(
      "Date range",
      `${model.dateRange.from ? model.dateRange.from.slice(0, 16).replace("T", " ") : "n/a"} .. ${
        model.dateRange.to ? model.dateRange.to.slice(0, 16).replace("T", " ") : "n/a"
      }`,
    ),
  );
  L.push(row("Database size", bytes(model.databaseBytes)));
  L.push(row("Retention policy", "Manual"));
  L.push(row("Remote upload", "Disabled"));
  L.push(
    row(
      "Storage advisory",
      model.storageAdvisory === "ok" ? `OK (${bytes(model.advisoryBytes)} limit)` : `EXCEEDED ${bytes(model.advisoryBytes)}`,
    ),
  );

  // ---- savings caveat -----------------------------------------------------
  L.push(section("TOKEN-SAVINGS EVIDENCE"));
  L.push(`${INDENT}Not enough controlled evidence.`);
  L.push(`${INDENT}Guard measures its own Jev usage, not total Cursor agent token usage.`);
  L.push("");

  return L.join("\n");
}

/** Response returned when evidence collection is disabled. */
export function formatDisabled(): string {
  const L: string[] = [];
  L.push("JEV CODING GUARD  ·  Local Guard Evidence");
  L.push("─".repeat(RULE_W));
  L.push(section("STATUS"));
  L.push(row("Collection", "Disabled"));
  L.push(row("Local artifact", "None created"));
  L.push("");
  L.push(`${INDENT}Local evidence collection is opt-in and currently off. No database,`);
  L.push(`${INDENT}WAL file, or directory has been created.`);
  L.push("");
  L.push(`${INDENT}To enable it, set the user-level flag and restart the MCP server:`);
  L.push(`${CONTINUATION_INDENT}JEV_GUARD_LOCAL_EVIDENCE=1`);
  L.push("");
  L.push(`${INDENT}Guard decisions are unaffected while this is disabled.`);
  L.push("");
  return L.join("\n");
}
