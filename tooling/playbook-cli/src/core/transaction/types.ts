import type { TransactionLockManager, TransactionLockHandle } from "../lock/index.js";

/**
 * Valid phases of a Write-Ahead Transaction Journal.
 */
export type TransactionPhase = "PREPARED" | "COMMITTING" | "COMMITTED";

/**
 * File mutation recorded inside the Write-Ahead Transaction Journal.
 */
export interface JournalFileEntry {
  /** Relative path from project root (e.g. ".playbook/state.json") */
  target_path: string;
  /** Relative path to temporary file during transaction execution */
  tmp_path: string;
  /** Relative path to backup file before overwrite (if file existed) */
  bak_path: string;
  /** Whether the file physically existed prior to transaction */
  existed_before: boolean;
  /** Expected SHA-256 hash of original file prior to write, or null if file did not exist */
  expected_source_hash: string | null;
  /** Expected SHA-256 hash of target content */
  expected_target_hash: string;
  /** Complete serialized target content to be committed */
  target_content: string;
  /** Complete original content prior to write (for rollback safety if existed) */
  original_content?: string | null;
}

/**
 * Data model for `.playbook/tx-journal.json`.
 */
export interface TransactionJournal {
  /** Unique transaction identifier (e.g. "tx-<timestamp>-<uuid>") */
  tx_id: string;
  /** Active transaction phase */
  phase: TransactionPhase;
  /** ISO timestamp when journal was prepared */
  created_at: string;
  /** ISO timestamp when transition to COMMITTING occurred */
  committing_at?: string;
  /** ISO timestamp when transition to COMMITTED occurred */
  committed_at?: string;
  /** Name of the high-level governance operation (e.g. "APPROVE_GATE", "ADVANCE_STAGE") */
  action: string;
  /** Nonce of the holding transaction.lock at journal creation */
  lock_nonce: string;
  /** Optional caller metadata */
  metadata?: Record<string, unknown>;
  /** Array of file specifications governed by this transaction */
  files: JournalFileEntry[];
}

/**
 * Specification for a file to be written as part of a transaction.
 */
export interface FileWriteSpec {
  /** Target file path relative to project root */
  targetPath: string;
  /** New content to write to target */
  content: string;
}

/**
 * Result returned after transaction crash recovery.
 */
export interface RecoveryResult {
  recovered: boolean;
  actionTaken: "rolled_back" | "rolled_forward" | "finalized_cleanup" | "none";
  txId?: string;
  originalPhase?: TransactionPhase;
  filesAffected: string[];
  details?: string;
}

/**
 * Error codes for transaction failures.
 */
export type TransactionFailureCode =
  | "PROJECT_UNINITIALIZED"
  | "TRANSACTION_JOURNAL_CORRUPT"
  | "CRITICAL_RECOVERY_FAILURE"
  | "TRANSACTION_PREPARATION_FAILED"
  | "TRANSACTION_COMMIT_FAILED"
  | "TARGET_PATH_INVALID"
  | "TRANSACTION_LOCK_FAILED"
  | "EXTERNAL_TARGET_MODIFIED"
  | "TTY_REQUIRED"
  | "AGENT_APPROVAL_PROHIBITED"
  | "GATE_MISMATCH"
  | "STAGE_NOT_READY_FOR_REVIEW"
  | "GATE_CRITERIA_UNMET"
  | "DELIVERABLE_UNVERIFIED"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_FILE_MISSING"
  | "EVIDENCE_RESULT_FAILED"
  | "BLOCKING_RFC_UNRESOLVED"
  | "EXCEPTION_EXPIRED"
  | "EXIT_PACKAGE_INCOMPLETE"
  | "STAGE_ALREADY_APPROVED"
  | "APPROVAL_FINGERPRINT_MISSING"
  | "APPROVAL_FINGERPRINT_MALFORMED"
  | "APPROVAL_STALE"
  | "ADVANCEMENT_BLOCKED"
  | "SNAPSHOT_CONFLICT"
  | "MILESTONE_MISMATCH"
  | "MANIFEST_STAGE_DRIFT"
  | "RECOVERY_FAILED";

/**
 * Structured error class for transaction and WAL operations.
 */
export class TransactionError extends Error {
  readonly code: TransactionFailureCode;
  readonly details?: Record<string, unknown>;

  constructor(code: TransactionFailureCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TransactionError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Fault-injection hooks for deterministic unit testing of WAL crash points.
 */
export interface TransactionFaultInjectionHooks {
  /** Crash immediately after journal is written in PREPARED phase */
  failAfterJournalPrepared?: boolean;
  /** Crash immediately after journal is updated to COMMITTING phase */
  failAfterEnteringCommitting?: boolean;
  /** Crash immediately after the first target file is renamed */
  failAfterFirstTargetWrite?: boolean;
  /** Crash between target file renames (on file index >= 1) */
  failBetweenTargetWrites?: boolean;
  /** Crash after all target files are renamed but before journal is updated to COMMITTED */
  failAfterAllTargetsWrittenBeforeCommitted?: boolean;
  /** Crash after journal is updated to COMMITTED but before temporary/journal cleanup */
  failAfterCommittedBeforeCleanup?: boolean;
  /** Simulate Windows EBUSY / EPERM file locking on rename for N attempts */
  simulateRenameEbusyCount?: number;
  /** Simulate I/O failure on parent directory fsync */
  failDirectoryFsync?: boolean;
  /** Simulate I/O failure on parent directory fsync during commit phase */
  failDirectoryFsyncOnCommit?: boolean;
  /** Internal flag indicating commit phase is active */
  isCommitPhase?: boolean;
  /** Callback fired whenever parent directory fsync is invoked */
  onDirectoryFsync?: (dirPath: string) => void;
}

/**
 * Configuration options for WriteAheadTransactionManager.
 */
export interface TransactionManagerOptions {
  targetDir?: string;
  journalPath?: string;
  lockManager?: TransactionLockManager;
  lockTimeoutMs?: number;
  maxRenameRetries?: number;
  renameRetryDelayMs?: number;
  faultInjection?: TransactionFaultInjectionHooks;
}
