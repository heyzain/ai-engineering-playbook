import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { DefaultRuleExecutionContext } from "../src/core/linters/execution-context.js";
import { RuleRegistry } from "../src/core/linters/rule-registry.js";
import { LinterEngine } from "../src/core/linters/engine.js";
import {
  ruleSecWorkflowPerms,
  ruleSecActionPinning,
  ruleSecPrTargetBan,
  ruleSecPublicEnvLeak,
  SECURITY_RULES,
} from "../src/core/linters/rules/security/index.js";
import {
  DOCUMENTATION_RULES,
  SCHEMA_RULES,
  INVARIANT_RULES,
  STACK_RULES,
  ALL_PRODUCTION_RULES,
} from "../src/core/linters/rules/index.js";
import type { RuleFinding } from "../src/core/linters/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupWorkflow(projectDir: string, fileName: string, content: string): string {
  const workflowDir = path.join(projectDir, ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  const filePath = path.join(workflowDir, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function setupEnvFile(projectDir: string, relativePath: string, content: string): string {
  const fullPath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

describe("Task 008B.6: Category E Security & Workflow Governance Rules", () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-sec-test-"));
  });

  test.afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RULE-SEC-WORKFLOW-PERMS
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. RULE-SEC-WORKFLOW-PERMS", () => {
    test("passes cleanly on valid explicit permissions: contents: read", async () => {
      setupWorkflow(
        tmpDir,
        "ci.yml",
        `name: CI
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "OK"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly on valid deny-all permissions: {}", async () => {
      setupWorkflow(
        tmpDir,
        "deny-all.yml",
        `name: Deny All
on: [push]
permissions: {}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Deny all"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags permissions: read-all with UNSAFE_WORKFLOW_PERMISSIONS as broad unconstrained scope", async () => {
      setupWorkflow(
        tmpDir,
        "read-all.yml",
        `name: Read All
on: [push]
permissions: read-all
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Not least privilege"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNSAFE_WORKFLOW_PERMISSIONS" &&
            f.message.includes("read-all")
        )
      );
    });

    test("flags missing top-level permissions block with MISSING_PERMISSIONS_BLOCK", async () => {
      setupWorkflow(
        tmpDir,
        "no-perms.yml",
        `name: No Perms
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "No perms"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "MISSING_PERMISSIONS_BLOCK" &&
            f.message.includes("missing an explicit, top-level 'permissions'")
        )
      );
    });

    test("verifies that job-level permissions do NOT substitute for top-level permissions", async () => {
      setupWorkflow(
        tmpDir,
        "job-only-perms.yml",
        `name: Job Only Perms
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo "Job level only"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "MISSING_PERMISSIONS_BLOCK" &&
            f.message.includes("Job-level permissions do not substitute")
        )
      );
    });

    test("flags permissions: write-all with UNSAFE_WORKFLOW_PERMISSIONS", async () => {
      setupWorkflow(
        tmpDir,
        "write-all.yml",
        `name: Write All
on: [push]
permissions: write-all
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Unsafe"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNSAFE_WORKFLOW_PERMISSIONS" &&
            f.message.includes("write-all")
        )
      );
    });

    test("flags unsafe write scopes in permissions mapping with UNSAFE_WORKFLOW_PERMISSIONS", async () => {
      setupWorkflow(
        tmpDir,
        "write-scopes.yml",
        `name: Write Scopes
on: [push]
permissions:
  contents: read
  pull-requests: write
  id-token: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Unsafe"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length >= 2);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNSAFE_WORKFLOW_PERMISSIONS" &&
            f.message.includes("pull-requests: write")
        )
      );
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNSAFE_WORKFLOW_PERMISSIONS" &&
            f.message.includes("id-token: write")
        )
      );
    });

    test("flags malformed YAML in workflow file with UNSAFE_WORKFLOW_PERMISSIONS", async () => {
      setupWorkflow(tmpDir, "bad-syntax.yml", "name: Bad\non: [push\npermissions: contents: read\n");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNSAFE_WORKFLOW_PERMISSIONS" &&
            f.message.includes("malformed or unparseable YAML")
        )
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. RULE-SEC-ACTION-PINNING
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. RULE-SEC-ACTION-PINNING", () => {
    test("passes cleanly on third-party actions pinned to full 40-character commit SHAs (with and without comment)", async () => {
      setupWorkflow(
        tmpDir,
        "pinned.yml",
        `name: Pinned
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2 (with comment)
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # (with comment)
      - uses: actions/cache@d4323d4df104b026a6aa633fdb11d772146be0bf
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly on local repository actions and docker actions", async () => {
      setupWorkflow(
        tmpDir,
        "local-docker.yml",
        `name: Local and Docker
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/my-custom-action
      - uses: docker://alpine:3.18
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags mutable tag reference (e.g. @v4) with UNPINNED_THIRD_PARTY_ACTION", async () => {
      setupWorkflow(
        tmpDir,
        "unpinned-tag.yml",
        `name: Unpinned Tag
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNPINNED_THIRD_PARTY_ACTION" &&
            f.message.includes("actions/checkout") &&
            f.message.includes("@v4")
        )
      );
      assert.strictEqual(findings[0].line, 9);
    });

    test("flags mutable branch reference (e.g. @main) with UNPINNED_THIRD_PARTY_ACTION", async () => {
      setupWorkflow(
        tmpDir,
        "unpinned-branch.yml",
        `name: Unpinned Branch
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@main
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNPINNED_THIRD_PARTY_ACTION" &&
            f.message.includes("actions/setup-node") &&
            f.message.includes("@main")
        )
      );
    });

    test("flags third-party action without version reference with UNPINNED_THIRD_PARTY_ACTION", async () => {
      setupWorkflow(
        tmpDir,
        "no-ref.yml",
        `name: No Ref
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "UNPINNED_THIRD_PARTY_ACTION" &&
            f.message.includes("lacks a version pin")
        )
      );
    });

    test("does not match unrelated comments or shell scripts containing action names", async () => {
      setupWorkflow(
        tmpDir,
        "comments.yml",
        `name: Comments
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Shell step
        run: |
          # Note: Previously used actions/checkout@v3 here
          echo "Run actions/setup-node@v2 in docker"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RULE-SEC-PR-TARGET-BAN
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. RULE-SEC-PR-TARGET-BAN", () => {
    test("passes cleanly on workflows using pull_request, push, and workflow_dispatch triggers", async () => {
      setupWorkflow(
        tmpDir,
        "pr.yml",
        `name: Normal PR
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly on pull_request_target workflows that do NOT check out PR code (e.g. labeler)", async () => {
      setupWorkflow(
        tmpDir,
        "labeler.yml",
        `name: Safe Labeler
on:
  pull_request_target:
    types: [opened, labeled]
permissions:
  pull-requests: write
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@11bd71901bbe5b1630ceea73d27597364c9af683
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags pull_request_target checking out PR head sha with FORBIDDEN_PR_TARGET_TRIGGER", async () => {
      setupWorkflow(
        tmpDir,
        "unsafe-pr-target.yml",
        `name: Unsafe PR Target
on: pull_request_target
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm test
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "FORBIDDEN_PR_TARGET_TRIGGER" &&
            f.message.includes("actions/checkout explicitly configures ref")
        )
      );
    });

    test("flags pull_request_target with sequence trigger checking out PR head ref", async () => {
      setupWorkflow(
        tmpDir,
        "seq-pr-target.yml",
        `name: Sequence PR Target
on: [push, pull_request_target]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: \${{ github.event.pull_request.head.ref }}
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some((f) => f.diagnosticCode === "FORBIDDEN_PR_TARGET_TRIGGER")
      );
    });

    test("flags pull_request_target manually checking out PR head in run step", async () => {
      setupWorkflow(
        tmpDir,
        "manual-git-checkout.yml",
        `name: Manual Git Checkout
on: pull_request_target
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: git checkout \${{ github.event.pull_request.head.sha }}
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "FORBIDDEN_PR_TARGET_TRIGGER" &&
            f.message.includes("manually checks out PR head code")
        )
      );
    });

    test("flags pull_request_target using gh pr checkout in run step", async () => {
      setupWorkflow(
        tmpDir,
        "gh-pr-checkout.yml",
        `name: GH PR Checkout
on: pull_request_target
permissions:
  contents: read
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr checkout \${{ github.event.pull_request.number }}
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "FORBIDDEN_PR_TARGET_TRIGGER" &&
            f.message.includes("manually checks out PR head code")
        )
      );
    });

    test("flags pull_request_target with dynamic unresolvable ref expression whose safety cannot be statically proven", async () => {
      setupWorkflow(
        tmpDir,
        "dynamic-ref.yml",
        `name: Dynamic Ref Checkout
on: pull_request_target
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: \${{ env.UNTRUSTED_PR_REF }}
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "FORBIDDEN_PR_TARGET_TRIGGER" &&
            f.message.includes("dynamic or ambiguous ref")
        )
      );
    });

    test("flags pull_request_target checking out PR head fork repository", async () => {
      setupWorkflow(
        tmpDir,
        "fork-repo.yml",
        `name: Fork Repo Checkout
on: pull_request_target
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "FORBIDDEN_PR_TARGET_TRIGGER" &&
            f.message.includes("actions/checkout explicitly configures repository")
        )
      );
    });

    test("passes cleanly on pull_request_target explicitly checking out base ref", async () => {
      setupWorkflow(
        tmpDir,
        "safe-base-checkout.yml",
        `name: Safe Base Checkout
on: pull_request_target
permissions:
  contents: read
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: \${{ github.base_ref }}
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RULE-SEC-PUBLIC-ENV-LEAK
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. RULE-SEC-PUBLIC-ENV-LEAK", () => {
    test("passes cleanly on benign public client configuration", async () => {
      setupEnvFile(
        tmpDir,
        ".env",
        `# Benign Public Configuration
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_APP_TITLE=My Playbook App
NEXT_PUBLIC_ENVIRONMENT=production
EXPO_PUBLIC_APP_VARIANT=development
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly on .env.example with standard placeholder values", async () => {
      setupEnvFile(
        tmpDir,
        ".env.example",
        `# Example Documentation Template
DATABASE_URL=postgresql://user:password@localhost:5432/mydb
API_KEY=your-secret-key-here
AUTH_TOKEN=TODO
SECRET_SALT=change_me
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags sensitive keyword exposed via NEXT_PUBLIC_ prefix with PUBLIC_ENV_SECRET_LEAK", async () => {
      setupEnvFile(
        tmpDir,
        ".env",
        `NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_SECRET_KEY=super-secret-key-12345
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("NEXT_PUBLIC_SECRET_KEY")
        )
      );
      // Redaction assertion: actual value must be redacted, not exposed in plaintext!
      assert.ok(!findings[0].actual?.includes("super-secret-key-12345"));
      assert.ok(findings[0].actual?.includes("***"));
    });

    test("flags sensitive keyword exposed via EXPO_PUBLIC_ prefix with PUBLIC_ENV_SECRET_LEAK", async () => {
      setupEnvFile(
        tmpDir,
        ".env.local",
        `EXPO_PUBLIC_ADMIN_TOKEN=admin_secret_token_9999
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("EXPO_PUBLIC_ADMIN_TOKEN")
        )
      );
      assert.ok(!findings[0].actual?.includes("admin_secret_token_9999"));
    });

    test("flags unencrypted sensitive credentials in non-example environment file", async () => {
      setupEnvFile(
        tmpDir,
        ".env.production",
        `DATABASE_PASSWORD=live_production_password_2026
API_SECRET=my_stripe_secret_production
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length >= 2);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("DATABASE_PASSWORD")
        )
      );
      assert.ok(!findings[0].actual?.includes("live_production_password_2026"));
    });

    test("flags PEM cryptographic private key block in any environment file", async () => {
      setupEnvFile(
        tmpDir,
        ".env.local",
        `SIGNING_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0...
-----END RSA PRIVATE KEY-----"
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("private cryptographic key block")
        )
      );
      assert.ok(findings.some((f) => f.actual?.includes("[REDACTED]")));
    });

    test("flags actual live credential format (e.g. ghp_ token) even in .env.example", async () => {
      setupEnvFile(
        tmpDir,
        ".env.example",
        `# This is supposed to be an example, but someone committed a live token!
GITHUB_TOKEN=ghp_ABC123456789012345678901234567890123456
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("Actual live credential detected")
        )
      );
      assert.ok(!findings[0].actual?.includes("ABC123456789012345678901234567890123456"));
    });

    test("flags high-entropy random token assigned to NEXT_PUBLIC_ prefix with PUBLIC_ENV_SECRET_LEAK", async () => {
      setupEnvFile(
        tmpDir,
        ".env",
        `# High-entropy token assigned to public variable
NEXT_PUBLIC_CLIENT_TOKEN=9xK2mP8qL1zW5yR4tV0bN7cJ3hG6fD8s
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("NEXT_PUBLIC_CLIENT_TOKEN")
        )
      );
      assert.ok(!findings[0].actual?.includes("9xK2mP8qL1zW5yR4tV0bN7cJ3hG6fD8s"));
      assert.ok(findings[0].actual?.includes("***"));
    });

    test("flags high-entropy random secret committed in .env.example with PUBLIC_ENV_SECRET_LEAK", async () => {
      setupEnvFile(
        tmpDir,
        ".env.example",
        `# High-entropy live secret committed to example file
API_SECRET=aF93kzL90vBx2NmP4Qq1RtW8ZcE6yUiO
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("Actual live credential detected")
        )
      );
      assert.ok(!findings[0].actual?.includes("aF93kzL90vBx2NmP4Qq1RtW8ZcE6yUiO"));
    });

    test("flags live database URI with embedded password in .env and redacts the password", async () => {
      setupEnvFile(
        tmpDir,
        ".env",
        `DATABASE_URL=postgresql://dbuser:superSecretPassword123@db.prod.internal:5432/main
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("Actual live credential detected")
        )
      );
      // Redaction assertion: superSecretPassword123 must be redacted, showing :***@
      assert.ok(!findings[0].actual?.includes("superSecretPassword123"));
      assert.ok(findings[0].actual?.includes(":***@"));
    });

    test("discovers and evaluates nested environment files under stacks/**/.env*", async () => {
      const nestedDir = path.join(tmpDir, "stacks", "expo");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedDir, ".env.local"),
        `EXPO_PUBLIC_PRIVATE_SIGNING_KEY=secret_signing_key_nested\n`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.filePath === "stacks/expo/.env.local" &&
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK"
        )
      );
      assert.ok(!findings[0].actual?.includes("secret_signing_key_nested"));
    });

    test("detects PEM private key in nested stacks/react-native/.env file", async () => {
      const nestedDir = path.join(tmpDir, "stacks", "react-native");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedDir, ".env"),
        `CERTIFICATE_KEY="-----BEGIN EC PRIVATE KEY-----\nMIGkAgEBBAU...\n-----END EC PRIVATE KEY-----"\n`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.filePath === "stacks/react-native/.env" &&
            f.diagnosticCode === "PUBLIC_ENV_SECRET_LEAK" &&
            f.message.includes("private cryptographic key block")
        )
      );
      assert.ok(findings.some((f) => f.actual?.includes("[REDACTED]")));
    });

    test("passes cleanly on harmless URLs, identifiers, and configuration in public client variables", async () => {
      setupEnvFile(
        tmpDir,
        ".env",
        `# Benign variables that should not be flagged by high-entropy or keyword detection
NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://api.example.com/v1/graphql/endpoint
NEXT_PUBLIC_SUPPORT_EMAIL=mailto:support@example.org
NEXT_PUBLIC_APP_DISPLAY_TITLE="My Playbook Web Application"
NEXT_PUBLIC_DEFAULT_LOCALE=en-US
NEXT_PUBLIC_BUILD_STAGE=PROJECT_STAGE_DISCOVERY_AND_REQUIREMENTS
`
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Engine Integration & Regression Consistency
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Engine Integration & Regression Consistency", () => {
    test("runs all 4 Category E rules via LinterEngine producing clean passed status on valid project", async () => {
      setupWorkflow(
        tmpDir,
        "ci.yml",
        `name: CI
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
`
      );
      setupEnvFile(
        tmpDir,
        ".env",
        `NEXT_PUBLIC_APP_NAME=PlaybookApp
NEXT_PUBLIC_API_URL=https://api.example.com
`
      );

      const registry = new RuleRegistry();
      for (const rule of SECURITY_RULES) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 4);

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.executedRuleCount, 4);
    });

    test("production registry registers exactly 21 rules with exactly 4 Category E rules", () => {
      assert.strictEqual(ALL_PRODUCTION_RULES.length, 21);
      assert.strictEqual(SECURITY_RULES.length, 4);

      const secRulesInAll = ALL_PRODUCTION_RULES.filter((r) => r.category === "security");
      assert.strictEqual(secRulesInAll.length, 4);

      const expectedIds = [
        "RULE-SEC-WORKFLOW-PERMS",
        "RULE-SEC-ACTION-PINNING",
        "RULE-SEC-PR-TARGET-BAN",
        "RULE-SEC-PUBLIC-ENV-LEAK",
      ];
      for (const id of expectedIds) {
        assert.ok(
          secRulesInAll.some((r) => r.id === id),
          `Missing expected security rule '${id}' in production registry`
        );
      }
    });

    test("executes Category A, B, C, D, and E rules concurrently without mutual interference", async () => {
      // Setup minimal valid project structures for all categories
      const playbookDir = path.join(tmpDir, ".playbook");
      const docsDir = path.join(tmpDir, "docs");
      const prdDir = path.join(docsDir, "prd");
      const adrDir = path.join(docsDir, "adr");
      fs.mkdirSync(playbookDir, { recursive: true });
      fs.mkdirSync(prdDir, { recursive: true });
      fs.mkdirSync(adrDir, { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, "README.md"),
        "# Root README\n\n[Valid Link](README.md)\n",
        "utf-8"
      );
      fs.writeFileSync(
        path.join(prdDir, "PRD-CORE.md"),
        "# PRD Core\n\n## 1. Document Metadata\n\n## 2. Problem Statement\n\n## 3. Target Users & Personas\n\n## 4. Scope Boundaries\n\n## 5. Functional Requirements\n\n## 6. Acceptance Criteria\n",
        "utf-8"
      );
      fs.writeFileSync(
        path.join(adrDir, "ADR-20261108-001-sec.md"),
        "# ADR-20261108-001: Security Architecture\n\n## 1. ADR Metadata\n\nStatus: Accepted\n\n## 2. Context and Problem Statement\n\n## 3. Decision Drivers\n\n## 4. Considered Options / Alternatives\n\n## 5. Decision Outcome / Chosen Solution\n\n## 6. Consequences & Trade-Offs\n",
        "utf-8"
      );
      fs.writeFileSync(
        path.join(playbookDir, "manifest.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
          schema_version: "1.0.0",
          project_id: "sec-test-project",
          project_name: "Sec Test Project",
          active_milestone_id: "M-1.0.0",
          description: "Test description",
          playbook: {
            version: "1.0.0",
            governance_profile: "standard",
            approval_mode: "solo",
          },
          tech_stack: {
            ecosystem: "node",
            primary_language: "typescript",
            runtimes: ["node20"],
            frameworks: [],
            package_manager: "npm",
          },
          paths: {
            docs_root: "docs",
            prd_dir: "docs/prd",
            adr_dir: "docs/adr",
            rfc_dir: "docs/rfcs",
            gates_dir: "docs/gates",
            exceptions_dir: "docs/exceptions",
            state_file: ".playbook/state.json",
          },
          active_lifecycle_stage: 0,
          capabilities: ["automated_testing"],
          technology_stacks: [],
        }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(playbookDir, "state.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
          schema_version: "1.0.0",
          project_id: "sec-test-project",
          playbook_version: "1.0.0",
          milestone_id: "M-1.0.0",
          milestone_name: "MVP",
          lifecycle_status: "active",
          current_stage: 0,
          stage_status: "not_started",
          current_stage_detail: {
            stage: 0,
            stage_name: "Discovery & Problem Formulation",
            started_at: "2026-11-08T00:00:00.000Z",
            deliverables: [],
            rfcs: [],
            adrs: [],
            exceptions: [],
            exit_package: {
              status: "not_drafted",
              path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
              submitted_at: null,
            },
            human_approval: {
              status: "not_requested",
              approved_by: null,
              role: null,
              approval_mode: "solo",
              decision: null,
              signature_reference: null,
              approved_at: null,
              conditions: null,
            },
          },
          stage_history: [],
          archived_milestones: [],
          last_updated: {
            timestamp: "2026-11-08T00:00:00.000Z",
            updated_by: "human-operator",
            actor_type: "human",
            reason: "Init",
          },
        }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(playbookDir, "quality-gates.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
          schema_version: "1.0.0",
          project_id: "sec-test-project",
          default_profile: "standard",
          global_settings: {
            default_timeout_ms: 30000,
            max_concurrency: 2,
            mask_secrets: true,
            log_retention_runs: 10,
            max_journaled_log_bytes: 1048576,
            env_allowlist: ["PATH", "NODE_ENV"],
          },
          gates: [],
        }),
        "utf-8"
      );
      setupWorkflow(
        tmpDir,
        "ci.yml",
        `name: CI
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
`
      );

      const registry = new RuleRegistry();
      for (const rule of ALL_PRODUCTION_RULES) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 21);

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.executedRuleCount, 21);
    });

    test("strictly read-only: does not mutate workflow or env files during linting", async () => {
      const workflowPath = setupWorkflow(
        tmpDir,
        "ci.yml",
        `name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "OK"\n`
      );
      const envPath = setupEnvFile(tmpDir, ".env", "NEXT_PUBLIC_APP_TITLE=TestApp\n");

      const beforeWf = fs.readFileSync(workflowPath, "utf-8");
      const beforeEnv = fs.readFileSync(envPath, "utf-8");

      const registry = new RuleRegistry();
      for (const rule of SECURITY_RULES) {
        registry.register(rule);
      }
      const engine = new LinterEngine(registry);
      await engine.run({ projectDir: tmpDir });

      assert.strictEqual(fs.readFileSync(workflowPath, "utf-8"), beforeWf);
      assert.strictEqual(fs.readFileSync(envPath, "utf-8"), beforeEnv);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", "journal.json")), false);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", ".lock")), false);
    });

    test("evaluates real repository workflows and env files with zero Category E findings", async () => {
      const repoRoot = path.resolve(__dirname, "../../../");
      const context = new DefaultRuleExecutionContext(repoRoot);

      const fWf = (await ruleSecWorkflowPerms.evaluate(context)) as RuleFinding[];
      const fPin = (await ruleSecActionPinning.evaluate(context)) as RuleFinding[];
      const fPr = (await ruleSecPrTargetBan.evaluate(context)) as RuleFinding[];
      const fEnv = (await ruleSecPublicEnvLeak.evaluate(context)) as RuleFinding[];

      assert.strictEqual(fWf.length, 0, `Unexpected workflow perms findings: ${JSON.stringify(fWf)}`);
      assert.strictEqual(fPin.length, 0, `Unexpected action pinning findings: ${JSON.stringify(fPin)}`);
      assert.strictEqual(fPr.length, 0, `Unexpected PR target findings: ${JSON.stringify(fPr)}`);
      assert.strictEqual(fEnv.length, 0, `Unexpected public env findings: ${JSON.stringify(fEnv)}`);
    });
  });
});
