import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS, STAGE_NAMES, type StageNumber } from "../constants.js";
import { SchemaValidator } from "./validator.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  computeFileSha256,
  computeSha256,
  safeUnlink,
} from "./transaction/index.js";
import { verifyFingerprintIntegrity, type ApprovalFingerprintSidecar } from "./fingerprint.js";
import { getStageBaselineDeliverables } from "./stage-defaults.js";
import type { ProjectState, StageHistoryEntry } from "../types/state.js";
import type { ProjectManifest } from "../types/manifest.js";

export interface AdvanceStageOptions {
  now?: Date;
  lockTimeoutMs?: number;
  txManager?: WriteAheadTransactionManager;
  validator?: SchemaValidator;
}

export interface AdvanceStageResult {
  success: boolean;
  txId?: string;
  previousStage: number;
  newStage: number;
  isTerminalClosed: boolean;
  milestoneSnapshotPath?: string;
  error?: string;
}

/**
 * Executes lifecycle stage advancement (or Stage 6 terminal milestone closure)
 * under a unified WAL transaction.
 */
export async function advanceStage(
  targetDir: string,
  options?: AdvanceStageOptions
): Promise<AdvanceStageResult> {
  const validator = options?.validator || new SchemaValidator();
  const manifestPath = path.resolve(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);
  const sidecarPath = path.resolve(targetDir, DEFAULT_PATHS.approvalFingerprintFile);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
    throw new TransactionError(
      "PROJECT_UNINITIALIZED",
      "Cannot advance: manifest or state file is missing."
    );
  }

  let rawManifest: unknown;
  let rawState: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    rawState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (err: unknown) {
    throw new TransactionError(
      "ADVANCEMENT_BLOCKED",
      `Cannot advance: governance file JSON syntax error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifestVal = validator.validateManifest(rawManifest);
  const stateVal = validator.validateState(rawState);
  if (!manifestVal.valid || !stateVal.valid) {
    throw new TransactionError(
      "ADVANCEMENT_BLOCKED",
      "Cannot advance: manifest or state fails JSON Schema validation."
    );
  }

  const manifest = rawManifest as ProjectManifest;
  const state = rawState as ProjectState;

  // Consistency checks
  if (manifest.project_id !== state.project_id) {
    throw new TransactionError(
      "ADVANCEMENT_BLOCKED",
      `Project ID mismatch: manifest has "${manifest.project_id}", state has "${state.project_id}".`
    );
  }

  if (manifest.active_milestone_id !== state.milestone_id) {
    throw new TransactionError(
      "MILESTONE_MISMATCH",
      `Milestone mismatch: manifest has "${manifest.active_milestone_id}", state has "${state.milestone_id}".`
    );
  }

  if (manifest.active_lifecycle_stage !== state.current_stage) {
    throw new TransactionError(
      "MANIFEST_STAGE_DRIFT",
      `Manifest stage drift: manifest has active_lifecycle_stage ${manifest.active_lifecycle_stage}, but authoritative state is at stage ${state.current_stage}.`
    );
  }

  // Precondition: Lifecycle terminal check
  if (state.lifecycle_status === "completed_terminal") {
    throw new TransactionError(
      "ADVANCEMENT_BLOCKED",
      "Cannot advance: lifecycle is already completed_terminal. Stage advancement beyond Stage 6 is strictly barred."
    );
  }

  // Precondition: Active stage must be approved
  if (
    state.stage_status !== "approved" ||
    state.current_stage_detail?.human_approval?.status !== "approved" ||
    state.current_stage_detail?.human_approval?.decision !== "GATE_APPROVED"
  ) {
    throw new TransactionError(
      "ADVANCEMENT_BLOCKED",
      `Cannot advance: Gate ${state.current_stage} has not received formal human approval (current status: ${state.stage_status}).`
    );
  }

  // Precondition: Sidecar must exist
  if (!fs.existsSync(sidecarPath)) {
    throw new TransactionError(
      "APPROVAL_FINGERPRINT_MISSING",
      `Cannot advance: approval fingerprint sidecar (${DEFAULT_PATHS.approvalFingerprintFile}) is missing. Human re-review and approval required.`
    );
  }

  let sidecar: ApprovalFingerprintSidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
  } catch (err: unknown) {
    throw new TransactionError(
      "APPROVAL_FINGERPRINT_MALFORMED",
      `Cannot advance: approval fingerprint sidecar is unreadable or malformed JSON. Human re-approval required.`
    );
  }

  if (
    !sidecar ||
    typeof sidecar !== "object" ||
    sidecar.gate !== state.current_stage ||
    typeof sidecar.fingerprint !== "string"
  ) {
    throw new TransactionError(
      "APPROVAL_FINGERPRINT_MALFORMED",
      `Cannot advance: approval fingerprint sidecar gate (${sidecar?.gate}) does not match current stage (${state.current_stage}).`
    );
  }

  // Precondition: Re-verify fingerprint freshness against current authoritative inputs
  const verification = verifyFingerprintIntegrity(targetDir, state, sidecar.fingerprint);
  if (!verification.isValid) {
    throw new TransactionError(
      "APPROVAL_STALE",
      `Cannot advance: ${verification.reason || "Approval fingerprint mismatch. Repository state has drifted since gate approval was granted."}`
    );
  }

  const now = options?.now || new Date();
  const nowIso = now.toISOString();
  const currentStage = state.current_stage;
  const currentStageDetail = state.current_stage_detail;

  // Construct stage_history entry
  const historyEntry: StageHistoryEntry = {
    stage: currentStage,
    stage_name: currentStageDetail.stage_name,
    status: "approved",
    started_at: currentStageDetail.started_at,
    completed_at: nowIso,
    approved_at: currentStageDetail.human_approval.approved_at || nowIso,
    exit_package_ref: currentStageDetail.exit_package.path,
    human_approval: {
      approved_by: currentStageDetail.human_approval.approved_by || "Unknown",
      role: currentStageDetail.human_approval.role || "Reviewer",
      approval_mode: currentStageDetail.human_approval.approval_mode || "solo",
      signature_reference: currentStageDetail.human_approval.signature_reference || "N/A",
    },
  };

  const txManager =
    options?.txManager ||
    new WriteAheadTransactionManager({
      targetDir,
      lockTimeoutMs: options?.lockTimeoutMs,
    });

  const nextState: ProjectState = JSON.parse(JSON.stringify(state));
  const nextManifest: ProjectManifest = JSON.parse(JSON.stringify(manifest));

  if (currentStage < 6) {
    // Normal advancement: Stages 0 -> 5
    const nextStage = (currentStage + 1) as StageNumber;
    nextState.current_stage = nextStage;
    nextState.stage_status = "not_started";
    nextState.stage_history.push(historyEntry);

    nextState.current_stage_detail = {
      stage: nextStage,
      stage_name: STAGE_NAMES[nextStage],
      started_at: nowIso,
      deliverables: getStageBaselineDeliverables(nextStage),
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "not_drafted",
        path: `docs/gates/GATE-${nextStage}-EXIT-PACKAGE.md`,
        submitted_at: null,
      },
      human_approval: {
        status: "not_requested",
        approved_by: null,
        role: null,
        approval_mode: currentStageDetail.human_approval.approval_mode || "solo",
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    };

    nextState.last_updated = {
      timestamp: nowIso,
      updated_by: "playbook:orchestrator",
      actor_type: "human",
      reason: `Advanced lifecycle from Stage ${currentStage} to Stage ${nextStage} following human approval.`,
    };

    nextManifest.active_lifecycle_stage = nextStage;

    const statePayload = JSON.stringify(nextState, null, 2) + "\n";
    const manifestPayload = JSON.stringify(nextManifest, null, 2) + "\n";

    const txResult = await txManager.executeTransaction("ADVANCE_STAGE", [
      { targetPath: DEFAULT_PATHS.stateFile, content: statePayload },
      { targetPath: DEFAULT_PATHS.manifestFile, content: manifestPayload },
    ]);

    return {
      success: true,
      txId: txResult.txId,
      previousStage: currentStage,
      newStage: nextStage,
      isTerminalClosed: false,
    };
  } else {
    // Stage 6: Terminal milestone closure (CLOSE_LIFECYCLE)
    // Invariant: current_stage remains 6; Stage 7 is NEVER created
    nextState.lifecycle_status = "completed_terminal";
    nextState.current_stage = 6;
    nextState.stage_status = "approved";
    nextState.stage_history.push(historyEntry);

    nextState.last_updated = {
      timestamp: nowIso,
      updated_by: "playbook:orchestrator",
      actor_type: "human",
      reason: "Milestone sealed. Lifecycle closed at Stage 6 (Deployment & Operational Monitoring).",
    };

    nextManifest.active_lifecycle_stage = 6;

    const snapshotRelPath = `.playbook/milestones/state-${state.milestone_id}.json`;
    const snapshotAbsPath = path.resolve(targetDir, snapshotRelPath);
    const snapshotPayload = JSON.stringify(nextState, null, 2) + "\n";

    // Snapshot collision defense
    if (fs.existsSync(snapshotAbsPath)) {
      const existingHash = computeFileSha256(snapshotAbsPath);
      const targetHash = computeSha256(snapshotPayload);
      if (existingHash !== targetHash) {
        throw new TransactionError(
          "SNAPSHOT_CONFLICT",
          `Cannot seal milestone: snapshot file "${snapshotRelPath}" already exists with differing contents. Milestone snapshot cannot be overwritten. Increment milestone ID before sealing.`,
          { snapshotPath: snapshotRelPath }
        );
      }
    }

    const statePayload = JSON.stringify(nextState, null, 2) + "\n";
    const manifestPayload = JSON.stringify(nextManifest, null, 2) + "\n";

    const txResult = await txManager.withTransaction("CLOSE_LIFECYCLE", [
      { targetPath: DEFAULT_PATHS.stateFile, content: statePayload },
      { targetPath: DEFAULT_PATHS.manifestFile, content: manifestPayload },
      { targetPath: snapshotRelPath, content: snapshotPayload },
    ], async () => {
      safeUnlink(sidecarPath);
    });

    // Make snapshot read-only if supported
    try {
      if (fs.existsSync(snapshotAbsPath)) {
        fs.chmodSync(snapshotAbsPath, 0o444);
      }
    } catch {
      // Non-fatal if platform restricts chmod
    }

    return {
      success: true,
      txId: txResult.txId,
      previousStage: 6,
      newStage: 6,
      isTerminalClosed: true,
      milestoneSnapshotPath: snapshotRelPath,
    };
  }
}
