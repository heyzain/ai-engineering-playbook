import type { DiagnosticIssue } from "../diagnostics/types.js";

/**
 * Metadata recorded inside `.playbook/transaction.lock`.
 */
export interface LockMetadata {
  pid: number;
  hostname: string;
  created_at: string;
  nonce: string;
}

/**
 * Metadata recorded inside `.playbook/reclaim.lock`.
 */
export interface ReclaimMetadata {
  reclaiming_pid: number;
  hostname: string;
  target_nonce: string;
  created_at: string;
  nonce: string;
}

/**
 * Active lock handle returned upon successful acquisition.
 */
export interface TransactionLockHandle {
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
  readonly lockPath: string;
  readonly isReleased: boolean;
  release(): Promise<void>;
}

/**
 * Structured error codes for lock failures.
 */
export type LockFailureCode =
  | "LOCK_ACQUISITION_FAILED"
  | "LOCK_HELD_BY_ACTIVE_PROCESS"
  | "LOCK_METADATA_UNREADABLE"
  | "RECLAIM_MARKER_UNVERIFIABLE"
  | "RECLAMATION_IN_PROGRESS"
  | "LOCK_LOST_DURING_TRANSACTION"
  | "CROSS_HOST_LOCK_UNVERIFIABLE"
  | "UNSUPPORTED_FILESYSTEM"
  | "LOCK_TIMEOUT";

/**
 * Custom error class for lock operations with structured code and details.
 */
export class LockError extends Error {
  readonly code: LockFailureCode;
  readonly details?: Record<string, unknown>;

  constructor(code: LockFailureCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LockError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Result of process liveness check.
 */
export interface ProcessLivenessResult {
  isAlive: boolean;
  isVerifiedDead: boolean;
  isRecycled?: boolean;
  reason: string;
  pid: number;
  startTime?: Date;
}

/**
 * Pluggable function for checking process liveness and start-time.
 */
export type ProcessLivenessChecker = (
  pid: number,
  recordedCreatedAt?: string,
  recordedHostname?: string
) => ProcessLivenessResult | Promise<ProcessLivenessResult>;

/**
 * Pluggable function for checking filesystem support.
 */
export type FilesystemChecker = (dirPath: string) => { supported: boolean; reason?: string };

/**
 * Inspection report of on-disk lock state without mutating anything.
 */
export interface LockInspection {
  lockExists: boolean;
  lockPath: string;
  lockMetadata: LockMetadata | null;
  lockStatus: "unlocked" | "held" | "stale" | "unreadable" | "cross_host";
  reclaimExists: boolean;
  reclaimPath: string;
  reclaimMetadata: ReclaimMetadata | null;
  reclaimStatus: "none" | "active" | "stale" | "unreadable" | "cross_host";
  holderLiveness?: ProcessLivenessResult;
  diagnostic?: DiagnosticIssue;
}

/**
 * Fault-injection hooks for deterministic unit testing of crash scenarios.
 */
export interface FaultInjectionHooks {
  failAfterLockCreatedBeforePayload?: boolean;
  failAfterLockPayloadWrittenBeforeClose?: boolean;
  failAfterReclaimCreatedBeforePayload?: boolean;
  failAfterReclaimBeforeUnlinkTarget?: boolean;
  failAfterUnlinkTargetBeforeNewLock?: boolean;
  failAfterNewLockBeforeUnlinkReclaim?: boolean;
  failDuringPostAcquisitionCheck?: boolean;
  delayBeforePostCheckMs?: number;
  simulateConcurrentReclaimBeforePostCheck?: boolean;
}

/**
 * Configuration options for TransactionLockManager.
 */
export interface LockManagerOptions {
  targetDir?: string;
  lockDir?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  transientGracePeriodMs?: number;
  timeoutMs?: number;
  hostname?: string;
  pid?: number;
  livenessChecker?: ProcessLivenessChecker;
  filesystemChecker?: FilesystemChecker;
  faultInjection?: FaultInjectionHooks;
}
