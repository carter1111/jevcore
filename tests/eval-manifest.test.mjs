// tests/eval-manifest.test.mjs — WP6 version manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVAL_MANIFEST_VERSION,
  ROUTING_VERSION,
  buildEvalManifest,
} from "../dist/eval-manifest.js";

test("eval-manifest: version constants are non-empty", () => {
  assert.ok(EVAL_MANIFEST_VERSION.length > 0);
  assert.ok(ROUTING_VERSION.length > 0);
});

test("eval-manifest: buildEvalManifest is content-free and stable", () => {
  const a = buildEvalManifest();
  const b = buildEvalManifest();
  assert.deepEqual(a, b);
  assert.equal(a.evalManifestVersion, EVAL_MANIFEST_VERSION);
  for (const [k, v] of Object.entries(a)) {
    assert.ok(typeof v === "string" || typeof v === "number", k);
    assert.ok(!String(v).includes(" "), `${k} should be a version id`);
  }
  // No content-bearing keys.
  assert.equal("task" in a, false);
  assert.equal("command" in a, false);
});
