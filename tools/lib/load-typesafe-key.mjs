/** Load TYPESAFE_API_KEY from process env or repo `.env.local` (no logging). */
import { readFileSync } from "node:fs";

export function loadTypesafeApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const raw = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^[ \t]*TYPESAFE_API_KEY[＝=][ \t]*([^ \t\r]+)/);
      if (m) {
        process.env.TYPESAFE_API_KEY = m[1];
        return m[1];
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

export function requireTypesafeApiKey(toolName) {
  const key = loadTypesafeApiKey();
  if (!key) {
    process.stderr.write(`${toolName}: TYPESAFE_API_KEY required\n`);
    process.exit(2);
  }
  return key;
}
