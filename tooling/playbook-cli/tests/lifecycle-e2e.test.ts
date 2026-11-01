import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { computeSha256 } from "../src/core/transaction/index.js";
import { DEFAULT_PATHS, STAGE_NAMES, type StageNumber } from "../src/constants.js";
import type { ProjectState, Deliverable, ExceptionRecord, RFCRecord } from "../src/types/state.js";
import type { ProjectManifest } from "../src/types/manifest.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");
const approvalWorkerPath = path.resolve(__dirname, "fixtures/approval-worker.js");

function createValidExitPackage(stage: number, stageName: string, deliverablesSummary: string): string {
  return `# Stage Gate Exit Package — Stage ${stage}: ${stageName}

## 1. Package & Stage Identification
This exit package formally documents all verified deliverables and supporting evidence for Stage ${stage} (${stageName}).
Active milestone: M-1.0.0. Project ID: e2e-service. All mandatory engineering invariants and gate criteria have been satisfied in full compliance with the constitution.

## 2. Deliverables Manifest & Status
The following deliverables have been produced, verified, and validated:
- ${deliverablesSummary}

## 3. Verifiable Validation Evidence
- Automated test logs and validation evidence recorded with SHA-256 verification hashes.
- 100% tests passing with zero failures.

## 4. Traceability & Sign-Off Record
- Traceability: All functional and non-functional requirements traced to verified deliverables.
- Residual Risk: Zero outstanding critical or high defects.
- Ready for formal human review.
`;
}

describe("End-to-End Engineering Lifecycle Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-e2e-integration-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore potential transient Windows file lock
      }
    }
  });

  test("Scenario A: Fresh project initialization", async () => {
    // 1. Initialize project via real CLI executable
    const initRes = await execFileAsync("node", [
      cliBinPath,
      "init",
      "--cwd",
      tempDir,
      "--non-interactive",
      "--project-id",
      "e2e-service",
      "--name",
      "E2E Integration Service",
      "--profile",
      "strict",
      "--mode",
      "solo",
      "--milestone",
      "M-1.0.0",
    ]);

    assert.equal(initRes.stderr, "");
    assert.match(initRes.stdout, /AI Engineering Playbook Initialized Successfully/);
    assert.match(initRes.stdout, /Project ID:\s+e2e-service/);

    // 2. Validate paths on disk
    const expectedDirs = [
      path.join(tempDir, ".playbook"),
      path.join(tempDir, ".playbook", "logs"),
      path.join(tempDir, "docs", "prd"),
      path.join(tempDir, "docs", "adr"),
      path.join(tempDir, "docs", "rfcs"),
      path.join(tempDir, "docs", "gates"),
      path.join(tempDir, "docs", "exceptions"),
    ];
    for (const d of expectedDirs) {
      assert.ok(fs.existsSync(d), `Expected directory missing: ${d}`);
    }

    // 3. Validate governance files via CLI validate
    const valRes = await execFileAsync("node", [cliBinPath, "validate", "--cwd", tempDir]);
    assert.match(valRes.stdout, /\[manifest\] Valid/);
    assert.match(valRes.stdout, /\[state\] Valid/);
    assert.match(valRes.stdout, /All governance files conform to official JSON Schemas/);

    // 4. Inspect initial lifecycle state via CLI inspect --json
    const inspectRes = await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir, "--json"]);
    const report = JSON.parse(inspectRes.stdout);

    assert.equal(report.initialized, true);
    assert.equal(report.milestone.lifecycle_status, "active");
    assert.equal(report.stage.number, 0);
    assert.equal(report.stage.status, "not_started");
    assert.equal(report.readiness.status, "needs_attention");
    assert.equal(report.deliverables_summary.not_started, 1);
    assert.equal(report.deliverables_summary.verified, 0);
  });

  test("Scenario B & C: Stage 0 preparation, verification, approval, and advancement", async () => {
    // 1. Initialize project
    await execFileAsync("node", [
      cliBinPath,
      "init",
      "--cwd",
      tempDir,
      "--non-interactive",
      "--project-id",
      "e2e-service",
      "--name",
      "E2E Integration Service",
      "--profile",
      "strict",
      "--mode",
      "solo",
    ]);

    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
    const manifestPath = path.join(tempDir, DEFAULT_PATHS.manifestFile);

    // Negative Check 1: Incomplete gate cannot be approved
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          approvalWorkerPath,
          "--cwd",
          tempDir,
          "--gate",
          "0",
          "--reviewer",
          "Alice Human",
          "--role",
          "Lead Architect",
          "--confirmation-phrase",
          "CONFIRM APPROVAL GATE 0",
        ]);
      },
      (err: { code?: number }) => {
        assert.equal(err.code, 1);
        return true;
      }
    );

    // Author Stage 0 artifact
    const prdPath = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
    fs.writeFileSync(prdPath, "# PRD Core Document\nProblem formulation and goals.\n", "utf-8");

    // Create evidence log
    const logRelPath = ".playbook/logs/stage-0-prd.log";
    const logAbsPath = path.join(tempDir, logRelPath);
    const logContent = "Verification log: PRD Core checked against Constitution.\nResult: PASSED.\n";
    fs.writeFileSync(logAbsPath, logContent, "utf-8");
    const logHash = computeSha256(logContent);

    // Author Exit Package
    const exitPkgRelPath = "docs/gates/GATE-0-EXIT-PACKAGE.md";
    const exitPkgAbsPath = path.join(tempDir, exitPkgRelPath);
    fs.writeFileSync(
      exitPkgAbsPath,
      createValidExitPackage(0, STAGE_NAMES[0], "PRD-CORE (Problem Statement Document)"),
      "utf-8"
    );

    // Update state to pending review
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "spec-validation",
        result: "passed",
        summary: "PRD core verified",
        exit_code: 0,
        evidence_ref: logRelPath,
        evidence_hash: logHash,
        verified_at: new Date().toISOString(),
        verified_by: "human:Alice Human",
        actor_type: "human",
      },
    ];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.current_stage_detail.human_approval.status = "pending_review";
    state.stage_status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    // Verify evidence via CLI verify-evidence
    const evRes = await execFileAsync("node", [cliBinPath, "verify-evidence", "--cwd", tempDir, "--json"]);
    const evReport = JSON.parse(evRes.stdout);
    assert.equal(evReport.all_passed, true);
    assert.equal(evReport.summary.integrity_passed, 1);

    // Verify inspect reports ready_for_review
    const inspectRes = await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir, "--json"]);
    const inspectReport = JSON.parse(inspectRes.stdout);
    assert.equal(inspectReport.readiness.status, "ready_for_human_review");

    // Negative Check 2: Headless CLI approve without interactive TTY fails
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          cliBinPath,
          "approve",
          "--cwd",
          tempDir,
          "--gate",
          "0",
          "--reviewer",
          "Alice Human",
          "--role",
          "Lead Architect",
        ]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /TTY_REQUIRED/);
        return true;
      }
    );

    // Negative Check 3: AI agent name rejected
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          approvalWorkerPath,
          "--cwd",
          tempDir,
          "--gate",
          "0",
          "--reviewer",
          "AI-Agent-Bot",
          "--role",
          "Lead Architect",
          "--confirmation-phrase",
          "CONFIRM APPROVAL GATE 0",
        ]);
      },
      (err: { code?: number }) => {
        assert.equal(err.code, 1);
        return true;
      }
    );

    // Positive Approval: Controlled human approval
    const approveRes = await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "0",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 0",
    ]);
    assert.equal(approveRes.stderr, "");

    // Invariant Check: Approval does NOT advance stage
    const approvedState: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(approvedState.current_stage, 0);
    assert.equal(approvedState.stage_status, "approved");
    assert.equal(approvedState.current_stage_detail.human_approval.status, "approved");

    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.active_lifecycle_stage, 0);

    // Negative Check 4: Stale approval after mutating evidence file
    fs.appendFileSync(logAbsPath, "\nTampered line!\n", "utf-8");
    await assert.rejects(
      async () => {
        await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /APPROVAL_STALE/);
        return true;
      }
    );

    // Negative Check 5: Re-approving an already approved gate fails with STAGE_ALREADY_APPROVED
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          approvalWorkerPath,
          "--cwd",
          tempDir,
          "--gate",
          "0",
          "--reviewer",
          "Alice Human",
          "--role",
          "Lead Architect",
          "--confirmation-phrase",
          "CONFIRM APPROVAL GATE 0",
        ]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /STAGE_ALREADY_APPROVED/);
        return true;
      }
    );

    // Restore evidence -> Fingerprint matches again -> Positive Advancement via CLI advance
    fs.writeFileSync(logAbsPath, logContent, "utf-8");

    // Positive Advancement via CLI advance
    const advanceRes = await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir, "--json"]);
    const advanceReport = JSON.parse(advanceRes.stdout);
    assert.equal(advanceReport.success, true);
    assert.equal(advanceReport.previous_stage, 0);
    assert.equal(advanceReport.new_stage, 1);
    assert.equal(advanceReport.is_terminal_closed, false);

    // Verify post-advance state & manifest synchronization
    const advancedState: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(advancedState.current_stage, 1);
    assert.equal(advancedState.stage_status, "not_started");
    assert.equal(advancedState.stage_history.length, 1);
    assert.equal(advancedState.stage_history[0].stage, 0);
    assert.equal(advancedState.stage_history[0].human_approval.approved_by, "Alice Human");
    assert.equal(advancedState.current_stage_detail.deliverables[0].id, "REQ-SPEC");

    const updatedManifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(updatedManifest.active_lifecycle_stage, 1);
  });

  test("Scenario D: Multi-stage lifecycle (Rejection & recovery, Blocking RFC, Waivers & exceptions)", async () => {
    // Bootstrap project at Stage 1
    await execFileAsync("node", [
      cliBinPath,
      "init",
      "--cwd",
      tempDir,
      "--non-interactive",
      "--project-id",
      "e2e-service",
      "--name",
      "E2E Integration Service",
      "--profile",
      "strict",
      "--mode",
      "solo",
    ]);

    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);

    // Complete Stage 0 cleanly to advance to Stage 1
    const prdPath = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
    fs.writeFileSync(prdPath, "# PRD Core\n", "utf-8");
    const log0Path = path.join(tempDir, ".playbook", "logs", "stage-0.log");
    const log0Content = "Stage 0 verified.\n";
    fs.writeFileSync(log0Path, log0Content, "utf-8");
    fs.writeFileSync(
      path.join(tempDir, "docs", "gates", "GATE-0-EXIT-PACKAGE.md"),
      createValidExitPackage(0, STAGE_NAMES[0], "PRD-CORE"),
      "utf-8"
    );

    let state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "ok",
        exit_code: 0,
        evidence_ref: ".playbook/logs/stage-0.log",
        evidence_hash: computeSha256(log0Content),
        verified_at: new Date().toISOString(),
        verified_by: "human:Alice Human",
        actor_type: "human",
      },
    ];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "0",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 0",
    ]);
    await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);

    // Now at Stage 1 (Requirements & Specification)
    // Part 1: Rejection and recovery
    const reqSpecPath = path.join(tempDir, "docs", "prd", "REQUIREMENTS-SPEC.md");
    fs.writeFileSync(reqSpecPath, "# Requirements Spec\n", "utf-8");
    const log1Path = path.join(tempDir, ".playbook", "logs", "stage-1.log");
    const log1Content = "Stage 1 verified.\n";
    fs.writeFileSync(log1Path, log1Content, "utf-8");
    fs.writeFileSync(
      path.join(tempDir, "docs", "gates", "GATE-1-EXIT-PACKAGE.md"),
      createValidExitPackage(1, STAGE_NAMES[1], "REQ-SPEC"),
      "utf-8"
    );

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "ok",
        exit_code: 0,
        evidence_ref: ".playbook/logs/stage-1.log",
        evidence_hash: computeSha256(log1Content),
        verified_at: new Date().toISOString(),
        verified_by: "human:Alice Human",
        actor_type: "human",
      },
    ];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    // Human Rejects Gate 1 with rework conditions
    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "1",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--reject",
      "--conditions",
      "NFR-003 missing latency bounds and edge case specifications",
    ]);

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.stage_status, "in_progress");
    assert.equal(state.current_stage_detail.human_approval.status, "rejected");
    assert.equal(state.current_stage_detail.exit_package.status, "drafted");
    assert.equal(
      state.current_stage_detail.human_approval.conditions,
      "NFR-003 missing latency bounds and edge case specifications"
    );

    // Advance should fail when rejected
    await assert.rejects(
      async () => {
        await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);
      },
      (err: { code?: number }) => {
        assert.equal(err.code, 1);
        return true;
      }
    );

    // Rework and re-submit
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "1",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 1",
    ]);
    await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);

    // Now at Stage 2 (Architecture & System Design)
    // Part 2: Blocking RFC behavior
    const archSpecPath = path.join(tempDir, "docs", "adr", "ARCHITECTURE-SPEC.md");
    fs.writeFileSync(archSpecPath, "# Architecture Specification\n", "utf-8");
    const log2Path = path.join(tempDir, ".playbook", "logs", "stage-2.log");
    const log2Content = "Stage 2 verified.\n";
    fs.writeFileSync(log2Path, log2Content, "utf-8");
    fs.writeFileSync(
      path.join(tempDir, "docs", "gates", "GATE-2-EXIT-PACKAGE.md"),
      createValidExitPackage(2, STAGE_NAMES[2], "ARCH-SPEC"),
      "utf-8"
    );

    // Create an unresolved blocking RFC
    const rfcRelPath = "docs/rfcs/RFC-20261101-001-caching.md";
    fs.writeFileSync(path.join(tempDir, rfcRelPath), "# RFC Caching Policy\n", "utf-8");

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "ok",
        exit_code: 0,
        evidence_ref: ".playbook/logs/stage-2.log",
        evidence_hash: computeSha256(log2Content),
        verified_at: new Date().toISOString(),
        verified_by: "human:Alice Human",
        actor_type: "human",
      },
    ];
    state.current_stage_detail.rfcs = [
      {
        rfc_id: "RFC-20261101-001",
        title: "Distributed Caching Invalidation Policy",
        status: "pending_decision",
        is_blocking: true,
        path: rfcRelPath,
      },
    ];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    // Inspect reports blocked with exit code 1
    await assert.rejects(
      async () => {
        await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir, "--json"]);
      },
      (err: { code?: number; stdout?: string }) => {
        assert.equal(err.code, 1);
        const rep = JSON.parse(err.stdout || "{}");
        assert.equal(rep.readiness.status, "blocked");
        assert.ok(rep.diagnostics.some((d: any) => d.code === "RFC_BLOCKING_UNRESOLVED"));
        return true;
      }
    );

    // Approval fails due to blocking RFC
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          approvalWorkerPath,
          "--cwd",
          tempDir,
          "--gate",
          "2",
          "--reviewer",
          "Alice Human",
          "--role",
          "Lead Architect",
          "--confirmation-phrase",
          "CONFIRM APPROVAL GATE 2",
        ]);
      },
      (err: { code?: number }) => {
        assert.equal(err.code, 1);
        return true;
      }
    );

    // Resolve RFC
    state.current_stage_detail.rfcs[0].status = "resolved";
    state.current_stage_detail.rfcs[0].resolved_at = new Date().toISOString();
    state.current_stage_detail.rfcs[0].decision_summary = "Adopted Redis Cluster cache invalidation protocol.";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    // Now inspect passes and approval succeeds
    const inspect2 = await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir, "--json"]);
    assert.equal(JSON.parse(inspect2.stdout).readiness.status, "ready_for_human_review");

    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "2",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 2",
    ]);
    await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);

    // Now at Stage 3 (Implementation & Unit Verification)
    // Advance cleanly through Stage 3
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "index.ts"), "export const hello = 'world';\n", "utf-8");
    const log3Path = path.join(tempDir, ".playbook", "logs", "stage-3.log");
    const log3Content = "Stage 3 unit tests: 100% passed.\n";
    fs.writeFileSync(log3Path, log3Content, "utf-8");
    fs.writeFileSync(
      path.join(tempDir, "docs", "gates", "GATE-3-EXIT-PACKAGE.md"),
      createValidExitPackage(3, STAGE_NAMES[3], "CODE-IMPL"),
      "utf-8"
    );

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "ok",
        exit_code: 0,
        evidence_ref: ".playbook/logs/stage-3.log",
        evidence_hash: computeSha256(log3Content),
        verified_at: new Date().toISOString(),
        verified_by: "human:Alice Human",
        actor_type: "human",
      },
    ];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "3",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 3",
    ]);
    await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);

    // Now at Stage 4 (Integration & System Verification)
    // Part 3: Waivers and exceptions handling
    const excRelPath = "docs/exceptions/EXC-20261101-001.md";
    fs.writeFileSync(path.join(tempDir, excRelPath), "# Exception Record 001\nTemporary waiver.\n", "utf-8");
    fs.writeFileSync(
      path.join(tempDir, "docs", "gates", "GATE-4-EXIT-PACKAGE.md"),
      createValidExitPackage(4, STAGE_NAMES[4], "INT-TESTS (Waived under EXC-20261101-001)"),
      "utf-8"
    );

    // Negative Sub-test: Expired exception blocks approval
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const expiredException: ExceptionRecord = {
      exception_id: "EXC-20261101-001",
      title: "Temporary waiver of integration suite",
      path: excRelPath,
      waived_requirement: "INT-TESTS",
      authorized_by: "Alice Human",
      authorized_at: "2026-10-01T00:00:00.000Z",
      expiration_date: "2026-10-15",
      status: "expired", // EXPIRED!
    };
    state.current_stage_detail.exceptions = [expiredException];
    state.current_stage_detail.deliverables[0].status = "waived";
    state.current_stage_detail.deliverables[0].validation_status = "waived";
    state.current_stage_detail.deliverables[0].exception_ref = "EXC-20261101-001";
    state.current_stage_detail.deliverables[0].evidence = [];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          approvalWorkerPath,
          "--cwd",
          tempDir,
          "--gate",
          "4",
          "--reviewer",
          "Alice Human",
          "--role",
          "Lead Architect",
          "--confirmation-phrase",
          "CONFIRM APPROVAL GATE 4",
        ]);
      },
      (err: { code?: number }) => {
        assert.equal(err.code, 1);
        return true;
      }
    );

    // Positive Sub-test: Active valid waiver clears approval
    state.current_stage_detail.exceptions[0].status = "active";
    state.current_stage_detail.exceptions[0].expiration_date = "2026-12-31";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "4",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 4",
    ]);

    // Advance Stage 4 -> Stage 5
    await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);

    // Stage 5: Review, Hardening & Release Readiness
    const auditDir = path.join(tempDir, "docs", "audits");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, "RELEASE-HARDENING.md"), "# Release Hardening\n", "utf-8");
    const log5Path = path.join(tempDir, ".playbook", "logs", "stage-5.log");
    const log5Content = "Stage 5 security scan: 0 critical vulnerabilities.\n";
    fs.writeFileSync(log5Path, log5Content, "utf-8");
    fs.writeFileSync(
      path.join(tempDir, "docs", "gates", "GATE-5-EXIT-PACKAGE.md"),
      createValidExitPackage(5, STAGE_NAMES[5], "SEC-AUDIT"),
      "utf-8"
    );

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "audit",
        result: "passed",
        summary: "ok",
        exit_code: 0,
        evidence_ref: ".playbook/logs/stage-5.log",
        evidence_hash: computeSha256(log5Content),
        verified_at: new Date().toISOString(),
        verified_by: "human:Alice Human",
        actor_type: "human",
      },
    ];
    state.current_stage_detail.exit_package.status = "submitted_for_review";
    state.current_stage_detail.exit_package.submitted_at = new Date().toISOString();
    state.stage_status = "pending_review";
    state.current_stage_detail.human_approval.status = "pending_review";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "5",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 5",
    ]);

    // Advance Stage 5 -> Stage 6
    const adv5Res = await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir, "--json"]);
    const adv5Report = JSON.parse(adv5Res.stdout);
    assert.equal(adv5Report.new_stage, 6);
  });

  test("Scenario E & F: Stage 6 terminal lifecycle closure and milestone preservation", async () => {
    // Bootstrap project at Stage 6
    await execFileAsync("node", [
      cliBinPath,
      "init",
      "--cwd",
      tempDir,
      "--non-interactive",
      "--project-id",
      "e2e-service",
      "--name",
      "E2E Integration Service",
      "--profile",
      "strict",
      "--mode",
      "solo",
      "--milestone",
      "M-1.0.0",
    ]);

    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
    const manifestPath = path.join(tempDir, DEFAULT_PATHS.manifestFile);

    // Populate historical stages 0 to 5 in stage_history
    let state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    let manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    for (let s = 0; s < 6; s++) {
      state.stage_history.push({
        stage: s as StageNumber,
        stage_name: STAGE_NAMES[s as StageNumber],
        status: "approved",
        started_at: "2026-10-31T10:00:00.000Z",
        completed_at: "2026-10-31T11:00:00.000Z",
        approved_at: "2026-10-31T11:00:00.000Z",
        exit_package_ref: `docs/gates/GATE-${s}-EXIT-PACKAGE.md`,
        human_approval: {
          approved_by: "Alice Human",
          role: "Lead Architect",
          approval_mode: "solo",
          signature_reference: `Session-${s}`,
        },
      });
    }

    state.current_stage = 6;
    state.stage_status = "pending_review";
    manifest.active_lifecycle_stage = 6;

    // Create Stage 6 deliverable artifact
    const opsDir = path.join(tempDir, "docs", "ops");
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(path.join(opsDir, "DEPLOYMENT-LOG.md"), "# Deployment Log\nDeployment verified.\n", "utf-8");

    const log6Path = path.join(tempDir, ".playbook", "logs", "stage-6-deploy.log");
    const log6Content = "Deployment execution completed. Post-deployment smoke tests: 100% passed.\n";
    fs.writeFileSync(log6Path, log6Content, "utf-8");
    const log6Hash = computeSha256(log6Content);

    const exitPkg6Path = path.join(tempDir, "docs", "gates", "GATE-6-EXIT-PACKAGE.md");
    fs.writeFileSync(
      exitPkg6Path,
      createValidExitPackage(6, STAGE_NAMES[6], "DEPLOY-LOG (Deployment Execution & Monitoring Log)"),
      "utf-8"
    );

    state.current_stage_detail = {
      stage: 6,
      stage_name: STAGE_NAMES[6],
      started_at: "2026-10-31T12:00:00.000Z",
      deliverables: [
        {
          id: "DEPLOY-LOG",
          name: "Deployment Execution & Monitoring Log",
          description: "Deployment execution steps, post-deployment smoke test results, and operational telemetry baseline.",
          artifact_path: "docs/ops/DEPLOYMENT-LOG.md",
          status: "verified",
          validation_status: "passed",
          exception_ref: null,
          evidence: [
            {
              requirement_id: null,
              type: "automated_test",
              procedure: "post-deploy-smoke",
              result: "passed",
              summary: "Smoke tests passed",
              exit_code: 0,
              evidence_ref: ".playbook/logs/stage-6-deploy.log",
              evidence_hash: log6Hash,
              verified_at: "2026-10-31T12:30:00.000Z",
              verified_by: "human:Alice Human",
              actor_type: "human",
            },
          ],
        },
      ],
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "submitted_for_review",
        path: "docs/gates/GATE-6-EXIT-PACKAGE.md",
        submitted_at: "2026-10-31T12:30:00.000Z",
      },
      human_approval: {
        status: "pending_review",
        approved_by: null,
        role: null,
        approval_mode: "solo",
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    };

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    // Approve Gate 6
    const app6Res = await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "6",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 6",
    ]);
    assert.equal(app6Res.stderr, "");

    // Advance Stage 6 -> Executes CLOSE_LIFECYCLE
    const adv6Res = await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir, "--json"]);
    const adv6Report = JSON.parse(adv6Res.stdout);

    assert.equal(adv6Report.success, true);
    assert.equal(adv6Report.previous_stage, 6);
    assert.equal(adv6Report.new_stage, 6); // Stage remains 6! No Stage 7!
    assert.equal(adv6Report.is_terminal_closed, true);
    assert.ok(adv6Report.milestone_snapshot_path);

    // Verify terminal invariants on state & manifest
    const terminalState: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(terminalState.lifecycle_status, "completed_terminal");
    assert.equal(terminalState.current_stage, 6);
    assert.equal(terminalState.stage_status, "approved");
    assert.equal(terminalState.stage_history.length, 7); // Stages 0, 1, 2, 3, 4, 5, 6 archived!

    const terminalManifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(terminalManifest.active_lifecycle_stage, 6);

    // Milestone snapshot verification
    const snapshotPath = path.join(tempDir, adv6Report.milestone_snapshot_path);
    assert.ok(fs.existsSync(snapshotPath), `Snapshot missing at ${snapshotPath}`);
    const snapshotContent = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    assert.equal(snapshotContent.lifecycle_status, "completed_terminal");
    assert.equal(snapshotContent.milestone_id, "M-1.0.0");
    assert.equal(snapshotContent.stage_history.length, 7);

    // Approval sidecar is cleanly unlinked
    const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
    assert.equal(fs.existsSync(sidecarPath), false);

    // Negative Check: Attempting to advance an already closed terminal lifecycle fails
    await assert.rejects(
      async () => {
        await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /ADVANCEMENT_BLOCKED/);
        assert.match(err.stderr || "", /completed_terminal/);
        return true;
      }
    );

    // Reopening Gap Validation: Verify inspect reports terminal state
    const termInspect = await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir, "--json"]);
    const termReport = JSON.parse(termInspect.stdout);
    assert.equal(termReport.milestone.lifecycle_status, "completed_terminal");
    assert.match(termReport.readiness.summary, /terminal and completed in production/);
  });
});
