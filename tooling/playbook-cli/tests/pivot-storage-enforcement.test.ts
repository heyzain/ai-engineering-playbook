import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DEFAULT_PATHS, type ProjectState, type ProjectManifest } from "../src/index.js";
import {
  checkPivotEligibility,
  executeStagePivot,
  assertPivotStorageLayout,
  REQUIRED_PIVOT_DIRECTORIES,
} from "../src/core/pivot.js";
import { runPivot } from "../src/commands/pivot.js";
import { WriteAheadTransactionManager } from "../src/core/transaction/transaction-manager.js";
import { TransactionError } from "../src/core/transaction/types.js";

function bootstrapStage1MaintenanceProject(
  tempDir: string,
  options?: {
    omitDir?: ".playbook/pivots" | "docs/pivots" | "docs/prd/archive";
  }
): void {
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

  if (options?.omitDir !== ".playbook/pivots") {
    fs.mkdirSync(pivotsDir, { recursive: true });
  }
  if (options?.omitDir !== "docs/prd/archive") {
    fs.mkdirSync(prdArchiveDir, { recursive: true });
  }
  if (options?.omitDir !== "docs/pivots") {
    fs.mkdirSync(docsPivotsDir, { recursive: true });
  }

  const prdCorePath = path.join(prdDir, "PRD-CORE.md");
  fs.writeFileSync(
    prdCorePath,
    "# Original PRD Core Problem Statement\nInitial formulation for B2C consumer app.\n",
    "utf-8"
  );

  const assessmentPath = path.join(prdDir, "PRD-CORE-ASSESSMENT.md");
  fs.writeFileSync(
    assessmentPath,
    `# Foundational PRD Applicability Assessment\nMilestone: M-1.1.0\nAuthor: Alice Engineer\nApplicability: OUTDATED\n\n## Rationale\nDomain pivoted to enterprise B2B platform.\n`,
    "utf-8"
  );

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
    active_milestone_id: "M-1.1.0",
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
    active_lifecycle_stage: 1,
    capabilities: ["automated_testing"],
  };
  fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  const state: ProjectState = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    playbook_version: "1.0.0",
    milestone_id: "M-1.1.0",
    milestone_name: "Maintenance Milestone M-1.1.0",
    lifecycle_status: "reopened_maintenance",
    current_stage: 1,
    stage_status: "in_progress",
    current_stage_detail: {
      stage: 1,
      stage_name: "Requirements & Specification",
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
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "not_drafted",
        path: "docs/gates/GATE-1-EXIT.md",
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
    pivots: [],
  };
  fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
}

describe("Task 004F.2.4-B.2: Pivot Storage Layout Enforcement Test Suite", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-pivot-storage-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on transient Windows lock
    }
  });

  // Test 1a: Missing .playbook/pivots fails closed in preflight and public API
  test("Requirement 1 & 4: Missing .playbook/pivots fails closed with PIVOT_STORAGE_LAYOUT_MISSING and zero mutations", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { omitDir: ".playbook/pivots" });

    const missingPath = path.join(tempDir, DEFAULT_PATHS.pivotsDir);
    assert.strictEqual(fs.existsSync(missingPath), false);

    // Advisory preflight fails closed
    assert.throws(
      () => checkPivotEligibility(tempDir, 0),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes(".playbook/pivots")
    );

    // Public API execution fails closed
    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Missing pivots dir verification",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes(".playbook/pivots")
    );

    // Invariant: Directory was NOT created as an unjournaled side effect
    assert.strictEqual(fs.existsSync(missingPath), false, ".playbook/pivots must not be created");

    // Invariant: Zero journal, temporary files, or state mutations
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), true);
  });

  // Test 1b: Missing docs/pivots fails closed in preflight and public API
  test("Requirement 1 & 4: Missing docs/pivots fails closed with PIVOT_STORAGE_LAYOUT_MISSING and zero mutations", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { omitDir: "docs/pivots" });

    const missingPath = path.join(tempDir, DEFAULT_PATHS.docsPivotsDir);
    assert.strictEqual(fs.existsSync(missingPath), false);

    assert.throws(
      () => checkPivotEligibility(tempDir, 0),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes("docs/pivots")
    );

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Missing docs/pivots verification",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes("docs/pivots")
    );

    // Invariant: Directory was NOT created as an unjournaled side effect
    assert.strictEqual(fs.existsSync(missingPath), false, "docs/pivots must not be created");
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
  });

  // Test 1c: Missing docs/prd/archive fails closed in preflight and public API
  test("Requirement 1 & 4: Missing docs/prd/archive fails closed with PIVOT_STORAGE_LAYOUT_MISSING and zero mutations", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { omitDir: "docs/prd/archive" });

    const missingPath = path.join(tempDir, DEFAULT_PATHS.prdArchiveDir);
    assert.strictEqual(fs.existsSync(missingPath), false);

    assert.throws(
      () => checkPivotEligibility(tempDir, 0),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes("docs/prd/archive")
    );

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Missing docs/prd/archive verification",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      }),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes("docs/prd/archive")
    );

    // Invariant: Directory was NOT created as an unjournaled side effect
    assert.strictEqual(fs.existsSync(missingPath), false, "docs/prd/archive must not be created");
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
  });

  // Test 2: Directory disappearing between preflight and lock acquisition
  test("Requirement 3 & 4: Directory disappearing between preflight and lock acquisition aborts under lock", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    // 1. Preflight baseline captures clean valid state
    const baseline = checkPivotEligibility(tempDir, 0);
    assert.ok(baseline);

    // 2. Directory deleted out-of-band between preflight and lock acquisition
    const pivotsDir = path.join(tempDir, DEFAULT_PATHS.pivotsDir);
    fs.rmdirSync(pivotsDir);
    assert.strictEqual(fs.existsSync(pivotsDir), false);

    // 3. Execution under lock revalidates storage layout and rejects
    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "TOCTOU directory deletion",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        baseline,
      }),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes(".playbook/pivots")
    );

    // Invariant: Directory was NOT recreated
    assert.strictEqual(fs.existsSync(pivotsDir), false, ".playbook/pivots must not be recreated");
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), true);
  });

  // Test 3: Directory disappearing after lock acquisition but before prepare
  test("Requirement 3 & 4: Directory disappearing after lock acquisition before prepare aborts without journal or staging", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const docsPivotsDir = path.join(tempDir, DEFAULT_PATHS.docsPivotsDir);

    await assert.rejects(
      executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Disappearing dir under lock",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        beforePrepare: () => {
          // Simulate directory deleted while holding lock right before prepare
          fs.rmdirSync(docsPivotsDir);
        },
      }),
      (err: unknown) =>
        err instanceof TransactionError &&
        err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
        err.message.includes("docs/pivots")
    );

    // Invariant: Directory was NOT recreated
    assert.strictEqual(fs.existsSync(docsPivotsDir), false, "docs/pivots must not be recreated");
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);

    // Invariant: No target-adjacent staging or temp files exist in remaining dirs
    const pivotsFiles = fs.readdirSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir));
    assert.strictEqual(pivotsFiles.filter((f) => f.includes(".tmp")).length, 0);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), true);
  });

  // Test 4a: Transaction Manager scoped enforcement disables mkdirSync
  test("Requirement 5: txManager.prepare with requireParentDirectoriesExist fails closed without creating missing directory", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { omitDir: "docs/prd/archive" });

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const missingArchiveDir = path.join(tempDir, DEFAULT_PATHS.prdArchiveDir);
    assert.strictEqual(fs.existsSync(missingArchiveDir), false);

    await txManager.lockManager.withLock(async (lock) => {
      await assert.rejects(
        txManager.prepare(
          "TEST_OP",
          [
            {
              targetPath: "docs/prd/archive/test.md",
              content: "test content\n",
              createOnly: true,
            },
          ],
          lock,
          undefined,
          { requireParentDirectoriesExist: true }
        ),
        (err: unknown) =>
          err instanceof TransactionError &&
          err.code === "PIVOT_STORAGE_LAYOUT_MISSING" &&
          err.message.includes("docs/prd/archive")
      );
    });

    // Invariant: missingArchiveDir was NOT created
    assert.strictEqual(fs.existsSync(missingArchiveDir), false, "Directory must not be created");
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.transactionJournalFile)), false);
  });

  // Test 4b: Transaction Manager default behavior without requireParentDirectoriesExist retains mkdirSync fallback
  test("Requirement 5: txManager.prepare default behavior retains mkdirSync fallback for general workflows", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const customNestedDir = path.join(tempDir, "docs", "new-feature-folder");
    assert.strictEqual(fs.existsSync(customNestedDir), false);

    let journal: any;
    await txManager.lockManager.withLock(async (lock) => {
      journal = await txManager.prepare(
        "TEST_DEFAULT_MKDIR",
        [
          {
            targetPath: "docs/new-feature-folder/spec.md",
            content: "feature spec\n",
          },
        ],
        lock
      );
      assert.ok(journal);
      assert.strictEqual(fs.existsSync(customNestedDir), true, "Default workflow creates nested dir");
      await txManager.commit(journal, lock);
    });

    assert.strictEqual(
      fs.readFileSync(path.join(customNestedDir, "spec.md"), "utf-8"),
      "feature spec\n"
    );
  });

  // Test 5: Existing valid storage layout permits successful pivot
  test("Requirement 1: Existing valid storage layout permits clean pivot to Stage 0", async () => {
    bootstrapStage1MaintenanceProject(tempDir);

    // Verify all 3 required directories exist before execution
    assert.doesNotThrow(() => assertPivotStorageLayout(tempDir));

    const result = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "B2B domain pivot with full storage layout",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.fromStage, 1);
    assert.strictEqual(result.toStage, 0);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 0);
    assert.strictEqual(state.stage_status, "not_started");
  });

  // Test 6: CLI runPivot fails closed with TTY and PIVOT_STORAGE_LAYOUT_MISSING
  test("Requirement 4: CLI runPivot outputs PIVOT_STORAGE_LAYOUT_MISSING when directory is absent", async () => {
    bootstrapStage1MaintenanceProject(tempDir, { omitDir: ".playbook/pivots" });

    const result = await runPivot({
      cwd: tempDir,
      stage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "CLI storage layout test",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      isTTY: true,
      json: true,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.error, "PIVOT_STORAGE_LAYOUT_MISSING");
    assert.match(result.message, /\.playbook\/pivots/);

    // Invariant: Directory was NOT created
    assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir)), false);
  });
});
