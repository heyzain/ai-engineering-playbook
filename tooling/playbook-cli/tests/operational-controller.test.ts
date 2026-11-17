import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageProject } from "./fixtures/governance-helper.js";
import {
  startStage,
  submitStage,
  recordDeliverable,
  recordEvidence,
  recordException,
  resolveAuthoritativeVerification,
  getRequiredDisciplinesForDeliverable,
  inspectAndHashEvidenceFile,
  ControllerError,
} from "../src/core/controller/index.js";
import * as controllerModule from "../src/core/controller/index.js";
import { SchemaValidator } from "../src/core/validator.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { ProjectState, Deliverable } from "../src/types/state.js";

describe("Operational Controller Engine (Task 009B.1)", () => {
  let tempDir: string;
  let validator: SchemaValidator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-controller-test-"));
    validator = new SchemaValidator();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore transient Windows file locks
      }
    }
  });

  // Helper to create a valid exit package markdown adhering to approval validator
  function createValidExitPackage(targetPath: string, gate = 0) {
    const content = `# Stage Gate ${gate} Exit Package: Discovery & Problem Formulation

## 1. Package & Stage Identification
- Milestone: M-1.0.0
- Stage: ${gate}
- Status: Submitted for Review
- Date: 2026-11-09

## 2. Deliverables Manifest & Status
- PRD-CORE: Problem Statement Document (verified)

## 3. Verifiable Validation Evidence
- Automated Test Suite Log: Passed 100%

## 4. Architectural & Requirement Decisions (ADRs & RFCs)
- All decisions approved and recorded.

## 5. Security & Governance Invariant Verifications
- Zero critical vulnerabilities detected.

## 6. Residual Risk Assessment & Waivers
- No residual risks; all gate requirements satisfied.

## 7. Stage Gate Sign-Off & Attestation
- Signatures pending human review.
`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf-8");
  }

  // Helper to create a canonical EXC-YYYYMMDD-###.md document adhering to exception parser
  function createValidExceptionDoc(targetPath: string, options: {
    id?: string;
    scope?: string;
    status?: string;
    approvedBy?: string;
    expires?: string;
  } = {}) {
    const id = options.id ?? "EXC-20261109-001";
    const scope = options.scope ?? "PRD-CORE";
    const status = options.status ?? "Approved";
    const approvedBy = options.approvedBy ?? "Alice Lead Architect";
    const expires = options.expires ?? "2026-12-31";

    const content = `# ${id}: Exception for ${scope}

| Field | Value |
| :--- | :--- |
| **Exception ID** | \`${id}\` |
| **Exception Status** | ${status} |
| **Waived Requirement / Deliverable** | ${scope} |
| **Authorized By (Human)** | ${approvedBy} |
| **Expiration Date** | \`${expires}\` |

## Exception Rationale
Waived due to upstream regulatory dependency.
`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf-8");
  }

  /* -------------------------------------------------------------------------
   * 1. START_STAGE (§3.2)
   * ----------------------------------------------------------------------- */
  describe("1. Transition §3.2 (START_STAGE)", () => {
    test("starts stage 0 from unstarted state and initializes baseline deliverables", async () => {
      setupStageProject(tempDir, { stage: 0, status: "pending_review" });

      // Reset state to not_started
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.stage_status = "not_started";
      state.current_stage_detail.deliverables = [];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const res = await startStage({
        targetDir: tempDir,
        stage: 0,
        actor: "agent:antigravity",
        actorType: "agent",
      });

      assert.equal(res.success, true);
      assert.equal(res.stage, 0);
      assert.ok(res.txId.startsWith("tx-"));
      assert.ok(res.deliverablesCount > 0);

      // Verify state on disk
      const updatedState: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      assert.equal(updatedState.stage_status, "in_progress");
      assert.equal(updatedState.current_stage_detail.stage, 0);
      assert.ok(updatedState.current_stage_detail.deliverables.some((d) => d.id === "PRD-CORE"));

      // Invariants: initialized baseline deliverables start as not_started and unvalidated
      const prd = updatedState.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE");
      assert.ok(prd);
      assert.equal(prd.status, "not_started");
      assert.equal(prd.validation_status, "unvalidated");

      // Verify schema conformance
      const val = validator.validateState(updatedState);
      assert.equal(val.valid, true);
    });

    test("rejects starting stage when already in_progress", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      await assert.rejects(
        () => startStage({ targetDir: tempDir, stage: 0 }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "STAGE_ALREADY_IN_PROGRESS");
          return true;
        }
      );
    });

    test("rejects starting stage when in pending_review without approval", async () => {
      setupStageProject(tempDir, { stage: 0, status: "pending_review" });

      await assert.rejects(
        () => startStage({ targetDir: tempDir, stage: 0 }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "STAGE_NOT_READY_TO_START");
          return true;
        }
      );
    });

    test("rejects starting stage on a terminal completed lifecycle", async () => {
      setupStageProject(tempDir, { stage: 0, status: "approved" });
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.lifecycle_status = "completed_terminal";
      state.stage_status = "not_started";
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      await assert.rejects(
        () => startStage({ targetDir: tempDir, stage: 0 }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "LIFECYCLE_COMPLETED_TERMINAL");
          return true;
        }
      );
    });

    test("rejects starting Stage 1 if preceding Stage 0 is not approved in stage_history", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage = 1;
      state.stage_status = "not_started";
      state.stage_history = []; // Preceding stage missing
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      await assert.rejects(
        () => startStage({ targetDir: tempDir, stage: 1 }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "STAGE_PREREQUISITE_UNMET");
          return true;
        }
      );
    });

    test("starts Stage 1 successfully when Stage 0 is recorded as approved in stage_history", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage = 1;
      state.stage_status = "not_started";
      state.current_stage_detail.deliverables = [];
      state.stage_history = [
        {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          status: "approved",
          started_at: "2026-10-31T10:00:00.000Z",
          completed_at: "2026-10-31T11:00:00.000Z",
          approved_at: "2026-10-31T11:30:00.000Z",
          exit_package_ref: "docs/gates/GATE-0.md",
          human_approval: {
            approved_by: "Alice Human",
            role: "Lead Architect",
            approval_mode: "solo",
            signature_reference: "Session-1234",
          },
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const res = await startStage({ targetDir: tempDir, stage: 1 });
      assert.equal(res.success, true);
      assert.equal(res.stage, 1);

      const updatedState: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      assert.equal(updatedState.stage_status, "in_progress");
      assert.equal(updatedState.current_stage_detail.stage, 1);
      assert.ok(updatedState.current_stage_detail.deliverables.some((d) => d.id === "REQ-SPEC"));
    });
  });

  /* -------------------------------------------------------------------------
   * 2. RECORD_DELIVERABLE (§3.3)
   * ----------------------------------------------------------------------- */
  describe("2. Transition §3.3 (RECORD_DELIVERABLE)", () => {
    test("successfully records completed deliverable when artifact file exists on disk", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# Problem Statement Core\nApproved details.\n", "utf-8");

      const res = await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        name: "Problem Statement Document (PRD Core)",
        status: "completed",
        actor: "agent:antigravity",
        actorType: "agent",
      });

      assert.equal(res.success, true);
      assert.equal(res.deliverable.id, "PRD-CORE");
      assert.equal(res.deliverable.status, "completed");
      assert.equal(res.deliverable.validation_status, "unvalidated");
      assert.ok(res.txId.startsWith("tx-"));

      // Verify on disk
      const state: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
      );
      const recorded = state.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE");
      assert.ok(recorded);
      assert.equal(recorded.status, "completed");
      assert.equal(recorded.validation_status, "unvalidated");

      // Verify schema conformance
      const val = validator.validateState(state);
      assert.equal(val.valid, true);
    });

    test("successfully records in-progress deliverable without requiring file on disk", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const res = await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "CUSTOM-001",
        artifactPath: "docs/specs/custom.md",
        name: "Custom In Progress Specification",
        status: "in_progress",
      });

      assert.equal(res.success, true);
      assert.equal(res.deliverable.id, "CUSTOM-001");
      assert.equal(res.deliverable.status, "in_progress");
      assert.equal(res.deliverable.validation_status, "unvalidated");
    });

    test("rejects recording completed deliverable if file does not exist on disk", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      await assert.rejects(
        () =>
          recordDeliverable({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            artifactPath: "docs/prd/NON_EXISTENT.md",
            status: "completed",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "DELIVERABLE_ARTIFACT_MISSING");
          return true;
        }
      );
    });

    test("rejects deliverable path attempting path traversal outside project root", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      await assert.rejects(
        () =>
          recordDeliverable({
            targetDir: tempDir,
            deliverableId: "ESCAPE-001",
            artifactPath: "../outside-repo.md",
            status: "in_progress",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "TARGET_PATH_INVALID");
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------
   * 3. RECORD_EVIDENCE (§3.4)
   * ----------------------------------------------------------------------- */
  describe("3. Transition §3.4 (RECORD_EVIDENCE)", () => {
    test("successfully records passed evidence and promotes deliverable to verified", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // First record completed deliverable with cleared evidence
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Content\n", "utf-8");

      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage_detail.deliverables = [
        {
          id: "PRD-CORE",
          name: "Problem Statement Document",
          artifact_path: "docs/prd/PRD-CORE.md",
          status: "completed",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      // Create evidence file
      const logFile = path.join(tempDir, ".playbook", "logs", "test-pass.log");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, "All 42 tests passed without error\n", "utf-8");

      const res = await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "npm test",
        evidenceRef: ".playbook/logs/test-pass.log",
        result: "passed",
        actor: "agent:antigravity",
      });

      assert.equal(res.success, true);
      assert.equal(res.deliverable.id, "PRD-CORE");
      assert.equal(res.deliverable.status, "verified");
      assert.equal(res.deliverable.validation_status, "passed");
      assert.ok(res.evidenceRecord.evidence_hash?.startsWith("sha256:"));

      // Verify disk state
      const updatedState: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
      );
      const prd = updatedState.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE");
      assert.ok(prd);
      assert.equal(prd.status, "verified");
      assert.equal(prd.validation_status, "passed");
      assert.equal(prd.evidence.length, 1);

      // Verify schema
      assert.equal(validator.validateState(updatedState).valid, true);
    });

    test("CRITICAL INVARIANT: Appending failed evidence does NOT demote an already verified deliverable", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Clean setup with verified deliverable having 1 passed evidence record
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Content\n", "utf-8");

      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage_detail.deliverables = [
        {
          id: "PRD-CORE",
          name: "Problem Statement Document",
          artifact_path: "docs/prd/PRD-CORE.md",
          status: "verified",
          validation_status: "passed",
          exception_ref: null,
          evidence: [
            {
              type: "automated_test",
              procedure: "npm test",
              evidence_ref: ".playbook/logs/pass.log",
              evidence_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
              result: "passed",
              verified_at: "2026-11-09T10:00:00.000Z",
              requirement_id: null,
              summary: "Passed",
              exit_code: 0,
              verified_by: "agent:antigravity",
              actor_type: "agent",
            },
          ],
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      // Append a failing evidence record to the verified deliverable
      const failLog = path.join(tempDir, ".playbook", "logs", "fail.log");
      fs.mkdirSync(path.dirname(failLog), { recursive: true });
      fs.writeFileSync(failLog, "Assertion failed on regression run\n", "utf-8");

      const failRes = await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "npm test --regression",
        evidenceRef: ".playbook/logs/fail.log",
        result: "failed",
      });

      assert.equal(failRes.success, true);
      // Invariant: Status MUST NOT be demoted to in_progress or unvalidated
      assert.equal(failRes.deliverable.status, "verified");
      assert.equal(failRes.deliverable.evidence.length, 2);

      // Verify on disk
      const diskState: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
      );
      const prd = diskState.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE");
      assert.equal(prd?.status, "verified");
      assert.equal(prd?.evidence.length, 2);
    });

    test("rejects recording empty evidence file (0 bytes)", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });
      const emptyLog = path.join(tempDir, ".playbook", "logs", "empty.log");
      fs.mkdirSync(path.dirname(emptyLog), { recursive: true });
      fs.writeFileSync(emptyLog, "", "utf-8");

      await assert.rejects(
        () =>
          recordEvidence({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            type: "automated_test",
            procedure: "test",
            evidenceRef: ".playbook/logs/empty.log",
            result: "passed",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EVIDENCE_FILE_EMPTY");
          return true;
        }
      );
    });

    test("rejects recording missing evidence file", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      await assert.rejects(
        () =>
          recordEvidence({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            type: "automated_test",
            procedure: "test",
            evidenceRef: ".playbook/logs/non-existent.log",
            result: "passed",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EVIDENCE_FILE_NOT_FOUND");
          return true;
        }
      );
    });

    test("rejects future timestamp exceeding 60-second clock skew guard", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });
      const logFile = path.join(tempDir, ".playbook", "logs", "valid.log");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, "Valid test output\n", "utf-8");

      const futureDate = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes in future

      await assert.rejects(
        () =>
          recordEvidence({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            type: "automated_test",
            procedure: "test",
            evidenceRef: ".playbook/logs/valid.log",
            result: "passed",
            now: futureDate,
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EVIDENCE_CLOCK_SKEW");
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------
   * 4. RECORD_EXCEPTION (§3.5)
   * ----------------------------------------------------------------------- */
  describe("4. Transition §3.5 (RECORD_EXCEPTION)", () => {
    test("successfully records approved exception and transitions deliverable to waived", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const excPath = path.join(tempDir, "governance", "exceptions", "EXC-20261109-001.md");
      createValidExceptionDoc(excPath, {
        id: "EXC-20261109-001",
        scope: "PRD-CORE",
        status: "Approved",
        approvedBy: "Alice Lead Architect",
        expires: "2026-12-31",
      });

      const res = await recordException({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        exceptionPath: "governance/exceptions/EXC-20261109-001.md",
      });

      assert.equal(res.success, true);
      assert.equal(res.deliverable.id, "PRD-CORE");
      assert.equal(res.deliverable.status, "waived");
      assert.equal(res.deliverable.validation_status, "waived");
      assert.equal(res.deliverable.exception_ref, "EXC-20261109-001");

      // Verify on disk state
      const state: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
      );
      const prd = state.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE");
      assert.ok(prd);
      assert.equal(prd.status, "waived");
      assert.equal(prd.validation_status, "waived");
      assert.equal(prd.exception_ref, "EXC-20261109-001");
      assert.equal(state.current_stage_detail.exceptions.length, 1);

      // Verify schema conformance
      assert.equal(validator.validateState(state).valid, true);
    });

    test("rejects exception document that is not status Approved (e.g. Draft)", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const excPath = path.join(tempDir, "governance", "exceptions", "EXC-20261109-002.md");
      createValidExceptionDoc(excPath, {
        id: "EXC-20261109-002",
        status: "Draft",
      });

      await assert.rejects(
        () =>
          recordException({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            exceptionPath: "governance/exceptions/EXC-20261109-002.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXCEPTION_NOT_APPROVED");
          return true;
        }
      );
    });

    test("rejects exception document authored or approved by forbidden AI agent name", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const excPath = path.join(tempDir, "governance", "exceptions", "EXC-20261109-003.md");
      createValidExceptionDoc(excPath, {
        id: "EXC-20261109-003",
        approvedBy: "agent:antigravity",
      });

      await assert.rejects(
        () =>
          recordException({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            exceptionPath: "governance/exceptions/EXC-20261109-003.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXCEPTION_AGENT_ATTRIBUTION_FORBIDDEN");
          return true;
        }
      );
    });

    test("rejects expired exception document based on strict UTC expiration boundary", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const excPath = path.join(tempDir, "governance", "exceptions", "EXC-20261109-004.md");
      createValidExceptionDoc(excPath, {
        id: "EXC-20261109-004",
        expires: "2020-01-01", // Long expired
      });

      await assert.rejects(
        () =>
          recordException({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            exceptionPath: "governance/exceptions/EXC-20261109-004.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXCEPTION_EXPIRED");
          return true;
        }
      );
    });

    test("rejects exception whose scope does not match deliverable id", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const excPath = path.join(tempDir, "governance", "exceptions", "EXC-20261109-005.md");
      createValidExceptionDoc(excPath, {
        id: "EXC-20261109-005",
        scope: "DIFFERENT-DELIVERABLE",
      });

      await assert.rejects(
        () =>
          recordException({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            exceptionPath: "governance/exceptions/EXC-20261109-005.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXCEPTION_SCOPE_MISMATCH");
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------
   * 5. REQUEST_HUMAN_APPROVAL (§3.8 / submitStage)
   * ----------------------------------------------------------------------- */
  describe("5. Transition §3.8 (REQUEST_HUMAN_APPROVAL / submitStage)", () => {
    test("successfully transitions stage to pending_review when all deliverables are verified/waived and exit package is complete", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // PRD-CORE deliverable file & passed evidence
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-test.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");

      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-test.log",
        result: "passed",
      });

      // Create valid exit package
      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0.md");
      createValidExitPackage(exitPackagePath, 0);

      const res = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0.md",
        actor: "agent:antigravity",
      });

      assert.equal(res.success, true);
      assert.equal(res.stage, 0);
      assert.equal(res.stageStatus, "pending_review");
      assert.equal(res.humanApproval.status, "pending_review");
      assert.ok(res.txId.startsWith("tx-"));

      // Invariant: agent cannot self-approve gate
      const state: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
      );
      assert.equal(state.stage_status, "pending_review");
      assert.equal(state.current_stage_detail.human_approval.status, "pending_review");
      assert.equal(state.current_stage_detail.human_approval.decision, null);
      assert.equal(state.current_stage, 0); // stage not advanced

      // Verify schema
      assert.equal(validator.validateState(state).valid, true);
    });

    test("rejects submitStage if any deliverable is still in_progress or unverified", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      // Record as completed but do not verify
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      // Ensure validation status is unvalidated
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      const prd = state.current_stage_detail.deliverables.find((d) => d.id === "PRD-CORE");
      if (prd) {
        prd.status = "in_progress";
        prd.validation_status = "unvalidated";
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0.md");
      createValidExitPackage(exitPackagePath, 0);

      await assert.rejects(
        () =>
          submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "GATE_CRITERIA_UNMET");
          return true;
        }
      );
    });

    test("rejects submitStage if authoritative verification fails (e.g. failing latest evidence)", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      // Pass evidence first
      const passLog = path.join(tempDir, ".playbook", "logs", "pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/pass.log",
        result: "passed",
      });

      // Then failing evidence appended (non-demoting status remains verified)
      const failLog = path.join(tempDir, ".playbook", "logs", "fail.log");
      fs.writeFileSync(failLog, "Regression failed\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/fail.log",
        result: "failed",
      });

      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0.md");
      createValidExitPackage(exitPackagePath, 0);

      // submitStage runs authoritative resolution fail-closed
      await assert.rejects(
        () =>
          submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EVIDENCE_RESULT_FAILED");
          return true;
        }
      );
    });

    test("rejects submitStage if blocking RFC is unresolved", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });
      const passLog = path.join(tempDir, ".playbook", "logs", "pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Passed\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/pass.log",
        result: "passed",
      });

      // Add blocking RFC with schema-valid pattern
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage_detail.rfcs = [
        {
          rfc_id: "RFC-20261109-001",
          path: "docs/rfcs/RFC-20261109-001.md",
          title: "Blocking RFC for Testing",
          status: "pending_decision",
          is_blocking: true,
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0.md");
      createValidExitPackage(exitPackagePath, 0);

      await assert.rejects(
        () =>
          submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "RFC_BLOCKING_UNRESOLVED");
          return true;
        }
      );
    });

    test("rejects submitStage if exit package is structurally incomplete", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });
      const passLog = path.join(tempDir, ".playbook", "logs", "pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Passed\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/pass.log",
        result: "passed",
      });

      // Incomplete exit package (< 200 bytes, missing required sections)
      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0.md");
      fs.mkdirSync(path.dirname(exitPackagePath), { recursive: true });
      fs.writeFileSync(exitPackagePath, "# Exit Package\nToo short\n", "utf-8");

      await assert.rejects(
        () =>
          submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0.md",
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------
   * 6. Security Invariants & §3.15 Exclusion
   * ----------------------------------------------------------------------- */
  describe("6. Security Invariants & Boundary Enforcement", () => {
    test("inspectAndHashEvidenceFile verifies size, hash, and non-empty file", () => {
      const logFile = path.join(tempDir, ".playbook", "logs", "sample.log");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, "Deterministic log entry\n", "utf-8");

      const info = inspectAndHashEvidenceFile(tempDir, ".playbook/logs/sample.log");
      assert.ok(info.fileHash.startsWith("sha256:"));
      assert.ok(info.size > 0);
      assert.equal(info.relativePath, ".playbook/logs/sample.log");
    });

    test("resolveAuthoritativeVerification applies deterministic 3-tier tie-breaking", () => {
      const deliverable: Deliverable = {
        id: "PRD-CORE",
        name: "Test Deliverable",
        artifact_path: "docs/prd/PRD-CORE.md",
        status: "verified",
        validation_status: "passed",
        exception_ref: null,
        evidence: [
          {
            type: "automated_test",
            procedure: "npm test",
            evidence_ref: ".playbook/logs/test1.log",
            evidence_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            result: "failed",
            verified_at: "2026-11-09T10:00:00.000Z",
            requirement_id: null,
            summary: "Failed run",
            exit_code: 1,
            verified_by: "agent:antigravity",
            actor_type: "agent",
          },
          {
            type: "automated_test",
            procedure: "npm test",
            evidence_ref: ".playbook/logs/test2.log",
            evidence_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            result: "passed",
            verified_at: "2026-11-09T10:05:00.000Z", // Latest timestamp wins
            requirement_id: null,
            summary: "Passed run",
            exit_code: 0,
            verified_by: "agent:antigravity",
            actor_type: "agent",
          },
        ],
      };

      const result = resolveAuthoritativeVerification(
        tempDir,
        0,
        deliverable,
        null,
        [deliverable]
      );
      assert.equal(result.authoritativeResult, "passed");
      assert.equal(result.evaluatedDisciplines["automated_test"]?.latestResult, "passed");
      assert.equal(
        result.evaluatedDisciplines["automated_test"]?.evidenceRef,
        ".playbook/logs/test2.log"
      );
    });

    test("Candidate Transition §3.15 (INVALIDATE_DELIVERABLE) is strictly NOT exported and uncallable", () => {
      // Invariant check: The unauthorized candidate transition §3.15 must not be exposed anywhere
      assert.equal(
        (controllerModule as Record<string, unknown>)["invalidateDeliverable"],
        undefined,
        "invalidateDeliverable must NOT be exported in controllerModule"
      );
      assert.equal(
        (controllerModule as Record<string, unknown>)["INVALIDATE_DELIVERABLE"],
        undefined,
        "INVALIDATE_DELIVERABLE must NOT be exported in controllerModule"
      );
    });
  });

  /* -------------------------------------------------------------------------
   * 7. Task 009B.1.1 Audit: Multi-Discipline Promotion & Transaction Integrity
   * ----------------------------------------------------------------------- */
  describe("7. Task 009B.1.1 Audit: Multi-Discipline Promotion & Transaction Integrity", () => {
    test("Concrete Scenario: Deliverable requires automated_test AND static_analysis; verified only after both pass; subsequent failure blocks submission without demoting history", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // 1. Configure quality-gates.json requiring automated_test AND static_analysis for PRD-CORE
      const qgConfig = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: "governance-test-app",
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
                id: "prd-unit-tests",
                name: "PRD Test Suite",
                type: "automated_test",
                deliverable_id: "PRD-CORE",
                command: "npm",
                args: ["test"],
                severity: "blocking",
              },
              {
                id: "prd-linter",
                name: "PRD Documentation Linter",
                type: "static_analysis",
                deliverable_id: "PRD-CORE",
                command: "npx",
                args: ["markdownlint"],
                severity: "blocking",
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(tempDir, ".playbook", "quality-gates.json"),
        JSON.stringify(qgConfig, null, 2),
        "utf-8"
      );

      // Verify required disciplines derivation
      const reqDisciplines = getRequiredDisciplinesForDeliverable(
        tempDir,
        0,
        {
          id: "PRD-CORE",
          name: "PRD Core",
          artifact_path: "docs/prd/PRD-CORE.md",
          status: "in_progress",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        }
      );
      assert.deepEqual(reqDisciplines.sort(), ["automated_test", "static_analysis"].sort());

      // Setup PRD deliverable file
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Content\n", "utf-8");

      // Reset state deliverable to completed, unvalidated, with 0 evidence
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage_detail.deliverables = [
        {
          id: "PRD-CORE",
          name: "Problem Statement Document (PRD Core)",
          artifact_path: "docs/prd/PRD-CORE.md",
          status: "completed",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      // Setup evidence logs
      const testPassLog = path.join(tempDir, ".playbook", "logs", "test-pass.log");
      fs.mkdirSync(path.dirname(testPassLog), { recursive: true });
      fs.writeFileSync(testPassLog, "Unit tests passed cleanly\n", "utf-8");

      const lintPassLog = path.join(tempDir, ".playbook", "logs", "lint-pass.log");
      fs.writeFileSync(lintPassLog, "Markdownlint passed cleanly\n", "utf-8");

      const testFailLog = path.join(tempDir, ".playbook", "logs", "test-fail.log");
      fs.writeFileSync(testFailLog, "Unit tests failed with assertion error\n", "utf-8");

      // --- STEP 1: First record (automated_test PASSED; static_analysis MISSING) ---
      const t1 = new Date("2026-11-09T10:00:00.000Z");
      const res1 = await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "npm test",
        evidenceRef: ".playbook/logs/test-pass.log",
        result: "passed",
        now: t1,
      });

      // Deliverable MUST NOT be promoted to verified because static_analysis is missing!
      assert.equal(res1.deliverable.status, "completed");
      assert.equal(res1.deliverable.validation_status, "unvalidated");
      assert.equal(res1.promotedToVerified, false);

      // Authoritative resolution evaluates to unverified with missing static_analysis
      const resAuthoritative1 = resolveAuthoritativeVerification(
        tempDir,
        0,
        res1.deliverable,
        null,
        [res1.deliverable],
        t1
      );
      assert.equal(resAuthoritative1.authoritativeResult, "unverified");
      assert.deepEqual(resAuthoritative1.missingRequiredDisciplines, ["static_analysis"]);
      assert.equal(resAuthoritative1.isContended, false);

      // --- STEP 2: Second record (static_analysis PASSED; both required disciplines now pass) ---
      const t2 = new Date("2026-11-09T10:05:00.000Z");
      const res2 = await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "static_analysis",
        procedure: "npx markdownlint",
        evidenceRef: ".playbook/logs/lint-pass.log",
        result: "passed",
        now: t2,
      });

      // Deliverable is NOW promoted to verified!
      assert.equal(res2.deliverable.status, "verified");
      assert.equal(res2.deliverable.validation_status, "passed");
      assert.equal(res2.promotedToVerified, true);

      // Authoritative resolution is now passed
      const resAuthoritative2 = resolveAuthoritativeVerification(
        tempDir,
        0,
        res2.deliverable,
        null,
        [res2.deliverable],
        t2
      );
      assert.equal(resAuthoritative2.authoritativeResult, "passed");
      assert.deepEqual(resAuthoritative2.missingRequiredDisciplines, []);
      assert.deepEqual(resAuthoritative2.failingDisciplines, []);

      // --- STEP 3: Third record (subsequent automated_test FAILS) ---
      const t3 = new Date("2026-11-09T10:10:00.000Z");
      const res3 = await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "npm test",
        evidenceRef: ".playbook/logs/test-fail.log",
        result: "failed",
        now: t3,
      });

      // NON-DEMOTION INVARIANT: Deliverable status remains "verified" in state (no silent demotion)
      assert.equal(res3.deliverable.status, "verified");
      assert.equal(res3.demoted, false);

      // Authoritative resolution is now FAILED and CONTENDED
      const resAuthoritative3 = resolveAuthoritativeVerification(
        tempDir,
        0,
        res3.deliverable,
        null,
        [res3.deliverable],
        t3
      );
      assert.equal(resAuthoritative3.authoritativeResult, "failed");
      assert.deepEqual(resAuthoritative3.failingDisciplines, ["automated_test"]);
      assert.equal(resAuthoritative3.isContended, true);

      // Stage submission MUST fail-closed because authoritative verification failed
      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0.md");
      createValidExitPackage(exitPackagePath, 0);

      await assert.rejects(
        () =>
          submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0.md",
            now: t3,
          }),
        (err: Error) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EVIDENCE_RESULT_FAILED");
          return true;
        }
      );

      // --- STEP 4: Rectification (subsequent automated_test PASSES again) ---
      const t4 = new Date("2026-11-09T10:15:00.000Z");
      const res4 = await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "npm test",
        evidenceRef: ".playbook/logs/test-pass.log",
        result: "passed",
        now: t4,
      });

      const resAuthoritative4 = resolveAuthoritativeVerification(
        tempDir,
        0,
        res4.deliverable,
        null,
        [res4.deliverable],
        t4
      );
      assert.equal(resAuthoritative4.authoritativeResult, "passed");
      assert.equal(resAuthoritative4.isContended, false);

      // Now stage submission succeeds!
      const submitRes = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0.md",
        now: t4,
      });
      assert.equal(submitRes.success, true);
      assert.equal(submitRes.stageStatus, "pending_review");
    });

    test("Optional disciplines (warning/advisory severity) do not block deliverable verification", () => {
      fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
      const qgConfig = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: "governance-test-app",
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
                id: "blocking-test",
                name: "Blocking Tests",
                type: "automated_test",
                deliverable_id: "PRD-CORE",
                command: "npm",
                args: ["test"],
                severity: "blocking",
              },
              {
                id: "advisory-audit",
                name: "Advisory Audit",
                type: "visual_review",
                deliverable_id: "PRD-CORE",
                command: "npm",
                args: ["run", "audit"],
                severity: "advisory",
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(tempDir, ".playbook", "quality-gates.json"),
        JSON.stringify(qgConfig, null, 2),
        "utf-8"
      );

      const deliverable: Deliverable = {
        id: "PRD-CORE",
        name: "PRD Core",
        artifact_path: "docs/prd/PRD-CORE.md",
        status: "in_progress",
        validation_status: "unvalidated",
        exception_ref: null,
        evidence: [],
      };

      // Only blocking checks establish required disciplines; advisory is excluded
      const reqDisciplines = getRequiredDisciplinesForDeliverable(tempDir, 0, deliverable);
      assert.deepEqual(reqDisciplines, ["automated_test"]);

      // If automated_test passes and visual_review fails, authoritative resolution passes
      deliverable.evidence = [
        {
          type: "automated_test",
          procedure: "npm test",
          evidence_ref: ".playbook/logs/test.log",
          evidence_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          result: "passed",
          verified_at: "2026-11-09T10:00:00.000Z",
          requirement_id: null,
          summary: "Passed",
          exit_code: 0,
          verified_by: "agent:antigravity",
          actor_type: "agent",
        },
        {
          type: "visual_review",
          procedure: "audit",
          evidence_ref: ".playbook/logs/audit.log",
          evidence_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          result: "failed", // Advisory failure
          verified_at: "2026-11-09T10:05:00.000Z",
          requirement_id: null,
          summary: "Advisory warning",
          exit_code: 1,
          verified_by: "agent:antigravity",
          actor_type: "agent",
        },
      ];

      const res = resolveAuthoritativeVerification(tempDir, 0, deliverable, null, [deliverable]);
      assert.equal(res.authoritativeResult, "passed");
      assert.equal(res.failingDisciplines.length, 0);
    });

    test("Profile semantics: Comprehensive strict, standard, and lightweight discipline resolution", () => {
      fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
      const qgConfig = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: "governance-test-app",
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
            stage: 3,
            stage_name: "Implementation & Unit Verification",
            checks: [
              {
                id: "core-build",
                name: "Build Typecheck",
                type: "build_typecheck",
                deliverable_id: "CORE-IMPL",
                command: "npm",
                args: ["run", "build"],
                severity: "blocking",
                // Omitting profiles means it applies to all profiles (strict, standard, lightweight)
              },
              {
                id: "unit-tests",
                name: "Automated Unit Tests",
                type: "automated_test",
                deliverable_id: "CORE-IMPL",
                command: "npm",
                args: ["test"],
                profiles: ["standard" as const, "strict" as const],
                severity: "blocking",
              },
              {
                id: "security-audit",
                name: "Deep Security Audit",
                type: "security_audit",
                deliverable_id: "CORE-IMPL",
                command: "npm",
                args: ["audit"],
                profiles: ["strict" as const],
                severity: "blocking",
              },
              {
                id: "a11y-audit",
                name: "Accessibility Advisory Audit",
                type: "accessibility_audit",
                deliverable_id: "CORE-IMPL",
                command: "npm",
                args: ["run", "a11y"],
                severity: "advisory", // Non-blocking in all profiles
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(tempDir, ".playbook", "quality-gates.json"),
        JSON.stringify(qgConfig, null, 2),
        "utf-8"
      );

      const deliverable: Deliverable = {
        id: "CORE-IMPL",
        name: "Core Implementation",
        artifact_path: "src/index.ts",
        status: "in_progress",
        validation_status: "unvalidated",
        exception_ref: null,
        evidence: [],
      };

      // 1. Lightweight profile: only all-profile blocking check (build_typecheck) is mandatory
      const manifestLightweight: any = { playbook: { governance_profile: "lightweight" } };
      const reqLightweight = getRequiredDisciplinesForDeliverable(
        tempDir,
        3,
        deliverable,
        manifestLightweight,
        [deliverable]
      );
      assert.deepEqual(reqLightweight.sort(), ["build_typecheck"].sort());

      // 2. Standard profile: build_typecheck AND automated_test are mandatory
      const manifestStandard: any = { playbook: { governance_profile: "standard" } };
      const reqStandard = getRequiredDisciplinesForDeliverable(
        tempDir,
        3,
        deliverable,
        manifestStandard,
        [deliverable]
      );
      assert.deepEqual(reqStandard.sort(), ["automated_test", "build_typecheck"].sort());

      // 3. Strict profile: build_typecheck, automated_test, AND security_audit are mandatory
      const manifestStrict: any = { playbook: { governance_profile: "strict" } };
      const reqStrict = getRequiredDisciplinesForDeliverable(
        tempDir,
        3,
        deliverable,
        manifestStrict,
        [deliverable]
      );
      assert.deepEqual(
        reqStrict.sort(),
        ["automated_test", "build_typecheck", "security_audit"].sort()
      );

      // 4. Default fallback: when manifest has no profile specified, falls back to default_profile ("standard")
      const reqFallback = getRequiredDisciplinesForDeliverable(
        tempDir,
        3,
        deliverable,
        null,
        [deliverable]
      );
      assert.deepEqual(reqFallback.sort(), ["automated_test", "build_typecheck"].sort());
    });

    test("Discipline resolution fails closed on missing, malformed, or inconsistent configurations", () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-failclosed-test-"));
      try {
        const customDeliverable: Deliverable = {
          id: "CUSTOM-SPEC",
          name: "Custom Deliverable",
          artifact_path: "docs/specs/custom.md",
          status: "in_progress",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        };

        // 1. Missing quality-gates.json on custom deliverable -> REQUIRED_DISCIPLINES_INDETERMINATE
        assert.throws(
          () => getRequiredDisciplinesForDeliverable(emptyDir, 1, customDeliverable),
          (err: Error) => {
            assert.ok(err instanceof ControllerError);
            assert.equal(err.code, "REQUIRED_DISCIPLINES_INDETERMINATE");
            return true;
          }
        );

        // 2. Malformed quality-gates.json -> QUALITY_GATE_DEFINITION_INVALID
        fs.mkdirSync(path.join(emptyDir, ".playbook"), { recursive: true });
        fs.writeFileSync(
          path.join(emptyDir, ".playbook", "quality-gates.json"),
          "{ invalid json syntax",
          "utf-8"
        );
        assert.throws(
          () => getRequiredDisciplinesForDeliverable(emptyDir, 1, customDeliverable),
          (err: Error) => {
            assert.ok(err instanceof ControllerError);
            assert.equal(err.code, "QUALITY_GATE_DEFINITION_INVALID");
            return true;
          }
        );

        // 3. Inconsistent quality-gates.json (references undeclared deliverable) -> QUALITY_GATE_INCONSISTENT
        const inconsistentQG = {
          $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
          schema_version: "1.0.0",
          project_id: "test",
          default_profile: "standard",
          global_settings: {
            default_timeout_ms: 10000,
            max_concurrency: 1,
            mask_secrets: true,
            log_retention_runs: 1,
            max_journaled_log_bytes: 10000,
            env_allowlist: [],
          },
          gates: [
            {
              stage: 1,
              stage_name: "Requirements & Specification",
              checks: [
                {
                  id: "phantom-check",
                  name: "Phantom Check",
                  type: "automated_test",
                  deliverable_id: "NON_EXISTENT_DELIVERABLE",
                  command: "test",
                  args: [],
                  severity: "blocking",
                },
              ],
            },
          ],
        };
        fs.writeFileSync(
          path.join(emptyDir, ".playbook", "quality-gates.json"),
          JSON.stringify(inconsistentQG, null, 2),
          "utf-8"
        );

        assert.throws(
          () =>
            getRequiredDisciplinesForDeliverable(emptyDir, 1, customDeliverable, null, [
              customDeliverable,
            ]),
          (err: Error) => {
            assert.ok(err instanceof ControllerError);
            assert.equal(err.code, "QUALITY_GATE_INCONSISTENT");
            return true;
          }
        );
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    test("Transaction expectedPreviousSha256 prevents concurrent target file modifications", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Append evidence normally
      const logFile = path.join(tempDir, ".playbook", "logs", "pass.log");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, "Log content\n", "utf-8");

      // Verify that out-of-band state modification during transaction throws TransactionError
      const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
      const originalState = fs.readFileSync(statePath, "utf-8");

      // Transaction manager with outdated previous hash
      const { WriteAheadTransactionManager, TransactionError } = await import("../src/core/transaction/index.js");
      const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });

      await assert.rejects(
        () =>
          txManager.executeTransaction(
            "RECORD_EVIDENCE",
            [
              {
                operation: "write",
                targetPath: DEFAULT_PATHS.stateFile,
                content: originalState,
                expectedPreviousSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              },
            ],
            {}
          ),
        (err: Error) => {
          assert.ok(err instanceof TransactionError);
          assert.equal(err.code, "EXTERNAL_TARGET_MODIFIED");
          return true;
        }
      );
    });
  });
});
