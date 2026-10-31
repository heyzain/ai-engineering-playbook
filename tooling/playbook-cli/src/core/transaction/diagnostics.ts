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

    case "TTY_REQUIRED":
      return {
        code: "TTY_REQUIRED",
        severity: "error",
        message: error.message,
        path: targetDir,
        remediation:
          "Gate approval requires an interactive terminal session. Automated, scripted, or piped approval invocations are strictly prohibited.",
      };

    case "AGENT_APPROVAL_PROHIBITED":
      return {
        code: "AGENT_APPROVAL_PROHIBITED",
        severity: "error",
        message: error.message,
        path: targetDir,
        remediation:
          "AI agents are strictly forbidden from approving quality gates. Approval requires an authorized human reviewer.",
      };

    case "GATE_MISMATCH":
      return {
        code: "GATE_MISMATCH",
        severity: "error",
        message: error.message,
        path: ".playbook/state.json",
        remediation:
          "The requested gate does not match the active lifecycle stage. Specify the correct gate number corresponding to current_stage.",
      };

    case "STAGE_ALREADY_APPROVED":
      return {
        code: "STAGE_ALREADY_APPROVED",
        severity: "error",
        message: error.message,
        path: ".playbook/state.json",
        remediation:
          "Active lifecycle stage has already received formal human approval. Run 'playbook advance' to advance to the next lifecycle stage.",
      };

    case "GATE_CRITERIA_UNMET":
      return {
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: error.message,
        path: ".playbook/state.json",
        remediation:
          "Cannot approve stage gate: deliverables are incomplete, unverified, or failing. Ensure all deliverables are verified or validly waived.",
      };

    case "APPROVAL_FINGERPRINT_MISSING":
      return {
        code: "APPROVAL_FINGERPRINT_MISSING",
        severity: "error",
        message: error.message,
        path: ".playbook/approval-fingerprint.json",
        remediation:
          "Approval fingerprint sidecar is missing. Human re-review and re-approval via 'playbook approve --gate <N>' is required.",
      };

    case "APPROVAL_STALE":
      return {
        code: "APPROVAL_STALE",
        severity: "error",
        message: error.message,
        path: ".playbook/approval-fingerprint.json",
        remediation:
          "Repository state or evidence files have drifted since human approval was granted. Re-verify deliverables and execute human re-approval.",
      };

    case "ADVANCEMENT_BLOCKED":
      return {
        code: "ADVANCEMENT_BLOCKED",
        severity: "error",
        message: error.message,
        path: ".playbook/state.json",
        remediation:
          "Lifecycle stage advancement is blocked. Resolve blocking prerequisites or obtain human gate approval before advancing.",
      };

    case "SNAPSHOT_CONFLICT":
      return {
        code: "SNAPSHOT_CONFLICT",
        severity: "error",
        message: error.message,
        path: (error.details?.snapshotPath as string) || ".playbook/milestones",
        remediation:
          "A milestone snapshot file already exists with differing contents. Overwriting milestone snapshots is prohibited. Increment milestone ID before sealing.",
      };

    case "MANIFEST_STAGE_DRIFT":
      return {
        code: "MANIFEST_STAGE_DRIFT",
        severity: "error",
        message: error.message,
        path: ".playbook/manifest.json",
        remediation:
          "Synchronize manifest active_lifecycle_stage with state.current_stage before advancing.",
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
