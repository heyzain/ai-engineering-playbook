import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { QualityGateRunner, QualityGateExecutionError } from "../src/core/quality-gates/runner.js";
import { QualityGateVerifier } from "../src/core/quality-gates/verifier.js";
import { runGateRecover } from "../src/commands/gate.js";
import { checkRecoveryEligibility, recoverBlockedStage } from "../src/core/quality-gates/recovery.js";
import { WriteAheadTransactionManager } from "../src/core/transaction/transaction-manager.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { ProjectState } from "../src/types/state.js";

describe("Controlled Human Recovery & Governance Integrity (Task 005B.4 Verified)", () => {
  let tmpDir: string;
  let playbookDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-qg-recovery-"));
    playbookDir = path.join(tmpDir, DEFAULT_PATHS.playbookDir);
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "docs/prd"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs/prd/PRD-CORE.md"), "# PRD Core\n\nProblem statement.\n", "utf-8");

    // Initialize minimal valid manifest.json
    const manifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      project_id: "recovery-app",
      project_name: "Recovery Test App",
      active_milestone_id: "M-1.0.0",
      playbook: {
        version: "1.0.0",
        governance_profile: "standard",
        approval_mode: "solo",
      },
      tech_stack: {
        ecosystem: "node",
        primary_language: "typescript",
      },
      paths: {
        docs_root: "docs",
        prd_dir: "docs/prd",
        adr_dir: "docs/adr",
        rfc_dir: "docs/rfcs",
        gates_dir: "docs/gates",
        exceptions_dir: "governance/exceptions",
        state_file: ".playbook/state.json",
      },
      active_lifecycle_stage: 0,
      capabilities: [],
    };
    fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    // Initialize minimal valid state.json in blocked status
    const state: ProjectState = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
      schema_version: "1.1.0",
      project_id: "recovery-app",
      playbook_version: "1.0.0",
      milestone_id: "M-1.0.0",
      milestone_name: "Initial Release",
      lifecycle_status: "active",
      current_stage: 0,
      stage_status: "blocked",
      current_stage_detail: {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        started_at: "2026-11-03T10:00:00.000Z",
        deliverables: [
          {
            id: "PRD-CORE",
            name: "Problem Statement Document (PRD Core)",
            artifact_path: "docs/prd/PRD-CORE.md",
            status: "in_progress",
            validation_status: "failed",
            exception_ref: null,
            evidence: [
              {
                requirement_id: null,
                type: "static_analysis",
                procedure: "node -e process.exit(1);",
                result: "failed",
                summary: "Quality check 'prd-check' FAILED (exit code 1)",
                exit_code: 1,
                commit_sha: null,
                evidence_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                evidence_ref: ".playbook/logs/gate-stage-0-prd-check-failed.log",
                verified_at: "2026-11-03T10:05:00.000Z",
                verified_by: "agent:quality-gate-engine",
                actor_type: "agent",
                rif: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                working_tree_clean: true,
                inputs_hash: null,
              },
            ],
          },
        ],
        rfcs: [],
        adrs: [],
        exceptions: [],
        exit_package: {
          status: "not_drafted",
          path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        },
        human_approval: {
          status: "not_requested",
          approved_by: null,
          role: null,
          approval_mode: null,
          decision: null,
          signature_reference: null,
          approved_at: null,
          conditions: null,
        },
      },
      stage_history: [],
      archived_milestones: [],
      last_updated: {
        timestamp: "2026-11-03T10:05:00.000Z",
        updated_by: "agent:quality-gate-engine",
        actor_type: "agent",
        reason: "Controller Halt triggered: Stage 0 transitioned to blocked due to quality gate failure (--halt-on-failure).",
      },
    };
    fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");

    // Initialize mock failed evidence log on disk
    fs.mkdirSync(path.join(playbookDir, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(playbookDir, "logs/gate-stage-0-prd-check-failed.log"),
      "=== FAILED CHECK LOG ===\nSyntax error detected in PRD\n",
      "utf-8"
    );

    // Initialize valid quality-gates.json
    const qgConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "recovery-app",
      default_profile: "standard",
      global_settings: {
        default_timeout_ms: 30000,
        max_concurrency: 2,
        mask_secrets: true,
        log_retention_runs: 5,
        max_journaled_log_bytes: 1048576,
        env_allowlist: ["NODE_ENV", "PATH"],
      },
      gates: [
        {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          checks: [
            {
              id: "prd-check",
              name: "PRD Syntax & Spec Check",
              type: "static_analysis",
              deliverable_id: "PRD-CORE",
              command: "node",
              args: ["-e", "console.log('PRD specification verified after fix'); process.exit(0);"],
              inputs: ["docs/prd/**/*.md"],
            },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows
    }
  });

  test("1. Blocked stage rejects gate execution with STAGE_BLOCKED", async () => {
    const runner = new QualityGateRunner(tmpDir);
    await assert.rejects(
      async () => runner.run(),
      (err: unknown) => {
        assert.ok(err instanceof QualityGateExecutionError);
        assert.equal(err.code, "STAGE_BLOCKED");
        assert.equal(err.exitCode, 3);
        return true;
      }
    );
  });

  test("2. Automated execution cannot recover the stage", () => {
    const verifier = new QualityGateVerifier(tmpDir);
    const report = verifier.verify();

    // Verifier notes not fresh
    assert.equal(report.all_fresh, false);

    // State MUST remain blocked
    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "blocked");
    assert.equal(state.last_updated.actor_type, "agent");
  });

  test("3. Missing recovery reason is rejected with RECOVERY_REASON_REQUIRED", async () => {
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "   ", // Empty / whitespace
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.error, "RECOVERY_REASON_REQUIRED");

    // State MUST remain blocked
    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "blocked");
  });

  test("4. Non-TTY recovery is rejected with TTY_REQUIRED", async () => {
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: false,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.error, "TTY_REQUIRED");

    // State MUST remain blocked
    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "blocked");
  });

  test("5. Declined confirmation leaves state unchanged", async () => {
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect.",
      confirmationPhrase: "INCORRECT_CONFIRMATION_PHRASE",
    });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.error, "RECOVERY_ABORTED");

    // State MUST remain blocked
    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "blocked");
  });

  test("5b. Agent self-recovery is strictly rejected with AGENT_RECOVERY_FORBIDDEN", async () => {
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "agent:autonomous-controller",
      role: "AI Agent",
      reason: "Attempting automated unblocking without human authority.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.error, "AGENT_RECOVERY_FORBIDDEN");

    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "blocked");
  });

  test("6. Successful human recovery records an audit entry and canonical recovery log", async () => {
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect and updated specification document.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    assert.equal(res.success, true);
    assert.equal(res.exitCode, 0);

    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "in_progress");
    assert.equal(state.last_updated.actor_type, "human");
    assert.equal(state.last_updated.updated_by, "human:Jane Doe");
    assert.ok(state.last_updated.reason.includes("Remediated PRD syntax defect"));

    // Verify canonical recovery audit log exists on disk
    const logs = fs.readdirSync(path.join(playbookDir, "logs"));
    const recoveryLog = logs.find((f) => f.startsWith("recovery-stage-0-"));
    assert.ok(recoveryLog, "Recovery audit log must be created on disk");

    const logContent = fs.readFileSync(path.join(playbookDir, "logs", recoveryLog), "utf-8");
    assert.ok(logContent.includes("=== PLAYBOOK CONTROLLED OPERATOR-ATTESTED RECOVERY AUDIT LOG ==="));
    assert.ok(logContent.includes("Attested Operator:    Jane Doe"));
    assert.ok(logContent.includes("Attested Role:        Lead Systems Architect"));
    assert.ok(logContent.includes("Identity Confidence:  Operator-attested via interactive TTY session (Non-cryptographic"));
    assert.ok(logContent.includes("Previous Status:      blocked"));
    assert.ok(logContent.includes("New Status:           in_progress"));
  });

  test("7. Successful recovery returns the stage to in_progress, NOT approved", async () => {
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect and updated specification document.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    assert.equal(res.success, true);

    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "in_progress");
    assert.notEqual(state.stage_status, "approved");
    assert.equal(state.current_stage_detail.human_approval.status, "not_requested");
  });

  test("8. Gate execution becomes available after recovery and succeeds", async () => {
    // 1. Recover stage
    const recRes = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect and updated specification document.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });
    assert.equal(recRes.success, true);

    // 2. Gate execution is permitted now!
    const runner = new QualityGateRunner(tmpDir);
    const report = await runner.run();

    assert.equal(report.overall_outcome, "passed");
    assert.equal(report.summary.passed, 1);

    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.current_stage_detail.deliverables[0].status, "verified");
    assert.equal(state.current_stage_detail.deliverables[0].validation_status, "passed");
  });

  test("9. Failed evidence from the original halt remains auditable after recovery and re-run", async () => {
    // 1. Recover
    await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    // 2. Re-run check to earn passing evidence
    const runner = new QualityGateRunner(tmpDir);
    await runner.run();

    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    const deliv = state.current_stage_detail.deliverables[0];

    // Both historical failed evidence AND new passing evidence are present (append-only)
    assert.equal(deliv.evidence.length, 2);
    assert.equal(deliv.evidence[0].result, "failed");
    assert.equal(deliv.evidence[1].result, "passed");

    // The original failed log remains on disk
    assert.ok(fs.existsSync(path.join(tmpDir, deliv.evidence[0].evidence_ref)));
    // The new passed log exists on disk
    assert.ok(fs.existsSync(path.join(tmpDir, deliv.evidence[1].evidence_ref)));
  });

  test("10. Non-blocked stage cannot be recovered (STAGE_NOT_BLOCKED)", async () => {
    // 1. Recover once -> stage is now in_progress
    await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Remediated PRD syntax defect.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    // 2. Attempt recovering again when not blocked
    const res = await runGateRecover({
      cwd: tmpDir,
      isTTY: true,
      operator: "Jane Doe",
      role: "Lead Systems Architect",
      reason: "Redundant recovery attempt.",
      confirmationPhrase: "CONFIRM RECOVER STAGE 0",
    });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.error, "STAGE_NOT_BLOCKED");
  });

  test("11. WAL crash during COMMITTING phase rolls forward both state and audit log atomically without loss", async () => {
    const journalPath = path.join(playbookDir, "tx-journal.json");

    // Crashing transaction manager that fails between target writes (file 0 written, file 1 not yet)
    const crashingTxManager = new WriteAheadTransactionManager({
      targetDir: tmpDir,
      faultInjection: {
        failBetweenTargetWrites: true,
      },
    });

    await assert.rejects(
      async () => {
        await recoverBlockedStage(tmpDir, {
          operatorName: "Jane Doe",
          role: "Lead Systems Architect",
          reason: "Remediated PRD syntax defect with crash injection.",
          confirmationPhrase: "CONFIRM RECOVER STAGE 0",
          txManager: crashingTxManager,
        });
      },
      (err: any) => err.code === "TRANSACTION_COMMIT_FAILED"
    );

    // Journal must exist in COMMITTING phase
    assert.ok(fs.existsSync(journalPath), "Journal must exist after simulated crash during commit");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    assert.equal(journal.phase, "COMMITTING");

    // Clean transaction manager performs crash recovery (roll forward)
    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tmpDir });
    await recoveryTxManager.lockManager.withLock(async (lockHandle) => {
      const recResult = await recoveryTxManager.recover(lockHandle);
      assert.ok(recResult, "Crash recovery result must be returned");
      assert.equal(recResult.recovered, true);
      assert.equal(recResult.actionTaken, "rolled_forward");
    });

    // Journal must be cleaned up
    assert.ok(!fs.existsSync(journalPath), "Journal must be deleted after roll-forward recovery");

    // Both state.json and audit log must be committed and valid
    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "in_progress");
    assert.ok(state.last_updated.reason.includes("Remediated PRD syntax defect"));

    const logs = fs.readdirSync(path.join(playbookDir, "logs"));
    const recoveryLog = logs.find((f) => f.startsWith("recovery-stage-0-"));
    assert.ok(recoveryLog, "Recovery audit log must exist after roll forward");

    const logContent = fs.readFileSync(path.join(playbookDir, "logs", recoveryLog), "utf-8");
    assert.ok(logContent.includes("=== PLAYBOOK CONTROLLED OPERATOR-ATTESTED RECOVERY AUDIT LOG ==="));
    assert.ok(logContent.includes("Attested Operator:    Jane Doe"));
  });

  test("12. WAL crash in PREPARED phase rolls back both state and audit log, leaving stage blocked with zero mutations", async () => {
    const journalPath = path.join(playbookDir, "tx-journal.json");

    // Crashing transaction manager that fails after journal is prepared (before committing)
    const crashingTxManager = new WriteAheadTransactionManager({
      targetDir: tmpDir,
      faultInjection: {
        failAfterJournalPrepared: true,
      },
    });

    await assert.rejects(
      async () => {
        await recoverBlockedStage(tmpDir, {
          operatorName: "Jane Doe",
          role: "Lead Systems Architect",
          reason: "Remediated PRD syntax defect with preparation crash.",
          confirmationPhrase: "CONFIRM RECOVER STAGE 0",
          txManager: crashingTxManager,
        });
      },
      (err: any) => err.code === "TRANSACTION_PREPARATION_FAILED"
    );

    // Journal must exist in PREPARED phase
    assert.ok(fs.existsSync(journalPath), "Journal must exist after simulated crash in PREPARED phase");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    assert.equal(journal.phase, "PREPARED");

    // Clean transaction manager performs crash recovery (roll back)
    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tmpDir });
    await recoveryTxManager.lockManager.withLock(async (lockHandle) => {
      const recResult = await recoveryTxManager.recover(lockHandle);
      assert.ok(recResult, "Crash recovery result must be returned");
      assert.equal(recResult.recovered, true);
      assert.equal(recResult.actionTaken, "rolled_back");
    });

    // Journal must be cleaned up
    assert.ok(!fs.existsSync(journalPath), "Journal must be deleted after rollback");

    // State remains blocked; zero recovery audit logs created
    const state = JSON.parse(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"));
    assert.equal(state.stage_status, "blocked");

    const logs = fs.readdirSync(path.join(playbookDir, "logs"));
    const recoveryLogs = logs.filter((f) => f.startsWith("recovery-stage-0-"));
    assert.equal(recoveryLogs.length, 0, "No recovery audit logs must exist after rollback");
  });

  test("13. Operator identity boundary: rejects known agent labels, accepts declared name as operator attestation", async () => {
    // 1. Known agent labels are blocked
    await assert.rejects(
      async () => {
        await recoverBlockedStage(tmpDir, {
          operatorName: "copilot",
          role: "AI Assistant",
          reason: "Attempting automated self-recovery.",
        });
      },
      (err: any) => err.code === "AGENT_RECOVERY_FORBIDDEN"
    );

    // 2. An arbitrary non-agent name is accepted via operator attestation (no cryptographic auth)
    const res = await recoverBlockedStage(tmpDir, {
      operatorName: "Alice Unverified Operator",
      role: "Consultant",
      reason: "Remediated PRD syntax defect and updated specifications.",
    });

    assert.equal(res.success, true);
    assert.equal(res.operatorName, "Alice Unverified Operator");

    // The audit log explicitly records the non-cryptographic attestation model
    const logContent = fs.readFileSync(path.join(tmpDir, res.auditLogPath), "utf-8");
    assert.ok(logContent.includes("Attested Operator:    Alice Unverified Operator"));
    assert.ok(logContent.includes("Identity Confidence:  Operator-attested via interactive TTY session (Non-cryptographic"));
  });
});
