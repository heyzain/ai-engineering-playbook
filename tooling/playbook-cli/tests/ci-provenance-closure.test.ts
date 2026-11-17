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
} from "../src/index.js";

describe("CI Provenance & Fallback Semantics Closure (Task 006C.3.4)", () => {
  let tempDir: string;
  let summaryFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ci-closure-"));
    summaryFile = path.join(tempDir, "github_step_summary.md");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    // Initialize temporary git repo
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: tempDir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: "ignore" });

    // Initial commit to establish HEAD on main
    fs.writeFileSync(path.join(tempDir, "README.md"), "# Closure Test Repo\n", "utf-8");
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

  describe("1. Commit Provenance & Reachability vs Existence", () => {
    test("rejects commit verification when PR head commit exists in git db but is NOT reachable from checked-out commit", () => {
      // Create a commit on a disconnected feature branch
      execSync("git checkout -b feature-unreachable", { cwd: tempDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tempDir, "unreachable.txt"), "isolated work\n", "utf-8");
      execSync("git add unreachable.txt", { cwd: tempDir, stdio: "ignore" });
      execSync('git commit -m "Unreachable feature commit"', { cwd: tempDir, stdio: "ignore" });
      const isolatedPrHeadSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      // Return to main without merging feature-unreachable
      execSync("git checkout main", { cwd: tempDir, stdio: "ignore" });

      // Simulate a raw report falsely claiming pass
      fs.writeFileSync(
        path.join(tempDir, "gate-raw-report.json"),
        JSON.stringify({
          overall_outcome: "passed",
          stage: 1,
          summary: { total: 1, passed: 1, failed: 0, warning: 0, skipped: 0 },
        }),
        "utf-8"
      );

      // Evaluate PR evidence claiming isolatedPrHeadSha is the PR head
      const report = buildCiEvidenceReport(tempDir, {
        eventName: "pull_request",
        prNumber: 99,
        prHeadSha: isolatedPrHeadSha,
      });

      // Assert commit existence was verified, but reachability failed
      assert.equal(report.run_identity.commit_verified, false);
      assert.equal(report.governance_evaluation.overall_outcome, "incomplete");
      assert.equal(report.evidence_completeness, "incomplete");
      assert.ok(
        report.diagnostics.some(
          (d) => d.includes("exists in repository but is NOT reachable from checked-out commit")
        )
      );
    });

    test("verifies commit reachability when checked-out commit is a synthetic merge ref containing PR head", () => {
      const baseSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      // Create a feature branch
      execSync("git checkout -b feature-mergeable", { cwd: tempDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tempDir, "mergeable.txt"), "mergeable work\n", "utf-8");
      execSync("git add mergeable.txt", { cwd: tempDir, stdio: "ignore" });
      execSync('git commit -m "Mergeable feature commit"', { cwd: tempDir, stdio: "ignore" });
      const prHeadSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      // Return to main and create non-fast-forward merge commit (simulating refs/pull/:id/merge)
      execSync("git checkout main", { cwd: tempDir, stdio: "ignore" });
      execSync('git merge feature-mergeable --no-ff -m "Merge pull request #100 into main"', {
        cwd: tempDir,
        stdio: "ignore",
      });
      const mergeCommitSha = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

      const report = buildCiEvidenceReport(tempDir, {
        eventName: "pull_request",
        prNumber: 100,
        prHeadSha,
        prBaseSha: baseSha,
      });

      assert.equal(report.run_identity.commit_verified, true);
      assert.equal(report.run_identity.is_merge_commit, true);
      assert.equal(report.run_identity.checked_out_commit_sha, mergeCommitSha);
      assert.equal(report.run_identity.pr_head_sha, prHeadSha);
      assert.equal(report.run_identity.pr_base_sha, baseSha);
    });

    test("rejects provenance when PR event is missing pr_head_sha", () => {
      const report = buildCiEvidenceReport(tempDir, {
        eventName: "pull_request",
        prNumber: 101,
        // prHeadSha intentionally omitted
      });

      assert.equal(report.run_identity.commit_verified, false);
      assert.equal(report.governance_evaluation.overall_outcome, "incomplete");
      assert.ok(report.diagnostics.some((d) => d.includes("missing a valid PR head commit SHA")));
    });

    test("detects GITHUB_SHA mismatch on push events", () => {
      process.env.GITHUB_SHA = "0123456789abcdef0123456789abcdef01234567";

      const report = buildCiEvidenceReport(tempDir, {
        eventName: "push",
      });

      assert.equal(report.run_identity.commit_verified, false);
      assert.equal(report.governance_evaluation.overall_outcome, "incomplete");
      assert.ok(report.diagnostics.some((d) => d.includes("does not match GITHUB_SHA")));
    });
  });

  describe("2. Fallback Evidence Semantics & Invariants", () => {
    test("populates explicit report_generation_method, gate execution status, and evidence_completeness", () => {
      // Provide valid raw report
      fs.writeFileSync(
        path.join(tempDir, "gate-raw-report.json"),
        JSON.stringify({
          overall_outcome: "passed",
          stage: 1,
          summary: { total: 3, passed: 3, failed: 0, warning: 0, skipped: 0 },
        }),
        "utf-8"
      );

      const report = buildCiEvidenceReport(tempDir, {
        eventName: "push",
      });

      assert.equal(report.report_generation_method, "playbook_cli");
      assert.equal(report.gate_execution_started, true);
      assert.equal(report.gate_execution_completed, true);
      assert.equal(report.evidence_completeness, "complete");
      assert.equal(report.governance_evaluation.overall_outcome, "passed");
    });

    test("generateEmergencyFallbackReport sets emergency_fallback method and incomplete status", () => {
      const emergency = generateEmergencyFallbackReport({
        repository: "octocat/hello-world",
        workflow: "Playbook Quality Gates",
        runId: "999",
        runAttempt: 1,
        eventName: "push",
        reason: "Runner out of memory during checkout",
      });

      assert.equal(emergency.report_generation_method, "emergency_fallback");
      assert.equal(emergency.gate_execution_started, false);
      assert.equal(emergency.gate_execution_completed, false);
      assert.equal(emergency.evidence_completeness, "incomplete");
      assert.equal(emergency.governance_evaluation.overall_outcome, "incomplete");

      const validation = validateCiEvidenceReport(emergency);
      assert.equal(validation.valid, true);
    });

    test("validateCiEvidenceReport strictly blocks FALSE_PASS when report_generation_method is emergency_fallback", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.report_generation_method = "emergency_fallback";
      report.governance_evaluation.overall_outcome = "passed";

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("Emergency fallback report cannot claim overall_outcome 'passed'"))
      );
    });

    test("validateCiEvidenceReport strictly blocks FALSE_PASS when gate_execution_completed is false", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.gate_execution_completed = false;
      report.governance_evaluation.overall_outcome = "passed";

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("gate_execution_completed is false"))
      );
    });

    test("validateCiEvidenceReport strictly blocks FALSE_PASS when evidence_completeness is not complete", () => {
      const report = buildCiEvidenceReport(tempDir);
      report.evidence_completeness = "partial";
      report.governance_evaluation.overall_outcome = "passed";

      const result = validateCiEvidenceReport(report);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("evidence_completeness is 'partial'"))
      );
    });
  });

  describe("3. Concurrency & Attempt Isolation", () => {
    test("verifies canonical workflow concurrency group isolates different PRs and preserves push audits", () => {
      const adapter = getCiAdapter("github");
      const workflow = adapter.generateWorkflow({ provider: "github" });

      // Concurrency group expression
      const groupMatch = workflow.match(/concurrency:\s*\n\s*group:\s*([^\n]+)/);
      assert.ok(groupMatch, "Expected concurrency group definition");
      const groupExpr = groupMatch[1];
      assert.ok(
        groupExpr.includes("github.event.pull_request.number"),
        "Concurrency group must distinguish PR numbers"
      );

      // Cancel in progress expression
      const cancelMatch = workflow.match(/cancel-in-progress:\s*([^\n]+)/);
      assert.ok(cancelMatch, "Expected cancel-in-progress definition");
      assert.ok(
        cancelMatch[1].includes("github.event_name == 'pull_request'"),
        "cancel-in-progress must only cancel PR events, never push events"
      );
    });

    test("verifies evidence artifact naming isolates multiple workflow attempts", () => {
      const adapter = getCiAdapter("github");
      const workflow = adapter.generateWorkflow({ provider: "github" });

      const artifactNameMatch = workflow.match(/name:\s*playbook-ci-evidence-([^\n]+)/);
      assert.ok(artifactNameMatch, "Expected evidence artifact upload name");
      assert.ok(
        artifactNameMatch[1].includes("github.run_id") &&
          artifactNameMatch[1].includes("github.run_attempt"),
        "Artifact name must include both github.run_id and github.run_attempt"
      );
    });

    test("validator rejects workflow whose concurrency group does not isolate PRs", () => {
      const adapter = getCiAdapter("github");
      let workflow = adapter.generateWorkflow({ provider: "github" });
      workflow = workflow.replace(
        /group:\s*\${{\s*github\.workflow\s*}}-\${{\s*github\.event\.pull_request\.number\s*\|\|\s*github\.ref\s*}}/,
        "group: ${{ github.workflow }}"
      );

      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("concurrency group must include pull request number"))
      );
    });

    test("validator rejects workflow if artifact name does not isolate re-run attempts", () => {
      const adapter = getCiAdapter("github");
      let workflow = adapter.generateWorkflow({ provider: "github" });
      workflow = workflow.replace(
        /name:\s*playbook-ci-evidence-\${{\s*github\.run_id\s*}}-\${{\s*github\.run_attempt\s*}}/,
        "name: playbook-ci-evidence-latest"
      );

      const result = validateCiWorkflow(tempDir, {
        provider: "github",
        content: workflow,
      });

      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("Evidence artifact upload name must include 'github.run_attempt'"))
      );
    });
  });
});
