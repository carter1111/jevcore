/**
 * C-5 Phase B — jev_assess_task batchItems (schemaVersion 2).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createJevMcpServer } from "../dist/mcp-server.js";

class BatchFakeProvider {
  judgeCalls = 0;
  judgeManyCalls = 0;

  async judge() {
    this.judgeCalls += 1;
    return this.ok();
  }

  async judgeMany(inputs) {
    this.judgeManyCalls += 1;
    return inputs.map(() => this.ok());
  }

  ok() {
    return {
      kind: "backend",
      kindConfidence: 0.9,
      riskScore: 0.2,
      riskConfidence: 0.9,
      securityReviewNoul: 0.1,
      failed: false,
    };
  }
}

class McpTester {
  static async start(provider) {
    const [srvT, cliT] = InMemoryTransport.createLinkedPair();
    const server = createJevMcpServer({ provider });
    await server.connect(srvT);
    const t = new McpTester();
    t.server = server;
    t.cliT = cliT;
    t.id = 0;
    t.pending = new Map();
    cliT.onmessage = (msg) => {
      if (msg && msg.id !== undefined && t.pending.has(msg.id)) {
        t.pending.get(msg.id).resolve(msg);
        t.pending.delete(msg.id);
      }
    };
    await cliT.start();
    await srvT.start();
    await t.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jev-batch-test", version: "1.0.0" },
    });
    await t.notify("notifications/initialized", {});
    return t;
  }

  request(method, params) {
    const rid = ++this.id;
    const p = new Promise((resolve) => this.pending.set(rid, { resolve }));
    this.cliT.send({ jsonrpc: "2.0", id: rid, method, params });
    return p;
  }

  notify(method, params) {
    this.cliT.send({ jsonrpc: "2.0", method, params });
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    await this.server.close();
  }
}

describe("MCP jev_assess_task batch", () => {
  it("returns schemaVersion 2 with shared_system_one meta", async () => {
    const provider = new BatchFakeProvider();
    const t = await McpTester.start(provider);
    const resp = await t.callTool("jev_assess_task", {
      userTask: "parent context",
      repositoryContext: "repo",
      batchItems: [
        { userTask: "rename helper", changedFiles: ["src/a.ts"] },
        { userTask: "fix typo", changedFiles: ["README.md"] },
      ],
      batchStrategy: "shared_system_one",
    });
    await t.close();
    assert.equal(resp.result.isError, undefined);
    const out = resp.result.structuredContent;
    assert.equal(out.schemaVersion, 2);
    assert.equal(out.items.length, 2);
    assert.equal(out.meta.strategy, "shared_system_one");
    assert.equal(out.meta.providerCalls, 1);
    assert.equal(provider.judgeManyCalls, 1);
    assert.equal(provider.judgeCalls, 0);
  });

  it("rejects batchItems over max 8 (strict schema)", async () => {
    const provider = new BatchFakeProvider();
    const t = await McpTester.start(provider);
    const resp = await t.callTool("jev_assess_task", {
      userTask: "parent context",
      repositoryContext: "repo",
      batchItems: Array.from({ length: 9 }, (_, i) => ({
        userTask: `subtask ${i}`,
        changedFiles: [`src/f${i}.ts`],
      })),
    });
    await t.close();
    assert.equal(resp.result.isError, true);
    assert.equal(provider.judgeManyCalls, 0);
    assert.equal(provider.judgeCalls, 0);
  });

  it("single-task path unchanged (schemaVersion absent)", async () => {
    const provider = new BatchFakeProvider();
    const t = await McpTester.start(provider);
    const resp = await t.callTool("jev_assess_task", {
      userTask: "ordinary refactor",
      repositoryContext: "repo",
    });
    await t.close();
    const out = resp.result.structuredContent;
    assert.equal(out.schemaVersion, undefined);
    assert.ok(out.executionMode);
    assert.equal(provider.judgeCalls, 1);
  });
});
