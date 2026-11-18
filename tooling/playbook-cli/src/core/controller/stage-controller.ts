import fs from "node:fs";
import {assertExceptionGateState} from "./exception-service.js";
import path from "node:path";
import {
  DEFAULT_PATHS,
  STAGE_NAMES,
  type StageNumber,
  type StageName,
} from "../../constants.js";
import type { ProjectState, Deliverable } from "../../types/state.js";
import type { ProjectManifest } from "../../types/manifest.js";
import { SchemaValidator } from "../validator.js";
import { getStageBaselineDeliverables } from "../stage-defaults.js";
import { validateExitPackageAst } from "./ast-validators.js";
import {
  WriteAheadTransactionManager,
  computeFileSha256,
  validateCanonicalPath,
  TransactionError,
} from "../transaction/index.js";
import { resolveAuthoritativeVerification, resolveGovernanceProfile } from "./resolver.js";
import {
  ControllerError,
  type StartStageOptions,
  type StartStageResult,
  type SubmitStageOptions,
  type SubmitStageResult,
} from "./types.js";

/**
 * Loads and validates both manifest and state files from disk.
 */
function loadAndValidateState(
  targetDir: string,
  validator: SchemaValidator
): {
  manifest: ProjectManifest;
  state: ProjectState;
  stateRaw: string;
  manifestRaw: string;
  statePath: string;
  manifestPath: string;
} {
  const manifestPath = path.resolve(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
    throw new ControllerError(
      "PROJECT_UNINITIALIZED",
      "Project manifest or state file is missing from .playbook/ directory."
    );
  }

  const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
  const stateRaw = fs.readFileSync(statePath, "utf-8");

  let parsedManifest: unknown;
  let parsedState: unknown;

  try {
    parsedManifest = JSON.parse(manifestRaw);
  } catch (err: unknown) {
    throw new ControllerError(
      "MANIFEST_MALFORMED",
      `Syntax error in .playbook/manifest.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    parsedState = JSON.parse(stateRaw);
  } catch (err: unknown) {
    throw new ControllerError(
      "STATE_MALFORMED",
      `Syntax error in .playbook/state.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifestVal = validator.validateManifest(parsedManifest);
  // Permit omission of governance_profile from manifest under the accepted 3-tier fallback contract:
  // 1. manifest.playbook.governance_profile
  // 2. qualityGatesConfig.default_profile
  // 3. standard fallback
  const manifestErrors = manifestVal.errors.filter(
    (e) => !(e.instancePath === "/playbook" && e.params?.missingProperty === "governance_profile")
  );
  if (manifestErrors.length > 0) {
    throw new ControllerError(
      "MANIFEST_SCHEMA_INVALID",
      `Manifest schema violation:\n${validator.formatErrors("manifest", manifestErrors)}`,
      { errors: manifestErrors }
    );
  }

  const stateVal = validator.validateState(parsedState);
  if (!stateVal.valid) {
    throw new ControllerError(
      "STATE_SCHEMA_INVALID",
      `State schema violation:\n${stateVal.formattedErrors}`,
      { errors: stateVal.errors }
    );
  }

  return {
    manifest: parsedManifest as ProjectManifest,
    state: parsedState as ProjectState,
    stateRaw,
    manifestRaw,
    statePath,
    manifestPath,
  };
}

/**
 * Implements Transition §3.2 (`START_STAGE`).
 * Commences active engineering work within the target stage under WAL protection.
 */
export async function startStage(options: StartStageOptions): Promise<StartStageResult> {
  const targetDir = path.resolve(options.targetDir);
  const validator = new SchemaValidator();
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  const { state, stateRaw } = loadAndValidateState(targetDir, validator);

  const stageToStart: StageNumber =
    options.stage !== undefined ? options.stage : state.current_stage;

  if (stageToStart !== state.current_stage) {
    throw new ControllerError(
      "STAGE_MISMATCH",
      `Cannot start Stage ${stageToStart}; current authoritative stage is ${state.current_stage}.`,
      { requested_stage: stageToStart, current_stage: state.current_stage }
    );
  }

  if (state.lifecycle_status === "completed_terminal") {
    throw new ControllerError(
      "LIFECYCLE_COMPLETED_TERMINAL",
      "Cannot start stage on a sealed terminal lifecycle. Project lifecycle is complete."
    );
  }

  if (state.lifecycle_status === "paused") {
    throw new ControllerError(
      "LIFECYCLE_PAUSED",
      "Lifecycle is currently paused. Resume lifecycle before starting work."
    );
  }

  if (state.stage_status === "in_progress") {
    throw new ControllerError(
      "STAGE_ALREADY_IN_PROGRESS",
      `Stage ${stageToStart} is already in_progress.`,
      { stage: stageToStart }
    );
  }

  if (state.stage_status === "pending_review") {
    throw new ControllerError(
      "STAGE_NOT_READY_TO_START",
      `Stage ${stageToStart} is currently pending_review. Await human approval or reject to rework.`,
      { stage: stageToStart }
    );
  }

  if (state.stage_status === "approved") {
    throw new ControllerError(
      "STAGE_ALREADY_APPROVED",
      `Stage ${stageToStart} is already approved. Run 'playbook advance' to proceed to next stage.`,
      { stage: stageToStart }
    );
  }

  if (state.stage_status !== "not_started") {
    throw new ControllerError(
      "STAGE_NOT_READY_TO_START",
      `Cannot start Stage ${stageToStart} from stage_status "${state.stage_status}". Must be "not_started".`,
      { current_status: state.stage_status }
    );
  }

  // Preceding stage prerequisite check
  if (stageToStart > 0) {
    const prevStage = (stageToStart - 1) as StageNumber;
    const prevHistory = (state.stage_history || []).find((h) => h.stage === prevStage);
    if (!prevHistory || (prevHistory.status !== "approved" && prevHistory.status !== "waived")) {
      throw new ControllerError(
        "STAGE_PREREQUISITE_UNMET",
        `Preceding Stage ${prevStage} must be approved before starting Stage ${stageToStart}.`,
        { preceding_stage: prevStage }
      );
    }
  }

  // Mutate state
  const nextState: ProjectState = JSON.parse(JSON.stringify(state));
  nextState.stage_status = "in_progress";

  const stageName = STAGE_NAMES[stageToStart];
  nextState.current_stage_detail.stage = stageToStart;
  nextState.current_stage_detail.stage_name = stageName;
  nextState.current_stage_detail.started_at = nowIso;

  // Initialize baseline deliverables if deliverables array is empty
  if (!nextState.current_stage_detail.deliverables || nextState.current_stage_detail.deliverables.length === 0) {
    const baselines = getStageBaselineDeliverables(stageToStart);
    nextState.current_stage_detail.deliverables = baselines.map((b) => ({
      ...b,
      status: "not_started",
      validation_status: "unvalidated",
      evidence: [],
      exception_ref: null,
    }));
  }

  const actor = options.actor || "agent:controller";
  const actorType = options.actorType || "agent";
  nextState.last_updated = {
    timestamp: nowIso,
    updated_by: actor,
    actor_type: actorType,
    reason: `Commenced active work in Stage ${stageToStart} (${stageName}).`,
  };

  // Validate mutated state before transaction prepare
  const postVal = validator.validateState(nextState);
  if (!postVal.valid) {
    throw new ControllerError(
      "STATE_SCHEMA_INVALID",
      `Post-mutation state failed schema validation:\n${postVal.formattedErrors}`,
      { errors: postVal.errors }
    );
  }

  const currentSha256 = computeFileSha256(path.resolve(targetDir, DEFAULT_PATHS.stateFile)) || undefined;
  const statePayload = JSON.stringify(nextState, null, 2) + "\n";

  const txManager = new WriteAheadTransactionManager({
    targetDir,
    lockTimeoutMs: options.lockTimeoutMs,
  });

  const txResult = await txManager.executeTransaction(
    "START_STAGE",
    [
      {
        operation: "write",
        targetPath: DEFAULT_PATHS.stateFile,
        content: statePayload,
        expectedPreviousSha256: currentSha256,
      },
    ],
    {
      stage: stageToStart,
      actor,
    }
  );

  return {
    success: true,
    stage: stageToStart,
    stageName,
    startedAt: nowIso,
    deliverablesCount: nextState.current_stage_detail.deliverables.length,
    txId: txResult.txId,
    recovery: txResult.recovery,
  };
}

/**
 * Implements Transition §3.8 (`REQUEST_HUMAN_APPROVAL`).
 * Phase 1 Handover: Verifies deliverable completeness and exit package integrity,
 * transitioning stage_status to `pending_review` without self-approving.
 */
export async function submitStage(options: SubmitStageOptions): Promise<SubmitStageResult> {
  const targetDir = path.resolve(options.targetDir);
  const validator = new SchemaValidator();
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  const { manifest, state } = loadAndValidateState(targetDir, validator);

  const stageToSubmit: StageNumber =
    options.stage !== undefined ? options.stage : state.current_stage;

  if (stageToSubmit !== state.current_stage) {
    throw new ControllerError(
      "STAGE_MISMATCH",
      `Cannot submit Stage ${stageToSubmit}; current authoritative stage is ${state.current_stage}.`,
      { requested_stage: stageToSubmit, current_stage: state.current_stage }
    );
  }

  if (state.stage_status !== "in_progress") {
    throw new ControllerError(
      "STAGE_NOT_IN_PROGRESS",
      `Cannot submit stage from status "${state.stage_status}". Must be "in_progress".`,
      { current_status: state.stage_status }
    );
  }

  const deliverables = state.current_stage_detail?.deliverables || [];
  assertExceptionGateState(targetDir,state,manifest,now);
  if (deliverables.length === 0) {
    throw new ControllerError(
      "STAGE_DELIVERABLES_INCOMPLETE",
      `Stage ${stageToSubmit} defines zero deliverables. At least one deliverable is required.`
    );
  }

  // 1. Check mandatory baseline deliverables are present
  const baselines = getStageBaselineDeliverables(stageToSubmit);
  const declaredIds = new Set(deliverables.map((d) => d.id));
  for (const b of baselines) {
    if (!declaredIds.has(b.id)) {
      throw new ControllerError(
        "GATE_REQUIRED_DELIVERABLE_MISSING",
        `Missing mandatory baseline deliverable "${b.id}" (${b.name}) for Stage ${stageToSubmit}.`,
        { deliverable_id: b.id, stage: stageToSubmit }
      );
    }
  }

  // 2. Deliverables completeness and authoritative verification checks
  for (const deliv of deliverables) {
    if (deliv.status !== "verified" && deliv.status !== "waived") {
      throw new ControllerError(
        "GATE_CRITERIA_UNMET",
        `Deliverable "${deliv.id}" is in status "${deliv.status}". All deliverables must be "verified" or "waived" before review submission.`,
        { deliverable_id: deliv.id, status: deliv.status }
      );
    }

    if (deliv.status === "verified") {
      if (deliv.validation_status !== "passed" || !Array.isArray(deliv.evidence) || deliv.evidence.length === 0) {
        throw new ControllerError(
          "DELIVERABLE_UNVERIFIED",
          `Verified deliverable "${deliv.id}" lacks passed validation status or supporting evidence.`,
          { deliverable_id: deliv.id }
        );
      }

      // Authoritative verification evaluation
      const resolution = resolveAuthoritativeVerification(
        targetDir,
        stageToSubmit,
        deliv,
        manifest,
        deliverables,
        now
      );

      if (resolution.authoritativeResult === "failed") {
        throw new ControllerError(
          "EVIDENCE_RESULT_FAILED",
          `Authoritative verification for deliverable "${deliv.id}" has failing disciplines: ${resolution.failingDisciplines.join(", ")}. ${resolution.blockingReasons.join(" ")}`,
          { deliverable_id: deliv.id, failing_disciplines: resolution.failingDisciplines }
        );
      }

      if (resolution.authoritativeResult === "inconclusive") {
        throw new ControllerError(
          "EVIDENCE_RESULT_INCONCLUSIVE",
          `Authoritative verification for deliverable "${deliv.id}" is inconclusive. ${resolution.blockingReasons.join(" ")}`,
          { deliverable_id: deliv.id }
        );
      }

      if (resolution.authoritativeResult === "unverified") {
        throw new ControllerError(
          "DELIVERABLE_UNVERIFIED",
          `Authoritative verification for deliverable "${deliv.id}" is unverified. ${resolution.blockingReasons.join(" ")}`,
          { deliverable_id: deliv.id, missing: resolution.missingRequiredDisciplines }
        );
      }
    }

    if (deliv.status === "waived") {
      if (!deliv.exception_ref) {
        throw new ControllerError(
          "EXCEPTION_REFERENCE_MISSING",
          `Waived deliverable "${deliv.id}" is missing an exception_ref.`
        );
      }
      const exc = (state.current_stage_detail?.exceptions || []).find(
        (e) => e.exception_id === deliv.exception_ref
      );
      if (!exc || exc.status !== "active") {
        throw new ControllerError(
          "EXCEPTION_EXPIRED",
          `Waived deliverable "${deliv.id}" references inactive or missing exception "${deliv.exception_ref}".`,
          { deliverable_id: deliv.id, exception_ref: deliv.exception_ref }
        );
      }

      // Strict UTC expiration boundary check
      const expiryBoundary = new Date(`${exc.expiration_date}T23:59:59.999Z`).getTime();
      if (isNaN(expiryBoundary) || now.getTime() > expiryBoundary) {
        throw new ControllerError(
          "EXCEPTION_EXPIRED",
          `Exception "${exc.exception_id}" expired on ${exc.expiration_date}. Expired exceptions cannot authorize waivers.`,
          { exception_id: exc.exception_id, expiration_date: exc.expiration_date }
        );
      }
    }
  }

  // 3. RFC blocking check
  for (const rfc of state.current_stage_detail?.rfcs || []) {
    if (rfc.is_blocking && rfc.status === "pending_decision") {
      throw new ControllerError(
        "RFC_BLOCKING_UNRESOLVED",
        `Unresolved blocking RFC exists: "${rfc.rfc_id}" (${rfc.title}). Resolve before submitting for review.`,
        { rfc_id: rfc.rfc_id }
      );
    }
  }

  // 4. Exit package verification
  const packageRelPath =
    options.packagePath ||
    state.current_stage_detail?.exit_package?.path ||
    `docs/gates/GATE-${stageToSubmit}-EXIT-PACKAGE.md`;

  let validatedPath: { relativePath: string; absolutePath: string };
  try {
    validatedPath = validateCanonicalPath(targetDir, packageRelPath);
  } catch (err: unknown) {
    if (err instanceof TransactionError) {
      throw new ControllerError(err.code, err.message, { path: packageRelPath });
    }
    throw new ControllerError(
      "TARGET_PATH_INVALID",
      `Invalid exit package path: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!fs.existsSync(validatedPath.absolutePath)) {
    throw new ControllerError(
      "EXIT_PACKAGE_MISSING",
      `Stage Gate Exit Package file does not exist on disk at "${validatedPath.relativePath}". Compile exit package before submitting for review.`,
      { path: validatedPath.relativePath }
    );
  }

  const packageContent = fs.readFileSync(validatedPath.absolutePath, "utf-8");
  const profile = resolveGovernanceProfile(targetDir, manifest);
  const isStrict = options.strict ?? (profile === "strict");
  const packageValidation = validateExitPackageAst(packageContent, {
    stage: stageToSubmit,
    strict: isStrict,
  });
  if (!packageValidation.valid) {
    throw new ControllerError(
      "EXIT_PACKAGE_INCOMPLETE",
      `Exit package at "${validatedPath.relativePath}" is structurally incomplete:\n${packageValidation.errors.join("\n")}`,
      { errors: packageValidation.errors, diagnostics: packageValidation.diagnostics }
    );
  }

  // Mutate state to pending_review
  const nextState: ProjectState = JSON.parse(JSON.stringify(state));
  nextState.stage_status = "pending_review";

  const stageName = STAGE_NAMES[stageToSubmit];
  nextState.current_stage_detail.exit_package = {
    status: "submitted_for_review",
    path: validatedPath.relativePath,
    submitted_at: nowIso,
  };

  nextState.current_stage_detail.human_approval = {
    status: "pending_review",
    approved_by: null,
    role: null,
    approval_mode: options.approvalMode || "solo",
    decision: null,
    signature_reference: null,
    approved_at: null,
    conditions: null,
  };

  const actor = options.actor || "agent:controller";
  const actorType = options.actorType || "agent";
  nextState.last_updated = {
    timestamp: nowIso,
    updated_by: actor,
    actor_type: actorType,
    reason: `Submitted Stage ${stageToSubmit} (${stageName}) Exit Package for human review. Phase 1 Handover complete.`,
  };

  const postVal = validator.validateState(nextState);
  if (!postVal.valid) {
    throw new ControllerError(
      "STATE_SCHEMA_INVALID",
      `Post-submission state failed schema validation:\n${postVal.formattedErrors}`,
      { errors: postVal.errors }
    );
  }

  const currentSha256 = computeFileSha256(path.resolve(targetDir, DEFAULT_PATHS.stateFile)) || undefined;
  const statePayload = JSON.stringify(nextState, null, 2) + "\n";

  const txManager = new WriteAheadTransactionManager({
    targetDir,
    lockTimeoutMs: options.lockTimeoutMs,
  });

  const txResult = await txManager.executeTransaction(
    "REQUEST_HUMAN_APPROVAL",
    [
      {
        operation: "write",
        targetPath: DEFAULT_PATHS.stateFile,
        content: statePayload,
        expectedPreviousSha256: currentSha256,
      },
    ],
    {
      stage: stageToSubmit,
      actor,
      packagePath: validatedPath.relativePath,
    }
  );

  return {
    success: true,
    stage: stageToSubmit,
    stageName,
    stageStatus: "pending_review",
    exitPackage: nextState.current_stage_detail.exit_package,
    humanApproval: nextState.current_stage_detail.human_approval,
    txId: txResult.txId,
    recovery: txResult.recovery,
  };
}
