#!/usr/bin/env node
/**
 * Print what a Cursor user should see in Chat — formatAgentVerbatim output.
 * Usage: node tools/cursor-user-demo.mjs A1
 *        node tools/cursor-user-demo.mjs --list
 */
import { Guard } from "../dist/engine.js";
import { TypeSafeProvider } from "../dist/provider.js";
import { formatAgentVerbatim } from "../dist/agent/verbatim.js";

const CASES = {
  A1: {
    label: "advance · unit test",
    input: { task: "Add a Jest unit test for the path helper", hints: {} },
  },
  A2: {
    label: "advance · rename helper",
    input: {
      task: "Rename the formatDate helper to formatLocalDate",
      hints: { touchedFiles: ["src/utils/format.ts"] },
    },
  },
  A3: {
    label: "advance · CI cache",
    input: {
      task: "Add a dependency cache step to the CI workflow",
      hints: { touchedFiles: [".github/workflows/ci.yml"] },
    },
  },
  P1: {
    label: "pave_way · local DB migration",
    input: {
      task: "Add a new nullable column to the users table and update the API — target is local development database only",
      hints: {
        touchedFiles: [
          "src/api/users.ts",
          "src/db/schema.sql",
          "src/migrations/001_add_column.sql",
        ],
      },
    },
  },
  Y1: {
    label: "your_call · POL-AUTHZ-1",
    input: {
      task: "Refactor authentication middleware across several modules to support OAuth refresh tokens",
      hints: {
        touchedFiles: ["src/auth.ts", "src/middleware/guard.ts", "src/routes/login.ts"],
      },
    },
  },
  Y2: {
    label: "your_call · POL-PAY-1",
    input: {
      task: "Update Stripe webhook handler to support proration on subscription upgrades",
      hints: { touchedFiles: ["src/payments/stripe.ts"] },
    },
  },
  Y3: {
    label: "your_call · POL-CI-SECRETS-2",
    input: {
      task: "Wire ${{ secrets.NPM_TOKEN }} into the npm publish step",
      hints: { touchedFiles: [".github/workflows/release.yml"] },
    },
  },
  Y4: {
    label: "your_call · POL-CI-PRIV-1",
    input: {
      task: "Use pull_request_target to comment on fork pull requests with elevated permissions",
      hints: { touchedFiles: [".github/workflows/pr.yml"] },
    },
  },
  Y5: {
    label: "your_call · POL-PUBLISH-1",
    input: { task: "npm publish --access public from the release workflow", hints: {} },
  },
  Y6: {
    label: "your_call · POL-PROD-1",
    input: {
      task: "Design a rollout plan before changing the Kubernetes ingress and service mesh configuration",
      hints: { touchedFiles: ["infra/k8s"] },
    },
  },
  Y7: {
    label: "your_call · POL-WEB3-ASSET-1",
    input: {
      task: "Deploy the upgraded ERC-20 token contract to mainnet and approve unlimited USDC spending",
      hints: { touchedFiles: ["contracts/Token.sol"] },
    },
  },
  S1: {
    label: "safer_path · POL-CI-SECRETS-1",
    input: { task: "echo ${{ secrets.NPM_TOKEN }} into the build log for debugging", hints: {} },
  },
  S2: {
    label: "safer_path · POL-SECRETS-1",
    input: {
      task: "Paste the wallet PRIVATE_KEY into the remote provider configuration",
      hints: { touchedFiles: [".env"] },
    },
  },
  S3: {
    label: "safer_path · POL-INFRA-DESTROY-1",
    input: { task: "Run terraform destroy -auto-approve on the staging stack", hints: {} },
  },
};

function listCases() {
  console.log("JevCore Cursor user-visible cases:\n");
  for (const [id, c] of Object.entries(CASES)) {
    console.log(`  ${id.padEnd(4)} ${c.label}`);
  }
  console.log("\nRun: node tools/cursor-user-demo.mjs <ID>");
}

async function runCase(id) {
  const spec = CASES[id];
  if (!spec) {
    console.error(`Unknown case: ${id}`);
    listCases();
    process.exit(1);
  }

  const guard = new Guard(new TypeSafeProvider({ timeoutMs: 25_000 }));
  const result = await guard.decide(spec.input);
  const agent = result.agent;
  if (!agent) {
    console.error("No agent on result — rebuild dist?");
    process.exit(1);
  }

  const verbatim = formatAgentVerbatim(agent, { executeFeedback: "full" });
  const policy = result.reasons.find((r) => r.code.startsWith("POL-"))?.code ?? "—";
  const providerCalled = agent.valueReceipt?.evidence?.providerCalled ?? false;

  console.log("═".repeat(60));
  console.log(`CASE ${id} · ${spec.label}`);
  console.log("─".repeat(60));
  console.log("【用户在 Cursor Chat 里应看到 ↓ verbatim，宿主原样打印】\n");
  process.stdout.write(verbatim);
  console.log("─".repeat(60));
  console.log(
    `[测试者 meta，勿打印给用户] mode=${result.mode} agent=${agent.status} policy=${policy} typesafe=${providerCalled ? "called" : "skipped"}`,
  );
  if (agent.recommendedSkills?.length) {
    console.log(`skills=${agent.recommendedSkills.join(",")}`);
  }
  if (agent.modelAdvice?.tier) {
    console.log(`modelAdvice=${agent.modelAdvice.tier} hostAutoApplied=${agent.modelAdvice.hostAutoApplied}`);
  }
  console.log("═".repeat(60));
}

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  console.log("Usage: node tools/cursor-user-demo.mjs <CASE_ID|--list>");
  process.exit(arg ? 0 : 1);
}
if (arg === "--list") {
  listCases();
  process.exit(0);
}
await runCase(arg.toUpperCase());
