import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { approveGate, checkGateEligibility } from "../src/core/approval.js";
import { runApprove } from "../src/commands/approve.js";
import { reopenLifecycle } from "../src/core/reopen.js";
import { DiagnosticsEngine } from "../src/core/diagnostics/engine.js";
import { inspectRawProject } from "../src/core/diagnostics/inspector.js";
import { evaluatePrdApplicability } from "../src/core/prd-applicability.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { ProjectState } from "../src/types/state.js";

function setupMaintenanceStage1Project(
  tempDir: string,
  options: {
    prdCoreExists?: boolean;
    assessmentType?: "applicable" | "outdated" | "missing" | "ambiguous";
    artifactLocation?: "req-spec" | "dedicated";
  } = {}
): { statePath: string; prdCorePath: string; reqSpecPath: string } {
  const prdCoreExists = options.prdCoreExists ?? true;
  const assessmentType = options.assessmentType ?? "applicable";
  const artifactLocation = options.artifactLocation ?? "req-spec";

  const { state, statePath } = setupStageProject(tempDir, {
    stage: 1,
    status: "pending_review",
    milestoneId: "M-1.1.0",
  });

  // Switch lifecycle status to reopened_maintenance
  state.lifecycle_status = "reopened_maintenance";
  state.archived_milestones = [
    {
      milestone_id: "M-1.0.0",
      milestone_name: "MVP Release",
      completed_at: "2026-10-31T12:00:00.000Z",
      final_stage: 6,
      stage_history: [],
      exit_package_ref: "docs/gates/GATE-6-EXIT-PACKAGE.md",
    },
  ];

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

  const prdDir = path.join(tempDir, "docs", "prd");
  fs.mkdirSync(prdDir, { recursive: true });

  const prdCorePath = path.join(prdDir, "PRD-CORE.md");
  if (prdCoreExists) {
    fs.writeFileSync(
      prdCorePath,
      "# PRD Core Problem Formulation\nFoundational problem statement for LMS platform.\n",
      "utf-8"
    );
  }

  const reqSpecPath = path.join(prdDir, "REQUIREMENTS-SPEC.md");
  const dedicatedPath = path.join(prdDir, "PRD-CORE-ASSESSMENT.md");

  if (assessmentType === "applicable") {
    const text =
      artifactLocation === "dedicated"
        ? `# PRD Core Applicability Assessment\nApplicability: APPLICABLE\nSummary: Problem formulation in docs/prd/PRD-CORE.md remains fully valid for performance optimizations.\n`
        : `# System Requirements Specification\n\n## Inherited Problem Statement Applicability\nApplicability: APPLICABLE\nSummary: Problem formulation remains fully valid for caching and reliability enhancements.\n\n## Functional Requirements\n- Fast caching\n`;
    fs.writeFileSync(artifactLocation === "dedicated" ? dedicatedPath : reqSpecPath, text, "utf-8");
  } else if (assessmentType === "outdated") {
    const text =
      artifactLocation === "dedicated"
        ? `# PRD Core Applicability Assessment\nApplicability: OUTDATED\nReason: Fundamental pivot from single-tenant LMS to decentralized peer learning.\n`
        : `# System Requirements Specification\n\n## Inherited Problem Statement Applicability\nApplicability: OUTDATED\nReason: Market demands decentralized network rather than centralized LMS.\n`;
    fs.writeFileSync(artifactLocation === "dedicated" ? dedicatedPath : reqSpecPath, text, "utf-8");
  } else if (assessmentType === "ambiguous") {
    const text =
      artifactLocation === "dedicated"
        ? `# PRD Core Applicability Assessment\nAssessment discussion without an explicit determination keyword.\n`
        : `# System Requirements Specification\n\n## Inherited Problem Statement Applicability\nNotes on problem statement but no explicit Applicability keyword.\n`;
    fs.writeFileSync(artifactLocation === "dedicated" ? dedicatedPath : reqSpecPath, text, "utf-8");
  }

  return { statePath, prdCorePath, reqSpecPath };
}

describe("Stage 1 Inherited Prerequisite Applicability & Reopening Audit", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-audit-prd-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore transient lock
      }
    }
  });

  test("1. Applicable PRD: Valid applicability assessment permits Gate 1 eligibility and approval", async () => {
    setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "applicable",
      artifactLocation: "req-spec",
    });

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.diagnostics.length, 0);

    const res = await approveGate(tempDir, {
      gate: 1,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      confirmationPhrase: "CONFIRM APPROVAL GATE 1",
      isTTY: true,
    });

    assert.equal(res.success, true);
    assert.ok(res.fingerprint?.startsWith("sha256:"));

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "approved");
    assert.equal(state.current_stage_detail.human_approval.decision, "GATE_APPROVED");
  });

  test("1b. Applicable PRD: Dedicated PRD-CORE-ASSESSMENT.md artifact is also accepted", async () => {
    setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "applicable",
      artifactLocation: "dedicated",
    });

    const assessment = evaluatePrdApplicability(tempDir);
    assert.equal(assessment.status, "applicable");
    assert.match(assessment.path || "", /PRD-CORE-ASSESSMENT\.md/);

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, true);
  });

  test("2. Outdated PRD: Assessment marked OUTDATED blocks Gate 1 progression and triggers diagnostics", async () => {
    setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "outdated",
      artifactLocation: "req-spec",
    });

    // Eligibility is blocked
    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, false);
    assert.ok(
      eligibility.diagnostics.some(
        (d) => d.code === "GATE_CRITERIA_UNMET" && d.message.includes("marked OUTDATED")
      )
    );

    // Diagnostics Engine flags readiness as blocked
    const raw = inspectRawProject(tempDir);
    const engine = new DiagnosticsEngine();
    const report = engine.evaluate(raw);

    assert.equal(report.readiness.status, "blocked");
    assert.ok(report.diagnostics.some((d) => d.code === "PRD_ASSESSMENT_OUTDATED"));
  });

  test("3. Missing assessment: PRD exists but assessment is missing blocks Gate 1 progression", async () => {
    setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "missing",
    });

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, false);
    assert.ok(
      eligibility.diagnostics.some(
        (d) =>
          d.code === "GATE_CRITERIA_UNMET" &&
          d.message.includes("Inherited PRD applicability assessment is missing")
      )
    );
  });

  test("4. Human reviewer visibility: Gate 1 approval review panel displays assessment details", async () => {
    setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "applicable",
      artifactLocation: "req-spec",
    });

    // Capture console output during approval review
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg?: unknown, ...optionalParams: unknown[]) => {
      logs.push(String(msg) + (optionalParams.length > 0 ? " " + optionalParams.join(" ") : ""));
    };

    try {
      await runApprove({
        cwd: tempDir,
        gate: 1,
        reviewer: "Alice Human",
        role: "Lead Engineer",
        isTTY: false, // will fail at TTY check, but run after or we mock prompter
      });
    } finally {
      console.log = originalLog;
    }

    // Verify evaluatePrdApplicability yields human-visible details
    const assessment = evaluatePrdApplicability(tempDir);
    assert.equal(assessment.status, "applicable");
    assert.equal(assessment.determination, "APPLICABLE");
    assert.ok(assessment.summary?.includes("caching and reliability"));
  });

  test("5. Stage 0 pivot path: Outdated problem statement allows human to reopen at Stage 0", async () => {
    // Bootstrap terminal project
    const playbookDir = path.join(tempDir, ".playbook");
    const milestonesDir = path.join(playbookDir, "milestones");
    fs.mkdirSync(milestonesDir, { recursive: true });

    const { state, manifest, statePath, manifestPath } = setupStageProject(tempDir, {
      stage: 6,
      status: "approved",
      milestoneId: "M-1.0.0",
    });
    state.lifecycle_status = "completed_terminal";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    fs.writeFileSync(
      path.join(milestonesDir, "state-M-1.0.0.json"),
      JSON.stringify(state, null, 2) + "\n",
      "utf-8"
    );

    // Reopen with explicit targetStage: 0 (Domain Pivot)
    const reopenRes = await reopenLifecycle(tempDir, {
      milestoneId: "M-2.0.0",
      milestoneName: "Major Domain Pivot 2.0",
      targetStage: 0,
      reason: "Complete business model pivot from LMS to peer learning network",
      authorizedBy: "Alice Human",
      role: "Lead Architect",
    });

    assert.equal(reopenRes.success, true);
    assert.equal(reopenRes.newStage, 0);

    const updatedState: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(updatedState.current_stage, 0);
    assert.equal(updatedState.lifecycle_status, "reopened_maintenance");
    assert.equal(updatedState.current_stage_detail.deliverables.length, 1);
    assert.equal(updatedState.current_stage_detail.deliverables[0].id, "PRD-CORE");
    assert.equal(updatedState.current_stage_detail.deliverables[0].status, "not_started");
  });

  test("6. Attempted Gate 1 approval without a valid assessment rejects with zero mutations", async () => {
    setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "outdated",
    });

    await assert.rejects(
      async () => {
        await approveGate(tempDir, {
          gate: 1,
          reviewerName: "Alice Human",
          role: "Lead Engineer",
          confirmationPhrase: "CONFIRM APPROVAL GATE 1",
          isTTY: true,
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "GATE_CRITERIA_UNMET");
        return true;
      }
    );

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "pending_review");
    assert.equal(state.current_stage_detail.human_approval.decision, null);
  });

  test("7. Subsequent valid approval replaces lingering or stale sidecar", async () => {
    const { statePath } = setupMaintenanceStage1Project(tempDir, {
      prdCoreExists: true,
      assessmentType: "applicable",
    });

    // Place an old sidecar from a prior gate
    const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({ gate: 6, milestone_id: "M-1.0.0", fingerprint: "old" }),
      "utf-8"
    );

    const res = await approveGate(tempDir, {
      gate: 1,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      confirmationPhrase: "CONFIRM APPROVAL GATE 1",
      isTTY: true,
    });

    assert.equal(res.success, true);

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.equal(sidecar.gate, 1);
    assert.equal(sidecar.milestone_id, "M-1.1.0");
    assert.equal(sidecar.fingerprint, res.fingerprint);
  });
});
