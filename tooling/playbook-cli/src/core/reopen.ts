import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS, STAGE_NAMES, MILESTONE_REGEX, type StageNumber } from "../constants.js";
import { SchemaValidator } from "./validator.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  safeUnlink,
} from "./transaction/index.js";
import { isForbiddenAgentName } from "./approval.js";
import { getStageBaselineDeliverables } from "./stage-defaults.js";
import type { ProjectState, ArchivedMilestone } from "../types/state.js";
import type { ProjectManifest } from "../types/manifest.js";

export interface ReopenLifecycleOptions {
  milestoneId: string;
  milestoneName?: string;
  targetStage?: 0 | 1;
  reason: string;
  authorizedBy: string;
  role: string;
  now?: Date;
  lockTimeoutMs?: number;
  txManager?: WriteAheadTransactionManager;
  validator?: SchemaValidator;
}

export interface ReopenLifecycleResult {
  success: boolean;
  txId?: string;
  previousMilestoneId: string;
  newMilestoneId: string;
  newStage: 0 | 1;
  archivedMilestonesCount: number;
  error?: string;
}

/**
 * Executes controlled lifecycle reopening (REOPEN_LIFECYCLE) under a unified WAL transaction.
 * Transitions a project from 'completed_terminal' to 'reopened_maintenance'.
 */
export async function reopenLifecycle(
  targetDir: string,
  options: ReopenLifecycleOptions
): Promise<ReopenLifecycleResult> {
  const validator = options.validator || new SchemaValidator();
  const manifestPath = path.resolve(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);
  const sidecarPath = path.resolve(targetDir, DEFAULT_PATHS.approvalFingerprintFile);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
    throw new TransactionError(
      "PROJECT_UNINITIALIZED",
      "Cannot reopen: manifest or state file is missing."
    );
  }

  let rawManifest: unknown;
  let rawState: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    rawState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (err: unknown) {
    throw new TransactionError(
      "REOPEN_BLOCKED",
      `Cannot reopen: governance file JSON syntax error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifestVal = validator.validateManifest(rawManifest);
  const stateVal = validator.validateState(rawState);
  if (!manifestVal.valid || !stateVal.valid) {
    throw new TransactionError(
      "REOPEN_BLOCKED",
      "Cannot reopen: manifest or state fails JSON Schema validation."
    );
  }

  const manifest = rawManifest as ProjectManifest;
  const state = rawState as ProjectState;

  // Consistency checks
  if (manifest.project_id !== state.project_id) {
    throw new TransactionError(
      "REOPEN_BLOCKED",
      `Project ID mismatch: manifest has "${manifest.project_id}", state has "${state.project_id}".`
    );
  }

  // Precondition: Lifecycle status eligibility
  if (state.lifecycle_status === "active") {
    throw new TransactionError(
      "LIFECYCLE_NOT_TERMINAL",
      "Cannot reopen: lifecycle is currently active. Only projects in 'completed_terminal' status can be reopened."
    );
  }

  if (state.lifecycle_status === "paused") {
    throw new TransactionError(
      "LIFECYCLE_NOT_TERMINAL",
      "Cannot reopen: lifecycle is currently paused. Resume active development before performing stage work."
    );
  }

  if (state.lifecycle_status === "reopened_maintenance") {
    throw new TransactionError(
      "LIFECYCLE_ALREADY_REOPENED",
      `Cannot reopen: lifecycle is already in 'reopened_maintenance' mode for milestone "${state.milestone_id}".`
    );
  }

  if (state.lifecycle_status !== "completed_terminal") {
    throw new TransactionError(
      "LIFECYCLE_NOT_TERMINAL",
      `Cannot reopen: lifecycle status "${state.lifecycle_status}" is not eligible. Reopening requires 'completed_terminal' status.`
    );
  }

  // Precondition: Target Stage Validation (0 or 1)
  const targetStage = options.targetStage ?? 1;
  if (targetStage !== 0 && targetStage !== 1) {
    throw new TransactionError(
      "INVALID_REOPEN_STAGE",
      `Invalid target stage "${targetStage}". Reopening permits only Stage 1 (default) or Stage 0 (major pivot).`
    );
  }

  // Precondition: Milestone ID Validation
  const newMilestoneId = options.milestoneId?.trim();
  if (!newMilestoneId || !MILESTONE_REGEX.test(newMilestoneId)) {
    throw new TransactionError(
      "INVALID_MILESTONE_ID",
      `Milestone identifier "${newMilestoneId}" is invalid. Must match pattern ^M-[a-zA-Z0-9.-]+$ (e.g. 'M-1.1.0').`
    );
  }

  // Collision with active milestone
  if (newMilestoneId === state.milestone_id) {
    throw new TransactionError(
      "MILESTONE_ID_COLLISION",
      `Milestone ID "${newMilestoneId}" collides with current milestone ID. Reopening requires a new, distinct milestone identifier.`
    );
  }

  // Collision with archived milestones
  if (
    Array.isArray(state.archived_milestones) &&
    state.archived_milestones.some((m) => m.milestone_id === newMilestoneId)
  ) {
    throw new TransactionError(
      "MILESTONE_ID_COLLISION",
      `Milestone ID "${newMilestoneId}" already exists in archived milestones history.`
    );
  }

  // Collision with existing milestone snapshot file on disk
  const targetSnapshotRel = path.posix.join(".playbook", "milestones", `state-${newMilestoneId}.json`);
  const targetSnapshotAbs = path.resolve(targetDir, targetSnapshotRel);
  if (fs.existsSync(targetSnapshotAbs)) {
    throw new TransactionError(
      "MILESTONE_ID_COLLISION",
      `Snapshot file for milestone "${newMilestoneId}" already exists at "${targetSnapshotRel}". Specify a unique milestone identifier.`
    );
  }

  // Precondition: Human Authorization Guardrails
  const authorizedBy = options.authorizedBy?.trim();
  if (!authorizedBy) {
    throw new TransactionError(
      "REOPEN_BLOCKED",
      "Authorizing human engineer name is required."
    );
  }

  if (isForbiddenAgentName(authorizedBy)) {
    throw new TransactionError(
      "AGENT_REOPEN_PROHIBITED",
      `Authorizer identity "${authorizedBy}" matches an automated AI agent pattern. AI agents are strictly forbidden from reopening project lifecycles.`
    );
  }

  const role = options.role?.trim();
  if (!role) {
    throw new TransactionError(
      "REOPEN_BLOCKED",
      "Authorizer professional role is required."
    );
  }

  const reason = options.reason?.trim();
  if (!reason) {
    throw new TransactionError(
      "REOPEN_BLOCKED",
      "Reopening rationale / business justification is required."
    );
  }

  // Precondition: Prior Milestone Snapshot Verification
  const priorSnapshotRel = path.posix.join(".playbook", "milestones", `state-${state.milestone_id}.json`);
  const priorSnapshotAbs = path.resolve(targetDir, priorSnapshotRel);
  if (!fs.existsSync(priorSnapshotAbs)) {
    throw new TransactionError(
      "SNAPSHOT_MISSING",
      `Preceding milestone snapshot "${priorSnapshotRel}" does not exist on disk. Cannot verify historical integrity of completed milestone before reopening.`
    );
  }

  // Execution setup
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const newMilestoneName = options.milestoneName?.trim() || `Maintenance Milestone ${newMilestoneId}`;

  // 1. Construct ArchivedMilestone entry from current state
  const lastCompletedAt =
    state.stage_history && state.stage_history.length > 0
      ? state.stage_history[state.stage_history.length - 1].completed_at
      : nowIso;

  const archivedEntry: ArchivedMilestone = {
    milestone_id: state.milestone_id,
    milestone_name: state.milestone_name,
    completed_at: lastCompletedAt,
    final_stage: 6 as StageNumber,
    stage_history: [...state.stage_history],
    exit_package_ref: `docs/gates/GATE-6-EXIT-PACKAGE.md`,
    state_snapshot_ref: priorSnapshotRel,
  };

  // 2. Construct nextState conforming to project-state schema
  const nextState: ProjectState = {
    ...state,
    milestone_id: newMilestoneId,
    milestone_name: newMilestoneName,
    lifecycle_status: "reopened_maintenance",
    current_stage: targetStage as StageNumber,
    stage_status: "not_started",
    archived_milestones: [...(state.archived_milestones || []), archivedEntry],
    stage_history: [],
    current_stage_detail: {
      stage: targetStage as StageNumber,
      stage_name: STAGE_NAMES[targetStage],
      started_at: nowIso,
      deliverables: getStageBaselineDeliverables(targetStage as StageNumber),
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "not_drafted",
        path: `docs/gates/GATE-${targetStage}-EXIT-PACKAGE.md`,
        submitted_at: null,
      },
      human_approval: {
        status: "not_requested",
        approved_by: null,
        role: null,
        approval_mode: manifest.playbook?.approval_mode || "solo",
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    },
    last_updated: {
      timestamp: nowIso,
      updated_by: `human:${authorizedBy}`,
      actor_type: "human",
      reason: `Reopened lifecycle into maintenance milestone ${newMilestoneId} (Stage ${targetStage}): ${reason}`,
    },
  };

  // 3. Construct nextManifest conforming to project-manifest schema
  const nextManifest: ProjectManifest = {
    ...manifest,
    active_milestone_id: newMilestoneId,
    active_lifecycle_stage: targetStage as StageNumber,
  };

  // Pre-write Schema Validation
  const nextStateVal = validator.validateState(nextState);
  const nextManifestVal = validator.validateManifest(nextManifest);
  if (!nextStateVal.valid || !nextManifestVal.valid) {
    const errors = [
      ...nextStateVal.errors.map((e) => `State: ${e.message}`),
      ...nextManifestVal.errors.map((e) => `Manifest: ${e.message}`),
    ].join("; ");
    throw new TransactionError(
      "REOPEN_BLOCKED",
      `Internal error: proposed state or manifest violates schema: ${errors}`
    );
  }

  // 4. Execute atomic transaction using WriteAheadTransactionManager
  const txManager =
    options.txManager ||
    new WriteAheadTransactionManager({
      targetDir,
      lockTimeoutMs: options.lockTimeoutMs,
    });

  const statePayload = JSON.stringify(nextState, null, 2) + "\n";
  const manifestPayload = JSON.stringify(nextManifest, null, 2) + "\n";

  const txResult = await txManager.withTransaction(
    "REOPEN_LIFECYCLE",
    [
      { targetPath: DEFAULT_PATHS.stateFile, content: statePayload },
      { targetPath: DEFAULT_PATHS.manifestFile, content: manifestPayload },
    ],
    async () => {
      // Idempotent sidecar cleanup: unlink lingering sidecar if present
      safeUnlink(sidecarPath);
    }
  );

  return {
    success: true,
    txId: txResult.txId,
    previousMilestoneId: state.milestone_id,
    newMilestoneId,
    newStage: targetStage,
    archivedMilestonesCount: nextState.archived_milestones.length,
  };
}
