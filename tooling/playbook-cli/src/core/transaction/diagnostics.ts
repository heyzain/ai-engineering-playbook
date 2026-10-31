import type { DiagnosticIssue } from "../diagnostics/types.js";
import type { TransactionError } from "./types.js";

/**
 * Creates structured DiagnosticIssue from a TransactionError.
 */
export function createTransactionDiagnostic(
  error: TransactionError,
  targetDir: string
): DiagnosticIssue {
  const journalPath = ".playbook/tx-journal.json";

  switch (error.code) {
    case "TRANSACTION_JOURNAL_CORRUPT":
      return {
        code: "TRANSACTION_JOURNAL_CORRUPT",
        severity: "error",
        message: error.message,
        path: journalPath,
        remediation:
          "Found empty, incomplete, or corrupted Write-Ahead Transaction Journal. Automatic recovery is barred to prevent data loss. Inspect repository state with git diff and perform operator triage.",
      };

    case "CRITICAL_RECOVERY_FAILURE":
      return {
        code: "CRITICAL_RECOVERY_FAILURE",
        severity: "error",
        message: error.message,
        path: journalPath,
        remediation:
          "Transaction crash recovery failed because files could not be reconciled with the journal payload. Restore files to known valid state using git checkout.",
      };

    case "TRANSACTION_PREPARATION_FAILED":
      return {
        code: "TRANSACTION_FAILED",
        severity: "error",
        message: error.message,
        path: journalPath,
        remediation:
          "Transaction preparation failed before any live files were touched. Verify filesystem permissions and target paths.",
      };

    case "TRANSACTION_COMMIT_FAILED":
      return {
        code: "TRANSACTION_FAILED",
        severity: "error",
        message: error.message,
        path: journalPath,
        remediation:
          "Transaction commit failed during atomic file replacement. Check for open file handles, antivirus locking, or disk space issues.",
      };

    case "TARGET_PATH_INVALID":
      return {
        code: "TRANSACTION_FAILED",
        severity: "error",
        message: error.message,
        path: (error.details?.targetPath as string) || targetDir,
        remediation:
          "Transaction target path is invalid (contains '..' traversal, absolute path, or symlink boundary escape). Ensure all target paths are relative and within project root.",
      };

    case "EXTERNAL_TARGET_MODIFIED":
      return {
        code: "TRANSACTION_FAILED",
        severity: "error",
        message: error.message,
        path: (error.details?.targetPath as string) || targetDir,
        remediation:
          "Target file was modified or deleted externally between transaction preparation and commit. Inspect repository changes with git diff before re-running.",
      };

    case "RECOVERY_FAILED":
    case "TRANSACTION_LOCK_FAILED":
    default:
      return {
        code: "TRANSACTION_FAILED",
        severity: "error",
        message: error.message,
        path: targetDir,
        remediation:
          "A transaction operation encountered an unexpected failure. Inspect filesystem permissions, lock files, and transaction journal.",
      };
  }
}
