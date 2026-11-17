import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  getCiAdapter,
  buildCiEvidenceReport,
  generateEmergencyFallbackReport,
  validateCiEvidenceReport,
  validateCiWorkflow,
  CI_EVIDENCE_LIMITATIONS,
} from "../src/index.js";

describe("CI Evidence Integrity & GitHub Workflow Hardening (Task 006C.3.3)", () => {
  let tempDir: string;
  let summaryFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ci-hardening-"));
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
    execSync("git checkout -B main", { cwd: tempDir, stdio: "ignore" });
  });

  afterEach(() => {
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_WORKFLOW;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_SHA;
    delete process.env.GITHUB_REF;
    delete process.env.PR_NUMBER;
    delete process.env.PR_HEAD_SHA;
    delete process.env.PR_BASE_SHA;
    delete process.env.PR_BASE_REF;
    delete process.env.JOB_STATUS;

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("1. Commit Identity Verification", () => {
    test("accurately binds checked_out_commit_sha and checked_out_tree_sha on push events", () => {
      const headSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
      const treeSha = execSync("git log -1 --format=%T HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      const report = buildCiEvidenceReport(tempDir, {
        eventName: "push",
        ref: "refs/heads/main",
      });

      assert.equal(report.run_identity.trigger_event, "push");
      assert.equal(report.run_identity.checked_out_commit_sha, headSha);
      assert.equal(report.run_identity.checked_out_tree_sha, treeSha);
      assert.equal(report.run_identity.pr_head_sha, null);
      assert.equal(report.run_identity.pr_base_sha, null);
      assert.equal(report.run_identity.is_merge_commit, false);
      assert.equal(report.run_identity.commit_verified, true);
    });

    test("explicitly distinguishes PR head SHA, PR base SHA, checked-out commit SHA, and checked-out tree SHA", () => {
      // Create a base branch commit
      const baseSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      // Create a feature branch with a distinct commit
      execSync("git checkout -b feature-test", { cwd: tempDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tempDir, "feature.txt"), "feature code\n", "utf-8");
      execSync("git add feature.txt", { cwd: tempDir, stdio: "ignore" });
      execSync('git commit -m "Feature commit"', { cwd: tempDir, stdio: "ignore" });
      const prHeadSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      // Create a merge commit simulating GitHub Actions refs/pull/42/merge
      execSync('git merge feature-test --no-ff -m "Merge PR #42"', { cwd: tempDir, stdio: "ignore" });

      const report = buildCiEvidenceReport(tempDir, {
        eventName: "pull_request",
        prNumber: 42,
        prHeadSha,
        prBaseSha: baseSha,
        prBaseRef: "main",
      });

      const checkedOutCommitSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
      const checkedOutTreeSha = execSync("git log -1 --format=%T HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      // Assert all four SHAs are distinct and never labeled as each other
      assert.notEqual(prHeadSha, baseSha);
      assert.equal(report.run_identity.pr_head_sha, prHeadSha);
      assert.equal(report.run_identity.pr_base_sha, baseSha);
      assert.equal(report.run_identity.checked_out_commit_sha, checkedOutCommitSha);
      assert.equal(report.run_identity.checked_out_tree_sha, checkedOutTreeSha);
      assert.equal(report.run_identity.commit_verified, true);
    });

    test("detects merge commit topology (refs/pull/:id/merge) accurately", () => {
      // Create a branch and commit
      execSync("git checkout -b dev", { cwd: tempDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tempDir, "file_dev.txt"), "dev\n", "utf-8");
      execSync("git add file_dev.txt", { cwd: tempDir, stdio: "ignore" });
      execSync('git commit -m "Commit on dev"', { cwd: tempDir, stdio: "ignore" });

      // Create a commit on main
      execSync("git checkout main", { cwd: tempDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tempDir, "file_main.txt"), "main\n", "utf-8");
      execSync("git add file_main.txt", { cwd: tempDir, stdio: "ignore" });
      execSync('git commit -m "Commit on main"', { cwd: tempDir, stdio: "ignore" });

      // Merge dev into main creating a 2-parent merge commit
      execSync('git merge dev --no-ff -m "Merge dev into main"', { cwd: tempDir, stdio: "ignore" });

      const report = buildCiEvidenceReport(tempDir, {
        eventName: "pull_request",
        prNumber: 10,
      });

      assert.equal(report.run_identity.is_merge_commit, true);
    });

    test("downgrades overall_outcome to incomplete when PR head SHA cannot be verified in local git history", () => {
      // Simulate raw report claiming passed
      fs.writeFileSync(
        path.join(tempDir, "gate-raw-report.json"),
        JSON.stringify({
          overall_outcome: "passed",
          stage: 1,
          summary: { total: 1, passed: 1, failed: 0, warning: 0, skipped: 0 },
        }),
        "utf-8"
      );

      // Specify an unresolvable PR head SHA (e.g. from force-push or shallow clone)
      const fakeSha = "1111222233334444555566667777888899990000";
      const report = buildCiEvidenceReport(tempDir, {
        eventName: "pull_request",
        prNumber: 99,
        prHeadSha: fakeSha,
      });

      assert.equal(report.run_identity.commit_verified, false);
      assert.equal(report.governance_evaluation.overall_outcome, "incomplete");
      assert.ok(
        report.diagnostics.some((d) => d.includes("was not found in local git history") || d.includes("downgraded to 'incomplete'"))
      );
    });
  });

  describe("2. Early Failure Reporting & Fallback", () => {
    test("produces incomplete outcome when workflow fails early before raw gate report generation", () => {
      const report = buildCiEvidenceReport(tempDir, {
        jobStatus: "failure",
      });

      assert.equal(report.governance_evaluation.overall_outcome, "incomplete");
      assert.ok(report.diagnostics.some((d) => d.includes("Workflow failed prior to Quality Gate execution")));
    });

    test("generateEmergencyFallbackReport produces structurally valid emergency evidence", () => {
      const emergency = generateEmergencyFallbackReport({
        repository: "octocat/hello-world",
        workflow: "Playbook Quality Gates",
        runId: "12345",
        runAttempt: 2,
        eventName: "pull_request",
        prNumber: 15,
        prHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prBaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        reason: "Early failure: actions/checkout failed due to network timeout.",
      });

      assert.equal(emergency.schema_version, "1.0.0");
      assert.equal(emergency.governance_evaluation.overall_outcome, "incomplete");
      assert.equal(emergency.run_identity.commit_verified, false);
      assert.equal(emergency.summary.total, 0);
      assert.equal(emergency.summary.passed, 0);
      assert.equal(emergency.checks.length, 0);
      assert.ok(emergency.diagnostics[0].includes("network timeout"));
      assert.ok(emergency.limitations.length >= 4);

      // Validate emergency report against validation engine
      const validation = validateCiEvidenceReport(emergency);
      assert.equal(validation.valid, true, `Expected emergency report to pass validation: ${validation.errors.join(", ")}`);
    });
  });

  describe("3. Evidence Integrity & False PASS Prevention", () => {
    test("includes explicit governance limitations in every report", () => {
      const report = buildCiEvidenceReport(tempDir);
      assert.ok(Array.isArray(report.limitations));
      assert.equal(report.limitations.length, CI_EVIDENCE_LIMITATIONS.length);
      for (const lim of CI_EVIDENCE_LIMITATIONS) {
        assert.ok(report.limitations.includes(lim));
      }
    });

    test("validateCiEvidenceReport detects and blocks FALSE_PASS when summary reports failed checks", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.governance_evaluation.overall_outcome = "passed";
      report.summary.failed = 1;

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("FALSE_PASS_DETECTED") && e.includes("failed checks")));
    });

    test("validateCiEvidenceReport detects and blocks FALSE_PASS when commit_verified is false", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.governance_evaluation.overall_outcome = "passed";
      report.run_identity.commit_verified = false;

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("FALSE_PASS_DETECTED") && e.includes("commit_verified is false")));
    });

    test("validateCiEvidenceReport detects and blocks FALSE_PASS when working_tree_clean is false", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.governance_evaluation.overall_outcome = "passed";
      report.governance_evaluation.working_tree_clean = false;

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("FALSE_PASS_DETECTED") && e.includes("working_tree_clean is false")));
    });

    test("validateCiEvidenceReport detects and blocks FALSE_PASS when zero checks are evaluated in Stage > 0", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.governance_evaluation.overall_outcome = "passed";
      report.governance_evaluation.stage = 2;
      report.summary.total = 0;

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("FALSE_PASS_DETECTED") && e.includes("zero checks were evaluated")));
    });

    test("validateCiEvidenceReport rejects run ID and commit SHA mismatches", () => {
      const report = buildCiEvidenceReport(tempDir, {
        runId: "1001",
      });

      const mismatchRun = validateCiEvidenceReport(report, { expectedRunId: "2002" });
      assert.equal(mismatchRun.valid, false);
      assert.ok(mismatchRun.errors.some((e) => e.includes("Run ID mismatch")));

      const mismatchCommit = validateCiEvidenceReport(report, {
        expectedHeadSha: "9999999999999999999999999999999999999999",
      });
      assert.equal(mismatchCommit.valid, false);
      assert.ok(mismatchCommit.errors.some((e) => e.includes("Commit SHA mismatch")));
    });
  });

  describe("4. Local Semantic Workflow Validation", () => {
    test("validates canonical generated workflow successfully with zero errors", () => {
      const adapter = getCiAdapter("github");
      const workflow = adapter.generateWorkflow({ provider: "github" });
      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, true, `Validation failed: ${result.errors.join(", ")}`);
      assert.equal(result.errors.length, 0);
    });

    test("rejects workflow missing concurrency configuration", () => {
      const adapter = getCiAdapter("github");
      let workflow = adapter.generateWorkflow({ provider: "github" });
      workflow = workflow.replace(/concurrency:[\s\S]*?(?=jobs:)/, "");

      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("concurrency")));
    });

    test("rejects workflow with missing cancel-in-progress on concurrency", () => {
      const adapter = getCiAdapter("github");
      let workflow = adapter.generateWorkflow({ provider: "github" });
      workflow = workflow.replace(
        /cancel-in-progress:\s*\${{\s*github\.event_name\s*==\s*['"]pull_request['"]\s*}}/,
        "cancel-in-progress: true"
      );

      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("cancel-in-progress")));
    });

    test("rejects workflow if report or artifact upload steps lack 'if: always()'", () => {
      const adapter = getCiAdapter("github");
      let workflow = adapter.generateWorkflow({ provider: "github" });
      // Remove if: always() from report step
      workflow = workflow.replace(
        /(- name: Publish Playbook Step Summary & Telemetry\s*\n)\s*if: always\(\)/,
        "$1"
      );

      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("Publish Playbook Step Summary") && e.includes("if: always()")));
    });

    test("rejects workflow with untrusted PR context interpolated into shell run commands", () => {
      const adapter = getCiAdapter("github");
      let workflow = adapter.generateWorkflow({ provider: "github" });
      workflow = workflow.replace(
        /run: npx @ai-engineering-playbook\/cli validate/,
        'run: echo "Validating ${{ github.head_ref }}" && npx @ai-engineering-playbook/cli validate'
      );

      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("interpolates untrusted PR/event context")));
    });
  });
});
