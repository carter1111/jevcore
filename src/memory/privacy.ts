/**
 * Privacy guards for preferences.sqlite.
 * Ledger may store category codes, rule ids, and opaque profile JSON —
 * never task/command/diff/raw provider payloads/credentials.
 */
import { MEMORY_FORBIDDEN_FIELD_NAMES } from "./types.js";

const FORBIDDEN_NAME_SET = new Set<string>(
  MEMORY_FORBIDDEN_FIELD_NAMES.map((n) => n.toLowerCase()),
);

/** Patterns that look like credential material (not category vocabulary). */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bBEGIN (RSA |EC |OPENSSH )?PRIVATE KEY\b/i,
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export class MemoryPrivacyError extends Error {
  readonly code = "MEMORY-PRIVACY";
  constructor(message: string) {
    super(message);
    this.name = "MemoryPrivacyError";
  }
}

/** Reject objects that smuggle forbidden keys (API boundary). */
export function assertNoForbiddenKeys(input: unknown, path = "root"): void {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      assertNoForbiddenKeys(input[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof input !== "object") return;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_NAME_SET.has(key.toLowerCase())) {
      throw new MemoryPrivacyError(`Forbidden field "${key}" at ${path}`);
    }
    assertNoForbiddenKeys(value, `${path}.${key}`);
  }
}

/** Reject credential-looking substrings in free-form stored strings. */
export function assertNoCredentialMaterial(value: string, field: string): void {
  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(value)) {
      throw new MemoryPrivacyError(
        `Value for "${field}" matches forbidden credential pattern`,
      );
    }
  }
}

/**
 * Category / reason codes: short stable ids, not prose tasks.
 * Allows profile-style names like secret_to_remote_provider.
 */
export function assertSafeCategory(category: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(category)) {
    throw new MemoryPrivacyError(`Invalid category code: ${category}`);
  }
  assertNoCredentialMaterial(category, "category");
}

/** Optional opaque id fields (session, grant, policy rule). */
export function assertSafeId(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(value)) {
    throw new MemoryPrivacyError(`Invalid ${field}`);
  }
  assertNoCredentialMaterial(value, field);
}

/**
 * profile_json is opaque to Memory — must be JSON object, no credential blobs,
 * and must not embed forbidden telemetry-style keys at any depth.
 */
export function assertSafeProfileJson(profileJson: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profileJson);
  } catch {
    throw new MemoryPrivacyError("profileJson must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryPrivacyError("profileJson must be a JSON object");
  }
  assertNoForbiddenKeys(parsed, "profileJson");
  assertNoCredentialMaterial(profileJson, "profileJson");
}
