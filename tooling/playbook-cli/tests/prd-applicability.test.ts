import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { approveGate, rejectGate, checkGateEligibility } from "../src/core/approval.js";
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
    milestoneId?: string;
    assessmentMilestoneId?: string | null;
    prdCoreExists?: boolean;
    assessmentType?: "applicable" | "outdated" | "missing" | "ambiguous";
    artifactLocation?: "req-spec" | "dedicated";
  } = {}
): { statePath: string; prdCorePath: string; reqSpecPath: string } {
  const milestoneId = options.milestoneId ?? "M-1.1.0";
  const assessmentMilestoneId =
    options.assessmentMilestoneId !== undefined ? options.assessmentMilestoneId : milestoneId;
  const prdCoreExists = options.prdCoreExists ?? true;
  const assessmentType = options.assessmentType ?? "applicable";
  const artifactLocation = options.artifactLocation ?? "req-spec";

  const { state, statePath } = setupStageProject(tempDir, {
    stage: 1,
    status: "pending_review",
    milestoneId,
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

  const milestoneHeader = assessmentMilestoneId !== null ? `Milestone: ${assessmentMilestoneId}\n` : "";
  const metadataBlock = `${milestoneHeader}Author: Alice Human\nScope: Caching and performance enhancements\nDate: 2026-11-01\n`;

  if (assessmentType === "applicable") {
    const text =
      artifactLocation === "dedicated"
        ? `# PRD Core Applicability Assessment\n${metadataBlock}Applicability: APPLICABLE\nSummary: Problem formulation in docs/prd/PRD-CORE.md remains fully valid for performance optimizations.\n`
        : `# System Requirements Specification\n\n## Inherited Problem Statement Applicability\n${metadataBlock}Applicability: APPLICABLE\nSummary: Problem formulation remains fully valid for caching and reliability enhancements.\n\n## Functional Requirements\n- Fast caching\n`;
    fs.writeFileSync(artifactLocation === "dedicated" ? dedicatedPath : reqSpecPath, text, "utf-8");
  } else if (assessmentType === "outdated") {
    const text =
      artifactLocation === "dedicated"
        ? `# PRD Core Applicability Assessment\n${metadataBlock}Applicability: OUTDATED\nReason: Fundamental pivot from single-tenant LMS to decentralized peer learning.\n`
        : `# System Requirements Specification\n\n## Inherited Problem Statement Applicability\n${metadataBlock}Applicability: OUTDATED\nReason: Market demands decentralized network rather than centralized LMS.\n`;
    fs.writeFileSync(artifactLocation === "dedicated" ? dedicatedPath : reqSpecPath, text, "utf-8");
  } else if (assessmentType === "ambiguous") {
    const text =
      artifactLocation === "dedicated"
        ? `# PRD Core Applicability Assessment\n${metadataBlock}Discussion on problem statement without explicit determination keyword.\n`
        : `# System Requirements Specification\n\n## Inherited Problem Statement Applicability\n${metadataBlock}Discussion on problem statement without explicit determination keyword.\n`;
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

  test("1. Applicable PRD: Valid current-milestone assessment permits Gate 1 eligibility and approval", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
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
      milestoneId: "M-1.1.0",
      prdCoreExists: true,
      assessmentType: "applicable",
      artifactLocation: "dedicated",
    });

    const assessment = evaluatePrdApplicability(tempDir, "M-1.1.0");
    assert.equal(assessment.status, "applicable");
    assert.equal(assessment.milestoneId, "M-1.1.0");
    assert.match(assessment.path || "", /PRD-CORE-ASSESSMENT\.md/);

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, true);
  });

  test("2. Outdated PRD: Assessment marked OUTDATED blocks Gate 1 progression and triggers diagnostics", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
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
      milestoneId: "M-1.1.0",
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

  test("4. Missing milestone ID in assessment is rejected with milestone_missing", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
      assessmentMilestoneId: null, // lacks Milestone: line
      prdCoreExists: true,
      assessmentType: "applicable",
    });

    const assessment = evaluatePrdApplicability(tempDir, "M-1.1.0");
    assert.equal(assessment.status, "milestone_missing");

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, false);
    assert.ok(
      eligibility.diagnostics.some(
        (d) => d.code === "GATE_CRITERIA_UNMET" && d.message.includes("missing active milestone binding")
      )
    );
  });

  test("5. Mismatched milestone ID (assessment from prior milestone) is rejected", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0", // Active milestone
      assessmentMilestoneId: "M-1.0.0", // Historical assessment from earlier milestone
      prdCoreExists: true,
      assessmentType: "applicable",
    });

    const assessment = evaluatePrdApplicability(tempDir, "M-1.1.0");
    assert.equal(assessment.status, "milestone_mismatch");
    assert.equal(assessment.milestoneId, "M-1.0.0");

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, false);
    assert.ok(
      eligibility.diagnostics.some(
        (d) => d.code === "GATE_CRITERIA_UNMET" && d.message.includes("bound to milestone 'M-1.0.0'")
      )
    );
  });

  test("6. Human reviewer visibility: Gate 1 approval review panel displays milestone-bound assessment", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
      prdCoreExists: true,
      assessmentType: "applicable",
      artifactLocation: "req-spec",
    });

    const assessment = evaluatePrdApplicability(tempDir, "M-1.1.0");
    assert.equal(assessment.status, "applicable");
    assert.equal(assessment.milestoneId, "M-1.1.0");
    assert.equal(assessment.author, "Alice Human");
    assert.equal(assessment.scope, "Caching and performance enhancements");
    assert.equal(assessment.determination, "APPLICABLE");
    assert.ok(assessment.summary?.includes("caching and reliability"));
  });

  test("7. Human rejection remains possible even with an APPLICABLE determination", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
      prdCoreExists: true,
      assessmentType: "applicable",
    });

    const res = await rejectGate(tempDir, {
      gate: 1,
      reviewerName: "Alice Human",
      role: "Lead Engineer",
      conditions: "Performance targets insufficient; need further optimization specs",
      isTTY: true,
    });

    assert.equal(res.success, true);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.stage_status, "in_progress");
    assert.equal(state.current_stage_detail.human_approval.decision, "REJECTED");
  });

  test("8. Second playbook reopen is strictly prohibited while milestone is active", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
      prdCoreExists: true,
      assessmentType: "outdated",
    });

    // Attempting to reopen while already reopened_maintenance rejects
    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.2.0",
          reason: "Attempt second reopen",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "LIFECYCLE_ALREADY_REOPENED");
        return true;
      }
    );
  });

  test("9. Attempted Gate 1 approval without a valid assessment rejects with zero mutations", async () => {
    setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
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

  test("10. Subsequent valid approval replaces lingering or stale sidecar", async () => {
    const { statePath } = setupMaintenanceStage1Project(tempDir, {
      milestoneId: "M-1.1.0",
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
