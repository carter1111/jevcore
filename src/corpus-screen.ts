/**
 * Privacy screen for proposed corpus fixtures.
 * Rejects absolute paths, credentials, emails, and URLs before anything is merged.
 * Does not store or upload candidate text.
 */
export interface CorpusCandidate {
  id: string;
  task: string;
  touchedFiles?: string[];
}

export interface CorpusScreenResult {
  id: string;
  ok: boolean;
  reasons: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extraDenyPatterns(): Array<{ code: string; re: RegExp }> {
  const raw = process.env.JEV_CORPUS_SCREEN_EXTRA_DENY ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((term) => ({
      code: "extra-deny",
      re: new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"),
    }));
}

const BASE_FORBIDDEN: Array<{ code: string; re: RegExp }> = [
  { code: "absolute-path", re: /\/Users\/|\/home\/|\/private\/|\bC:\\/ },
  { code: "hostname", re: /\blocalhost\b|\b127\.0\.0\.1\b|\.local\b/i },
  { code: "db-url", re: /\b(?:postgres|mysql|mongodb|redis):\/\//i },
  { code: "api-key", re: /\bsk-[a-z0-9]{16,}\b|\bghp_[a-z0-9]{20,}\b|\bxox[baprs]-/i },
  { code: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "pem", re: /BEGIN [A-Z ]+PRIVATE KEY/i },
  { code: "url", re: /https?:\/\//i },
  { code: "email", re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { code: "phone", re: /\+\d[\d\s-]{7,}/ },
];

export function screenCorpusCandidate(candidate: CorpusCandidate): CorpusScreenResult {
  const reasons: string[] = [];
  if (!candidate.id || typeof candidate.id !== "string") reasons.push("missing-id");
  if (!candidate.task || typeof candidate.task !== "string") reasons.push("missing-task");
  const hay = `${candidate.id}\n${candidate.task}\n${(candidate.touchedFiles ?? []).join("\n")}`;
  const forbidden = [...BASE_FORBIDDEN, ...extraDenyPatterns()];
  for (const rule of forbidden) {
    if (rule.re.test(hay)) reasons.push(rule.code);
  }
  return { id: candidate.id || "(missing)", ok: reasons.length === 0, reasons };
}

export function screenCorpusCandidates(candidates: readonly CorpusCandidate[]): CorpusScreenResult[] {
  return candidates.map(screenCorpusCandidate);
}
