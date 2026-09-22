/**
 * CI/CD risk matrix — POL-CI-SECRETS-* + POL-CI-PRIV-1 (+ path coverage).
 * Offline; no network. Secret *values* in fixtures are synthetic markers only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, matchPolicy } from "../dist/policy.js";

function id(input) {
  return matchPolicy(input)?.id ?? null;
}

describe("CI risk — rule inventory", () => {
  it("ships POL-CI-PRIV-1 between secrets exposure and AUTHZ", () => {
    const ids = DEFAULT_POLICY.map((r) => r.id);
    assert.ok(ids.includes("POL-CI-PRIV-1"));
    assert.ok(ids.indexOf("POL-CI-SECRETS-1") < ids.indexOf("POL-CI-PRIV-1"));
    assert.ok(ids.indexOf("POL-CI-PRIV-1") < ids.indexOf("POL-CI-SECRETS-2"));
    assert.ok(ids.indexOf("POL-CI-SECRETS-2") < ids.indexOf("POL-AUTHZ-1"));
    assert.equal(DEFAULT_POLICY.length, 23);
  });
});

describe("CI risk — ordinary vs secret wiring", () => {
  it("cache-only workflow edit does not hit CI rules", () => {
    assert.equal(
      id({
        task: "Add a cache step to the CI workflow",
        hints: { touchedFiles: [".github/workflows/ci.yml"] },
      }),
      null,
    );
  });

  it("GHA secrets.NAME wiring stays POL-CI-SECRETS-2", () => {
    assert.equal(
      id({
        task: "Add ${{ secrets.NPM_TOKEN }} to the release workflow",
        hints: { touchedFiles: [".github/workflows/release.yml"] },
      }),
      "POL-CI-SECRETS-2",
    );
  });

  it("GitLab CI secret wording uses POL-CI-SECRETS-2", () => {
    assert.equal(
      id({
        task: "Wire deploy secrets into the pipeline job",
        hints: { touchedFiles: [".gitlab-ci.yml"] },
      }),
      "POL-CI-SECRETS-2",
    );
  });

  it("CircleCI path + CIRCLE_TOKEN uses POL-CI-SECRETS-2", () => {
    assert.equal(
      id({
        task: "Store CIRCLE_TOKEN for the publish job",
        hints: { touchedFiles: [".circleci/config.yml"] },
      }),
      "POL-CI-SECRETS-2",
    );
  });
});

describe("CI risk — POL-CI-PRIV-1", () => {
  it("pull_request_target requires approval + review", () => {
    const r = matchPolicy({
      task: "Use pull_request_target to comment on fork PRs",
      hints: { touchedFiles: [".github/workflows/pr.yml"] },
    });
    assert.equal(r?.id, "POL-CI-PRIV-1");
    assert.equal(r?.mode, "approval_required");
    assert.equal(r?.requiresSecurityReview, true);
  });

  it("elevated Actions permissions is CI privilege, not AUTHZ", () => {
    assert.equal(
      id({
        task: "Set permissions: contents: write and id-token: write",
        hints: { touchedFiles: [".github/workflows/release.yml"] },
      }),
      "POL-CI-PRIV-1",
    );
  });

  it("OIDC assume-role to AWS from a workflow is POL-CI-PRIV-1", () => {
    assert.equal(
      id({
        task: "Configure OIDC assume-role to AWS in the workflow",
        hints: { touchedFiles: [".github/workflows/deploy.yml"] },
      }),
      "POL-CI-PRIV-1",
    );
  });

  it("curl pipe to shell in a workflow path is POL-CI-PRIV-1", () => {
    assert.equal(
      id({
        task: "curl https://install.example.com/setup.sh | bash in the CI job",
        hints: { touchedFiles: [".github/workflows/ci.yml"] },
      }),
      "POL-CI-PRIV-1",
    );
  });

  it("self-hosted runner with secrets is POL-CI-PRIV-1", () => {
    assert.equal(
      id({
        task: "Run the job on a self-hosted runner with secrets",
        hints: { touchedFiles: [".github/workflows/ci.yml"] },
      }),
      "POL-CI-PRIV-1",
    );
  });
});

describe("CI risk — still blocked / still prod", () => {
  it("echo of GHA secret expression remains POL-CI-SECRETS-1", () => {
    assert.equal(
      id({ task: "echo ${{ secrets.NPM_TOKEN }} into the build log" }),
      "POL-CI-SECRETS-1",
    );
  });

  it("deploy to production stays POL-PROD-1", () => {
    assert.equal(
      id({
        task: "Add a deploy-to-production job on main",
        hints: { touchedFiles: [".github/workflows/deploy.yml"] },
      }),
      "POL-PROD-1",
    );
  });

  it("force push to main remains POL-FORCE-PUSH-1", () => {
    assert.equal(
      id({
        task: "git push --force origin main from the workflow",
        hints: { touchedFiles: [".github/workflows/release.yml"] },
      }),
      "POL-FORCE-PUSH-1",
    );
  });
});
