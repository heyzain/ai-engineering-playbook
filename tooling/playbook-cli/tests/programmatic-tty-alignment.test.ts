import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { DEFAULT_PATHS, STAGE_NAMES, type ProjectState, type ProjectManifest } from "../src/index.js";
import { executeStagePivot } from "../src/core/pivot.js";
import { runPivot } from "../src/commands/pivot.js";
import { approveGate } from "../src/core/approval.js";
import { runApprove } from "../src/commands/approve.js";
import { advanceStage } from "../src/core/advancement.js";
import { TransactionError } from "../src/core/transaction/types.js";

function bootstrapStage1MaintenanceProject(tempDir: string): void {
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
  fs.mkdirSync(pivotsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(milestonesDir, { recursive: true });
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(prdArchiveDir, { recursive: true });
  fs.mkdirSync(docsPivotsDir, { recursive: true });
  fs.mkdirSync(gatesDir, { recursive: true });
  fs.mkdirSync(rfcsDir, { recursive: true });
  fs.mkdirSync(adrDir, { recursive: true });
  fs.mkdirSync(exceptionsDir, { recursive: true });

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
      stage_name: STAGE_NAMES[1],
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
  };
  fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
}

describe("Task 004F.2.4-B.3.4 — Programmatic TTY Default Alignment", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-tty-align-test-"));
    bootstrapStage1MaintenanceProject(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore Windows file lock
      }
    }
  });

  // Scenario 1: Explicit isTTY: true
  test("1. Explicit isTTY: true allows interactive attestation flow", async () => {
    const res = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Systems Architect",
      reason: "Validated domain pivot to Stage 0",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      isTTY: true,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.toStage, 0);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 0);
    assert.strictEqual(state.stage_status, "not_started");
    assert(state.last_updated.reason.includes("(human-attested)"));

    const auditContent = fs.readFileSync(path.join(tempDir, res.auditRef), "utf-8");
    assert(auditContent.includes("- **Authorization Method**: `human_attestation`"));
    assert(auditContent.includes("- **Attestation Status**: `human-attested`"));
  });

  // Scenario 2: Explicit isTTY: false
  test("2. Explicit isTTY: false rejects with TTY_REQUIRED and zero mutations", async () => {
    await assert.rejects(
      async () => {
        await executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "Alice Engineer",
          role: "Lead Systems Architect",
          reason: "Attempting headless programmatic pivot",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          isTTY: false,
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "TTY_REQUIRED");
        assert(err.message.includes("requires an interactive terminal session with human attestation"));
        return true;
      }
    );

    // Verify zero mutations
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    assert.strictEqual(fs.readdirSync(path.join(tempDir, ".playbook/pivots")).length, 0);
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
  });

  // Scenario 3: Omitted isTTY in a real headless child process
  test("3. Omitted isTTY in a real headless child process fails closed with TTY_REQUIRED", () => {
    // Write a standalone ESM script that imports executeStagePivot and runs it without isTTY option
    const scriptPath = path.join(tempDir, "headless-runner.mjs");
    const pivotUrl = new URL("../src/core/pivot.js", import.meta.url).href;
    const targetDirPath = tempDir.replace(/\\/g, "/");

    const scriptContent = `
      import { executeStagePivot } from "${pivotUrl}";
      async function main() {
        try {
          await executeStagePivot("${targetDirPath}", {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "Lead Systems Architect",
            reason: "Headless subprocess execution attempt",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0"
          });
          process.exit(0);
        } catch (err) {
          if (err && err.code === "TTY_REQUIRED") {
            process.exit(42);
          }
          console.error("DEBUG err in headless-runner:", err);
          process.exit(1);
        }
      }
      main();
    `;
    fs.writeFileSync(scriptPath, scriptContent, "utf-8");

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [scriptPath], {
        cwd: tempDir,
        stdio: "pipe", // non-interactive pipe: process.stdin.isTTY is false
      });
    } catch (err: any) {
      exitCode = err.status;
      if (exitCode !== 42) {
        console.error("Subprocess stderr:", err.stderr?.toString());
        console.error("Subprocess stdout:", err.stdout?.toString());
      }
    }

    assert.strictEqual(exitCode, 42, "Headless process must fail closed with exit code 42 (TTY_REQUIRED)");

    // Verify zero mutations
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    assert.strictEqual(fs.readdirSync(path.join(tempDir, ".playbook/pivots")).length, 0);
  });

  // Scenario 4: Omitted isTTY when process TTY is unavailable (direct programmatic invocation)
  test("4. Omitted isTTY in programmatic call derives process TTY and fails closed when unavailable", async () => {
    // Under node --test, process.stdin.isTTY is false/undefined.
    // Calling executeStagePivot without isTTY must reject with TTY_REQUIRED.
    await assert.rejects(
      async () => {
        await executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "Alice Engineer",
          role: "Lead Systems Architect",
          reason: "Direct invocation without isTTY",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          // isTTY is omitted
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "TTY_REQUIRED");
        return true;
      }
    );

    // Verify state unchanged
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 1);
  });

  // Scenario 5: Existing CLI interactive approval
  test("5. Existing CLI interactive approval succeeds when isTTY is true", async () => {
    const pivotRes = await runPivot({
      cwd: tempDir,
      stage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Systems Architect",
      reason: "Interactive CLI pivot",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      isTTY: true,
    });

    assert.strictEqual(pivotRes.success, true);
    assert.strictEqual(pivotRes.exitCode, 0);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.current_stage, 0);
  });

  // Scenario 6: Existing CLI piped/headless rejection
  test("6. Existing CLI piped/headless rejection enforces TTY_REQUIRED", async () => {
    // 6a: runPivot with isTTY: false
    const resPipedPivot = await runPivot({
      cwd: tempDir,
      stage: 0,
      isTTY: false,
    });
    assert.strictEqual(resPipedPivot.success, false);
    assert.strictEqual(resPipedPivot.exitCode, 1);
    assert.strictEqual(resPipedPivot.error, "TTY_REQUIRED");

    // 6b: runPivot with nonInteractive: true
    const resNonInteractivePivot = await runPivot({
      cwd: tempDir,
      stage: 0,
      nonInteractive: true,
      isTTY: true,
    });
    assert.strictEqual(resNonInteractivePivot.success, false);
    assert.strictEqual(resNonInteractivePivot.exitCode, 1);
    assert.strictEqual(resNonInteractivePivot.error, "TTY_REQUIRED");

    // 6c: runApprove with isTTY: false
    const resPipedApprove = await runApprove({
      cwd: tempDir,
      gate: 1,
      isTTY: false,
    });
    assert.strictEqual(resPipedApprove.success, false);
    assert.strictEqual(resPipedApprove.exitCode, 1);
    assert.strictEqual(resPipedApprove.error, "TTY_REQUIRED");

    // 6d: runApprove with nonInteractive: true
    const resNonInteractiveApprove = await runApprove({
      cwd: tempDir,
      gate: 1,
      nonInteractive: true,
      isTTY: true,
    });
    assert.strictEqual(resNonInteractiveApprove.success, false);
    assert.strictEqual(resNonInteractiveApprove.exitCode, 1);
    assert.strictEqual(resNonInteractiveApprove.error, "TTY_REQUIRED");
  });

  // Scenario 7: Programmatic bypass attempts
  test("7. Programmatic bypass attempts are thwarted across identity and TTY guards", async () => {
    // 7a: Unknown agent in headless environment without isTTY is blocked by TTY_REQUIRED
    await assert.rejects(
      async () => {
        await executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "AutonomousCustomAgent-99",
          role: "Lead Systems Architect",
          reason: "Bypass attempt without isTTY",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "TTY_REQUIRED");
        return true;
      }
    );

    // 7b: Known agent forging isTTY: true is blocked by AGENT_APPROVAL_PROHIBITED
    await assert.rejects(
      async () => {
        await executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "claude-agent",
          role: "Lead Systems Architect",
          reason: "Agent claiming human role with forged isTTY",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "AGENT_APPROVAL_PROHIBITED");
        return true;
      }
    );

    // 7c: Known agent role forging isTTY: true is blocked by AGENT_APPROVAL_PROHIBITED
    await assert.rejects(
      async () => {
        await executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "Bob Smith",
          role: "LLM Assistant Subagent",
          reason: "Agent role with forged isTTY",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "AGENT_APPROVAL_PROHIBITED");
        return true;
      }
    );

    // 7d: Blank name with isTTY: true is blocked by AGENT_APPROVAL_PROHIBITED
    await assert.rejects(
      async () => {
        await executeStagePivot(tempDir, {
          targetStage: 0,
          authorizedBy: "   ",
          role: "Lead Systems Architect",
          reason: "Blank reviewer name",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "AGENT_APPROVAL_PROHIBITED");
        return true;
      }
    );
  });

  // Scenario 8: Existing valid pivot and approval workflows
  test("8. Existing valid pivot and approval workflows succeed end-to-end", async () => {
    // Step 1: Execute interactive pivot to Stage 0
    const pivotRes = await executeStagePivot(tempDir, {
      targetStage: 0,
      authorizedBy: "Alice Engineer",
      role: "Lead Architect",
      reason: "Reformulating foundational problem statement",
      confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      isTTY: true,
    });
    assert.strictEqual(pivotRes.success, true);
    assert.strictEqual(pivotRes.toStage, 0);

    // Step 2: Formulate new PRD-CORE.md for Stage 0
    const newPrdCore = "# Problem Statement Document (PRD Core)\n\n## 1. Problem Definition\nB2B Platform problem definition.\n";
    fs.writeFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), newPrdCore, "utf-8");

    // Step 3: Create verification evidence for PRD-CORE deliverable
    const logPath = path.join(tempDir, ".playbook/logs/prd-review.log");
    const logContent = "PRD Core review and problem formulation completed successfully.\n";
    fs.writeFileSync(logPath, logContent, "utf-8");
    const logHash = crypto.createHash("sha256").update(logContent).digest("hex");

    // Update state deliverable to verified
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    state.current_stage_detail.deliverables[0].status = "verified";
    state.current_stage_detail.deliverables[0].validation_status = "passed";
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-0",
        type: "architecture_review",
        procedure: "architecture-review",
        result: "passed",
        summary: "Problem statement reviewed and approved",
        exit_code: 0,
        evidence_ref: ".playbook/logs/prd-review.log",
        evidence_hash: `sha256:${logHash}`,
        verified_at: new Date().toISOString(),
        verified_by: "Alice Engineer",
        actor_type: "human",
      },
    ];

    // Create exit package for Stage 0 (minimum 200 bytes)
    const exitPackagePath = path.join(tempDir, "docs/gates/GATE-0-EXIT.md");
    const exitPackageContent = `# Stage Gate Exit Package — Stage 0: Discovery & Problem Formulation

## 1. Executive Summary & Objectives
This exit package documents the reformulated problem statement following domain pivot.
All gate criteria for Stage 0 have been satisfied in full compliance with the constitution.

## 2. Deliverables Manifest & Status
- Deliverables verified: PRD-CORE.

## 3. Verifiable Validation Evidence
- Quality evidence: Manual review logs attached.
- Automated checks: 0 failures, all invariants satisfied.

## 4. Traceability & Sign-Off Record
- Residual risk: Zero critical defects.
- Review status: Ready for formal human gate approval.
`;
    fs.writeFileSync(exitPackagePath, exitPackageContent, "utf-8");
    state.current_stage_detail.exit_package = {
      status: "submitted_for_review",
      path: "docs/gates/GATE-0-EXIT.md",
    };
    fs.writeFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), JSON.stringify(state, null, 2), "utf-8");

    // Step 4: Human gate approval for Stage 0
    const approveRes = await approveGate(tempDir, {
      gate: 0,
      reviewerName: "Alice Engineer",
      role: "Lead Architect",
      confirmationPhrase: "CONFIRM APPROVAL GATE 0",
      isTTY: true,
    });
    assert.strictEqual(approveRes.success, true);
    assert.ok(approveRes.fingerprint);

    // Step 5: Advance lifecycle from Stage 0 to Stage 1
    const advanceRes = await advanceStage(tempDir);
    assert.strictEqual(advanceRes.success, true);
    assert.strictEqual(advanceRes.newStage, 1);

    const finalState: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(finalState.current_stage, 1);
    assert.strictEqual(finalState.stage_status, "not_started");
    assert.strictEqual(finalState.stage_history.length, 1);
    assert.strictEqual(finalState.stage_history[0].stage, 0);
  });
});
