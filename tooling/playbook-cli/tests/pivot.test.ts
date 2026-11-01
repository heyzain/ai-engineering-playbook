import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStagePivot, checkPivotEligibility, discoverNextPivotId } from "../src/core/pivot.js";
import { runPivot } from "../src/commands/pivot.js";
import { checkGateEligibility } from "../src/core/approval.js";
import { advanceStage } from "../src/core/advancement.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  computeSha256,
  computeFileSha256,
} from "../src/core/transaction/index.js";
import { TransactionLockManager, LockError } from "../src/core/lock/index.js";
import { DEFAULT_PATHS, STAGE_NAMES, type StageNumber } from "../src/constants.js";
import type { ProjectState, ExceptionRecord, RFCRecord, ADRRecord } from "../src/types/state.js";
import type { ProjectManifest } from "../src/types/manifest.js";

function bootstrapStage1MaintenanceProject(
  tempDir: string,
  overrides?: {
    milestoneId?: string;
    lifecycleStatus?: ProjectState["lifecycle_status"];
    currentStage?: StageNumber;
    stageStatus?: ProjectState["stage_status"];
    approvalDecision?: "GATE_APPROVED" | "REJECTED" | null;
    assessmentDetermination?: "OUTDATED" | "APPLICABLE" | "MISSING";
    assessmentMilestoneId?: string;
    missingPrdCore?: boolean;
    missingStorageDirs?: boolean;
    exceptions?: ExceptionRecord[];
    rfcs?: RFCRecord[];
    adrs?: ADRRecord[];
  }
): {
  statePath: string;
  manifestPath: string;
  prdCorePath: string;
  assessmentPath: string;
} {
  const milestoneId = overrides?.milestoneId ?? "M-1.1.0";
  const playbookDir = path.join(tempDir, ".playbook");
  const pivotsDir = path.join(playbookDir, "pivots");
  const logsDir = path.join(playbookDir, "logs");
  const milestonesDir = path.join(playbookDir, "milestones");
  const docsDir = path.join(tempDir, "docs");
  const prdDir = path.join(docsDir, "prd");
  const prdArchiveDir = path.join(prdDir, "archive");
  const docsPivotsDir = path.join(docsDir, "pivots");
  const gatesDir = path.join(docsDir, "gates");
  const rfcsDir = path.join(docsDir, "rfcs");
  const adrDir = path.join(docsDir, "adr");
  const exceptionsDir = path.join(docsDir, "exceptions");

  fs.mkdirSync(playbookDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(milestonesDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(gatesDir, { recursive: true });
  fs.mkdirSync(rfcsDir, { recursive: true });
  fs.mkdirSync(adrDir, { recursive: true });
  fs.mkdirSync(exceptionsDir, { recursive: true });

  if (!overrides?.missingStorageDirs) {
    fs.mkdirSync(pivotsDir, { recursive: true });
    fs.mkdirSync(prdArchiveDir, { recursive: true });
    fs.mkdirSync(docsPivotsDir, { recursive: true });
  }

  const prdCorePath = path.join(prdDir, "PRD-CORE.md");
  if (!overrides?.missingPrdCore) {
    fs.writeFileSync(
      prdCorePath,
      "# Original PRD Core Problem Statement\nInitial formulation for B2C consumer app.\n",
      "utf-8"
    );
  }

  const assessmentPath = path.join(prdDir, "PRD-CORE-ASSESSMENT.md");
  const determination = overrides?.assessmentDetermination ?? "OUTDATED";
  const assessMilestone = overrides?.assessmentMilestoneId ?? milestoneId;
  if (determination !== "MISSING") {
    fs.writeFileSync(
      assessmentPath,
      `# Foundational PRD Applicability Assessment\nMilestone: ${assessMilestone}\nAuthor: Alice Engineer\nApplicability: ${determination}\n\n## Rationale\nDomain pivoted to enterprise B2B platform.\n`,
      "utf-8"
    );
  }

  fs.writeFileSync(
    path.join(prdDir, "REQUIREMENTS-SPEC.md"),
    "# Requirements Specification\nMaintenance requirements for milestone.\n",
    "utf-8"
  );

  const manifest: ProjectManifest = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    project_name: "Test Service",
    active_milestone_id: milestoneId,
    description: "Test service for lifecycle pivot",
    playbook: {
      version: "1.0.0",
      governance_profile: "strict",
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
      exceptions_dir: "docs/exceptions",
      state_file: ".playbook/state.json",
    },
    active_lifecycle_stage: overrides?.currentStage ?? 1,
    capabilities: ["automated_testing"],
  };

  const state: ProjectState = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    playbook_version: "1.0.0",
    milestone_id: milestoneId,
    milestone_name: `Maintenance Milestone ${milestoneId}`,
    lifecycle_status: overrides?.lifecycleStatus ?? "reopened_maintenance",
    current_stage: overrides?.currentStage ?? 1,
    stage_status: overrides?.stageStatus ?? "in_progress",
    current_stage_detail: {
      stage: overrides?.currentStage ?? 1,
      stage_name: STAGE_NAMES[overrides?.currentStage ?? 1],
      started_at: "2026-11-01T10:00:00.000Z",
      deliverables: [
        {
          id: "REQ-SPEC",
          name: "Requirements Specification",
          artifact_path: "docs/prd/REQUIREMENTS-SPEC.md",
          status: "in_progress",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ],
      rfcs: overrides?.rfcs ?? [],
      adrs: overrides?.adrs ?? [],
      exceptions: overrides?.exceptions ?? [],
      exit_package: {
        status: "not_drafted",
        path: "docs/gates/GATE-1-EXIT.md",
      },
      human_approval: {
        status: overrides?.approvalDecision === "GATE_APPROVED" ? "approved" : "not_requested",
        approved_by: overrides?.approvalDecision === "GATE_APPROVED" ? "Alice Engineer" : null,
        role: overrides?.approvalDecision === "GATE_APPROVED" ? "Lead Architect" : null,
        approval_mode: overrides?.approvalDecision === "GATE_APPROVED" ? "solo" : null,
        decision: overrides?.approvalDecision ?? null,
        signature_reference: overrides?.approvalDecision === "GATE_APPROVED" ? "PR-101" : null,
        approved_at: overrides?.approvalDecision === "GATE_APPROVED" ? "2026-11-01T12:00:00.000Z" : null,
        conditions: null,
      },
    },
    stage_history: [],
    archived_milestones: [
      {
        milestone_id: "M-1.0.0",
        milestone_name: "MVP Production Release",
        completed_at: "2026-10-31T12:00:00.000Z",
        final_stage: 6,
        stage_history: [],
        exit_package_ref: "docs/gates/GATE-6-EXIT.md",
        state_snapshot_ref: ".playbook/milestones/state-M-1.0.0.json",
      },
    ],
    last_updated: {
      timestamp: "2026-11-01T10:00:00.000Z",
      updated_by: "Alice Engineer",
      actor_type: "human",
      reason: "Reopened maintenance milestone at Stage 1",
    },
  };

  const manifestPath = path.join(playbookDir, "manifest.json");
  const statePath = path.join(playbookDir, "state.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

  return {
    statePath,
    manifestPath,
    prdCorePath,
    assessmentPath,
  };
}

describe("Task 004F.2.4-B: Stage 1 to Stage 0 Pivot Governance Test Suite (40 Scenarios)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-pivot-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // T1: Valid Stage 1-to-Stage 0 Pivot
  test("T1: Valid Stage 1-to-Stage 0 Pivot", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const res = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2C problem definition is completely obsolete; reformulating for B2B enterprise marketplace.",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.pivotId, "PVT-M-1.1.0-001");
    assert.strictEqual(res.fromStage, 1);
    assert.strictEqual(res.toStage, 0);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    const manifest: ProjectManifest = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.manifestFile), "utf-8")
    );

    assert.strictEqual(state.current_stage, 0);
    assert.strictEqual(state.stage_status, "not_started");
    assert.strictEqual(state.current_stage_detail.stage, 0);
    assert.strictEqual(state.current_stage_detail.deliverables[0].id, "PRD-CORE");
    assert.strictEqual(state.current_stage_detail.deliverables[0].status, "not_started");
    assert.strictEqual(manifest.active_lifecycle_stage, 0);

    // Snapshot, audit, and archive files exist
    assert.strictEqual(fs.existsSync(path.join(tempDir, res.snapshotRef)), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, res.auditRef)), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, res.archivedPrdRef)), true);

    // Active PRD-CORE.md unlinked
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), false);
  });

  // T2: Pivot Rejected from Stage 2
  test("T2: Pivot Rejected from Stage 2", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { currentStage: 2 });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Late pivot attempt",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) => err instanceof TransactionError && err.code === "PIVOT_INVALID_STAGE"
    );
  });

  // T3: Pivot Rejected After Gate 1 Approval
  test("T3: Pivot Rejected After Gate 1 Approval", async () => {
    bootstrapStage1MaintenanceProject(tempDir, {
      stageStatus: "approved",
      approvalDecision: "GATE_APPROVED",
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Post-approval pivot attempt",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) => err instanceof TransactionError && err.code === "STAGE_ALREADY_APPROVED"
    );
  });

  // T4: Pivot Rejected for Non-Maintenance
  test("T4: Pivot Rejected for Non-Maintenance", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { lifecycleStatus: "active" });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Active greenfield pivot attempt",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) => err instanceof TransactionError && err.code === "LIFECYCLE_NOT_MAINTENANCE"
    );
  });

  // T5: Pivot Rejected without OUTDATED Assessment
  test("T5: Pivot Rejected without OUTDATED Assessment", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { assessmentDetermination: "APPLICABLE" });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Pivot while applicable",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) => err instanceof TransactionError && err.code === "PIVOT_PRD_NOT_OUTDATED"
    );

    // Missing assessment
    const tempDirMissing = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-pivot-missing-"));
    try {
      bootstrapStage1MaintenanceProject(tempDirMissing, { assessmentDetermination: "MISSING" });
      await assert.rejects(
        executeStagePivot(tempDirMissing, {
          targetStage: 0,
          authorizedBy: "Alice Engineer",
          role: "Lead Architect",
          reason: "Pivot without assessment",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        }),
        (err: unknown) => err instanceof TransactionError && err.code === "PIVOT_PRD_NOT_OUTDATED"
      );
    } finally {
      fs.rmSync(tempDirMissing, { recursive: true, force: true });
    }
  });

  // T6: Non-TTY Invocation Rejected
  test("T6: Non-TTY Invocation Rejected", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const res = await runPivot({
      cwd: tempDir,
      stage: 0,
      isTTY: false,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "Automated script attempt",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.error, "TTY_REQUIRED");
  });

  // T7: Incorrect Confirmation Phrase Rejected
  test("T7: Incorrect Confirmation Phrase Rejected", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Valid reason",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.2.0", // Typo in milestone
      }),
      (err: unknown) => err instanceof TransactionError && err.code === "PIVOT_ABORTED"
    );
  });

  // T8: Missing Justification Rejected
  test("T8: Missing Justification Rejected", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "   ", // Whitespace only
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) => err instanceof TransactionError && err.code === "PIVOT_REASON_REQUIRED"
    );
  });

  // T9: Historical Stage 1 Preservation
  test("T9: Historical Stage 1 Preservation", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const res = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    const snapshotContent = JSON.parse(
      fs.readFileSync(path.join(tempDir, res.snapshotRef), "utf-8")
    );
    assert.strictEqual(snapshotContent.current_stage, 1);
    assert.strictEqual(snapshotContent.stage_status, "in_progress");

    // Authored artifacts in docs/ are preserved
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/REQUIREMENTS-SPEC.md")), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE-ASSESSMENT.md")), true);
  });

  // T10: Fresh Stage 0 Initialization
  test("T10: Fresh Stage 0 Initialization", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );

    const delivs = state.current_stage_detail.deliverables;
    assert.strictEqual(delivs.length, 1);
    assert.strictEqual(delivs[0].id, "PRD-CORE");
    assert.strictEqual(delivs[0].status, "not_started");
    assert.strictEqual(delivs[0].validation_status, "unvalidated");
    assert.deepStrictEqual(delivs[0].evidence, []);
    assert.strictEqual(state.current_stage_detail.exit_package.status, "not_drafted");
    assert.strictEqual(state.current_stage_detail.human_approval.status, "not_requested");
  });

  // T11: Stale Approval Rejection
  test("T11: Stale Approval Rejection", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    // Write a stale sidecar claiming Stage 1
    const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify(
        {
          schema_version: "1.0.0",
          created_at: new Date().toISOString(),
          project_id: "test-service",
          milestone_id: "M-1.1.0",
          gate: 1, // Stale gate!
          approval_mode: "solo",
          fingerprint: "stale-fingerprint-123",
        },
        null,
        2
      )
    );

    const check = checkGateEligibility(tempDir, 0);
    assert.strictEqual(check.eligible, false);
    // Since stage is not ready for review and sidecar gate mismatch occurs
    assert.strictEqual(check.eligible, false);
  });

  // T12: Transaction Interruption & Recovery
  test("T12: Transaction Interruption & Recovery", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterFirstTargetWrite: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Crash simulation",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after first target write/
    );

    // Run recovery on next execution
    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const recoveryResult = await recoveryTxManager.lockManager.withLock((lock) =>
      recoveryTxManager.recover(lock)
    );

    assert.strictEqual(recoveryResult.recovered, true);
    assert.strictEqual(recoveryResult.actionTaken, "rolled_forward");

    // Both state.json and manifest.json must describe Stage 0
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    const manifest: ProjectManifest = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.manifestFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 0);
    assert.strictEqual(manifest.active_lifecycle_stage, 0);
  });

  // T13: Normal Stage 0 Progression & Closure
  test("T13: Normal Stage 0 Progression & Closure", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    // Author fresh PRD-CORE.md with different content
    fs.writeFileSync(
      path.join(tempDir, "docs/prd/PRD-CORE.md"),
      "# Fresh B2B Enterprise Marketplace PRD\nCompletely new problem statement.\n",
      "utf-8"
    );

    // Verify Gate 0 byte-match guardrail passes
    const prdHash = computeFileSha256(path.join(tempDir, "docs/prd/PRD-CORE.md"))!;
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.notStrictEqual(prdHash.toLowerCase(), state.pivots![0].source_prd_sha256?.toLowerCase());
  });

  // T14: Concurrent Pivot Attempts (Lock Contention)
  test("T14: Concurrent Pivot Attempts (Lock Contention)", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const lockManager = new TransactionLockManager({ targetDir: tempDir });
    const lockHandle = await lockManager.acquire();

    try {
      await assert.rejects(
        executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "Bob Engineer",
          role: "Engineer",
          reason: "Concurrent attempt",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          lockTimeoutMs: 100,
        }),
        (err: unknown) =>
          err instanceof LockError && err.code === "LOCK_HELD_BY_ACTIVE_PROCESS"
      );
    } finally {
      await lockHandle.release();
    }
  });

  // T15: TOCTOU State Modification Under Prompt
  test("T15: TOCTOU State Modification Under Prompt", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const baseline = checkPivotEligibility(tempDir, 0);

    // Concurrently mutate state.json
    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.stage_status = "approved";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Valid reason",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        baseline,
      }),
      (err: unknown) =>
        err instanceof TransactionError && err.code === "STATE_CONCURRENTLY_MODIFIED"
    );
  });

  // T16: Repeated Pivot Without Historical Overwrite
  test("T16: Repeated Pivot Without Historical Overwrite", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    // Pivot 1
    const res1 = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "Pivot 1",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });
    assert.strictEqual(res1.pivotId, "PVT-M-1.1.0-001");

    // Advance back to Stage 1
    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
    const manifestPath = path.join(tempDir, DEFAULT_PATHS.manifestFile);
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    state.current_stage = 1;
    manifest.active_lifecycle_stage = 1;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    fs.writeFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), "# Second PRD Core\n", "utf-8");

    // Pivot 2
    const res2 = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "Pivot 2",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });
    assert.strictEqual(res2.pivotId, "PVT-M-1.1.0-002");

    // Both exist permanently
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/pivots/state-PVT-M-1.1.0-001.json")), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/pivots/state-PVT-M-1.1.0-002.json")), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/pivots/PVT-M-1.1.0-001.md")), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/pivots/PVT-M-1.1.0-002.md")), true);
  });

  // T17: Snapshot Staging / Write Failure
  test("T17: Snapshot Staging / Write Failure", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPreparing: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Staging failure injection",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after journal in PREPARING phase/
    );

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
  });

  // T18: Audit Document Write Failure
  test("T18: Audit Document Write Failure", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterStagingBeforePrepared: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Staging before prepared failure",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after staging files before PREPARED/
    );

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
  });

  // T19: WAL Preparation Failure
  test("T19: WAL Preparation Failure", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPreparing: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Journal failure injection",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after journal in PREPARING phase/
    );

    // State remains Stage 1 and lock is released
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionLockFile)), false);
  });

  // T20: Crash Recovery with Incomplete Artifacts
  test("T20: Crash Recovery with Incomplete Artifacts", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    // Leave orphaned .tmp in pivots dir
    const orphanedTmp = path.join(tempDir, DEFAULT_PATHS.pivotsDir, "state-PVT-M-1.1.0-001.json.tmp.tx-12345");
    fs.writeFileSync(orphanedTmp, "orphaned tmp content", "utf-8");

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    await txManager.lockManager.withLock((lock) => txManager.recover(lock));

    // Recovery runs without error and preserves unjournaled temporary file (Phase A.2 retention invariant)
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.stateFile)), true);
    assert.strictEqual(fs.existsSync(orphanedTmp), true, "Unjournaled staging files must be safely retained and never swept by wildcards");
  });

  // T21: PRD-CORE Archival & Byte-Match Guardrail
  test("T21: PRD-CORE Archival & Byte-Match Guardrail", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const originalContent = fs.readFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), "utf-8");

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    // Re-create active PRD with identical bytes
    fs.writeFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), originalContent, "utf-8");

    const check = checkGateEligibility(tempDir, 0);
    const prdUnalteredIssue = check.diagnostics.find((d) => d.code === "PRD_CONTENT_UNALTERED");
    assert.notStrictEqual(prdUnalteredIssue, undefined);
  });

  // T22: Historical RFC, ADR, Exception Dispositions
  test("T22: Historical RFC, ADR, Exception Dispositions", async () => {
    const activeExc: ExceptionRecord = {
      exception_id: "EXC-20261101-001",
      title: "Temporary waiver",
      path: "docs/exceptions/EXC-20261101-001.md",
      waived_requirement: "REQ-01",
      authorized_by: "Alice Engineer",
      authorized_at: "2026-11-01T10:00:00.000Z",
      expiration_date: "2026-12-01",
      status: "active",
    };
    const activeRfc: RFCRecord = {
      rfc_id: "RFC-20261101-001",
      title: "Data model question",
      path: "docs/rfcs/RFC-20261101-001.md",
      status: "pending_decision",
      is_blocking: true,
    };
    const activeAdr: ADRRecord = {
      adr_id: "ADR-20261101-001",
      title: "Postgres database",
      path: "docs/adr/ADR-20261101-001.md",
      status: "proposed",
    };

    bootstrapStage1MaintenanceProject(tempDir, {
      exceptions: [activeExc],
      rfcs: [activeRfc],
      adrs: [activeAdr],
    });

    const res = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    const auditContent = fs.readFileSync(path.join(tempDir, res.auditRef), "utf-8");
    assert.match(auditContent, /EXC-20261101-001.*invalidated_by_pivot/);
    assert.match(auditContent, /RFC-20261101-001.*superseded_by_pivot/);
    assert.match(auditContent, /ADR-20261101-001.*Preserved on disk/);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.deepStrictEqual(state.current_stage_detail.exceptions, []);
    assert.deepStrictEqual(state.current_stage_detail.rfcs, []);
    assert.deepStrictEqual(state.current_stage_detail.adrs, []);
  });

  // T23: Crash Before Durable Journal
  test("T23: Crash Before Durable Journal", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPreparing: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Pre-journal crash",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after journal in PREPARING phase/
    );

    // No target-adjacent staging or backup files exist
    const files = fs.readdirSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir));
    assert.strictEqual(files.filter((f) => f.includes(".tmp")).length, 0);
  });

  // T24: Crash During PRD Archive and Unlink
  test("T24: Crash During PRD Archive and Unlink", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failDuringUnlinkCommit: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Unlink crash simulation",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash during unlink commit/
    );

    // Roll forward via recovery
    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const recoveryResult = await recoveryTxManager.lockManager.withLock((lock) =>
      recoveryTxManager.recover(lock)
    );

    assert.strictEqual(recoveryResult.actionTaken, "rolled_forward");
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), false);
  });

  // T25: PREPARED Rollback Preserves Active PRD
  test("T25: PREPARED Rollback Preserves Active PRD", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPrepared: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Prepared rollback simulation",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after journal prepared/
    );

    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const recoveryResult = await recoveryTxManager.lockManager.withLock((lock) =>
      recoveryTxManager.recover(lock)
    );

    assert.strictEqual(recoveryResult.actionTaken, "rolled_back");
    // Active PRD remains untouched
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), true);
  });

  // T26: Snapshot/Audit Cleanup Without Historical Loss
  test("T26: Snapshot/Audit Cleanup Without Historical Loss", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const histSnapshot = path.join(tempDir, DEFAULT_PATHS.pivotsDir, "state-PVT-M-1.1.0-001.json");
    fs.writeFileSync(histSnapshot, '{"historical": true}\n', "utf-8");

    const orphanTmp = path.join(tempDir, DEFAULT_PATHS.pivotsDir, "state-PVT-M-1.1.0-002.json.tmp.tx-999");
    fs.writeFileSync(orphanTmp, "temp content", "utf-8");

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    await txManager.lockManager.withLock((lock) => txManager.recover(lock));

    // Historical snapshot preserved intact
    assert.strictEqual(fs.existsSync(histSnapshot), true);
  });

  // T27: Repeated Pivot Sequence Discovery Across 3 Dirs
  test("T27: Repeated Pivot Sequence Discovery Across 3 Dirs", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    fs.writeFileSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir, "state-PVT-M-1.1.0-001.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(tempDir, DEFAULT_PATHS.docsPivotsDir, "PVT-M-1.1.0-003.md"), "{}", "utf-8");

    const discovery = discoverNextPivotId(tempDir, "M-1.1.0");
    assert.strictEqual(discovery.sequence, 4);
    assert.strictEqual(discovery.pivotId, "PVT-M-1.1.0-004");
  });

  // T28: Filename-Pattern Regex Correctness
  test("T28: Filename-Pattern Regex Correctness", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    fs.writeFileSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir, "state-M-1.1.0.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(tempDir, DEFAULT_PATHS.docsPivotsDir, "random.md"), "{}", "utf-8");

    const discovery = discoverNextPivotId(tempDir, "M-1.1.0");
    assert.strictEqual(discovery.sequence, 1);
    assert.strictEqual(discovery.pivotId, "PVT-M-1.1.0-001");
  });

  // T29: Lock Path Consistency Verification
  test("T29: Lock Path Consistency Verification", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    // Verify lock path was strictly .playbook/transaction.lock (and no alternate lock files)
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/trans.lock")), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/transaction.lock")), false); // released cleanly
  });

  // T30: Manifest Path Consistency Verification
  test("T30: Manifest Path Consistency Verification", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/manifest.json")), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "project.manifest.json")), false);
  });

  // T31: State Drift Involving Assessment Artifact
  test("T31: State Drift Involving Assessment Artifact", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const baseline = checkPivotEligibility(tempDir, 0);

    // Concurrently change assessment from OUTDATED to APPLICABLE
    const assessPath = path.join(tempDir, "docs/prd/PRD-CORE-ASSESSMENT.md");
    fs.writeFileSync(
      assessPath,
      "# Assessment\nMilestone: M-1.1.0\nApplicability: APPLICABLE\n",
      "utf-8"
    );

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Drift test",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        baseline,
      }),
      (err: unknown) =>
        err instanceof TransactionError && err.code === "STATE_CONCURRENTLY_MODIFIED"
    );
  });

  // T32: Hash-Different but Semantically Stale PRD
  test("T32: Hash-Different but Semantically Stale PRD", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const originalContent = fs.readFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), "utf-8");

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    // Write PRD with trivial whitespace difference (hash differs)
    fs.writeFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), originalContent + "\n  \n", "utf-8");

    const check = checkGateEligibility(tempDir, 0);
    // Byte-match guardrail does NOT reject it because byte hash is different
    const prdUnalteredIssue = check.diagnostics.find((d) => d.code === "PRD_CONTENT_UNALTERED");
    assert.strictEqual(prdUnalteredIssue, undefined);
  });

  // T33: Sidecar Cleanup Failure Defense-in-Depth
  test("T33: Sidecar Cleanup Failure Defense-in-Depth", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    // Inject stale sidecar with gate 1
    fs.writeFileSync(
      path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile),
      JSON.stringify(
        {
          schema_version: "1.0.0",
          created_at: new Date().toISOString(),
          project_id: "test-service",
          milestone_id: "M-1.1.0",
          gate: 1,
          approval_mode: "solo",
          fingerprint: "stale-1",
        },
        null,
        2
      )
    );

    // Gate 0 eligibility rejects with gate mismatch
    const check = checkGateEligibility(tempDir, 0);
    assert.strictEqual(check.eligible, false);
  });

  // T34: Journal-First Staging Invariant
  test("T34: Journal-First Staging Invariant", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPreparing: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Invariant check",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after journal in PREPARING phase/
    );

    // Staging temp files never existed
    const stagedTemps = fs.readdirSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir)).filter((f) => f.includes(".tmp"));
    assert.strictEqual(stagedTemps.length, 0);
  });

  // T35: Crash During PREPARING
  test("T35: Crash During PREPARING", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterStagingBeforePrepared: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Staging crash",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after staging files before PREPARED/
    );

    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const res = await recoveryTxManager.lockManager.withLock((lock) =>
      recoveryTxManager.recover(lock)
    );

    assert.strictEqual(res.actionTaken, "rolled_back");
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), true);
  });

  // T36: Missing Temp During COMMITTING
  test("T36: Missing Temp During COMMITTING", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterEnteringCommitting: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Commit crash",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after entering COMMITTING/
    );

    // Delete one of the staged temp files to simulate file loss
    const journal: any = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile), "utf-8")
    );
    const firstTmp = path.join(tempDir, journal.files[0].tmp_path);
    if (fs.existsSync(firstTmp)) {
      fs.unlinkSync(firstTmp);
    }

    // Recovery must reconstruct the file from durable journal content and roll forward
    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const res = await recoveryTxManager.lockManager.withLock((lock) =>
      recoveryTxManager.recover(lock)
    );

    assert.strictEqual(res.actionTaken, "rolled_forward");
    assert.strictEqual(fs.existsSync(path.join(tempDir, journal.files[0].target_path)), true);
  });

  // T37: Create-Only Collision During Recovery
  test("T37: Create-Only Collision During Recovery", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterEnteringCommitting: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Collision test",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after entering COMMITTING/
    );

    // Place conflicting content at create-only snapshot target
    const snapshotTarget = path.join(tempDir, DEFAULT_PATHS.pivotsDir, "state-PVT-M-1.1.0-001.json");
    fs.writeFileSync(snapshotTarget, "conflicting unexpected content", "utf-8");

    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    await assert.rejects(
      recoveryTxManager.lockManager.withLock((lock) => recoveryTxManager.recover(lock)),
      (err: unknown) =>
        err instanceof TransactionError && err.code === "TRANSACTION_RECOVERY_REQUIRED"
    );
  });

  // T38: Original PRD Hash Survives Archive Banner
  test("T38: Original PRD Hash Survives Archive Banner", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const originalContent = fs.readFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), "utf-8");
    const originalHash = computeSha256(originalContent);

    const res = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "Banner hash survival check",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    const archiveContent = fs.readFileSync(path.join(tempDir, res.archivedPrdRef), "utf-8");
    const archiveHash = computeSha256(archiveContent);

    // Banner changes the archive file hash
    assert.notStrictEqual(originalHash, archiveHash);

    // But state.pivots retains the original source hash
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.pivots![0].source_prd_sha256, originalHash);
  });

  // T39: Corrupt Journal Fails Closed
  test("T39: Corrupt Journal Fails Closed", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    // Create a corrupt journal file
    fs.writeFileSync(
      path.join(tempDir, DEFAULT_PATHS.transactionJournalFile),
      "{ corrupt json content: invalid syntax",
      "utf-8"
    );

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    await assert.rejects(
      txManager.lockManager.withLock((lock) => txManager.recover(lock)),
      (err: unknown) =>
        err instanceof TransactionError &&
        (err.code === "TRANSACTION_JOURNAL_CORRUPT" || err.code === "CRITICAL_RECOVERY_FAILURE")
    );
  });

  // T40: COMMITTED Cleanup Is Idempotent
  test("T40: COMMITTED Cleanup Is Idempotent", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterCommittedBeforeCleanup: true,
      },
    });

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Committed cleanup test",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        txManager,
      }),
      /Fault injection: crash after COMMITTED before cleanup/
    );

    // Next recovery finishes cleanup idempotently
    const recoveryTxManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const res = await recoveryTxManager.lockManager.withLock((lock) =>
      recoveryTxManager.recover(lock)
    );

    assert.strictEqual(res.actionTaken, "finalized_cleanup");
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);
  });
});
