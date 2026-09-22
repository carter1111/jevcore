#!/usr/bin/env node
/**
 * Operator release checklist (offline + advisory host checks).
 * Never enables live Jev, never writes host config, never flips thresholds.
 *
 *   npm run verify:release
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const steps = [
  ["screen:corpus", ["tools/corpus-screen.mjs"]],
  ["corpus:propose", ["tools/corpus-propose.mjs"]],
  ["eval:corpus", ["tools/corpus-eval.mjs"]],
  ["propose:thresholds", ["tools/threshold-propose.mjs"]],
  ["verify:adapters", ["tools/verify-adapters.mjs"]],
  ["verify:hosts", ["tools/verify-hosts.mjs"]],
];

let failed = 0;
for (const [name, argv] of steps) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const r = spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 180_000,
  });
  if (r.status !== 0) {
    failed += 1;
    process.stdout.write(`FAIL ${name} (exit ${r.status ?? "?"})\n`);
  } else {
    process.stdout.write(`PASS ${name}\n`);
  }
}

process.stdout.write(
  `\n=== verify:release ${failed === 0 ? "ALL PASS" : `${failed} FAIL`} ===\n`,
);
process.exit(failed === 0 ? 0 : 1);
