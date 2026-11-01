import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS, STAGE_NAMES } from "../constants.js";
import { SchemaValidator } from "./validator.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  computeSha256,
  computeFileSha256,
  type FileOperationSpec,
} from "./transaction/index.js";
import { LockError } from "./lock/types.js";
import { isForbiddenAgentName } from "./approval.js";
import { evaluatePrdApplicability } from "./prd-applicability.js";
import type { ProjectState, PivotRecord } from "../types/state.js";
import type { ProjectManifest } from "../types/manifest.js";

/**
 * Baseline snapshot captured prior to displaying the interactive confirmation prompt.
 * Used to detect TOCTOU drift when the lock is acquired.
 */
export interface PrePromptBaseline {
  lifecycleStatus: string;
  milestoneId: string;
  currentStage: number;
  stageStatus: string;
  approvalDecision: string | null;
  stateFileHash: string;
  manifestFileHash: string;
  prdCoreHash: string;
  assessmentPath: string;
  assessmentFileHash: string;
  assessmentStatus: string;
  sidecarHash: string | null;
}

export interface PivotExecutionOptions {
  targetStage: number;
  authorizedBy: string;
  role: string;
  reason: string;
  confirmationPhrase: string;
  baseline?: PrePromptBaseline;
  now?: Date;
  lockTimeoutMs?: number;
  txManager?: WriteAheadTransactionManager;
  validator?: SchemaValidator;
  /** Test hook executed immediately after acquiring the lock and performing initial validations */
  onUnderLockValidation?: () => void | Promise<void>;
  /** Test hook executed immediately before txManager.prepare is invoked */
  beforePrepare?: () => void | Promise<void>;
}

export const REQUIRED_PIVOT_DIRECTORIES = [
  DEFAULT_PATHS.pivotsDir,
  DEFAULT_PATHS.docsPivotsDir,
  DEFAULT_PATHS.prdArchiveDir,
] as const;

/**
 * Asserts that all mandatory storage directories required for Stage Pivot exist on disk.
 * Fails closed with PIVOT_STORAGE_LAYOUT_MISSING if any required directory is absent.
 */
export function assertPivotStorageLayout(targetDir: string): void {
  for (const relDir of REQUIRED_PIVOT_DIRECTORIES) {
    const absDir = path.resolve(targetDir, relDir);
    if (!fs.existsSync(absDir)) {
      throw new TransactionError(
        "PIVOT_STORAGE_LAYOUT_MISSING",
        `Required pivot storage directory is missing: "${relDir}". Provision storage layout before executing pivot.`,
        { missingDirectory: relDir, targetPath: relDir }
      );
    }
  }
}

export interface PivotResult {
  success: boolean;
  pivotId: string;
  milestoneId: string;
  fromStage: 1;
  toStage: 0;
  txId: string;
  snapshotRef: string;
  auditRef: string;
  archivedPrdRef: string;
  sourcePrdHash: string;
}

/**
 * Preflight eligibility check for Stage 1 -> Stage 0 Pivot.
 * Validates initialization, storage layout, schemas, and preconditions C1-C4.
 * Returns the captured pre-prompt baseline.
 */
export function checkPivotEligibility(
  targetDir: string,
  targetStage: number,
  validator = new SchemaValidator()
): PrePromptBaseline {
  // Target stage boundary check
  if (targetStage !== 0) {
    throw new TransactionError(
      "PIVOT_TARGET_UNSUPPORTED",
      `Unsupported pivot target stage: ${targetStage}. Only pivot to Stage 0 is supported.`
    );
  }

  // Advisory preflight storage layout verification
  assertPivotStorageLayout(targetDir);

  const manifestPath = path.resolve(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
    throw new TransactionError(
      "PROJECT_UNINITIALIZED",
      "Cannot pivot: manifest or state file is missing."
    );
  }

  let rawManifest: unknown;
  let rawState: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    rawState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (err: unknown) {
    throw new TransactionError(
      "PIVOT_ABORTED",
      `Cannot pivot: governance file JSON syntax error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifestVal = validator.validateManifest(rawManifest);
  const stateVal = validator.validateState(rawState);
  if (!manifestVal.valid || !stateVal.valid) {
    const errMsgs = [
      ...manifestVal.errors.map((e) => `Manifest: ${e.message}`),
      ...stateVal.errors.map((e) => `State (${e.instancePath}): ${e.message}`),
    ].join("; ");
    throw new TransactionError(
      "PIVOT_ABORTED",
      `Cannot pivot: manifest or state fails JSON Schema validation. ${errMsgs}`
    );
  }

  const manifest = rawManifest as ProjectManifest;
  const state = rawState as ProjectState;

  // Consistency checks
  if (manifest.project_id !== state.project_id) {
    throw new TransactionError(
      "PIVOT_ABORTED",
      `Project ID mismatch: manifest has "${manifest.project_id}", state has "${state.project_id}".`
    );
  }

  if (manifest.active_milestone_id !== state.milestone_id) {
    throw new TransactionError(
      "PIVOT_ABORTED",
      `Milestone mismatch: manifest has "${manifest.active_milestone_id}", state has "${state.milestone_id}".`
    );
  }

  // C1: Lifecycle Status Guard
  if (state.lifecycle_status !== "reopened_maintenance") {
    throw new TransactionError(
      "LIFECYCLE_NOT_MAINTENANCE",
      `Cannot pivot: lifecycle is in '${state.lifecycle_status}' mode. Stage pivot is only permitted for active milestones in 'reopened_maintenance' mode.`
    );
  }

  // C2: Stage Boundary Guard
  if (state.current_stage !== 1) {
    throw new TransactionError(
      "PIVOT_INVALID_STAGE",
      `Cannot pivot: current lifecycle stage is ${state.current_stage}. Stage pivot is strictly permitted only from Stage 1 to Stage 0.`
    );
  }

  // C3: Unapproved Stage Guard
  if (
    state.stage_status === "approved" ||
    state.current_stage_detail?.human_approval?.decision === "GATE_APPROVED"
  ) {
    throw new TransactionError(
      "STAGE_ALREADY_APPROVED",
      "Cannot pivot: Stage 1 has already received formal human gate approval. Approved stages cannot be unapproved via pivot."
    );
  }

  // C4: Assessment Status Guard
  const prdCorePath = path.resolve(targetDir, "docs/prd/PRD-CORE.md");
  if (!fs.existsSync(prdCorePath)) {
    throw new TransactionError(
      "PIVOT_PRD_NOT_OUTDATED",
      "Cannot pivot: foundational Problem Statement 'docs/prd/PRD-CORE.md' is missing from disk."
    );
  }

  const assessment = evaluatePrdApplicability(targetDir, state.milestone_id, state.current_stage_detail);
  if (assessment.status !== "outdated") {
    throw new TransactionError(
      "PIVOT_PRD_NOT_OUTDATED",
      `Cannot pivot: PRD applicability assessment determination is '${assessment.status}'. Stage pivot requires an explicit 'OUTDATED' assessment bound to milestone '${state.milestone_id}'.`
    );
  }

  const assessmentPath = path.resolve(targetDir, assessment.path!);
  if (!fs.existsSync(assessmentPath)) {
    throw new TransactionError(
      "PIVOT_PRD_NOT_OUTDATED",
      `Assessment artifact at "${assessment.path}" is missing from disk.`
    );
  }

  const sidecarPath = path.resolve(targetDir, DEFAULT_PATHS.approvalFingerprintFile);
  const sidecarHash = fs.existsSync(sidecarPath) ? computeFileSha256(sidecarPath) : null;

  return {
    lifecycleStatus: state.lifecycle_status,
    milestoneId: state.milestone_id,
    currentStage: state.current_stage,
    stageStatus: state.stage_status,
    approvalDecision: state.current_stage_detail?.human_approval?.decision ?? null,
    stateFileHash: computeFileSha256(statePath)!,
    manifestFileHash: computeFileSha256(manifestPath)!,
    prdCoreHash: computeFileSha256(prdCorePath)!,
    assessmentPath: assessment.path!,
    assessmentFileHash: computeFileSha256(assessmentPath)!,
    assessmentStatus: assessment.status,
    sidecarHash,
  };
}

/**
 * Discovers the next monotonic pivot sequence number and generates the unique Pivot Event ID.
 * Scans `.playbook/pivots/`, `docs/pivots/`, and `docs/prd/archive/`.
 * Ensures collision avoidance: increments sequence until all 3 target paths are unoccupied.
 */
export function discoverNextPivotId(
  targetDir: string,
  milestoneId: string
): { pivotId: string; sequence: number } {
  const escapedMilestone = milestoneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const snapshotRegex = new RegExp(`^state-PVT-${escapedMilestone}-([0-9]{3,})\\.json$`);
  const auditRegex = new RegExp(`^PVT-${escapedMilestone}-([0-9]{3,})\\.md$`);
  const prdArchiveRegex = new RegExp(`^PRD-CORE\\.PVT-${escapedMilestone}-([0-9]{3,})\\.outdated\\.md$`);

  const sequences = new Set<number>();

  const scanDir = (dirRel: string, regex: RegExp) => {
    const dirAbs = path.resolve(targetDir, dirRel);
    if (!fs.existsSync(dirAbs)) return;
    try {
      const files = fs.readdirSync(dirAbs);
      for (const file of files) {
        const match = file.match(regex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > 0) {
            sequences.add(num);
          }
        }
      }
    } catch {
      // Ignore read errors during scanning
    }
  };

  scanDir(DEFAULT_PATHS.pivotsDir, snapshotRegex);
  scanDir(DEFAULT_PATHS.docsPivotsDir, auditRegex);
  scanDir(DEFAULT_PATHS.prdArchiveDir, prdArchiveRegex);

  let seq = sequences.size === 0 ? 1 : Math.max(...Array.from(sequences)) + 1;

  // Collision defense: verify none of the 3 candidate paths exist
  while (true) {
    const seqStr = String(seq).padStart(3, "0");
    const candidateId = `PVT-${milestoneId}-${seqStr}`;

    const snapPath = path.resolve(targetDir, DEFAULT_PATHS.pivotsDir, `state-${candidateId}.json`);
    const auditPath = path.resolve(targetDir, DEFAULT_PATHS.docsPivotsDir, `${candidateId}.md`);
    const archPath = path.resolve(targetDir, DEFAULT_PATHS.prdArchiveDir, `PRD-CORE.${candidateId}.outdated.md`);

    if (!fs.existsSync(snapPath) && !fs.existsSync(auditPath) && !fs.existsSync(archPath)) {
      return { pivotId: candidateId, sequence: seq };
    }

    seq++;
  }
}

/**
 * Formats the Markdown audit document for `docs/pivots/<PIVOT_ID>.md`.
 */
function buildAuditMarkdown(params: {
  pivotId: string;
  milestoneId: string;
  nowIso: string;
  authorizedBy: string;
  role: string;
  reason: string;
  sourcePrdHash: string;
  assessmentPath: string;
  assessmentAuthor?: string | null;
  assessmentSummary?: string | null;
  stageDetail: ProjectState["current_stage_detail"];
}): string {
  const {
    pivotId,
    milestoneId,
    nowIso,
    authorizedBy,
    role,
    reason,
    sourcePrdHash,
    assessmentPath,
    assessmentAuthor = "Unspecified",
    assessmentSummary = "Original problem statement declared outdated for active milestone.",
    stageDetail,
  } = params;

  let deliverablesRows = "";
  const deliverables = stageDetail.deliverables || [];
  if (deliverables.length === 0) {
    deliverablesRows = "| None | None | None | None | None |\n";
  } else {
    for (const d of deliverables) {
      deliverablesRows += `| ${d.id} | ${d.name} | ${d.artifact_path} | ${d.status} | ${d.validation_status} |\n`;
    }
  }

  let exceptionsList = "";
  const exceptions = stageDetail.exceptions || [];
  if (exceptions.length === 0) {
    exceptionsList = "- None.\n";
  } else {
    for (const exc of exceptions) {
      exceptionsList += `- \`${exc.exception_id}\`: Disposed as \`invalidated_by_pivot\`. (Stage 1 exceptions do NOT carry over to Stage 0 or future Stage 1 scopes).\n`;
    }
  }

  let rfcsList = "";
  const rfcs = stageDetail.rfcs || [];
  if (rfcs.length === 0) {
    rfcsList = "- None.\n";
  } else {
    for (const rfc of rfcs) {
      rfcsList += `- \`${rfc.rfc_id}\`: Disposed as \`superseded_by_pivot\`.\n`;
    }
  }

  let adrsList = "";
  const adrs = stageDetail.adrs || [];
  if (adrs.length === 0) {
    adrsList = "- None.\n";
  } else {
    for (const adr of adrs) {
      adrsList += `- \`${adr.adr_id}\`: Preserved on disk; architectural decisions flagged for re-evaluation against new Stage 0 problem formulation.\n`;
    }
  }

  return `# Stage Pivot Audit Record: ${pivotId}

## 1. Pivot Execution Metadata
- **Pivot Event ID**: \`${pivotId}\`
- **Milestone ID**: \`${milestoneId}\`
- **Source Stage**: Stage 1 (Requirements & Specification)
- **Target Stage**: Stage 0 (Discovery & Problem Formulation)
- **Executed At**: \`${nowIso}\`
- **Authorized By**: \`${authorizedBy}\`
- **Role / Authority**: \`${role}\`
- **Source PRD Hash**: \`${sourcePrdHash}\`
- **State Snapshot Reference**: \`.playbook/pivots/state-${pivotId}.json\`
- **Archived PRD Reference**: \`docs/prd/archive/PRD-CORE.${pivotId}.outdated.md\`

## 2. Invalidation Rationale & Assessment
- **Assessment Artifact**: \`${assessmentPath}\`
- **Assessment Determination**: \`OUTDATED\`
- **Assessment Author**: \`${assessmentAuthor}\`
- **Invalidation Summary**: \`${assessmentSummary}\`
- **Human Authorizer Justification**:
  > ${reason}

## 3. Preserved Stage 1 Artifacts & Evidence
| Deliverable ID | Name | Artifact Path | Status | Validation Status |
| :--- | :--- | :--- | :--- | :--- |
${deliverablesRows}
## 4. Historical RFC, ADR, and Exception Dispositions
- **Active Exceptions in Stage 1**:
${exceptionsList}- **Active RFCs in Stage 1**:
${rfcsList}- **ADRs Recorded in Stage 1**:
${adrsList}
## 5. Remediation Directives for Stage 0
1. Foundational discovery must be conducted for the revised problem domain.
2. Fresh \`PRD-CORE.md\` must be authored from scratch (cannot reuse outdated content).
3. Fresh Exit Package must be compiled and submitted for human Gate 0 sign-off (\`playbook approve --gate 0\`).
`;
}

/**
 * Executes controlled Stage 1 -> Stage 0 pivot under a unified WAL transaction.
 */
export async function executeStagePivot(
  targetDir: string,
  options: PivotExecutionOptions
): Promise<PivotResult> {
  // Target stage boundary check
  if (options.targetStage !== 0) {
    throw new TransactionError(
      "PIVOT_TARGET_UNSUPPORTED",
      `Unsupported pivot target stage: ${options.targetStage}. Only pivot to Stage 0 is supported.`
    );
  }

  const validator = options.validator || new SchemaValidator();
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  // Advisory preflight eligibility check & baseline capture
  const baseline = options.baseline || checkPivotEligibility(targetDir, options.targetStage, validator);

  // Authorizer identity validation (C5)
  const authorizedBy = options.authorizedBy?.trim();
  if (!authorizedBy) {
    throw new TransactionError(
      "AGENT_APPROVAL_PROHIBITED",
      "Authorizing human reviewer name is required."
    );
  }
  if (isForbiddenAgentName(authorizedBy)) {
    throw new TransactionError(
      "AGENT_APPROVAL_PROHIBITED",
      `Authorizing reviewer "${authorizedBy}" appears to be an automated agent. Stage pivots require sovereign human authorization.`
    );
  }

  const role = options.role?.trim();
  if (!role) {
    throw new TransactionError(
      "PIVOT_ABORTED",
      "Authorizer professional role is required."
    );
  }
  if (isForbiddenAgentName(role)) {
    throw new TransactionError(
      "AGENT_APPROVAL_PROHIBITED",
      `Authorizer role "${role}" appears to be an automated agent role. Stage pivots require sovereign human authorization.`
    );
  }

  // Justification guard (C6)
  const reason = options.reason?.trim();
  if (!reason) {
    throw new TransactionError(
      "PIVOT_REASON_REQUIRED",
      "Stage pivot requires an explicit, non-empty justification string."
    );
  }

  const txManager =
    options.txManager ||
    new WriteAheadTransactionManager({
      targetDir,
      lockTimeoutMs: options.lockTimeoutMs,
    });

  // Execute transaction under the exclusive transaction lock
  try {
    return await txManager.lockManager.withLock(
      async (lockHandle) => {
        // Step 0: Crash Recovery of any prior interrupted transaction
        await txManager.recover(lockHandle);

        // Step 1: Authoritative re-read under lock
        const manifestPath = path.resolve(targetDir, DEFAULT_PATHS.manifestFile);
        const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);
        const prdCorePath = path.resolve(targetDir, "docs/prd/PRD-CORE.md");

        if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
          throw new TransactionError(
            "PROJECT_UNINITIALIZED",
            "Cannot pivot: manifest or state file is missing."
          );
        }

        let rawManifest: unknown;
        let rawState: unknown;
        try {
          rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
          rawState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        } catch (err: unknown) {
          throw new TransactionError(
            "STATE_CONCURRENTLY_MODIFIED",
            `Governance file unparseable under lock: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const manifest = rawManifest as ProjectManifest;
        const state = rawState as ProjectState;

        // Step 2: Authoritative drift detection against pre-prompt baseline
        const currentStateHash = computeFileSha256(statePath)!;
        const currentManifestHash = computeFileSha256(manifestPath)!;
        const currentPrdHash = fs.existsSync(prdCorePath) ? computeFileSha256(prdCorePath) : null;

        const assessment = evaluatePrdApplicability(targetDir, state.milestone_id, state.current_stage_detail);
        const currentAssessmentPath = assessment.path ? path.resolve(targetDir, assessment.path) : null;
        const currentAssessmentHash =
          currentAssessmentPath && fs.existsSync(currentAssessmentPath)
            ? computeFileSha256(currentAssessmentPath)
            : null;

        const sidecarPath = path.resolve(targetDir, DEFAULT_PATHS.approvalFingerprintFile);
        const currentSidecarHash = fs.existsSync(sidecarPath) ? computeFileSha256(sidecarPath) : null;

        const driftErrors: string[] = [];
        if (state.lifecycle_status !== baseline.lifecycleStatus) {
          driftErrors.push(`lifecycle_status drifted: "${baseline.lifecycleStatus}" -> "${state.lifecycle_status}"`);
        }
        if (state.milestone_id !== baseline.milestoneId) {
          driftErrors.push(`milestone_id drifted: "${baseline.milestoneId}" -> "${state.milestone_id}"`);
        }
        if (state.current_stage !== baseline.currentStage) {
          driftErrors.push(`current_stage drifted: ${baseline.currentStage} -> ${state.current_stage}`);
        }
        if (state.stage_status !== baseline.stageStatus) {
          driftErrors.push(`stage_status drifted: "${baseline.stageStatus}" -> "${state.stage_status}"`);
        }
        if ((state.current_stage_detail?.human_approval?.decision ?? null) !== baseline.approvalDecision) {
          driftErrors.push(`human_approval.decision drifted`);
        }
        if (currentStateHash.toLowerCase() !== baseline.stateFileHash.toLowerCase()) {
          driftErrors.push(`state.json content hash drifted`);
        }
        if (currentManifestHash.toLowerCase() !== baseline.manifestFileHash.toLowerCase()) {
          driftErrors.push(`manifest.json content hash drifted`);
        }
        if (currentPrdHash?.toLowerCase() !== baseline.prdCoreHash.toLowerCase()) {
          driftErrors.push(`PRD-CORE.md content hash drifted`);
        }
        if (assessment.status !== baseline.assessmentStatus) {
          driftErrors.push(`PRD applicability assessment status drifted: "${baseline.assessmentStatus}" -> "${assessment.status}"`);
        }
        if (currentAssessmentHash?.toLowerCase() !== baseline.assessmentFileHash.toLowerCase()) {
          driftErrors.push(`PRD applicability assessment file content drifted`);
        }
        if (currentSidecarHash !== baseline.sidecarHash) {
          driftErrors.push(`approval fingerprint sidecar drifted`);
        }

        if (driftErrors.length > 0) {
          throw new TransactionError(
            "STATE_CONCURRENTLY_MODIFIED",
            `Project state or prerequisite files modified concurrently between prompt display and lock acquisition: ${driftErrors.join("; ")}`,
            { driftErrors }
          );
        }

        // Re-verify Authoritative Preconditions C1-C6 under lock
        if (state.lifecycle_status !== "reopened_maintenance") {
          throw new TransactionError("LIFECYCLE_NOT_MAINTENANCE", "Lifecycle is not in reopened_maintenance mode.");
        }
        if (state.current_stage !== 1) {
          throw new TransactionError("PIVOT_INVALID_STAGE", `Current stage is ${state.current_stage}, expected 1.`);
        }
        if (
          state.stage_status === "approved" ||
          state.current_stage_detail?.human_approval?.decision === "GATE_APPROVED"
        ) {
          throw new TransactionError("STAGE_ALREADY_APPROVED", "Stage 1 has already received gate approval.");
        }
        if (!fs.existsSync(prdCorePath) || assessment.status !== "outdated") {
          throw new TransactionError("PIVOT_PRD_NOT_OUTDATED", "Prerequisite PRD assessment is not OUTDATED.");
        }

        // Exact confirmation phrase check (C5)
        const expectedPhrase = `CONFIRM PIVOT TO STAGE 0 ${state.milestone_id}`;
        if (options.confirmationPhrase !== expectedPhrase) {
          throw new TransactionError(
            "PIVOT_ABORTED",
            `Confirmation phrase mismatch. Expected exactly "${expectedPhrase}", received "${options.confirmationPhrase}".`
          );
        }

        // Step 2.5: Re-verify mandatory storage layout under lock before sequence discovery
        assertPivotStorageLayout(targetDir);

        if (options.onUnderLockValidation) {
          await options.onUnderLockValidation();
          assertPivotStorageLayout(targetDir);
        }

        // Step 3: Discover unique pivot sequence & event ID
        const { pivotId } = discoverNextPivotId(targetDir, state.milestone_id);

        const snapshotRelPath = path.posix.join(DEFAULT_PATHS.pivotsDir, `state-${pivotId}.json`);
        const auditRelPath = path.posix.join(DEFAULT_PATHS.docsPivotsDir, `${pivotId}.md`);
        const archivedPrdRelPath = path.posix.join(DEFAULT_PATHS.prdArchiveDir, `PRD-CORE.${pivotId}.outdated.md`);

        // Read source PRD and calculate unalterable source hash
        const rawPrdContent = fs.readFileSync(prdCorePath, "utf-8");
        const sourcePrdHash = computeSha256(rawPrdContent);

        // Prep archive PRD content with warning banner
        const archiveContent = `> [!WARNING]
> **ARCHIVED & OUTDATED PROBLEM STATEMENT**
> This document was declared OUTDATED during Stage 1 under Pivot Event \`${pivotId}\` on \`${nowIso}\` by \`${authorizedBy}\`.
> It is preserved strictly for audit and historical context. It is NOT the active problem statement.

${rawPrdContent}`;

        // Build audit markdown
        const auditContent = buildAuditMarkdown({
          pivotId,
          milestoneId: state.milestone_id,
          nowIso,
          authorizedBy,
          role,
          reason,
          sourcePrdHash,
          assessmentPath: assessment.path || "docs/prd/PRD-CORE-ASSESSMENT.md",
          assessmentAuthor: assessment.author,
          assessmentSummary: assessment.reason,
          stageDetail: state.current_stage_detail,
        });

        // Deep clone state for pre-pivot snapshot
        const snapshotContent = JSON.stringify(state, null, 2) + "\n";

        // Step 4: Construct Stage 0 Re-initialized State
        const priorPivots = Array.isArray(state.pivots) ? state.pivots : [];
        const newPivotRecord: PivotRecord = {
          pivot_id: pivotId,
          milestone_id: state.milestone_id,
          from_stage: 1,
          to_stage: 0,
          pivoted_at: nowIso,
          authorized_by: authorizedBy,
          role,
          reason,
          snapshot_ref: snapshotRelPath,
          audit_ref: auditRelPath,
          archived_prd_ref: archivedPrdRelPath,
          source_prd_sha256: sourcePrdHash,
        };

        const nextState: ProjectState = {
          ...state,
          current_stage: 0,
          stage_status: "not_started",
          current_stage_detail: {
            stage: 0,
            stage_name: STAGE_NAMES[0],
            started_at: nowIso,
            deliverables: [
              {
                id: "PRD-CORE",
                name: "Problem Statement Document",
                artifact_path: "docs/prd/PRD-CORE.md",
                status: "not_started",
                validation_status: "unvalidated",
                exception_ref: null,
                evidence: [],
              },
            ],
            rfcs: [],
            adrs: [],
            exceptions: [],
            exit_package: {
              status: "not_drafted",
              path: "docs/gates/GATE-0-EXIT.md",
            },
            human_approval: {
              status: "not_requested",
              approved_by: null,
              role: null,
              approval_mode: null,
              decision: null,
              signature_reference: null,
              approved_at: null,
              conditions: null,
            },
          },
          last_updated: {
            timestamp: nowIso,
            updated_by: authorizedBy,
            actor_type: "human",
            reason: `Stage pivot to Stage 0 under event ${pivotId}: ${reason}`,
          },
          pivots: [...priorPivots, newPivotRecord],
        };

        const nextManifest: ProjectManifest = {
          ...manifest,
          active_lifecycle_stage: 0,
        };

        const nextStateContent = JSON.stringify(nextState, null, 2) + "\n";
        const nextManifestContent = JSON.stringify(nextManifest, null, 2) + "\n";

        // Step 5: Construct complete atomic operation set
        const fileOperations: FileOperationSpec[] = [
          {
            operation: "write",
            targetPath: snapshotRelPath,
            content: snapshotContent,
            createOnly: true,
            readOnlyOnCommit: true,
          },
          {
            operation: "write",
            targetPath: auditRelPath,
            content: auditContent,
            createOnly: true,
          },
          {
            operation: "write",
            targetPath: archivedPrdRelPath,
            content: archiveContent,
            createOnly: true,
          },
          {
            operation: "unlink",
            targetPath: "docs/prd/PRD-CORE.md",
            mustExist: true,
            expectedSha256: sourcePrdHash,
          },
          {
            operation: "unlink",
            targetPath: DEFAULT_PATHS.approvalFingerprintFile,
            mustExist: false,
          },
          {
            operation: "write",
            targetPath: DEFAULT_PATHS.stateFile,
            content: nextStateContent,
            createOnly: false,
            expectedPreviousSha256: currentStateHash,
          },
          {
            operation: "write",
            targetPath: DEFAULT_PATHS.manifestFile,
            content: nextManifestContent,
            createOnly: false,
            expectedPreviousSha256: currentManifestHash,
          },
        ];

        if (options.beforePrepare) {
          await options.beforePrepare();
          assertPivotStorageLayout(targetDir);
        }

        // Step 6: Execute WAL transaction with strict storage directory enforcement
        const journal = await txManager.prepare(
          "PIVOT_TO_STAGE_0",
          fileOperations,
          lockHandle,
          {
            pivotId,
            milestoneId: state.milestone_id,
            fromStage: 1,
            toStage: 0,
            sourcePrdHash,
          },
          {
            requireParentDirectoriesExist: true,
          }
        );

        await txManager.commit(journal, lockHandle);

        return {
          success: true,
          pivotId,
          milestoneId: state.milestone_id,
          fromStage: 1,
          toStage: 0,
          txId: journal.tx_id,
          snapshotRef: snapshotRelPath,
          auditRef: auditRelPath,
          archivedPrdRef: archivedPrdRelPath,
          sourcePrdHash,
        };
      },
      { timeoutMs: options.lockTimeoutMs }
    );
  } catch (err: unknown) {
    if (err instanceof LockError) {
      if (err.code === "LOCK_TIMEOUT" || err.code === "LOCK_HELD_BY_ACTIVE_PROCESS") {
        const inspection = await txManager.lockManager.inspect();
        if (inspection.holderLiveness?.isAlive || inspection.lockStatus === "held") {
          throw new LockError(
            "LOCK_HELD_BY_ACTIVE_PROCESS",
            `Cannot execute pivot: transaction lock is actively held by process PID ${inspection.lockMetadata?.pid} on ${inspection.lockMetadata?.hostname}.`
          );
        }
      }
    }
    throw err;
  }
}
