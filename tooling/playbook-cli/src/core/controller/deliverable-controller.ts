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
import { resolveAuthoritativeVerification,resolveGovernanceProfile } from "./resolver.js";
import {loadQualityGatesConfig,getStageQualityGate,filterChecksForProfile} from "../quality-gates/config.js";
import {configurationFingerprint,toolFingerprint} from "../quality-gates/evidence-binding.js";
import {computeRif} from "../quality-gates/rif.js";
import {inspectWorkingTree} from "../quality-gates/policy.js";
import {assertEffectiveWaiver} from "./exception-lifecycle.js";
import {verifyExceptionAuthority} from "./exception-service.js";
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
    if (existing.status === "waived") throw new ControllerError("DELIVERABLE_WAIVED", "Use bound remediation evidence rather than overwriting an active waiver.");
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
  const remediation = nextState.current_stage_detail.exceptions.find(e => e.exception_id === targetDeliverable.exception_ref);
  const isRemediation = targetDeliverable.status === "waived" && options.remediationRef && remediation?.remediation_id === options.remediationRef;
  if (targetDeliverable.status === "waived" && !isRemediation) {
    throw new ControllerError(
      "DELIVERABLE_WAIVED",
      `Cannot record evidence for waived deliverable "${id}". Waived deliverables must be un-waived before verification.`,
      { deliverable_id: id }
    );
  }

  if (options.remediationRef && !isRemediation) throw new ControllerError("REMEDIATION_SCOPE_MISMATCH", "Evidence must bind the current target's active remediation marker.");
  if (isRemediation) {
    assertEffectiveWaiver(state,targetDeliverable,e=>verifyExceptionAuthority(targetDir,state,manifest,e),now);
    if (!remediation?.remediation_started_at || now.getTime() <= Date.parse(remediation.remediation_started_at) || now.getTime() <= Date.parse(remediation.authorized_at!)) {
      throw new ControllerError("REMEDIATION_EVIDENCE_NOT_FRESH", "Evidence must be strictly newer than initiation and authorization.");
    }
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
  if (evidenceRecord.result === "passed" && ["automated_test","build_typecheck","static_analysis","schema_validation","security_audit"].includes(evidenceRecord.type) && evidenceRecord.exit_code !== 0) {
    throw new ControllerError("EVIDENCE_RESULT_EXIT_MISMATCH","Passing automated proof must report exit code zero.");
  }
  if (options.toolVersion && !options.checkId) throw new ControllerError("EVIDENCE_CHECK_REQUIRED","Tool-version binding requires an explicit declared check ID.");
  if (options.checkId) {
    const config=loadQualityGatesConfig(targetDir);
    const check=filterChecksForProfile(getStageQualityGate(config,state.current_stage)?.checks || [],resolveGovernanceProfile(targetDir,manifest))
      .find(c=>c.id===options.checkId && c.deliverable_id===id && c.type===options.type);
    if (!check) throw new ControllerError("EVIDENCE_CHECK_MISMATCH","Check ID, target, type and selected profile must match the declared check.");
    if (check.tool_version_command && !options.toolVersion) throw new ControllerError("EVIDENCE_TOOL_VERSION_REQUIRED","Record the observed declared tool version or run the quality gate directly.");
    const clean=inspectWorkingTree(targetDir,"local").isClean;
    const version=options.toolVersion || "v1.0.0";
    const rif=computeRif({projectDir:targetDir,check,workingTreeClean:clean,toolVersion:version,ambientEnv:process.env,sensitivePatterns:config.global_settings.sensitive_patterns});
    evidenceRecord.rif=rif.rif;evidenceRecord.inputs_hash=rif.inputs_hash;evidenceRecord.working_tree_clean=clean;
    evidenceRecord.quality_gate={gate_id:`gate-stage-${state.current_stage}`,check_id:check.id,config_hash:configurationFingerprint(targetDir,manifest),tool_fingerprint:toolFingerprint(targetDir,check),tool_version:version};
  }
  if (nextState.schema_version === "1.1.0") {
    nextState.transaction_sequence = (nextState.transaction_sequence || 0) + 1;
    evidenceRecord.sequence = nextState.transaction_sequence;
    if (isRemediation) evidenceRecord.remediation_ref = options.remediationRef;
    nextState.audit_trail ||= [];
    nextState.audit_trail.push({action:"EVIDENCE_RECORDED",sequence:nextState.transaction_sequence,timestamp:nowIso,actor,actor_type:"agent",reason:"Verification evidence appended",deliverable_id:id,prior_authorization_ref:remediation?.authorization_ref || null});
  }

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

  if (isRemediation) {
    // Recording proof never retires a waiver; explicit remediation retirement owns that transition.
    targetDeliverable.status = "waived";
    targetDeliverable.validation_status = "waived";
  } else if (resolution.authoritativeResult === "passed") {
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
export async function recordException(_options: RecordExceptionOptions): Promise<RecordExceptionResult> {
  throw new ControllerError("EXCEPTION_LEGACY_WAIVER_DISABLED", "Documentary metadata cannot authorize a waiver. Use exception propose followed by an actual interactive exception approve after migration.");
}
