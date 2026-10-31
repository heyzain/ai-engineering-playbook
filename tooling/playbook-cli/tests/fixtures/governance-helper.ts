import fs from "node:fs";
import path from "node:path";
import { SchemaValidator } from "../../src/core/validator.js";
import { createInitialManifest } from "../../src/templates/manifest-template.js";
import { createInitialState } from "../../src/templates/state-template.js";
import { getStageBaselineDeliverables } from "../../src/core/stage-defaults.js";
import { computeSha256 } from "../../src/core/transaction/index.js";
import { buildApprovalFingerprintSidecar } from "../../src/core/fingerprint.js";
import { DEFAULT_PATHS, STAGE_NAMES, type StageNumber } from "../../src/constants.js";
import type { ProjectState } from "../../src/types/state.js";
import type { ProjectManifest } from "../../src/types/manifest.js";

export interface SetupStageOptions {
  stage?: StageNumber;
  status?: "pending_review" | "approved" | "in_progress";
  approvalMode?: "solo" | "team";
  reviewerName?: string;
  role?: string;
  signatureReference?: string;
  milestoneId?: string;
}

export function setupStageProject(
  targetDir: string,
  options: SetupStageOptions = {}
): {
  manifest: ProjectManifest;
  state: ProjectState;
  manifestPath: string;
  statePath: string;
  sidecarPath: string;
  evidencePath: string;
  exitPackagePath: string;
} {
  const stage = options.stage ?? 0;
  const status = options.status ?? "pending_review";
  const approvalMode = options.approvalMode ?? "solo";
  const reviewerName = options.reviewerName ?? "Alice Engineer";
  const role = options.role ?? "Lead Architect";
  const signatureReference = options.signatureReference ?? "Session-1234";
  const milestoneId = options.milestoneId ?? "M-1.0.0";

  // Ensure directories exist per downstream storage convention
  const playbookDir = path.join(targetDir, ".playbook");
  const logsDir = path.join(playbookDir, "logs");
  const gatesDir = path.join(targetDir, "docs", "gates");
  const milestonesDir = path.join(playbookDir, "milestones");
  const prdDir = path.join(targetDir, "docs", "prd");
  const adrDir = path.join(targetDir, "docs", "adr");
  const rfcDir = path.join(targetDir, "docs", "rfcs");
  const exceptionsDir = path.join(targetDir, "docs", "exceptions");

  fs.mkdirSync(playbookDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(gatesDir, { recursive: true });
  fs.mkdirSync(milestonesDir, { recursive: true });
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(adrDir, { recursive: true });
  fs.mkdirSync(rfcDir, { recursive: true });
  fs.mkdirSync(exceptionsDir, { recursive: true });

  // 1. Evidence file on disk
  const evidenceRelPath = `.playbook/logs/test-stage-${stage}.log`;
  const evidenceAbsPath = path.join(targetDir, evidenceRelPath);
  const evidenceContent = `Test execution log for Stage ${stage}\nAll automated tests passed successfully with 0 failures.\n`;
  fs.writeFileSync(evidenceAbsPath, evidenceContent, "utf-8");
  const evidenceHash = computeSha256(evidenceContent);

  // 2. Baseline deliverables verified
  const baseline = getStageBaselineDeliverables(stage);
  const verifiedDeliverables = baseline.map((deliv) => ({
    ...deliv,
    status: "verified" as const,
    validation_status: "passed" as const,
    evidence: [
      {
        requirement_id: null,
        type: "automated_test" as const,
        procedure: "npm test",
        result: "passed" as const,
        summary: `Automated test passed for ${deliv.id}.`,
        exit_code: 0,
        evidence_ref: evidenceRelPath,
        evidence_hash: evidenceHash,
        verified_at: "2026-10-31T10:30:00.000Z",
        verified_by: `human:${reviewerName}`,
        actor_type: "human" as const,
      },
    ],
  }));

  // 3. Exit package on disk (minimum 200 bytes)
  const exitPackageRelPath = `docs/gates/GATE-${stage}-EXIT-PACKAGE.md`;
  const exitPackageAbsPath = path.join(targetDir, exitPackageRelPath);
  const exitPackageContent = `# Stage Gate Exit Package — Stage ${stage}: ${STAGE_NAMES[stage]}

## Executive Summary
This exit package documents all verified deliverables and supporting evidence for Stage ${stage}.
All mandatory engineering invariants and gate criteria have been satisfied in full compliance with the constitution.

## Deliverables and Traceability
- Deliverables verified: ${verifiedDeliverables.map((d) => d.id).join(", ")}.
- Quality evidence: 100% passing automated test logs attached.
- Residual risk: Zero outstanding critical or high defects.
`;
  fs.writeFileSync(exitPackageAbsPath, exitPackageContent, "utf-8");

  // 4. Manifest construction
  const manifest = createInitialManifest({
    projectId: "governance-test-app",
    projectName: "Governance Test Application",
    ecosystem: "node",
    primaryLanguage: "typescript",
  });
  manifest.active_lifecycle_stage = stage;
  manifest.active_milestone_id = milestoneId;

  // 5. State construction
  const state = createInitialState({
    projectId: "governance-test-app",
    approvalMode,
    milestoneId,
  });
  state.current_stage = stage;
  state.stage_status = status;

  state.current_stage_detail = {
    stage,
    stage_name: STAGE_NAMES[stage],
    started_at: "2026-10-31T10:00:00.000Z",
    deliverables: verifiedDeliverables,
    rfcs: [],
    adrs: [],
    exceptions: [],
    exit_package: {
      status: "submitted_for_review",
      path: exitPackageRelPath,
      submitted_at: "2026-10-31T11:00:00.000Z",
    },
    human_approval: {
      status: status === "approved" ? "approved" : status === "pending_review" ? "pending_review" : "not_requested",
      approved_by: status === "approved" ? reviewerName : null,
      role: status === "approved" ? role : null,
      approval_mode: approvalMode,
      decision: status === "approved" ? "GATE_APPROVED" : null,
      signature_reference: status === "approved" ? signatureReference : null,
      approved_at: status === "approved" ? "2026-10-31T11:30:00.000Z" : null,
      conditions: null,
    },
  };

  state.last_updated = {
    timestamp: "2026-10-31T11:30:00.000Z",
    updated_by: `human:${reviewerName}`,
    actor_type: "human",
    reason: status === "approved" ? `Stage ${stage} approved` : "Updated",
  };

  const validator = new SchemaValidator();
  const manifestVal = validator.validateManifest(manifest);
  if (!manifestVal.valid) {
    throw new Error(`Fixture manifest schema invalid: ${JSON.stringify(manifestVal.errors)}`);
  }
  const stateVal = validator.validateState(state);
  if (!stateVal.valid) {
    throw new Error(`Fixture state schema invalid: ${JSON.stringify(stateVal.errors)}`);
  }

  const manifestPath = path.join(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.join(targetDir, DEFAULT_PATHS.stateFile);
  const sidecarPath = path.join(targetDir, DEFAULT_PATHS.approvalFingerprintFile);

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

  // If approved, create the approval sidecar
  if (status === "approved") {
    const { sidecar } = buildApprovalFingerprintSidecar(targetDir, state, {
      approvedBy: reviewerName,
      role,
      signatureReference,
      approvedAt: "2026-10-31T11:30:00.000Z",
    });
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");
  }

  return {
    manifest,
    state,
    manifestPath,
    statePath,
    sidecarPath,
    evidencePath: evidenceAbsPath,
    exitPackagePath: exitPackageAbsPath,
  };
}
