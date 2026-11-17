import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  runLint,
  resolveCategories,
  SUPPORTED_CLI_CATEGORIES,
} from "../src/commands/lint.js";
import {
  ALL_PRODUCTION_RULES,
  DOCUMENTATION_RULES,
  SCHEMA_RULES,
  INVARIANT_RULES,
  STACK_RULES,
  SECURITY_RULES,
  RuleRegistry,
} from "../src/core/linters/index.js";
import {
  getCiAdapter,
  initCiWorkflow,
  validateCiWorkflow,
  buildCiEvidenceReport,
  writeCiEvidenceReport,
  formatCiStepSummaryMarkdown,
  validateCiEvidenceReport,
} from "../src/index.js";
import { DEFAULT_GITHUB_WORKFLOW_PATH } from "../src/core/ci/types.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");

function createValidPlaybookWorkspace(dir: string): void {
  // .playbook manifest & state & gates
  const playbookDir = path.join(dir, ".playbook");
  fs.mkdirSync(playbookDir, { recursive: true });

  const manifest = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    project_name: "Test Governance Project",
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
      frameworks: ["nextjs"],
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
    technology_stacks: ["nextjs"],
  };
  fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  const state = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    playbook_version: "1.0.0",
    milestone_id: "M-1.0.0",
    milestone_name: "M-1.0.0 Initial Release",
    lifecycle_status: "active",
    current_stage: 0,
    stage_status: "not_started",
    current_stage_detail: {
      stage: 0,
      stage_name: "Discovery & Problem Formulation",
      started_at: "2026-11-07T00:00:00.000Z",
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
      timestamp: "2026-11-07T00:00:00.000Z",
      updated_by: "playbook-cli",
      actor_type: "human",
      reason: "Test state initialization",
    },
  };
  fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");

  const gatesConfig = {
    $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    default_profile: "standard",
    global_settings: {
      default_timeout_ms: 30000,
      max_concurrency: 2,
      mask_secrets: true,
      log_retention_runs: 10,
      max_journaled_log_bytes: 1048576,
      env_allowlist: ["PATH", "NODE_ENV"],
    },
    gates: [
      {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        checks: [
          {
            id: "prd-audit",
            name: "PRD Structural Audit",
            type: "static_analysis",
            deliverable_id: "PRD-CORE",
            command: "node",
            args: ["--version"],
            inputs: ["docs/prd/PRD-CORE.md"],
            severity: "blocking",
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(gatesConfig, null, 2), "utf-8");

  // docs directory with valid PRD
  const prdDir = path.join(dir, "docs/prd");
  fs.mkdirSync(prdDir, { recursive: true });
  fs.writeFileSync(
    path.join(prdDir, "PRD-CORE.md"),
    `# PRD Core: System Specifications

## 1. Document Metadata
- Author: AI Systems Architect
- Status: Approved

## 2. Problem Statement & Value Proposition
Detailed problem formulation and core purpose.

## 3. Target Users & Personas
Target users and primary scenarios.

## 4. Scope Boundaries
Explicit boundary definitions.

## 5. Functional Requirements
Requirements breakdown.

## 6. Acceptance Criteria
Measurable acceptance criteria.

## 7. Non-Functional Requirements (NFRs)
Security, latency, reliability invariants.

## 8. Edge Cases, Negative Flows & Failure States
Failure states and error recovery.

## 9. Requirements vs. Assumptions Verification
Verification against baseline assumptions.

## 10. Open Questions & Clarification RFCs
None.

## 11. Approval and Sign-Off
Formal sign-off section. Reference [manifest](../../.playbook/manifest.json).
`
  );

  // GitHub workflow
  const wfDir = path.join(dir, ".github/workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(
    path.join(wfDir, "ci.yml"),
    `name: CI
on:
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
}

describe("Task 008B.7: Governance Linter CLI & CI Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-lint-cli-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. CLI Execution & Parameter Contracts
  // ─────────────────────────────────────────────────────────────────────────────
  describe("1. CLI Command Execution & Category Filtering", () => {
    test("default execution evaluates all 21 production rules through RuleRegistry", async () => {
      createValidPlaybookWorkspace(tmpDir);

      const res = await runLint({ cwd: tmpDir, silent: true });
      assert.ok(res.report);
      assert.equal(res.report.summary.rules_total, 21);
      assert.equal(res.report.summary.rules_evaluated, 21);
      assert.equal(res.report.categories.length, 5);
      assert.deepEqual(res.report.categories.sort(), [
        "documentation",
        "invariant",
        "schema",
        "security",
        "stack",
      ]);
    });

    test("filters rules accurately for each supported category selector", async () => {
      createValidPlaybookWorkspace(tmpDir);

      // Documentation (Category A: 5 rules)
      const resDoc = await runLint({ cwd: tmpDir, category: "documentation", silent: true });
      assert.equal(resDoc.report?.summary.rules_evaluated, DOCUMENTATION_RULES.length);
      assert.equal(resDoc.report?.summary.rules_evaluated, 5);

      // Schema (Category B: 4 rules)
      const resSchema = await runLint({ cwd: tmpDir, category: "schema", silent: true });
      assert.equal(resSchema.report?.summary.rules_evaluated, SCHEMA_RULES.length);
      assert.equal(resSchema.report?.summary.rules_evaluated, 4);

      // Governance / Invariant (Category C: 5 rules)
      const resGov = await runLint({ cwd: tmpDir, category: "governance", silent: true });
      assert.equal(resGov.report?.summary.rules_evaluated, INVARIANT_RULES.length);
      assert.equal(resGov.report?.summary.rules_evaluated, 5);

      // Stack (Category D: 3 rules)
      const resStack = await runLint({ cwd: tmpDir, category: "stack", silent: true });
      assert.equal(resStack.report?.summary.rules_evaluated, STACK_RULES.length);
      assert.equal(resStack.report?.summary.rules_evaluated, 3);

      // Security (Category E: 4 rules)
      const resSec = await runLint({ cwd: tmpDir, category: "security", silent: true });
      assert.equal(resSec.report?.summary.rules_evaluated, SECURITY_RULES.length);
      assert.equal(resSec.report?.summary.rules_evaluated, 4);
    });

    test("supports documented category aliases (docs, invariant, sec)", () => {
      assert.deepEqual(resolveCategories("docs"), ["documentation"]);
      assert.deepEqual(resolveCategories("invariant"), ["invariant"]);
      assert.deepEqual(resolveCategories("sec"), ["security"]);
      assert.deepEqual(resolveCategories("all"), undefined);
    });

    test("rejects unknown category with exit code 2 and structured error message", async () => {
      createValidPlaybookWorkspace(tmpDir);

      const res = await runLint({ cwd: tmpDir, category: "unknown_category", silent: true });
      assert.equal(res.success, false);
      assert.equal(res.exitCode, 2);
      assert.match(res.output, /Unknown category "unknown_category"/);
      assert.ok(SUPPORTED_CLI_CATEGORIES.every((c) => res.output.includes(c)));
    });

    test("filters rules by specific rule ID", async () => {
      createValidPlaybookWorkspace(tmpDir);

      const res = await runLint({
        cwd: tmpDir,
        rule: "RULE-SEC-WORKFLOW-PERMS",
        silent: true,
      });
      assert.equal(res.report?.summary.rules_evaluated, 1);
      assert.equal(res.report?.findings.every((f) => f.rule_id === "RULE-SEC-WORKFLOW-PERMS"), true);
    });

    test("rejects non-existent project directory with exit code 2", async () => {
      const nonExistent = path.join(tmpDir, "does-not-exist");
      const res = await runLint({ cwd: nonExistent, silent: true });
      assert.equal(res.success, false);
      assert.equal(res.exitCode, 2);
      assert.match(res.output, /Target directory does not exist/);
    });

    test("rejects invalid format argument with exit code 2", async () => {
      createValidPlaybookWorkspace(tmpDir);
      const res = await runLint({ cwd: tmpDir, format: "invalid_format", silent: true });
      assert.equal(res.success, false);
      assert.equal(res.exitCode, 2);
      assert.match(res.output, /Invalid format "invalid_format"/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Output Formats & Determinism
  // ─────────────────────────────────────────────────────────────────────────────
  describe("2. Output Formats, JSON Schema Contract, and Determinism", () => {
    test("produces canonical machine-readable JSON output matching contract", async () => {
      createValidPlaybookWorkspace(tmpDir);

      const res = await runLint({ cwd: tmpDir, format: "json", silent: true });
      const parsed = JSON.parse(res.output);

      assert.equal(parsed.schema_version, "1.0");
      assert.equal(typeof parsed.status, "string");
      assert.equal(parsed.complete, true);
      assert.equal(typeof parsed.summary.rules_total, "number");
      assert.equal(typeof parsed.summary.rules_evaluated, "number");
      assert.equal(typeof parsed.summary.rules_passed, "number");
      assert.equal(typeof parsed.summary.rules_failed, "number");
      assert.equal(typeof parsed.summary.findings_total, "number");
      assert.equal(typeof parsed.summary.blocking_findings, "number");
      assert.ok(Array.isArray(parsed.categories));
      assert.ok(Array.isArray(parsed.findings));
      assert.ok(Array.isArray(parsed.execution_failures));
      assert.equal(typeof parsed.execution.started_at, "string");
      assert.equal(typeof parsed.execution.completed_at, "string");
      assert.equal(typeof parsed.execution.duration_ms, "number");
    });

    test("produces human-readable terminal report with summary, categories, and locations", async () => {
      createValidPlaybookWorkspace(tmpDir);
      // Introduce an unpinned action
      fs.writeFileSync(
        path.join(tmpDir, ".github/workflows/ci.yml"),
        `name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`
      );

      const res = await runLint({ cwd: tmpDir, format: "terminal", silent: true });
      assert.match(res.output, /AI ENGINEERING PLAYBOOK — GOVERNANCE LINTER/);
      assert.match(res.output, /Rules Registered:\s+21/);
      assert.match(res.output, /Category E: Security & Workflow Governance/);
      assert.match(res.output, /RULE-SEC-ACTION-PINNING/);
      assert.match(res.output, /UNPINNED_THIRD_PARTY_ACTION/);
      assert.match(res.output, /\.github\/workflows\/ci\.yml/);
      assert.match(res.output, /Verdict:\s+FAILED/);
    });

    test("sorts findings deterministically and guarantees reproducible results across repeated runs", async () => {
      createValidPlaybookWorkspace(tmpDir);
      // Introduce multiple violations across categories
      fs.writeFileSync(
        path.join(tmpDir, ".github/workflows/ci.yml"),
        `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`
      );
      fs.writeFileSync(
        path.join(tmpDir, ".env"),
        `API_SECRET=super_secret_plaintext_key_12345\n`
      );

      const res1 = await runLint({ cwd: tmpDir, format: "json", silent: true });
      const res2 = await runLint({ cwd: tmpDir, format: "json", silent: true });

      const parsed1 = JSON.parse(res1.output);
      const parsed2 = JSON.parse(res2.output);

      assert.equal(parsed1.findings.length, parsed2.findings.length);
      for (let i = 0; i < parsed1.findings.length; i++) {
        assert.equal(parsed1.findings[i].rule_id, parsed2.findings[i].rule_id);
        assert.equal(parsed1.findings[i].diagnostic_code, parsed2.findings[i].diagnostic_code);
        assert.equal(parsed1.findings[i].file_path, parsed2.findings[i].file_path);
        assert.equal(parsed1.findings[i].line, parsed2.findings[i].line);
      }
    });

    test("redacts secret values from both JSON and terminal outputs", async () => {
      createValidPlaybookWorkspace(tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, ".env"),
        `DATABASE_PASSWORD=live_plaintext_super_secret_val\n`
      );

      const resJson = await runLint({ cwd: tmpDir, format: "json", silent: true });
      assert.ok(!resJson.output.includes("live_plaintext_super_secret_val"));
      assert.match(resJson.output, /\*\*\*/);

      const resTerm = await runLint({ cwd: tmpDir, format: "terminal", silent: true });
      assert.ok(!resTerm.output.includes("live_plaintext_super_secret_val"));
      assert.match(resTerm.output, /\*\*\*/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Strict Mode & Exit Code Semantics
  // ─────────────────────────────────────────────────────────────────────────────
  describe("3. Strict Mode & Exit Code Contracts", () => {
    test("returns exit code 0 when zero blocking findings exist", async () => {
      createValidPlaybookWorkspace(tmpDir);
      // Run category security which has 0 findings on this valid repo
      const res = await runLint({ cwd: tmpDir, category: "security", silent: true });
      assert.equal(res.exitCode, 0);
      assert.equal(res.success, true);
      assert.equal(res.status, "passed");
    });

    test("returns exit code 1 when blocking findings are detected", async () => {
      createValidPlaybookWorkspace(tmpDir);
      // Create unpinned action violation
      fs.writeFileSync(
        path.join(tmpDir, ".github/workflows/ci.yml"),
        `name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`
      );

      const res = await runLint({ cwd: tmpDir, category: "security", silent: true });
      assert.equal(res.exitCode, 1);
      assert.equal(res.success, false);
      assert.equal(res.status, "failed");
    });

    test("--strict promotes non-blocking warnings to blocking violations with exit code 1", async () => {
      createValidPlaybookWorkspace(tmpDir);
      // Create an ADR missing mandatory sections (normally warning-level)
      const adrDir = path.join(tmpDir, "docs/adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(
        path.join(adrDir, "ADR-20261109-001-test.md"),
        `# ADR-20261109-001: Incomplete ADR\n\n## 1. ADR Metadata\n| Field | Value |\n|---|---|\n| Title | Test |\n`
      );

      // Normal execution: warning is non-blocking (status passed, exitCode 0)
      const resNormal = await runLint({
        cwd: tmpDir,
        rule: "RULE-DOC-MANDATORY-SECTIONS",
        strict: false,
        silent: true,
      });
      assert.equal(resNormal.exitCode, 0);
      assert.equal(resNormal.status, "passed");
      assert.equal(resNormal.report?.summary.warning_findings! > 0, true);
      assert.equal(resNormal.report?.summary.blocking_findings, 0);

      // Strict mode execution: warning elevated to blocking (status failed, exitCode 1)
      const resStrict = await runLint({
        cwd: tmpDir,
        rule: "RULE-DOC-MANDATORY-SECTIONS",
        strict: true,
        silent: true,
      });
      assert.equal(resStrict.exitCode, 1);
      assert.equal(resStrict.status, "failed");
      assert.equal(resStrict.report?.summary.blocking_findings! > 0, true);
    });

    test("--strict preserves rule definitions and does not mutate project state or manifest", async () => {
      createValidPlaybookWorkspace(tmpDir);
      const manifestPath = path.join(tmpDir, ".playbook/manifest.json");
      const statePath = path.join(tmpDir, ".playbook/state.json");
      const initialManifest = fs.readFileSync(manifestPath, "utf-8");
      const initialState = fs.readFileSync(statePath, "utf-8");

      await runLint({ cwd: tmpDir, strict: true, silent: true });

      assert.equal(fs.readFileSync(manifestPath, "utf-8"), initialManifest);
      assert.equal(fs.readFileSync(statePath, "utf-8"), initialState);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. CI Workflow Integration & Reporting
  // ─────────────────────────────────────────────────────────────────────────────
  describe("4. Remote CI Workflow Integration & Evidence Telemetry", () => {
    test("canonical generated workflow includes distinct governance lint step", () => {
      const adapter = getCiAdapter("github");
      const workflow = adapter.generateWorkflow({ provider: "github" });

      assert.match(
        workflow,
        /playbook lint --strict --format json > lint-raw-report\.json/,
        "Canonical workflow must include distinct governance lint execution step"
      );
      assert.match(
        workflow,
        /lint-raw-report\.json/,
        "Canonical workflow must include lint report in uploaded evidence artifacts"
      );
    });

    test("validateCiWorkflow verifies required presence of playbook lint step", () => {
      const adapter = getCiAdapter("github");
      const validWorkflow = adapter.generateWorkflow({ provider: "github" });
      const validRes = validateCiWorkflow(tmpDir, { provider: "github", content: validWorkflow });
      assert.equal(validRes.valid, true);

      // Removing the lint step causes validation to fail
      const missingLint = validWorkflow.replace(/playbook lint --strict.*lint-raw-report\.json/, "# lint removed");
      const invalidRes = validateCiWorkflow(tmpDir, { provider: "github", content: missingLint });
      assert.equal(invalidRes.valid, false);
      assert.ok(invalidRes.errors.some((e) => e.includes("missing required step 'playbook lint'")));
    });

    test("CI evidence report incorporates lint report telemetry and artifact hash", () => {
      createValidPlaybookWorkspace(tmpDir);

      // Write a simulated raw lint report
      const lintReport = {
        schema_version: "1.0",
        status: "passed",
        complete: true,
        summary: {
          rules_total: 21,
          rules_evaluated: 21,
          rules_passed: 21,
          rules_failed: 0,
          findings_total: 0,
          blocking_findings: 0,
          warning_findings: 0,
          advisory_findings: 0,
        },
      };
      fs.writeFileSync(path.join(tmpDir, "lint-raw-report.json"), JSON.stringify(lintReport, null, 2));

      // Build evidence report
      const evidence = buildCiEvidenceReport(tmpDir, {
        cwd: tmpDir,
        jobStatus: "success",
        gateExecutionCompleted: true,
      });

      assert.ok(evidence.governance_linting);
      assert.equal(evidence.governance_linting.status, "passed");
      assert.equal(evidence.governance_linting.completed, true);
      assert.equal(evidence.governance_linting.rules_evaluated, 21);
      assert.equal(evidence.governance_linting.blocking_findings, 0);
      assert.ok(evidence.governance_linting.report_sha256?.startsWith("sha256:"));

      // Verify artifact entry
      const lintArtifact = evidence.artifacts.find((a) => a.path === "lint-raw-report.json");
      assert.ok(lintArtifact);
      assert.equal(lintArtifact.sha256, evidence.governance_linting.report_sha256);
    });

    test("failed or incomplete governance linting prevents CI pass (false pass prevention)", () => {
      createValidPlaybookWorkspace(tmpDir);

      // Write a failed lint report with 2 blocking violations
      const failedLint = {
        schema_version: "1.0",
        status: "failed",
        complete: true,
        summary: {
          rules_total: 21,
          rules_evaluated: 21,
          rules_passed: 19,
          rules_failed: 2,
          findings_total: 2,
          blocking_findings: 2,
          warning_findings: 0,
          advisory_findings: 0,
        },
      };
      fs.writeFileSync(path.join(tmpDir, "lint-raw-report.json"), JSON.stringify(failedLint, null, 2));

      const evidence = buildCiEvidenceReport(tmpDir, {
        cwd: tmpDir,
        jobStatus: "success",
        gateExecutionCompleted: true,
      });

      assert.equal(evidence.governance_evaluation.overall_outcome, "failed");
      assert.equal(evidence.governance_linting?.status, "failed");
      assert.equal(evidence.governance_linting?.blocking_findings, 2);

      // Validation strictly rejects overall_outcome passed when linting has blocking findings
      const falsePassEvidence = {
        ...evidence,
        governance_evaluation: {
          ...evidence.governance_evaluation,
          overall_outcome: "passed" as const,
        },
      };
      const validation = validateCiEvidenceReport(falsePassEvidence);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.includes("governance_linting failed")));
    });

    test("renders governance linting status and artifact hash in GitHub Step Summary markdown", () => {
      createValidPlaybookWorkspace(tmpDir);

      const lintReport = {
        schema_version: "1.0",
        status: "passed",
        complete: true,
        summary: {
          rules_total: 21,
          rules_evaluated: 21,
          rules_passed: 21,
          rules_failed: 0,
          findings_total: 0,
          blocking_findings: 0,
          warning_findings: 0,
          advisory_findings: 0,
        },
      };
      fs.writeFileSync(path.join(tmpDir, "lint-raw-report.json"), JSON.stringify(lintReport, null, 2));

      const evidence = buildCiEvidenceReport(tmpDir, {
        cwd: tmpDir,
        jobStatus: "success",
        gateExecutionCompleted: true,
      });

      const markdown = formatCiStepSummaryMarkdown(evidence);
      assert.match(markdown, /Governance Static Analysis & Policy Linting/);
      assert.match(markdown, /:white_check_mark: PASSED/);
      assert.match(markdown, /Rules Evaluated/);
      assert.match(markdown, /Lint Report Artifact SHA-256/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. CLI Process Invocation via playbook binary
  // ─────────────────────────────────────────────────────────────────────────────
  describe("5. CLI Binary Invocation (playbook lint)", () => {
    test("executes 'playbook lint --format json' via child process", async () => {
      createValidPlaybookWorkspace(tmpDir);

      const { stdout } = await execFileAsync("node", [
        cliBinPath,
        "lint",
        "--cwd",
        tmpDir,
        "--category",
        "security",
        "--format",
        "json",
      ]);

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.schema_version, "1.0");
      assert.equal(parsed.status, "passed");
      assert.equal(parsed.summary.rules_evaluated, 4);
    });

    test("CLI returns exit code 2 on unknown category", async () => {
      createValidPlaybookWorkspace(tmpDir);

      try {
        await execFileAsync("node", [
          cliBinPath,
          "lint",
          "--cwd",
          tmpDir,
          "--category",
          "invalid_category",
        ]);
        assert.fail("Expected child process to exit with non-zero code");
      } catch (err: any) {
        assert.equal(err.code, 2);
        assert.match(err.stderr || err.stdout, /Unknown category "invalid_category"/);
      }
    });

    test("CLI returns exit code 1 when blocking findings exist", async () => {
      createValidPlaybookWorkspace(tmpDir);
      // Introduce unpinned action in workflow
      fs.writeFileSync(
        path.join(tmpDir, ".github/workflows/ci.yml"),
        `name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`
      );

      try {
        await execFileAsync("node", [
          cliBinPath,
          "lint",
          "--cwd",
          tmpDir,
          "--category",
          "security",
        ]);
        assert.fail("Expected child process to exit with code 1");
      } catch (err: any) {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /UNPINNED_THIRD_PARTY_ACTION/);
      }
    });

    test("strictly read-only: does not modify state.json, manifest.json, or create WAL lock/journal files", async () => {
      createValidPlaybookWorkspace(tmpDir);
      const lockFile = path.join(tmpDir, ".playbook/.lock");
      const journalFile = path.join(tmpDir, ".playbook/journal.json");

      await execFileAsync("node", [cliBinPath, "lint", "--cwd", tmpDir]);

      assert.equal(fs.existsSync(lockFile), false, "Linter must never create WAL .lock");
      assert.equal(fs.existsSync(journalFile), false, "Linter must never create journal.json");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Production Rule Set Parity & Regression Invariants
  // ─────────────────────────────────────────────────────────────────────────────
  describe("6. Production Rule Set Parity & Regression Invariants", () => {
    test("production registry contains exactly 21 rules across Categories A-E", () => {
      assert.equal(ALL_PRODUCTION_RULES.length, 21);

      const registry = new RuleRegistry();
      for (const rule of ALL_PRODUCTION_RULES) {
        registry.register(rule);
      }

      assert.equal(registry.list().length, 21);
      assert.equal(registry.filter((r) => r.category === "documentation").length, 5);
      assert.equal(registry.filter((r) => r.category === "schema").length, 4);
      assert.equal(registry.filter((r) => r.category === "invariant").length, 5);
      assert.equal(registry.filter((r) => r.category === "stack").length, 3);
      assert.equal(registry.filter((r) => r.category === "security").length, 4);
    });

    test("every rule ID in ALL_PRODUCTION_RULES is unique", () => {
      const ids = ALL_PRODUCTION_RULES.map((r) => r.id);
      const uniqueIds = new Set(ids);
      assert.equal(ids.length, uniqueIds.size);
    });
  });
});
