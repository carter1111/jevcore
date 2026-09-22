/**
 * T11 — read-first path relay (identifiers only; no second LLM essay).
 */
export const MAX_READ_FIRST_PATHS = 12;
export const MAX_READ_FIRST_PATH_LEN = 512;

/**
 * Cap and sanitize path identifiers from Context Router.
 * Never invents paths; returns undefined when empty after filter.
 */
export function resolveReadFirst(
  paths: readonly string[] | undefined,
  options?: { maxPaths?: number; maxPathLen?: number },
): string[] | undefined {
  if (!paths || paths.length === 0) return undefined;
  const maxPaths = options?.maxPaths ?? MAX_READ_FIRST_PATHS;
  const maxPathLen = options?.maxPathLen ?? MAX_READ_FIRST_PATH_LEN;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p || p.length > maxPathLen) continue;
    // Identifiers only — reject obvious bodies / newlines.
    if (p.includes("\n") || p.includes("\0")) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= maxPaths) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Relay skill ids from routing; cap length; no prose. */
export function resolveRecommendedSkills(
  skills: readonly string[] | undefined,
  max = 16,
): string[] | undefined {
  if (!skills || skills.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    if (typeof s !== "string") continue;
    const id = s.trim();
    if (!id || id.length > 64 || !/^[a-z][a-z0-9_-]*$/i.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : undefined;
}
