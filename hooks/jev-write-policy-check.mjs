#!/usr/bin/env node
/**
 * jev-write-policy-check.mjs — Cursor preToolUse gate for Write/Delete.
 *
 * Closes the shell-only blind spot: editing secret paths (e.g. env files,
 * PEM material) never hit beforeShellExecution. This adapter applies the
 * same `matchPolicy` rules with `hints.touchedFiles` set from the tool path.
 *
 * Design (same constraints as the shell gate):
 *   * Deterministic + fast — no network / no LLM.
 *   * Introduces no policy of its own — thin adapter over dist/policy.js.
 *   * Fail-open on import/parse errors (broken gate must not stall all edits).
 *
 * preToolUse note: `permission: "ask"` is accepted by the schema but not
 * reliably enforced today. For `approval_required` we still return `ask` and
 * a clear agent_message; for `block` we return `deny`.
 *
 * Stdin (Cursor): { tool_name, tool_input: { file_path | path | target_file }, … }
 * Stdout: { permission: allow|deny|ask, user_message?, agent_message? }
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "policy.js",
);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Extract a filesystem path from common Write/Delete tool_input shapes. */
export function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of ["file_path", "path", "target_file", "targetFile", "filePath"]) {
    const v = toolInput[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

let input = {};
try {
  const raw = readStdin();
  if (raw.trim()) input = JSON.parse(raw);
} catch {
  input = {};
}

const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
const filePath = extractFilePath(input.tool_input ?? input);
if (!filePath) {
  emit({ permission: "allow" });
}

const task = `${toolName || "Write"} ${filePath}`.trim();

let rule;
try {
  const { matchPolicy } = await import(POLICY_PATH);
  rule = matchPolicy({ task, hints: { touchedFiles: [filePath] } });
} catch (e) {
  emit({
    permission: "allow",
    agent_message: `Jev Guard write-policy check unavailable (${e?.code ?? e?.message ?? e}); allowed (fail-open). Run "npm run build" in jev-coding-guard or check the dist path.`,
  });
}

if (!rule) {
  emit({ permission: "allow" });
}

if (rule.mode === "block") {
  emit({
    permission: "deny",
    user_message: `Jev Guard blocked this file edit (${rule.id}: ${rule.reason?.detail ?? rule.description}). Do not bypass.`,
    agent_message: `Jev Guard hard policy ${rule.id} -> block on path ${filePath}. Do not write/delete this path; explain the rule and offer a safer alternative.`,
  });
}

if (rule.mode === "approval_required") {
  emit({
    permission: "ask",
    user_message: `Jev Guard: approval required to edit ${filePath} (${rule.id}: ${rule.reason?.detail ?? rule.description}).`,
    agent_message: `Jev Guard hard policy ${rule.id} -> approval_required for ${filePath}. Ask the user for explicit approval before editing this path. (Note: preToolUse "ask" may not pause the UI — treat deny+reissue as the fallback if the host ignores ask.)`,
  });
}

emit({
  permission: "ask",
  user_message: `Jev Guard: ${rule.id} (${rule.mode}) — review before editing ${filePath}`,
  agent_message: `Jev Guard policy ${rule.id} -> ${rule.mode} for ${filePath}. Review with the user before proceeding.`,
});
