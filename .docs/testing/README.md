# JevCore — Cursor 用户可见 E2E 用例

> **目的**：记录用户在 **Cursor Chat** 里应看到什么（不是 backend JSON）。
> **真源输出**：MCP 返回 `agent` 后，宿主 Agent 用 `formatAgentVerbatim(agent)` **原样打印**（见 `adapters/generic/AGENTS.md`）。
> **离线回归**：`tests/acceptance-agent-v1.test.mjs` · `tests/policy-ci-risk.test.mjs`
> **Console 演示**：`node tools/cursor-user-demo.mjs <CASE_ID>`

## 怎么读

| 列 | 含义 |
|---|---|
| **Four Action** | `advance` · `pave_way` · `your_call` · `safer_path` |
| **用户任务** | 用户在 Cursor 里说的话（或等价 task） |
| **用户应看到** | `formatAgentVerbatim` 输出（Chat 里 JEV 块） |
| **Hook** | Cursor shell/write hook 是否另拦（与 MCP 独立） |

## 用例索引

见 [`cases.md`](./cases.md)。

## 运行单个用例（本机 Console 演示）

```bash
cd /path/to/jevcore
npm run build   # 若刚改过 src
node tools/cursor-user-demo.mjs A1
node tools/cursor-user-demo.mjs --list
```

输出 = **用户在 Cursor 里应看到的 verbatim 文本** + 一行 meta（mode / policy / TypeSafe 是否调用），meta 仅供测试者核对，**不应**由宿主 Agent 打印给用户。
