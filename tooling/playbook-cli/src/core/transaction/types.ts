import type { TransactionLockManager, TransactionLockHandle } from "../lock/index.js";

/**
 * Valid phases of a Write-Ahead Transaction Journal.
 */
export type TransactionPhase = "PREPARING" | "PREPARED" | "COMMITTING" | "COMMITTED";

/**
 * Valid mutation operations inside a transaction.
 */
export type JournalOperationType = "write" | "unlink";

/**
 * File mutation recorded inside the Write-Ahead Transaction Journal.
 */
export interface JournalFileEntry {
  /** High-level mutation operation (defaults to "write") */
  operation?: JournalOperationType;
  /** Relative path from project root (e.g. ".playbook/state.json") */
  target_path: string;
  /** Relative path to temporary file during transaction execution */
  tmp_path: string;
  /** Relative path to backup file before overwrite or unlink (if file existed) */
  bak_path: string;
  /** Whether the file physically existed prior to transaction */
  existed_before: boolean;
  /** Expected SHA-256 hash of original file prior to write/unlink, or null if file did not exist */
  expected_source_hash: string | null;
  /** Expected SHA-256 hash of target content (for write operations) */
  expected_target_hash?: string;
  /** Complete serialized target content to be committed (for write operations) */
  target_content?: string;
  /** Complete original content prior to write (for rollback safety if existed) */
  original_content?: string | null;
  /** For write: disallow overwriting if target already exists */
  create_only?: boolean;
  /** For write: apply read-only permissions (0o444) on commit */
  read_only_on_commit?: boolean;
  /** For unlink: whether target must exist at prepare/commit */
  must_exist?: boolean;
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
  operation?: "write";
  /** Target file path relative to project root */
  targetPath: string;
  /** New content to write to target */
  content: string;
  /** Disallow overwriting an existing target */
  createOnly?: boolean;
  /** Expected SHA-256 hash of prior target content */
  expectedPreviousSha256?: string;
  /** Set read-only permissions (0o444) on successful commit */
  readOnlyOnCommit?: boolean;
}

/**
 * Specification for a file to be deleted (unlinked) as part of a transaction.
 */
export interface FileUnlinkSpec {
  operation: "unlink";
  /** Target file path relative to project root */
  targetPath: string;
  /** Whether the file must exist; if false and absent, operation is a safe no-op */
  mustExist?: boolean;
  /** Expected SHA-256 hash of existing file to delete */
  expectedSha256?: string;
}

/**
 * Discriminated union of file operations accepted by the transaction manager.
 */
export type FileOperationSpec = FileWriteSpec | FileUnlinkSpec;

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
  | "GATE_REQUIRED_DELIVERABLE_MISSING"
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
  | "LIFECYCLE_NOT_TERMINAL"
  | "LIFECYCLE_ALREADY_REOPENED"
  | "INVALID_MILESTONE_ID"
  | "MILESTONE_ID_COLLISION"
  | "INVALID_REOPEN_STAGE"
  | "AGENT_REOPEN_PROHIBITED"
  | "CONFIRMATION_PHRASE_MISMATCH"
  | "SNAPSHOT_MISSING"
  | "REOPEN_BLOCKED"
  | "RECOVERY_FAILED"
  | "PIVOT_STORAGE_LAYOUT_MISSING"
  | "TRANSACTION_RECOVERY_REQUIRED"
  | "TARGET_ALREADY_EXISTS"
  | "PIVOT_INVALID_STAGE"
  | "LIFECYCLE_NOT_MAINTENANCE"
  | "PIVOT_PRD_NOT_OUTDATED"
  | "PIVOT_ABORTED"
  | "PIVOT_REASON_REQUIRED"
  | "STATE_CONCURRENTLY_MODIFIED"
  | "PRD_CONTENT_UNALTERED"
  | "PIVOT_TARGET_UNSUPPORTED";

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
  /** Crash immediately after journal is written in PREPARING phase */
  failAfterJournalPreparing?: boolean;
  /** Crash after staging files are written but before journal is updated to PREPARED */
  failAfterStagingBeforePrepared?: boolean;
  /** Crash immediately after journal is written in PREPARED phase */
  failAfterJournalPrepared?: boolean;
  /** Crash immediately after journal is updated to COMMITTING phase */
  failAfterEnteringCommitting?: boolean;
  /** Crash immediately after the first target file is renamed */
  failAfterFirstTargetWrite?: boolean;
  /** Crash between target file renames (on file index >= 1) */
  failBetweenTargetWrites?: boolean;
  /** Crash during an unlink operation during commit phase */
  failDuringUnlinkCommit?: boolean;
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
