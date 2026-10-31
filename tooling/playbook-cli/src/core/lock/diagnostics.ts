import type { DiagnosticIssue } from "../diagnostics/types.js";
import type { LockError } from "./types.js";

/**
 * Creates structured DiagnosticIssue from a LockError.
 */
export function createLockDiagnostic(error: LockError, targetDir: string): DiagnosticIssue {
  const lockPath = ".playbook/transaction.lock";

  switch (error.code) {
    case "LOCK_HELD_BY_ACTIVE_PROCESS":
      return {
        code: "LOCK_HELD_BY_ACTIVE_PROCESS",
        severity: "error",
        message: error.message,
        path: lockPath,
        remediation: "An active Playbook transaction is currently in progress. Wait for the active process to complete its operation.",
      };

    case "LOCK_METADATA_UNREADABLE":
      return {
        code: "LOCK_METADATA_UNREADABLE",
        severity: "error",
        message: error.message,
        path: lockPath,
        remediation: "Found empty or corrupt lock metadata. Automatic deletion is barred to prevent split-brain state mutations. Audit the local process tree, verify 0 playbook processes are running, and perform safe operator repair.",
      };

    case "RECLAIM_MARKER_UNVERIFIABLE":
      return {
        code: "RECLAIM_MARKER_UNVERIFIABLE",
        severity: "error",
        message: error.message,
        path: ".playbook/reclaim.lock",
        remediation: "Found unreadable or empty reclamation marker. Automatic deletion is barred. Verify no active processes are reclaiming and triage via operator maintenance.",
      };

    case "RECLAMATION_IN_PROGRESS":
      return {
        code: "RECLAMATION_IN_PROGRESS",
        severity: "error",
        message: error.message,
        path: ".playbook/reclaim.lock",
        remediation: "Another process is currently reclaiming a stale lock. Contenders must wait for reclamation to complete.",
      };

    case "LOCK_LOST_DURING_TRANSACTION":
      return {
        code: "LOCK_LOST_DURING_TRANSACTION",
        severity: "error",
        message: error.message,
        path: lockPath,
        remediation: "Lock ownership was lost during transaction execution (nonce mismatch). The operation must abort without deleting the replacement lock.",
      };

    case "CROSS_HOST_LOCK_UNVERIFIABLE":
      return {
        code: "CROSS_HOST_LOCK_UNVERIFIABLE",
        severity: "error",
        message: error.message,
        path: lockPath,
        remediation: "Lock was acquired by another host. Process liveness cannot be verified across physical machines. Coordinate with the other host or inspect shared storage.",
      };

    case "UNSUPPORTED_FILESYSTEM":
      return {
        code: "UNSUPPORTED_FILESYSTEM",
        severity: "error",
        message: error.message,
        path: targetDir,
        remediation: "The project is stored on an unsupported networked filesystem (e.g. UNC share, NFSv3). Move repository to a local NTFS, ext4, or APFS filesystem to guarantee atomic mutual exclusion.",
      };

    case "LOCK_TIMEOUT":
      return {
        code: "LOCK_TIMEOUT",
        severity: "error",
        message: error.message,
        path: lockPath,
        remediation: "Lock acquisition timed out while waiting for competing processes. Check for deadlocks or long-running operations.",
      };

    case "LOCK_ACQUISITION_FAILED":
    default:
      return {
        code: "LOCK_ACQUISITION_FAILED",
        severity: "error",
        message: error.message,
        path: lockPath,
        remediation: "Lock acquisition encountered an unrecoverable error. Inspect filesystem permissions and lock files.",
      };
  }
}
