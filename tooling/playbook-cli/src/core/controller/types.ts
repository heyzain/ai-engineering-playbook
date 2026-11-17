import type { StageNumber, StageName, ApprovalMode } from "../../constants.js";
import type {
  ProjectState,
  Deliverable,
  DeliverableStatus,
  ValidationStatus,
  EvidenceRecord,
  ExceptionRecord,
  ExitPackage,
  HumanApproval,
} from "../../types/state.js";
import type { RecoveryResult } from "../transaction/types.js";

/**
 * Standard structured error class for Operational Controller operations.
 */
export class ControllerError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "ControllerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Options for starting an active lifecycle stage (`START_STAGE`).
 */
export interface StartStageOptions {
  targetDir: string;
  stage?: StageNumber;
  actor?: string;
  actorType?: "agent" | "human";
  now?: Date;
  lockTimeoutMs?: number;
}

/**
 * Result of starting a lifecycle stage.
 */
export interface StartStageResult {
  success: boolean;
  stage: StageNumber;
  stageName: StageName;
  startedAt: string;
  deliverablesCount: number;
  txId: string;
  recovery?: RecoveryResult;
}

/**
 * Options for recording deliverable authoring (`RECORD_DELIVERABLE`).
 */
export interface RecordDeliverableOptions {
  targetDir: string;
  deliverableId: string;
  artifactPath: string;
  name?: string;
  description?: string;
  status?: "in_progress" | "completed";
  actor?: string;
  actorType?: "agent" | "human";
  now?: Date;
  lockTimeoutMs?: number;
}

/**
 * Result of recording a deliverable.
 */
export interface RecordDeliverableResult {
  success: boolean;
  deliverable: Deliverable;
  txId: string;
  recovery?: RecoveryResult;
}

/**
 * Options for appending verification proof (`RECORD_EVIDENCE`).
 */
export interface RecordEvidenceOptions {
  targetDir: string;
  deliverableId: string;
  type: string;
  result: "passed" | "failed" | "inconclusive";
  evidenceRef: string;
  procedure?: string;
  summary?: string;
  requirementId?: string | null;
  exitCode?: number | null;
  commitSha?: string | null;
  actor?: string;
  actorType?: "agent" | "human";
  now?: Date;
  lockTimeoutMs?: number;
}

/**
 * Result of recording evidence.
 */
export interface RecordEvidenceResult {
  success: boolean;
  deliverable: Deliverable;
  evidenceRecord: EvidenceRecord;
  promotedToVerified: boolean;
  demoted: boolean;
  authoritativeResolution: AuthoritativeResolutionResult;
  txId: string;
  recovery?: RecoveryResult;
}

/**
 * Options for waiving a deliverable via authorized exception (`RECORD_EXCEPTION`).
 */
export interface RecordExceptionOptions {
  targetDir: string;
  deliverableId: string;
  exceptionPath: string;
  actor?: string;
  actorType?: "agent" | "human";
  now?: Date;
  lockTimeoutMs?: number;
}

/**
 * Result of recording an exception waiver.
 */
export interface RecordExceptionResult {
  success: boolean;
  deliverable: Deliverable;
  exception: ExceptionRecord;
  txId: string;
  recovery?: RecoveryResult;
}

/**
 * Options for submitting stage exit package for human review (`REQUEST_HUMAN_APPROVAL`).
 */
export interface SubmitStageOptions {
  targetDir: string;
  stage?: StageNumber;
  packagePath?: string;
  approvalMode?: ApprovalMode;
  strict?: boolean;
  actor?: string;
  actorType?: "agent" | "human";
  now?: Date;
  lockTimeoutMs?: number;
}

/**
 * Result of submitting stage for review.
 */
export interface SubmitStageResult {
  success: boolean;
  stage: StageNumber;
  stageName: StageName;
  stageStatus: "pending_review";
  exitPackage: ExitPackage;
  humanApproval: HumanApproval;
  txId: string;
  recovery?: RecoveryResult;
}

/**
 * Result of authoritative verification evaluation.
 */
export interface AuthoritativeResolutionResult {
  authoritativeResult: "passed" | "failed" | "inconclusive" | "unverified";
  missingRequiredDisciplines: string[];
  failingDisciplines: string[];
  evaluatedDisciplines: Record<
    string,
    {
      latestResult: string;
      verifiedAt: string;
      evidenceRef: string;
      evidenceHash?: string | null;
    }
  >;
  isContended: boolean;
  blockingReasons: string[];
}
