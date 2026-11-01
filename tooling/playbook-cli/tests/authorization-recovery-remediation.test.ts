import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { DEFAULT_PATHS, STAGE_NAMES, type ProjectState, type ProjectManifest } from "../src/index.js";
import { executeStagePivot } from "../src/core/pivot.js";
import { runPivot } from "../src/commands/pivot.js";
import { approveGate, isForbiddenAgentName } from "../src/core/approval.js";
import { WriteAheadTransactionManager } from "../src/core/transaction/transaction-manager.js";
import { TransactionError } from "../src/core/transaction/types.js";
import { readJournal } from "../src/core/transaction/journal.js";

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
  fs.mkdirSync(docsDir, { recursive: true });
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

describe("Task 004F.2.4-B.3.2 — Authorization Contract & WAL Recovery Remediation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-remediation-test-"));
    bootstrapStage1MaintenanceProject(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("1. H3 — Human Authorization Contract & Distinction", () => {
    test("1. Recognized AI identities are rejected with AGENT_APPROVAL_PROHIBITED", () => {
      const recognizedAgents = [
        "deepseek",
        "DeepSeekCoder",
        "mistral",
        "Mistral-Large",
        "grok",
        "Grok-2",
        "llama",
        "Llama-3-Agent",
        "qwen",
        "Qwen-Coder",
        "chatgpt",
        "gemini",
        "copilot",
        "antigravity",
        "claude-agent",
        "openai-bot",
        "anthropic-assistant",
        "synthetic-worker",
      ];

      for (const name of recognizedAgents) {
        assert.strictEqual(
          isForbiddenAgentName(name),
          true,
          `Expected "${name}" to be recognized as forbidden agent`
        );
      }
    });

    test("2. Unknown agent names: headless calls are blocked by TTY_REQUIRED", async () => {
      // Even if an unknown agent name does not match the keyword blacklist,
      // a headless or automated execution cannot approve without an interactive TTY session.
      const res = await runPivot({
        cwd: tempDir,
        stage: 0,
        isTTY: false,
        authorizedBy: "UnlistedCustomAgent42",
        role: "Lead Architect",
        reason: "Headless execution attempt",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert.strictEqual(res.error, "TTY_REQUIRED");

      // Verify zero filesystem mutations
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    });

    test("3. AI identity claiming a legitimate human role is rejected", async () => {
      // AI name with legitimate engineering role
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "DeepSeek-AI",
            role: "Principal Systems Architect",
            reason: "Domain pivot",
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

      // Human name with automated AI role
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "AI Autonomous Coding Assistant",
            reason: "Domain pivot",
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

    test("4. Missing or whitespace-only identity and role are rejected", async () => {
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "   ",
            role: "Lead Architect",
            reason: "Valid reason",
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

      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "   ",
            reason: "Valid reason",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
            isTTY: true,
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "PIVOT_ABORTED");
          return true;
        }
      );
    });

    test("5. Headless programmatic approval with isTTY: false is rejected with TTY_REQUIRED", async () => {
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "Lead Architect",
            reason: "Headless API call",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
            isTTY: false,
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "TTY_REQUIRED");
          return true;
        }
      );

      // Verify zero filesystem mutations
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    });

    test("6. Explicit TTY-based human approval succeeds and records human-attested metadata", async () => {
      const res = await executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Lead Systems Architect",
        reason: "Valid B2B domain pivot",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        isTTY: true,
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.toStage, 0);

      // Verify audit document records human_attestation and its limitations
      const auditContent = fs.readFileSync(path.join(tempDir, res.auditRef), "utf-8");
      assert(auditContent.includes("- **Authorization Method**: `human_attestation`"));
      assert(auditContent.includes("- **Attestation Status**: `human-attested`"));
      assert(auditContent.includes("- **Attestation Limitations**: Caller identity is human-asserted; no cryptographic human authentication was performed."));

      // Verify state.json records human-attested reason
      const stateContent: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8")
      );
      assert(stateContent.last_updated.reason.includes("(human-attested)"));
    });

    test("7. Existing valid approval workflows remain functional without regression", async () => {
      // Set PRD applicability to VALID so Stage 1 gate progression is allowed
      fs.writeFileSync(
        path.join(tempDir, "docs/prd/PRD-CORE-ASSESSMENT.md"),
        `# Foundational PRD Applicability Assessment\nMilestone: M-1.1.0\nAuthor: Alice Engineer\nApplicability: VALID\n\n## Rationale\nFoundational formulation remains valid.\n`,
        "utf-8"
      );

      // Create valid exit package & evidence for Stage 1 approval test
      const exitPackagePath = path.join(tempDir, "docs/gates/GATE-1-EXIT.md");
      const exitPackageContent = `# Stage Gate Exit Package — Stage 1: Requirements Definition

## 1. Executive Summary & Objectives
This exit package documents all verified deliverables and supporting evidence for Stage 1.
All mandatory engineering invariants and gate criteria have been satisfied in full compliance with the constitution.

## 2. Deliverables Manifest & Status
- Deliverables verified: REQ-SPEC.

## 3. Verifiable Validation Evidence
- Quality evidence: 100% passing automated test logs attached.
- Automated tests: 0 failures, all assertions passed.

## 4. Traceability & Sign-Off Record
- Residual risk: Zero outstanding critical or high defects.
- Review status: Ready for formal human review.
`;
      fs.writeFileSync(exitPackagePath, exitPackageContent, "utf-8");

      const logPath = path.join(tempDir, ".playbook/logs/test.log");
      const logContent = "Test execution log output for gate approval verification\n";
      fs.writeFileSync(logPath, logContent, "utf-8");
      const logHash = crypto.createHash("sha256").update(logContent).digest("hex");

      const state: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8")
      );
      state.current_stage_detail.exit_package = {
        status: "submitted_for_review",
        path: "docs/gates/GATE-1-EXIT.md",
      };
      state.current_stage_detail.deliverables[0].status = "verified";
      state.current_stage_detail.deliverables[0].validation_status = "passed";
      state.current_stage_detail.deliverables[0].evidence = [
        {
          requirement_id: "REQ-01",
          type: "automated_test",
          procedure: "test",
          result: "passed",
          summary: "All automated unit tests passed",
          exit_code: 0,
          evidence_ref: ".playbook/logs/test.log",
          evidence_hash: `sha256:${logHash}`,
          verified_at: new Date().toISOString(),
          verified_by: "test-runner",
          actor_type: "agent",
        },
      ];
      fs.writeFileSync(path.join(tempDir, ".playbook/state.json"), JSON.stringify(state, null, 2), "utf-8");

      const approveRes = await approveGate(tempDir, {
        gate: 1,
        reviewerName: "Alice Engineer",
        role: "Lead Architect",
        confirmationPhrase: "CONFIRM APPROVAL GATE 1",
        isTTY: true,
      });

      assert.strictEqual(approveRes.success, true);
      assert.ok(approveRes.fingerprint);

      // Verify sidecar records authorization_method and limitations
      const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
      assert.strictEqual(fs.existsSync(sidecarPath), true);
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      assert.strictEqual(sidecar.authorization_method, "human_attestation");
      assert(Array.isArray(sidecar.attestation_limitations));
      assert(sidecar.attestation_limitations[0].includes("Attested via interactive terminal"));
    });
  });

  describe("2. Race E — Strict Directory Policy During Staging", () => {
    test("Parent directory removed at beforeStagedFileWrite fails deterministically without recreating directory", async () => {
      const removedDir = path.join(tempDir, "docs/pivots");
      assert.strictEqual(fs.existsSync(removedDir), true);

      const txManager = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: true,
        faultInjection: {
          beforeStagedFileWrite: async (targetPath) => {
            if (targetPath.includes("docs/pivots")) {
              // Deterministically remove directory at the execution boundary
              fs.rmSync(removedDir, { recursive: true, force: true });
            }
          },
        },
      });

      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "Lead Architect",
            reason: "Race E test",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
            txManager,
            isTTY: true,
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "PIVOT_STORAGE_LAYOUT_MISSING");
          return true;
        }
      );

      // Verify directory was NOT implicitly recreated by safeWriteAndSync
      assert.strictEqual(fs.existsSync(removedDir), false, "Missing directory must NOT be recreated under strict policy");

      // Verify journal exists in PREPARING phase before recovery
      const journalBefore = readJournal(path.join(tempDir, ".playbook/tx-journal.json"));
      assert.strictEqual(journalBefore.exists, true);
      assert.strictEqual(journalBefore.journal?.phase, "PREPARING");

      // Now run recover to test the WAL state machine rollback
      const recoverRes = await txManager.lockManager.withLock((lockHandle) =>
        txManager.recover(lockHandle)
      );
      assert.strictEqual(recoverRes.recovered, true);
      assert.strictEqual(recoverRes.actionTaken, "rolled_back");

      // Verify journal is now cleaned up after rollback
      const journalAfter = readJournal(path.join(tempDir, ".playbook/tx-journal.json"));
      assert.strictEqual(journalAfter.exists, false, "Journal must be rolled back and cleaned up");
    });

    test("When requireParentDirectoriesExist is false or omitted, directory is recreated as normal", async () => {
      const normalTarget = "deep/dynamic/folder/file.txt";
      const fullDir = path.join(tempDir, "deep/dynamic/folder");
      assert.strictEqual(fs.existsSync(fullDir), false);

      const txManager = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: false,
      });

      const res = await txManager.executeTransaction("RECREATE_DIR_ALLOWED", [
        {
          targetPath: normalTarget,
          content: "file content in dynamic folder",
        },
      ]);

      assert.ok(res.txId);
      assert.strictEqual(fs.existsSync(fullDir), true, "Directory should be created when strict policy is off");
      assert.strictEqual(fs.existsSync(path.join(tempDir, normalTarget)), true);
    });
  });

  describe("3. Race F — COMMITTING Recovery", () => {
    test("Target directory removed during COMMITTING fails closed, preserves journal, and recovers upon operator restoration", async () => {
      const docsPivotsDir = path.join(tempDir, "docs/pivots");
      const journalPath = path.join(tempDir, ".playbook/tx-journal.json");

      // Step 1: Simulate external directory removal during commit phase
      const faultTxManager = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: true,
        faultInjection: {
          beforeTargetCommitRename: async (targetPath) => {
            if (targetPath.includes("docs/pivots")) {
              // Sabotage: external process deletes docs/pivots mid-commit
              fs.rmSync(docsPivotsDir, { recursive: true, force: true });
            }
          },
        },
      });

      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "Lead Architect",
            reason: "Race F mid-commit sabotage",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
            txManager: faultTxManager,
            isTTY: true,
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "COMMITTING_RECOVERY_BLOCKED");
          assert(err.message.includes("destination directory"));
          assert(err.message.includes("Operator Action Required"));
          return true;
        }
      );

      // Verify journal exists and remains durably in COMMITTING phase
      const journalAfterCrash = readJournal(journalPath);
      assert.strictEqual(journalAfterCrash.exists, true);
      assert.strictEqual(journalAfterCrash.journal?.phase, "COMMITTING");

      // Step 2: First recovery attempt (directory still missing) -> fails closed
      const recoveryTxManager = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: true,
      });

      await assert.rejects(
        async () => {
          await recoveryTxManager.executeTransaction("NEW_OP", [
            { targetPath: "test.txt", content: "hello" },
          ]);
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "COMMITTING_RECOVERY_BLOCKED");
          assert(err.message.includes("Operator Action Required: Restore or recreate directory"));
          return true;
        }
      );

      // Journal remains intact in COMMITTING phase
      const journalAfterFirstRecovery = readJournal(journalPath);
      assert.strictEqual(journalAfterFirstRecovery.exists, true);
      assert.strictEqual(journalAfterFirstRecovery.journal?.phase, "COMMITTING");

      // Step 3: Repeated recovery attempt -> fails closed identically without damaging transaction
      await assert.rejects(
        async () => {
          await recoveryTxManager.executeTransaction("NEW_OP_REPEATED", [
            { targetPath: "test.txt", content: "hello" },
          ]);
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "COMMITTING_RECOVERY_BLOCKED");
          return true;
        }
      );

      // Step 4: Operator manual restoration of missing directory
      fs.mkdirSync(docsPivotsDir, { recursive: true });

      // Step 5: Successful recovery after restoration
      const recoverResult = await recoveryTxManager.executeTransaction("OP_AFTER_RESTORE", [
        { targetPath: "docs/recovered.txt", content: "recovery successful" },
      ]);

      assert.ok(recoverResult.txId);
      assert.strictEqual(recoverResult.recovery?.recovered, true);
      assert.strictEqual(recoverResult.recovery?.actionTaken, "rolled_forward");

      // Step 6: Verify no duplicate or corrupted artifacts; pivot completed cleanly
      assert.strictEqual(fs.existsSync(journalPath), false, "Journal must be cleaned up after roll-forward");
      const stateAfterRecovery: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8")
      );
      assert.strictEqual(stateAfterRecovery.current_stage, 0);
      assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), false);
      assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/recovered.txt")), true);
    });
  });
});
