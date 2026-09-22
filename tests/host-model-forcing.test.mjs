/**
 * Host model selection must stay advisory — no forcing path in MCP contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("host model forcing", () => {
  it("mcp-server exposes modelSelection as optional advisory only", () => {
    const src = readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf8");
    assert.match(src, /modelSelection/);
    assert.doesNotMatch(src, /forceModel|forcedModel|overrideHostModel|setHostModel/);
    assert.match(src, /modelSelection\?:/);
  });

  it("threshold-propose documents host forcing as blocked", () => {
    const src = readFileSync(new URL("../tools/threshold-propose.mjs", import.meta.url), "utf8");
    assert.match(src, /hostModelForcing/);
    assert.match(src, /blocked/);
  });
});
