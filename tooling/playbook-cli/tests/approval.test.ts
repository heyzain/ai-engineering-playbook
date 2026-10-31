import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { approveGate, rejectGate, checkGateEligibility, isForbiddenAgentName } from "../src/core/approval.js";
import { runApprove } from "../src/commands/approve.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  computeSha256,
} from "../src/core/transaction/index.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { ProjectState } from "../src/types/state.js";

describe("Gate Approval Engine & CLI (playbook approve)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-approve-test-"));
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

  // Scenario 1: Successful gate approval
  test("Scenario 1: Successful gate approval updates state to approved, creates sidecar, and finalizes WAL", async () => {
    setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    const res = await approveGate(tempDir, {
      gate: 0,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      confirmationPhrase: "CONFIRM APPROVAL GATE 0",
      isTTY: true,
    });

    assert.equal(res.success, true);
    assert.ok(res.fingerprint?.startsWith("sha256:"));
    assert.ok(res.txId?.startsWith("tx-"));

    // Verify state.json
    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.stage_status, "approved");
    assert.equal(state.current_stage_detail.human_approval.status, "approved");
    assert.equal(state.current_stage_detail.human_approval.approved_by, "Alice Human");
    assert.equal(state.current_stage_detail.human_approval.role, "Lead Engineer");
    assert.equal(state.current_stage_detail.human_approval.decision, "GATE_APPROVED");
    assert.equal(state.last_updated.actor_type, "human");

    // Verify sidecar
    const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
    assert.ok(fs.existsSync(sidecarPath));
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.equal(sidecar.fingerprint, res.fingerprint);
    assert.equal(sidecar.gate, 0);
    assert.equal(sidecar.approved_by, "Alice Human");
    assert.equal(sidecar.role, "Lead Engineer");

    // Verify WAL journal is cleaned up
    const journalPath = path.join(tempDir, DEFAULT_PATHS.transactionJournalFile);
    assert.ok(!fs.existsSync(journalPath));

    // Verify lock is released
    const lockPath = path.join(tempDir, DEFAULT_PATHS.transactionLockFile);
    assert.ok(!fs.existsSync(lockPath));
  });

  // Scenario 2: Non-TTY approval rejection
  test("Scenario 2: Non-TTY approval invocation is rejected with TTY_REQUIRED and zero mutations", async () => {
    setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // via runApprove
    const res = await runApprove({
      cwd: tempDir,
      isTTY: false,
      gate: 0,
      reviewer: "Alice Human",
      role: "Lead Engineer",
    });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.error, "TTY_REQUIRED");

    // via approveGate directly
    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: false,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TTY_REQUIRED");
        return true;
      }
    );

    // Verify state unchanged
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "pending_review");
    assert.ok(!fs.existsSync(path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile)));
  });

  // Scenario 3: Incorrect confirmation phrase
  test("Scenario 3: Incorrect confirmation phrase aborts with zero mutations", async () => {
    setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    const res = await approveGate(tempDir, {
      gate: 0,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      confirmationPhrase: "yes", // incorrect phrase
      isTTY: true,
    });

    assert.equal(res.success, false);
    assert.match(res.error || "", /Confirmation phrase mismatch/);

    // Verify state unchanged
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "pending_review");
    assert.ok(!fs.existsSync(path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile)));
  });

  // Scenario 4: Agent self-approval rejection
  test("Scenario 4: Agent self-approval is strictly prohibited for known AI/agent patterns", async () => {
    setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    const forbiddenNames = [
      "Agent Smith",
      "AutoBot",
      "playbook-agent",
      "ci-bot",
      "system-orchestrator",
      "ai-assistant",
      "Claude-Agent",
      "autonomous-bot-v1",
    ];

    for (const forbidden of forbiddenNames) {
      assert.equal(isForbiddenAgentName(forbidden), true);

      await assert.rejects(
        async () => {
          await approveGate(tempDir, {
            gate: 0,
            reviewerName: forbidden,
            role: "Autonomous Agent",
            confirmationPhrase: "CONFIRM APPROVAL GATE 0",
            isTTY: true,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof TransactionError);
          assert.equal(err.code, "AGENT_APPROVAL_PROHIBITED");
          return true;
        }
      );
    }

    // Verify state remained untouched
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "pending_review");
    assert.ok(!fs.existsSync(path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile)));
  });

  // Scenario 5: Missing or unverified deliverables
  test("Scenario 5: Incomplete or unverified deliverables block gate approval with GATE_CRITERIA_UNMET", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // Mark one deliverable as in_progress
    state.current_stage_detail.deliverables[0].status = "in_progress";
    state.current_stage_detail.deliverables[0].validation_status = "unvalidated";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "GATE_CRITERIA_UNMET");
        return true;
      }
    );

    // Verify state was not approved
    const stateAfter: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.notEqual(stateAfter.stage_status, "approved");
    assert.ok(!fs.existsSync(path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile)));
  });

  // Scenario 5a: Missing mandatory baseline deliverable
  test("Scenario 5a: Missing mandatory baseline deliverable rejects with GATE_REQUIRED_DELIVERABLE_MISSING", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // Remove PRD-CORE (mandatory for Stage 0)
    state.current_stage_detail.deliverables = state.current_stage_detail.deliverables.filter(
      (d) => d.id !== "PRD-CORE"
    );
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "GATE_REQUIRED_DELIVERABLE_MISSING");
        return true;
      }
    );
  });

  // Scenario 5b: Optional deliverable cannot substitute for missing mandatory deliverable
  test("Scenario 5b: Optional deliverable cannot substitute for missing mandatory baseline deliverable", async () => {
    const { state, statePath, evidencePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // Filter out PRD-CORE, add an optional/extra deliverable
    state.current_stage_detail.deliverables = state.current_stage_detail.deliverables.filter(
      (d) => d.id !== "PRD-CORE"
    );
    state.current_stage_detail.deliverables.push({
      id: "OPTIONAL-DISCOVERY-DOC",
      name: "Optional Discovery Notes",
      description: "Non-baseline exploratory findings",
      status: "verified",
      validation_status: "passed",
      artifact_path: "docs/prd/notes.md",
      exception_ref: null,
      evidence: [
        {
          requirement_id: null,
          type: "automated_test",
          procedure: "npm test",
          result: "passed",
          summary: "Passing test",
          exit_code: 0,
          evidence_ref: ".playbook/logs/test-stage-0.log",
          evidence_hash: computeSha256(fs.readFileSync(evidencePath, "utf-8")),
          verified_at: "2026-10-31T10:30:00.000Z",
          verified_by: "human:Alice Human",
          actor_type: "human",
        },
      ],
    });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "GATE_REQUIRED_DELIVERABLE_MISSING");
        return true;
      }
    );
  });

  // Scenario 5c: Validly waived mandatory deliverable clears gate approval
  test("Scenario 5c: Validly waived mandatory deliverable with active exception clears gate approval", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // Mark PRD-CORE as waived with valid active exception
    const excId = "EXC-20261031-001";
    const prdCore = state.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE")!;
    prdCore.status = "waived";
    prdCore.validation_status = "waived";
    prdCore.exception_ref = excId;
    prdCore.evidence = [];

    state.current_stage_detail.exceptions = [
      {
        exception_id: excId,
        title: "Authorized waiver for PRD-CORE",
        waived_requirement: "PRD-CORE",
        status: "active",
        path: `docs/exceptions/${excId}.md`,
        expiration_date: "2030-12-31",
        authorized_by: "Security Lead",
        authorized_at: "2026-10-01T00:00:00.000Z",
      },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    const res = await approveGate(tempDir, {
      gate: 0,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      confirmationPhrase: "CONFIRM APPROVAL GATE 0",
      isTTY: true,
    });

    assert.equal(res.success, true);
    assert.ok(res.fingerprint?.startsWith("sha256:"));
  });

  // Scenario 6: Expired or revoked exceptions
  test("Scenario 6: Expired or revoked exceptions block gate approval with EXCEPTION_EXPIRED", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "in_progress" });

    // Add an expired exception
    state.current_stage_detail.exceptions = [
      {
        exception_id: "EXC-20261001-001",
        title: "Temporary PRD-CORE waiver",
        waived_requirement: "PRD-CORE",
        status: "expired",
        path: "docs/exceptions/EXC-20261001-001.md",
        expiration_date: "2026-10-01",
        authorized_by: "Security Lead",
        authorized_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXCEPTION_EXPIRED");
        return true;
      }
    );

    // Now test with revoked status
    state.current_stage_detail.exceptions[0].status = "revoked";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXCEPTION_EXPIRED");
        return true;
      }
    );
  });

  // Scenario 7: Blocking RFC
  test("Scenario 7: Unresolved blocking RFC blocks gate approval with RFC_BLOCKING_UNRESOLVED", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "in_progress" });

    state.current_stage_detail.rfcs = [
      {
        rfc_id: "RFC-20261031-001",
        title: "Database Partitioning Strategy Ambiguity",
        status: "pending_decision",
        is_blocking: true,
        path: "docs/rfcs/RFC-20261031-001.md",
      },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "RFC_BLOCKING_UNRESOLVED");
        return true;
      }
    );
  });

  // Scenario 8: Failed evidence verification
  test("Scenario 8: Missing evidence file or mismatched hash blocks gate approval", async () => {
    const { state, statePath, evidencePath } = setupStageProject(tempDir, {
      stage: 0,
      status: "pending_review",
    });

    // 8a: Missing evidence file on disk
    fs.unlinkSync(evidencePath);

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EVIDENCE_FILE_MISSING");
        return true;
      }
    );

    // 8b: Evidence file exists but hash mismatches
    fs.writeFileSync(evidencePath, "tampered content that does not match recorded sha\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EVIDENCE_HASH_MISMATCH");
        return true;
      }
    );
  });

  // Scenario 8c: Exit package missing required sections
  test("Scenario 8c: Exit package missing required sections rejects with EXIT_PACKAGE_INCOMPLETE", async () => {
    const { exitPackagePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // Missing Section 3: Deliverables Manifest
    const incompleteContent = `# Stage Gate Exit Package — Stage 0

## 1. Executive Summary & Objectives
Summary content here that exceeds minimum length requirements for the structural checks.

## 4. Verifiable Validation Evidence
Evidence details here with passing results.

## 9. Traceability & Sign-Off Record
All sign-offs verified.
`.padEnd(250, " ");

    fs.writeFileSync(exitPackagePath, incompleteContent, "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
        assert.match(err.message, /Deliverables Manifest/i);
        return true;
      }
    );
  });

  // Scenario 8d: Exit package with unresolved placeholders
  test("Scenario 8d: Exit package with unresolved placeholders rejects with EXIT_PACKAGE_INCOMPLETE", async () => {
    const { exitPackagePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    fs.appendFileSync(exitPackagePath, "\n<!-- TODO: Complete architectural risk assessment -->\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
        assert.match(err.message, /placeholder/i);
        return true;
      }
    );
  });

  // Scenario 8e: Truncated exit package (< 200 bytes)
  test("Scenario 8e: Truncated exit package (< 200 bytes) rejects with EXIT_PACKAGE_INCOMPLETE", async () => {
    const { exitPackagePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    fs.writeFileSync(exitPackagePath, "# Short exit package\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
        assert.match(err.message, /200 bytes/i);
        return true;
      }
    );
  });

  // Scenario 8f: Evidence record with result 'failed'
  test("Scenario 8f: Evidence record with result 'failed' rejects with EVIDENCE_RESULT_FAILED", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    state.current_stage_detail.deliverables[0].evidence[0].result = "failed";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EVIDENCE_RESULT_FAILED");
        return true;
      }
    );
  });

  // Scenario 8g: Evidence record with result 'inconclusive'
  test("Scenario 8g: Evidence record with result 'inconclusive' rejects with EVIDENCE_RESULT_FAILED", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    state.current_stage_detail.deliverables[0].evidence[0].result = "inconclusive";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EVIDENCE_RESULT_FAILED");
        return true;
      }
    );
  });

  // Scenario 8h: Null or absent hash in automated evidence
  test("Scenario 8h: Null or absent hash in automated evidence rejects with EVIDENCE_HASH_MISMATCH", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    state.current_stage_detail.deliverables[0].evidence[0].evidence_hash = null;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EVIDENCE_HASH_MISMATCH");
        return true;
      }
    );
  });

  // Scenario 8i: Manual review evidence without hash is accepted when file exists on disk
  test("Scenario 8i: Manual review evidence without hash is accepted when file exists on disk", async () => {
    const { state, statePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    const manualDocRelPath = "docs/prd/architecture-checklist.md";
    const manualDocAbsPath = path.join(tempDir, manualDocRelPath);
    fs.writeFileSync(manualDocAbsPath, "# Architecture Checklist\nManual inspection completed.\n", "utf-8");

    state.current_stage_detail.deliverables[0].evidence[0] = {
      requirement_id: null,
      type: "architecture_review",
      procedure: "Manual review of architecture invariants against constitution",
      result: "passed",
      summary: "Manual architectural inspection passed.",
      exit_code: null,
      evidence_ref: manualDocRelPath,
      evidence_hash: null,
      verified_at: "2026-10-31T10:30:00.000Z",
      verified_by: "human:Alice Human",
      actor_type: "human",
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    const res = await approveGate(tempDir, {
      gate: 0,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      confirmationPhrase: "CONFIRM APPROVAL GATE 0",
      isTTY: true,
    });

    assert.equal(res.success, true);
    assert.ok(res.fingerprint?.startsWith("sha256:"));
  });

  // Scenario 8j: Multi-evidence deliverable where second evidence fails
  test("Scenario 8j: Multi-evidence deliverable where second evidence fails rejects with EVIDENCE_RESULT_FAILED", async () => {
    const { state, statePath, evidencePath } = setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    const secondLogRelPath = ".playbook/logs/secondary-test.log";
    fs.writeFileSync(path.join(tempDir, secondLogRelPath), "Secondary test suite log\n", "utf-8");

    const ev1 = state.current_stage_detail.deliverables[0].evidence[0];
    const ev2 = {
      requirement_id: null,
      type: "automated_test" as const,
      procedure: "npm run test:integration",
      result: "failed" as const,
      summary: "Integration test failed.",
      exit_code: 1,
      evidence_ref: secondLogRelPath,
      evidence_hash: computeSha256("Secondary test suite log\n"),
      verified_at: "2026-10-31T10:35:00.000Z",
      verified_by: "human:Alice Human",
      actor_type: "human" as const,
    };

    state.current_stage_detail.deliverables[0].evidence = [ev1, ev2];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EVIDENCE_RESULT_FAILED");
        return true;
      }
    );
  });

  // Scenario 9: Rejection persistence
  test("Scenario 9: Gate rejection reverts stage to in_progress, records conditions, and purges sidecar", async () => {
    const { statePath, sidecarPath } = setupStageProject(tempDir, {
      stage: 0,
      status: "pending_review",
    });

    // Pre-create an approval sidecar (e.g. from earlier or staged test)
    fs.writeFileSync(sidecarPath, '{"gate": 0, "fingerprint": "dummy"}\n', "utf-8");
    assert.ok(fs.existsSync(sidecarPath));

    const res = await rejectGate(tempDir, {
      gate: 0,
      reviewerName: "Bob Auditor",
      role: "Security Lead",
      conditions: "Add automated fuzzing test suite and resolve PRD risk section.",
      isTTY: true,
    });

    assert.equal(res.success, true);

    // Read state
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.stage_status, "in_progress");
    assert.equal(state.current_stage_detail.exit_package.status, "drafted");
    assert.equal(state.current_stage_detail.human_approval.status, "rejected");
    assert.equal(state.current_stage_detail.human_approval.decision, "REJECTED");
    assert.equal(state.current_stage_detail.human_approval.approved_by, "Bob Auditor");
    assert.equal(
      state.current_stage_detail.human_approval.conditions,
      "Add automated fuzzing test suite and resolve PRD risk section."
    );

    // Verify sidecar was purged
    assert.ok(!fs.existsSync(sidecarPath));
  });

  // Scenario 10: Crash recovery during approval
  test("Scenario 10: Crash during COMMITTING phase of approval is rolled forward cleanly upon recovery", async () => {
    setupStageProject(tempDir, { stage: 0, status: "pending_review" });

    // Fault-injected manager: crashes between target writes in COMMITTING phase
    const crashingTxManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failBetweenTargetWrites: true,
      },
    });

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 0,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 0",
          isTTY: true,
          txManager: crashingTxManager,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Journal should be in COMMITTING phase on disk
    const journalPath = path.join(tempDir, DEFAULT_PATHS.transactionJournalFile);
    assert.ok(fs.existsSync(journalPath));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    assert.equal(journal.phase, "COMMITTING");
    assert.equal(journal.action, "APPROVE_GATE");

    // Clean recovery manager recovers the transaction
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();
    const recResult = await recoveryManager.recover(lock);
    await lock.release();

    assert.equal(recResult.recovered, true);
    assert.equal(recResult.actionTaken, "rolled_forward");

    // Live state and sidecar are now fully committed and consistent
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "approved");
    assert.equal(state.current_stage_detail.human_approval.decision, "GATE_APPROVED");

    const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
    assert.ok(fs.existsSync(sidecarPath));
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.equal(sidecar.gate, 0);
    assert.equal(sidecar.approved_by, "Alice Human");

    // Journal cleaned up
    assert.ok(!fs.existsSync(journalPath));
  });
});
