import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS, type StageNumber } from "../../constants.js";
import type { ProjectState, Deliverable, EvidenceRecord, ExceptionRecord } from "../../types/state.js";
import type { ProjectManifest } from "../../types/manifest.js";
import { SchemaValidator } from "../validator.js";
import { isForbiddenAgentName } from "../approval.js";
import { validateExceptionDocumentAst } from "./ast-validators.js";
import {
  WriteAheadTransactionManager,
  computeFileSha256,
  validateCanonicalPath,
  TransactionError,
} from "../transaction/index.js";
import { inspectAndHashEvidenceFile } from "./fs-security.js";
import { resolveAuthoritativeVerification } from "./resolver.js";
import {
  ControllerError,
  type RecordDeliverableOptions,
  type RecordDeliverableResult,
  type RecordEvidenceOptions,
  type RecordEvidenceResult,
  type RecordExceptionOptions,
  type RecordExceptionResult,
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
  };
}

/**
 * Parses markdown exception document metadata.
 */
interface ParsedExceptionMetadata {
  exception_id: string;
  title: string;
  status: string;
  waived_requirement: string;
  authorized_by: string;
  expiration_date: string;
}

export function parseExceptionDocument(
  content: string,
  fileName: string
): ParsedExceptionMetadata {
  const result = validateExceptionDocumentAst(content, fileName);
  if (!result.metadata) {
    const firstDiag = result.diagnostics.find((d) => d.severity === "error") || {
      code: "EXCEPTION_METADATA_INVALID",
      message: result.errors[0] || `Exception document "${path.basename(fileName)}" has invalid metadata.`,
    };
    throw new ControllerError(firstDiag.code, firstDiag.message, { file: fileName });
  }
  return result.metadata;
}

/**
 * Implements Transition §3.3 (`RECORD_DELIVERABLE`).
 * Records an authored deliverable artifact path and updates status.
 */
export async function recordDeliverable(
  options: RecordDeliverableOptions
): Promise<RecordDeliverableResult> {
  const targetDir = path.resolve(options.targetDir);
  const validator = new SchemaValidator();
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  // Clock skew guard
  if (now.getTime() > Date.now() + 60_000) {
    throw new ControllerError(
      "EVIDENCE_CLOCK_SKEW",
      `Evidence timestamp "${nowIso}" exceeds 60s future clock skew tolerance.`,
      { timestamp: nowIso }
    );
  }

  const { state, manifest } = loadAndValidateState(targetDir, validator);

  if (state.stage_status !== "in_progress") {
    throw new ControllerError(
      "STAGE_NOT_IN_PROGRESS",
      `Cannot record deliverable when stage_status is "${state.stage_status}". Must be "in_progress".`,
      { current_status: state.stage_status }
    );
  }

  const id = options.deliverableId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new ControllerError(
      "DELIVERABLE_ID_INVALID",
      `Deliverable ID "${id}" is invalid. Must contain alphanumeric, underscore, or dash characters.`,
      { deliverable_id: id }
    );
  }

  let validatedPath: { relativePath: string; absolutePath: string };
  try {
    validatedPath = validateCanonicalPath(targetDir, options.artifactPath);
  } catch (err: unknown) {
    if (err instanceof TransactionError) {
      throw new ControllerError(err.code, err.message, { path: options.artifactPath });
    }
    throw new ControllerError(
      "TARGET_PATH_INVALID",
      `Invalid deliverable artifact path: ${err instanceof Error ? err.message : String(err)}`,
      { path: options.artifactPath }
    );
  }

  const status = options.status || "completed";

  // If status is completed, the target artifact file or directory must physically exist on disk
  if (status === "completed") {
    if (!fs.existsSync(validatedPath.absolutePath)) {
      throw new ControllerError(
        "DELIVERABLE_ARTIFACT_MISSING",
        `Cannot record deliverable "${id}" as completed: artifact path does not exist on disk at "${validatedPath.relativePath}".`,
        { deliverable_id: id, path: validatedPath.relativePath }
      );
    }
  }

  const nextState: ProjectState = JSON.parse(JSON.stringify(state));
  const deliverables = nextState.current_stage_detail.deliverables || [];
  const existingIndex = deliverables.findIndex((d) => d.id === id);

  let updatedDeliverable: Deliverable;

  if (existingIndex >= 0) {
    const existing = deliverables[existingIndex];
    updatedDeliverable = {
      ...existing,
      name: options.name || existing.name,
      description: options.description || existing.description,
      artifact_path: validatedPath.relativePath,
      status,
      // Recording authored deliverable resets validation status to unvalidated
      validation_status: "unvalidated",
    };
    deliverables[existingIndex] = updatedDeliverable;
  } else {
    updatedDeliverable = {
      id,
      name: options.name || id,
      description: options.description,
      artifact_path: validatedPath.relativePath,
      status,
      validation_status: "unvalidated",
      exception_ref: null,
      evidence: [],
    };
    deliverables.push(updatedDeliverable);
  }

  nextState.current_stage_detail.deliverables = deliverables;

  const actor = options.actor || "agent:controller";
  const actorType = options.actorType || "agent";
  nextState.last_updated = {
    timestamp: nowIso,
    updated_by: actor,
    actor_type: actorType,
    reason: `Recorded deliverable "${id}" at "${validatedPath.relativePath}" (status: ${status}).`,
  };

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
    "RECORD_DELIVERABLE",
    [
      {
        operation: "write",
        targetPath: DEFAULT_PATHS.stateFile,
        content: statePayload,
        expectedPreviousSha256: currentSha256,
      },
    ],
    {
      deliverable_id: id,
      actor,
    }
  );

  return {
    success: true,
    deliverable: updatedDeliverable,
    txId: txResult.txId,
    recovery: txResult.recovery,
  };
}

/**
 * Implements Transition §3.4 (`RECORD_EVIDENCE`).
 * Appends cryptographic verification proof to a deliverable without silent demotion.
 */
export async function recordEvidence(
  options: RecordEvidenceOptions
): Promise<RecordEvidenceResult> {
  const targetDir = path.resolve(options.targetDir);
  const validator = new SchemaValidator();
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  // Clock skew guard
  if (now.getTime() > Date.now() + 60_000) {
    throw new ControllerError(
      "EVIDENCE_CLOCK_SKEW",
      `Evidence timestamp "${nowIso}" exceeds 60s future clock skew tolerance.`,
      { timestamp: nowIso }
    );
  }

  const { state, manifest } = loadAndValidateState(targetDir, validator);

  if (state.stage_status !== "in_progress") {
    throw new ControllerError(
      "STAGE_NOT_IN_PROGRESS",
      `Cannot record evidence when stage_status is "${state.stage_status}". Must be "in_progress".`,
      { current_status: state.stage_status }
    );
  }

  const id = options.deliverableId.trim();
  const nextState: ProjectState = JSON.parse(JSON.stringify(state));
  const deliverables = nextState.current_stage_detail.deliverables || [];
  const delivIndex = deliverables.findIndex((d) => d.id === id);

  if (delivIndex < 0) {
    throw new ControllerError(
      "DELIVERABLE_NOT_FOUND",
      `Deliverable "${id}" does not exist in current stage ${state.current_stage}.`,
      { deliverable_id: id, stage: state.current_stage }
    );
  }

  const targetDeliverable = deliverables[delivIndex];

  // A waived deliverable cannot receive evidence (waivers take precedence)
  if (targetDeliverable.status === "waived") {
    throw new ControllerError(
      "DELIVERABLE_WAIVED",
      `Cannot record evidence for waived deliverable "${id}". Waived deliverables must be un-waived before verification.`,
      { deliverable_id: id }
    );
  }

  // Inspect and hash evidence file
  const inspectResult = inspectAndHashEvidenceFile(targetDir, options.evidenceRef);

  const actor = options.actor || "agent:controller";
  const actorType = options.actorType || "agent";

  const evidenceRecord: EvidenceRecord = {
    requirement_id: options.requirementId || null,
    type: options.type,
    procedure: options.procedure || `Executed ${options.type} verification procedure`,
    result: options.result,
    summary: options.summary || `Verification ${options.result} for ${id}`,
    exit_code: options.exitCode !== undefined ? options.exitCode : options.result === "passed" ? 0 : 1,
    commit_sha: options.commitSha || null,
    evidence_hash: inspectResult.fileHash,
    evidence_ref: inspectResult.relativePath,
    verified_at: nowIso,
    verified_by: actor,
    actor_type: actorType,
  };

  // Append evidence (Strictly append-only at application level)
  const existingEvidence = targetDeliverable.evidence || [];
  existingEvidence.push(evidenceRecord);
  targetDeliverable.evidence = existingEvidence;

  // Evaluate authoritative verification across all required disciplines
  deliverables[delivIndex] = targetDeliverable;
  const resolution = resolveAuthoritativeVerification(
    targetDir,
    state.current_stage,
    targetDeliverable,
    manifest,
    deliverables,
    now
  );

  let promotedToVerified = false;
  let demoted = false;

  if (resolution.authoritativeResult === "passed") {
    if (targetDeliverable.status !== "verified") {
      targetDeliverable.status = "verified";
      targetDeliverable.validation_status = "passed";
      promotedToVerified = true;
    } else {
      targetDeliverable.validation_status = "passed";
    }
  } else if (resolution.authoritativeResult === "failed") {
    // Non-demotion rule: If deliverable was ALREADY "verified", its status remains "verified" (NO SILENT DOWNGRADE)
    // Stage submission will catch the failing authoritative resolution fail-closed.
    if (targetDeliverable.status !== "verified") {
      targetDeliverable.validation_status = "failed";
      targetDeliverable.status = "in_progress";
      demoted = true;
    }
  } else {
    // "unverified" or "inconclusive" (e.g. missing required disciplines)
    // If not already verified, deliverable is still in progress / unvalidated
    if (targetDeliverable.status !== "verified") {
      targetDeliverable.validation_status = "unvalidated";
    }
  }

  deliverables[delivIndex] = targetDeliverable;
  nextState.current_stage_detail.deliverables = deliverables;

  nextState.last_updated = {
    timestamp: nowIso,
    updated_by: actor,
    actor_type: actorType,
    reason: `Recorded ${options.type} verification evidence for "${id}" (result: ${options.result}).`,
  };

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
    "RECORD_EVIDENCE",
    [
      {
        operation: "write",
        targetPath: DEFAULT_PATHS.stateFile,
        content: statePayload,
        expectedPreviousSha256: currentSha256,
      },
    ],
    {
      deliverable_id: id,
      result: options.result,
      actor,
    }
  );

  return {
    success: true,
    deliverable: targetDeliverable,
    evidenceRecord,
    promotedToVerified,
    demoted,
    authoritativeResolution: resolution,
    txId: txResult.txId,
    recovery: txResult.recovery,
  };
}

/**
 * Implements Transition §3.5 (`RECORD_EXCEPTION`).
 * Records an authorized human exception waiver against a deliverable.
 */
export async function recordException(
  options: RecordExceptionOptions
): Promise<RecordExceptionResult> {
  const targetDir = path.resolve(options.targetDir);
  const validator = new SchemaValidator();
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  // Clock skew guard
  if (now.getTime() > Date.now() + 60_000) {
    throw new ControllerError(
      "EVIDENCE_CLOCK_SKEW",
      `Evidence timestamp "${nowIso}" exceeds 60s future clock skew tolerance.`,
      { timestamp: nowIso }
    );
  }

  const { state, manifest } = loadAndValidateState(targetDir, validator);

  if (state.stage_status !== "in_progress") {
    throw new ControllerError(
      "STAGE_NOT_IN_PROGRESS",
      `Cannot record exception waiver when stage_status is "${state.stage_status}". Must be "in_progress".`,
      { current_status: state.stage_status }
    );
  }

  const id = options.deliverableId.trim();
  const nextState: ProjectState = JSON.parse(JSON.stringify(state));
  const deliverables = nextState.current_stage_detail.deliverables || [];
  const delivIndex = deliverables.findIndex((d) => d.id === id);

  if (delivIndex < 0) {
    throw new ControllerError(
      "DELIVERABLE_NOT_FOUND",
      `Deliverable "${id}" does not exist in current stage ${state.current_stage}.`,
      { deliverable_id: id, stage: state.current_stage }
    );
  }

  const targetDeliverable = deliverables[delivIndex];

  // Validate exception file path within repository
  let validatedPath: { relativePath: string; absolutePath: string };
  try {
    validatedPath = validateCanonicalPath(targetDir, options.exceptionPath);
  } catch (err: unknown) {
    if (err instanceof TransactionError) {
      throw new ControllerError(err.code, err.message, { path: options.exceptionPath });
    }
    throw new ControllerError(
      "TARGET_PATH_INVALID",
      `Invalid exception path: ${err instanceof Error ? err.message : String(err)}`,
      { path: options.exceptionPath }
    );
  }

  if (!fs.existsSync(validatedPath.absolutePath)) {
    throw new ControllerError(
      "EXCEPTION_NOT_FOUND",
      `Exception markdown file does not exist on disk: "${validatedPath.relativePath}".`,
      { path: validatedPath.relativePath }
    );
  }

  const content = fs.readFileSync(validatedPath.absolutePath, "utf-8");
  const validation = validateExceptionDocumentAst(
    content,
    validatedPath.relativePath,
    id,
    now
  );

  if (!validation.valid || !validation.metadata) {
    const firstDiag = validation.diagnostics.find((d) => d.severity === "error") || {
      code: "EXCEPTION_METADATA_INVALID",
      message: validation.errors[0] || `Exception validation failed for "${validatedPath.relativePath}".`,
    };
    throw new ControllerError(firstDiag.code, firstDiag.message, {
      path: validatedPath.relativePath,
      errors: validation.errors,
      diagnostics: validation.diagnostics,
    });
  }

  const parsed = validation.metadata;

  // Update deliverable status to waived
  targetDeliverable.status = "waived";
  targetDeliverable.validation_status = "waived";
  targetDeliverable.exception_ref = parsed.exception_id;
  deliverables[delivIndex] = targetDeliverable;
  nextState.current_stage_detail.deliverables = deliverables;

  // Record in current_stage_detail.exceptions[]
  const exceptions = nextState.current_stage_detail.exceptions || [];
  const existingExcIndex = exceptions.findIndex((e) => e.exception_id === parsed.exception_id);

  const exceptionRecord: ExceptionRecord = {
    exception_id: parsed.exception_id,
    title: parsed.title,
    path: validatedPath.relativePath,
    waived_requirement: parsed.waived_requirement,
    authorized_by: parsed.authorized_by,
    authorized_at: nowIso,
    expiration_date: parsed.expiration_date,
    status: "active",
  };

  if (existingExcIndex >= 0) {
    exceptions[existingExcIndex] = exceptionRecord;
  } else {
    exceptions.push(exceptionRecord);
  }
  nextState.current_stage_detail.exceptions = exceptions;

  const actor = options.actor || "agent:controller";
  const actorType = options.actorType || "agent";
  nextState.last_updated = {
    timestamp: nowIso,
    updated_by: actor,
    actor_type: actorType,
    reason: `Waived deliverable "${id}" under authorized exception "${parsed.exception_id}".`,
  };

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
    "RECORD_EXCEPTION",
    [
      {
        operation: "write",
        targetPath: DEFAULT_PATHS.stateFile,
        content: statePayload,
        expectedPreviousSha256: currentSha256,
      },
    ],
    {
      deliverable_id: id,
      exception_id: parsed.exception_id,
      actor,
    }
  );

  return {
    success: true,
    deliverable: targetDeliverable,
    exception: exceptionRecord,
    txId: txResult.txId,
    recovery: txResult.recovery,
  };
}
