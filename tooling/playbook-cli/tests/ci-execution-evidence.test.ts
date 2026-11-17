import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  getCiAdapter,
  initCiWorkflow,
  validateCiWorkflow,
  buildCiEvidenceReport,
  validateCiEvidenceReport,
  writeCiEvidenceReport,
  formatCiStepSummaryMarkdown,
  runCiReport,
} from "../src/index.js";
import {
  CI_REQUIRED_CHECK_NAME,
  DEFAULT_GITHUB_WORKFLOW_PATH,
} from "../src/core/ci/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");

describe("GitHub Actions Execution & Evidence Verification (Task 006C.3.2)", () => {
  let tempDir: string;
  let summaryFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ci-exec-"));
    summaryFile = path.join(tempDir, "github_step_summary.md");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    // Initialize temporary git repo
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: tempDir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: "ignore" });

    // Initial commit to establish HEAD and tree
    fs.writeFileSync(path.join(tempDir, "README.md"), "# Test Project\n", "utf-8");
    execSync("git add README.md", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });
  });

  afterEach(() => {
    delete process.env.GITHUB_STEP_SUMMARY;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("1. Workflow YAML Structural Validity", () => {
    test("verifies that generated canonical workflow parses as 100% valid YAML AST", () => {
      const adapter = getCiAdapter("github");
      const workflowContent = adapter.generateWorkflow({ provider: "github" });

      const parsed = YAML.parse(workflowContent);
      assert.ok(parsed, "Expected parsed YAML document to be defined");
      assert.equal(typeof parsed, "object");
      assert.equal(parsed.name, "Playbook Quality Gates & Verification");
      assert.ok(parsed.on, "Expected 'on' triggers to be defined");
      assert.ok(parsed.on.pull_request, "Expected pull_request trigger");
      assert.ok(parsed.on.push, "Expected push trigger");
      assert.equal(parsed.permissions.contents, "read");
      assert.ok(parsed.jobs["quality-gates"], "Expected quality-gates job");
      assert.equal(parsed.jobs["quality-gates"].name, CI_REQUIRED_CHECK_NAME);
    });

    test("validates that all steps have valid names and pinned actions or safe commands", () => {
      const adapter = getCiAdapter("github");
      const workflowContent = adapter.generateWorkflow({ provider: "github" });
      const parsed = YAML.parse(workflowContent);
      const steps = parsed.jobs["quality-gates"].steps;

      assert.ok(Array.isArray(steps));
      assert.ok(steps.length >= 7, `Expected at least 7 steps, found ${steps.length}`);

      for (const step of steps) {
        assert.ok(step.name, "Every workflow step must have an explicit name");
        if (step.uses) {
          assert.match(
            step.uses,
            /@[a-f0-9]{40}/,
            `Third-party action '${step.uses}' must be pinned to a 40-character commit SHA`
          );
        }
      }
    });
  });

  describe("2. Security Invariants & Injection Defenses", () => {
    test("asserts workflow never interpolates untrusted github.event context into shell strings", () => {
      const adapter = getCiAdapter("github");
      const workflowContent = adapter.generateWorkflow({ provider: "github" });
      const parsed = YAML.parse(workflowContent);
      const steps = parsed.jobs["quality-gates"].steps;

      for (const step of steps) {
        if (step.run) {
          assert.doesNotMatch(
            step.run,
            /\$\{\{\s*github\.event/,
            `Step '${step.name}' directly interpolates untrusted github.event into shell run command`
          );
        }
      }
    });

    test("validation engine rejects workflows with inline shell interpolation of PR context", () => {
      const adapter = getCiAdapter("github");
      const maliciousWorkflow = adapter
        .generateWorkflow({ provider: "github" })
        .replace(
          "run: npx @ai-engineering-playbook/cli validate",
          'run: echo "Evaluating PR: ${{ github.event.pull_request.title }}" && npx @ai-engineering-playbook/cli validate'
        );

      const result = validateCiWorkflow(tempDir, { provider: "github", content: maliciousWorkflow });
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("directly interpolates untrusted PR/event context")),
        "Expected validation rejection for shell interpolation of PR event context"
      );
    });
  });

  describe("3. CI Evidence Context Binding & Schema Conformance", () => {
    test("binds execution context, Git commit SHA, and tree SHA deterministically", () => {
      const headCommit = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
      const headTree = execSync("git log -1 --format=%T HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      const rawReportPath = path.join(tempDir, "gate-raw-report.json");
      fs.writeFileSync(
        rawReportPath,
        JSON.stringify({
          stage: 1,
          stage_name: "Requirements & Specification",
          profile: "standard",
          working_tree_clean: true,
          overall_outcome: "passed",
          summary: { total: 1, passed: 1, failed: 0, warning: 0, skipped: 0 },
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        repository: "acme/ai-app",
        workflow: "Playbook Quality Gates & Verification",
        runId: "987654321",
        runAttempt: 2,
        eventName: "pull_request",
        prNumber: 101,
        prHeadSha: headCommit,
        prBaseRef: "main",
        jobStatus: "success",
        rawReportPath,
      });

      assert.equal(report.$schema, "https://ai-engineering-playbook.org/schemas/ci-run-evidence.schema.json");
      assert.equal(report.schema_version, "1.0.0");
      assert.equal(report.run_identity.repository, "acme/ai-app");
      assert.equal(report.run_identity.run_id, "987654321");
      assert.equal(report.run_identity.run_attempt, 2);
      assert.equal(report.run_identity.pull_request_number, 101);
      assert.equal(report.run_identity.head_commit_sha, headCommit);
      assert.equal(report.run_identity.head_tree_sha, headTree);
      assert.equal(report.governance_evaluation.overall_outcome, "passed");
      assert.equal(report.artifacts[0].name, "playbook-ci-evidence-987654321-2");
    });

    test("computes SHA-256 hash of written report artifact", () => {
      const outputPath = path.join(tempDir, "gate-report.json");
      const { report } = writeCiEvidenceReport(tempDir, {
        outputPath,
        runId: "12345",
        runAttempt: 1,
        jobStatus: "success",
      });

      assert.ok(fs.existsSync(outputPath));
      const fileBytes = fs.readFileSync(outputPath);
      const computedSha = `sha256:${crypto.createHash("sha256").update(fileBytes).digest("hex")}`;
      assert.equal(report.artifacts[0].sha256, computedSha);
    });
  });

  describe("4. Comprehensive Outcome Distinction (PASS, FAIL, INCOMPLETE, CANCELLED, SKIPPED)", () => {
    test("reports PASS when quality checks pass and exit code is 0", () => {
      // Create a passing raw report
      const rawReportPath = path.join(tempDir, "gate-raw-report.json");
      fs.writeFileSync(
        rawReportPath,
        JSON.stringify({
          stage: 1,
          stage_name: "Requirements & Specification",
          profile: "standard",
          working_tree_clean: true,
          overall_outcome: "passed",
          summary: { total: 2, passed: 2, failed: 0, warning: 0, skipped: 0 },
          checks: [
            {
              check_id: "chk-lint",
              name: "Code Linter",
              severity: "blocking",
              exit_code: 0,
              outcome: "passed",
              rif: "sha256:abc123456789",
            },
          ],
        }),
        "utf-8"
      );

      const res = runCiReport({
        cwd: tempDir,
        raw: rawReportPath,
        output: path.join(tempDir, "gate-report.json"),
      });

      assert.equal(res.success, true);
      assert.equal(res.exitCode, 0);
      assert.equal((res.data as any).governance_evaluation.overall_outcome, "passed");
    });

    test("reports FAIL when any quality check fails and returns exit code 1", () => {
      const rawReportPath = path.join(tempDir, "gate-raw-report.json");
      fs.writeFileSync(
        rawReportPath,
        JSON.stringify({
          stage: 1,
          stage_name: "Requirements & Specification",
          profile: "standard",
          working_tree_clean: true,
          overall_outcome: "failed",
          summary: { total: 2, passed: 1, failed: 1, warning: 0, skipped: 0 },
          checks: [
            {
              check_id: "chk-tests",
              name: "Unit Tests",
              severity: "blocking",
              exit_code: 1,
              outcome: "failed",
              rif: "sha256:def987654321",
            },
          ],
        }),
        "utf-8"
      );

      const res = runCiReport({
        cwd: tempDir,
        raw: rawReportPath,
        output: path.join(tempDir, "gate-report.json"),
      });

      assert.equal(res.success, false);
      assert.equal(res.exitCode, 1);
      assert.equal((res.data as any).governance_evaluation.overall_outcome, "failed");
    });

    test("reports INCOMPLETE when raw report is missing and job failed early", () => {
      const res = runCiReport({
        cwd: tempDir,
        raw: "nonexistent-report.json",
        jobStatus: "failure",
        output: path.join(tempDir, "gate-report.json"),
      });

      assert.equal(res.success, false);
      assert.equal(res.exitCode, 1);
      assert.equal((res.data as any).governance_evaluation.overall_outcome, "incomplete");
    });

    test("reports CANCELLED when jobStatus is 'cancelled'", () => {
      const res = runCiReport({
        cwd: tempDir,
        jobStatus: "cancelled",
        output: path.join(tempDir, "gate-report.json"),
      });

      assert.equal(res.success, false);
      assert.equal(res.exitCode, 1);
      assert.equal((res.data as any).governance_evaluation.overall_outcome, "cancelled");
    });

    test("reports SKIPPED when jobStatus is 'skipped'", () => {
      const res = runCiReport({
        cwd: tempDir,
        jobStatus: "skipped",
        output: path.join(tempDir, "gate-report.json"),
      });

      assert.equal(res.success, false);
      assert.equal(res.exitCode, 1);
      assert.equal((res.data as any).governance_evaluation.overall_outcome, "skipped");
    });
  });

  describe("5. Markdown Step Summary Formatting", () => {
    test("writes step summary to $GITHUB_STEP_SUMMARY when configured", () => {
      const rawReportPath = path.join(tempDir, "gate-raw-report.json");
      fs.writeFileSync(
        rawReportPath,
        JSON.stringify({
          stage: 1,
          stage_name: "Requirements & Specification",
          profile: "standard",
          working_tree_clean: true,
          overall_outcome: "passed",
          summary: { total: 1, passed: 1, failed: 0, warning: 0, skipped: 0 },
        }),
        "utf-8"
      );

      const { summaryWritten } = writeCiEvidenceReport(tempDir, {
        writeSummary: true,
        runId: "555",
        jobStatus: "success",
        rawReportPath,
      });

      assert.equal(summaryWritten, true);
      assert.ok(fs.existsSync(summaryFile));
      const summaryContent = fs.readFileSync(summaryFile, "utf-8");
      assert.ok(summaryContent.includes("AI Engineering Playbook Quality Gates & Verification"));
      assert.ok(summaryContent.includes(":white_check_mark: **PASSED**"));
    });

    test("formats appropriate caution banner for cancelled and failed runs", () => {
      const cancelledReport = buildCiEvidenceReport(tempDir, { jobStatus: "cancelled" });
      const cancelledMarkdown = formatCiStepSummaryMarkdown(cancelledReport);
      assert.ok(cancelledMarkdown.includes(":no_entry_sign: **CANCELLED**"));

      const failedReport = buildCiEvidenceReport(tempDir, { jobStatus: "failure" });
      const failedMarkdown = formatCiStepSummaryMarkdown(failedReport);
      assert.ok(failedMarkdown.includes(":warning: **INCOMPLETE**") || failedMarkdown.includes(":x: **FAILED**"));
    });
  });

  describe("6. End-to-End CLI Invocation via playbook ci report", () => {
    test("executes 'playbook ci report' via subprocess with --json output", () => {
      const rawReportPath = path.join(tempDir, "gate-raw-report.json");
      fs.writeFileSync(
        rawReportPath,
        JSON.stringify({
          stage: 1,
          stage_name: "Requirements & Specification",
          profile: "standard",
          working_tree_clean: true,
          overall_outcome: "passed",
          summary: { total: 1, passed: 1, failed: 0, warning: 0, skipped: 0 },
        }),
        "utf-8"
      );

      const output = execSync(
        `node "${cliBinPath}" ci report --cwd "${tempDir}" --raw "${rawReportPath}" --output "${path.join(tempDir, "gate-report.json")}" --json`,
        { encoding: "utf-8" }
      );

      const parsed = JSON.parse(output);
      assert.equal(parsed.$schema, "https://ai-engineering-playbook.org/schemas/ci-run-evidence.schema.json");
      assert.ok(parsed.run_identity);
      assert.ok(parsed.governance_evaluation);
      assert.equal(parsed.governance_evaluation.overall_outcome, "passed");
    });
  });

  describe("7. Governance Lint Evidence Failure-Case Hardening (Task 008B.7.1)", () => {
    function createPassingGateRawReport(filePath: string) {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          stage: 1,
          stage_name: "Requirements & Specification",
          profile: "standard",
          working_tree_clean: true,
          overall_outcome: "passed",
          summary: { total: 1, passed: 1, failed: 0, warning: 0, skipped: 0 },
          checks: [
            {
              check_id: "chk-lint",
              name: "Code Linter",
              severity: "blocking",
              exit_code: 0,
              outcome: "passed",
              rif: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            },
          ],
        }),
        "utf-8"
      );
    }

    test("Case 1: Valid successful lint JSON allows overall PASS and passes validation", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
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
          categories: ["documentation", "schema", "invariant", "stack", "security"],
          findings: [],
          execution_failures: [],
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "passed");
      assert.equal(report.governance_linting.completed, true);
      assert.equal(report.governance_linting.blocking_findings, 0);
      assert.equal(report.governance_evaluation.overall_outcome, "passed");

      const val = validateCiEvidenceReport(report, { requireGovernanceLinting: true });
      assert.equal(val.valid, true);
      assert.equal(val.errors.length, 0);
    });

    test("Case 2: Valid JSON containing blocking findings forces overall outcome to FAILED", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
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
          categories: ["documentation", "schema", "invariant", "stack", "security"],
          findings: [
            {
              rule_id: "RULE-SEC-WORKFLOW-PERMS",
              diagnostic_code: "PERM_WRITE_ALL",
              category: "security",
              severity: "error",
              enforcement: "blocking",
              message: "Workflow uses write-all.",
              file_path: ".github/workflows/bad.yml",
              line: 1,
              column: 1,
              blocks_operation: true,
            },
          ],
          execution_failures: [],
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "failed");
      assert.equal(report.governance_linting.blocking_findings, 2);
      assert.equal(report.governance_evaluation.overall_outcome, "failed");

      // Verify fail-closed in validator if someone attempts to tamper overall_outcome to passed
      report.governance_evaluation.overall_outcome = "passed";
      const val = validateCiEvidenceReport(report);
      assert.equal(val.valid, false);
      assert.ok(val.errors.some((e) => e.includes("FALSE_PASS_DETECTED") && e.includes("governance_linting failed")));
    });

    test("Case 3: Nonzero lint execution with valid report is recorded as failed", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
          schema_version: "1.0",
          status: "failed",
          complete: true,
          summary: {
            rules_total: 21,
            rules_evaluated: 21,
            rules_passed: 20,
            rules_failed: 1,
            findings_total: 1,
            blocking_findings: 1,
            warning_findings: 0,
            advisory_findings: 0,
          },
          findings: [],
          execution_failures: [],
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "failure", // Simulates nonzero step exit
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "failed");
      assert.equal(report.governance_linting.blocking_findings, 1);
      assert.notEqual(report.governance_evaluation.overall_outcome, "passed");
    });

    test("Case 4: Missing lint report cannot report successful governance linting", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      createPassingGateRawReport(gateRaw);

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: path.join(tempDir, "nonexistent-lint-report.json"),
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "incomplete");
      assert.equal(report.governance_linting.completed, false);
      assert.notEqual(report.governance_evaluation.overall_outcome, "passed");

      // Validator rejects if governance linting was required
      const reportWithoutLint: any = { ...report, governance_linting: undefined };
      const val = validateCiEvidenceReport(reportWithoutLint, { requireGovernanceLinting: true });
      assert.equal(val.valid, false);
      assert.ok(val.errors.some((e) => e.includes("Missing required 'governance_linting' summary")));
    });

    test("Case 5: Malformed JSON fails closed and prevents overall PASS", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(lintRaw, "{ corrupt json content: invalid syntax", "utf-8");

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "incomplete");
      assert.equal(report.governance_linting.completed, false);
      assert.notEqual(report.governance_evaluation.overall_outcome, "passed");
      assert.ok(report.diagnostics.some((d) => d.includes("malformed JSON")));
    });

    test("Case 6: Incorrect schema version fails closed", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
          schema_version: "2.0", // Invalid schema version
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
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "incomplete");
      assert.equal(report.governance_linting.completed, false);
      assert.notEqual(report.governance_evaluation.overall_outcome, "passed");
      assert.ok(report.diagnostics.some((d) => d.includes("Invalid lint report schema_version")));
    });

    test("Case 7: complete: false cannot report successful governance linting", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
          schema_version: "1.0",
          status: "incomplete",
          complete: false,
          summary: {
            rules_total: 21,
            rules_evaluated: 10,
            rules_passed: 10,
            rules_failed: 0,
            findings_total: 0,
            blocking_findings: 0,
            warning_findings: 0,
            advisory_findings: 0,
          },
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.completed, false);
      assert.equal(report.governance_linting.status, "incomplete");
      assert.equal(report.governance_evaluation.overall_outcome, "incomplete");

      // Verify false pass detection
      report.governance_evaluation.overall_outcome = "passed";
      const val = validateCiEvidenceReport(report);
      assert.equal(val.valid, false);
      assert.ok(val.errors.some((e) => e.includes("governance_linting did not complete")));
    });

    test("Case 8: Inconsistent summary counts fails closed", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
          schema_version: "1.0",
          status: "passed",
          complete: true,
          summary: {
            rules_total: 21,
            rules_evaluated: 21,
            rules_passed: 10,
            rules_failed: 5, // 10 + 5 !== 21 (Inconsistent!)
            findings_total: 0,
            blocking_findings: 0,
            warning_findings: 0,
            advisory_findings: 0,
          },
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "incomplete");
      assert.equal(report.governance_linting.completed, false);
      assert.notEqual(report.governance_evaluation.overall_outcome, "passed");
      assert.ok(report.diagnostics.some((d) => d.includes("inconsistent, non-numeric, or missing counts")));
    });

    test("Case 9: Execution failure record in report marks linting as failed", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(
        lintRaw,
        JSON.stringify({
          schema_version: "1.0",
          status: "failed",
          complete: false,
          summary: {
            rules_total: 21,
            rules_evaluated: 5,
            rules_passed: 5,
            rules_failed: 0,
            findings_total: 0,
            blocking_findings: 0,
            warning_findings: 0,
            advisory_findings: 0,
          },
          execution_failures: [
            {
              rule_id: "RULE-SEC-WORKFLOW-PERMS",
              error: "OutOfMemoryError: rule evaluation exceeded limits",
            },
          ],
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "failed");
      assert.equal(report.governance_linting.completed, false);
      assert.equal(report.governance_evaluation.overall_outcome, "failed");
      assert.ok(report.diagnostics.some((d) => d.includes("execution failure(s)")));
    });

    test("Case 10: Empty or zero-byte report fails closed", () => {
      const gateRaw = path.join(tempDir, "gate-raw-report.json");
      const lintRaw = path.join(tempDir, "lint-raw-report.json");
      createPassingGateRawReport(gateRaw);

      fs.writeFileSync(lintRaw, "", "utf-8"); // 0 bytes

      const report = buildCiEvidenceReport(tempDir, {
        rawReportPath: gateRaw,
        lintReportPath: lintRaw,
        jobStatus: "success",
      });

      assert.ok(report.governance_linting);
      assert.equal(report.governance_linting.status, "incomplete");
      assert.equal(report.governance_linting.completed, false);
      assert.notEqual(report.governance_evaluation.overall_outcome, "passed");
      assert.ok(report.diagnostics.some((d) => d.includes("empty (0 bytes)")));
    });
  });
});
