import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  type HookType,
  type SingleHookStatus,
  type HookWrapperIntegrity,
  type HookBackupIntegrity,
  ORIGINAL_HOOK_SUFFIX,
  USER_BACKUP_SUFFIX,
  HookError,
} from "../../types/hooks.js";
import { parseHookMarkers, isPurePlaybookWrapper } from "./hook-wrapper.js";
import { computeFileSha256, atomicRenameWithRetry } from "../transaction/fs-utils.js";
import { defaultProcessLivenessChecker } from "../lock/liveness.js";

export interface HookDiskState {
  hookPath: string;
  origPath: string;
  hookExists: boolean;
  origExists: boolean;
  hookHash: string | null;
  origHash: string | null;
  hookMode: number | null;
  origMode: number | null;
  wrapperIntegrity: HookWrapperIntegrity;
  backupIntegrity: HookBackupIntegrity;
  isInterruptedPhase2: boolean;
  isConflict: boolean;
  recoveryRequired: boolean;
  recoveryReason: string | null;
  warnings: string[];
}

/**
 * Inspects disk state for a single hook name in the target hooks directory.
 */
export function inspectHookDiskState(hooksDir: string, hookName: HookType): HookDiskState {
  const hookPath = path.join(hooksDir, hookName);
  const origPath = path.join(hooksDir, `${hookName}${ORIGINAL_HOOK_SUFFIX}`);

  const hookExists = fs.existsSync(hookPath);
  const origExists = fs.existsSync(origPath);

  const hookHash = hookExists ? computeFileSha256(hookPath) : null;
  const origHash = origExists ? computeFileSha256(origPath) : null;

  let hookMode: number | null = null;
  let origMode: number | null = null;

  try {
    if (hookExists) hookMode = fs.statSync(hookPath).mode;
  } catch {
    // Ignore
  }

  try {
    if (origExists) origMode = fs.statSync(origPath).mode;
  } catch {
    // Ignore
  }

  const warnings: string[] = [];
  let wrapperIntegrity: HookWrapperIntegrity = "missing";
  let backupIntegrity: HookBackupIntegrity = "not_applicable";
  let isInterruptedPhase2 = false;
  let isConflict = false;
  let recoveryRequired = false;
  let recoveryReason: string | null = null;

  if (!hookExists) {
    wrapperIntegrity = "missing";
    if (origExists) {
      // Orphaned backup without active hook
      backupIntegrity = "conflict";
      recoveryRequired = true;
      recoveryReason = `Orphaned backup "${path.basename(origPath)}" exists without primary hook.`;
      warnings.push(recoveryReason);
    }
  } else {
    let hookContent = "";
    try {
      hookContent = fs.readFileSync(hookPath, "utf-8");
    } catch {
      // Unreadable
    }

    const parsed = parseHookMarkers(hookContent);

    if (!parsed.hasMarkers) {
      wrapperIntegrity = "unmanaged";

      if (origExists) {
        if (hookHash && origHash && hookHash === origHash) {
          // Phase 2 completed (orig created), but Phase 3 was interrupted before primary replacement
          isInterruptedPhase2 = true;
          backupIntegrity = "verified";
          recoveryReason = "Previous installation was interrupted after original backup creation.";
        } else {
          // Both hook and .playbook-orig exist, but hashes differ!
          isConflict = true;
          backupIntegrity = "conflict";
          recoveryRequired = true;
          recoveryReason = `Conflicting files: unmanaged "${hookName}" and "${path.basename(origPath)}" both exist with different content.`;
          warnings.push(recoveryReason);
        }
      } else {
        backupIntegrity = "not_applicable";
      }
    } else if (parsed.markerState !== "valid") {
      wrapperIntegrity = "corrupt";
      recoveryRequired = true;
      recoveryReason = `Malformed or corrupted Playbook markers in "${hookName}" (${parsed.markerState}).`;
      warnings.push(recoveryReason);

      if (origExists) {
        backupIntegrity = "conflict";
      }
    } else {
      // Valid markers present
      if (isPurePlaybookWrapper(hookContent)) {
        wrapperIntegrity = "valid";
      } else {
        wrapperIntegrity = "modified";
        warnings.push(`Hook "${hookName}" contains custom user commands alongside the Playbook wrapper.`);
      }

      if (origExists) {
        backupIntegrity = "verified";
      } else if (parsed.hasCompanion === true) {
        backupIntegrity = "missing";
        recoveryRequired = true;
        recoveryReason = `Expected original hook backup "${path.basename(origPath)}" is missing.`;
        warnings.push(recoveryReason);
      } else {
        backupIntegrity = "not_applicable";
      }
    }
  }

  return {
    hookPath,
    origPath,
    hookExists,
    origExists,
    hookHash,
    origHash,
    hookMode,
    origMode,
    wrapperIntegrity,
    backupIntegrity,
    isInterruptedPhase2,
    isConflict,
    recoveryRequired,
    recoveryReason,
    warnings,
  };
}

export interface HookStagingMetadata {
  pid: number;
  hostname: string;
  created_at: string;
  staging_files: string[];
}

/**
 * Writes staging metadata descriptor to track active installer ownership.
 */
export function createStagingMetadata(
  hooksDir: string,
  hookName: HookType,
  pid: number,
  nonce: string,
  stagingFiles: string[]
): string {
  const metaFileName = `${hookName}.playbook-stage.${pid}.${nonce}.meta`;
  const metaPath = path.join(hooksDir, metaFileName);
  const meta: HookStagingMetadata = {
    pid,
    hostname: os.hostname(),
    created_at: new Date().toISOString(),
    staging_files: stagingFiles,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return metaPath;
}

/**
 * Converts internal disk state into SingleHookStatus model.
 */
export function toSingleHookStatus(hookName: HookType, state: HookDiskState): SingleHookStatus {
  const installed = state.wrapperIntegrity === "valid" || state.wrapperIntegrity === "modified";
  const validationStatus = installed ? "inert_transitional" : "inactive";
  const isInert = installed;
  const warnings = [...state.warnings];

  if (installed) {
    warnings.push("Validation engine inactive (Task 006C.1 transitional mode).");
  }

  return {
    hookName,
    effectivePath: state.hookPath,
    installed,
    wrapperIntegrity: state.wrapperIntegrity,
    originalBackupPresent: state.origExists,
    originalBackupPath: state.origExists ? state.origPath : null,
    originalBackupHash: state.origHash,
    backupIntegrity: state.backupIntegrity,
    validationStatus,
    isInert,
    recoveryRequired: state.recoveryRequired,
    recoveryReason: state.recoveryReason,
    warnings,
  };
}

/**
 * Safely archives a user hook file to a collision-proof timestamped backup.
 * Verifies byte-for-byte SHA-256 preservation before and after the operation.
 * NEVER deletes or destroys content silently.
 */
export function archiveUserHookFile(
  hooksDir: string,
  filePath: string,
  timestamp = Date.now()
): { archivePath: string; hash: string } {
  if (!fs.existsSync(filePath)) {
    throw new HookError("FILE_NOT_FOUND", `Cannot archive non-existent file: ${filePath}`);
  }

  const initialHash = computeFileSha256(filePath);
  if (!initialHash) {
    throw new HookError("FILE_UNREADABLE", `Could not compute SHA-256 for "${filePath}".`);
  }
  const baseName = path.basename(filePath);
  const nonce = crypto.randomBytes(4).toString("hex");

  let destPath = path.join(hooksDir, `${baseName}${USER_BACKUP_SUFFIX}.${timestamp}.${nonce}`);
  let counter = 0;
  while (fs.existsSync(destPath)) {
    counter++;
    destPath = path.join(hooksDir, `${baseName}${USER_BACKUP_SUFFIX}.${timestamp}.${nonce}.${counter}`);
  }

  atomicRenameWithRetry(filePath, destPath);

  const finalHash = computeFileSha256(destPath);
  if (!finalHash || initialHash !== finalHash) {
    throw new HookError(
      "BACKUP_INTEGRITY_MISMATCH",
      `SHA-256 mismatch after archiving "${baseName}" to "${path.basename(destPath)}". Expected ${initialHash}, got ${finalHash}.`
    );
  }

  return { archivePath: destPath, hash: finalHash };
}

/**
 * Safely archives conflicting hook and backup files to collision-proof user backups.
 * NEVER deletes or destroys content silently.
 */
export function archiveConflictingHooks(
  hooksDir: string,
  hookName: HookType,
  timestamp = Date.now()
): { archivedHook?: string; archivedOrig?: string } {
  const hookPath = path.join(hooksDir, hookName);
  const origPath = path.join(hooksDir, `${hookName}${ORIGINAL_HOOK_SUFFIX}`);
  const result: { archivedHook?: string; archivedOrig?: string } = {};

  if (fs.existsSync(origPath)) {
    const { archivePath } = archiveUserHookFile(hooksDir, origPath, timestamp);
    result.archivedOrig = archivePath;
  }

  if (fs.existsSync(hookPath)) {
    const { archivePath } = archiveUserHookFile(hooksDir, hookPath, timestamp);
    result.archivedHook = archivePath;
  }

  return result;
}

/**
 * Cleans up orphaned .tmp staging files from prior interrupted runs.
 *
 * Strict safety rules:
 * - Never deletes staging files based only on filename or age.
 * - Inspects .meta descriptor for PID and host ownership.
 * - Unknown or indeterminate process state means RETAIN the files.
 * - Cross-host staging files are always RETAINED.
 * - Only files belonging to a definitively dead process (verified via defaultProcessLivenessChecker) are removed.
 */
export function cleanupStagingFiles(hooksDir: string, hookName: HookType): void {
  try {
    if (!fs.existsSync(hooksDir)) return;
    const entries = fs.readdirSync(hooksDir);

    for (const file of entries) {
      if (!file.startsWith(`${hookName}.playbook-stage.`) || !file.endsWith(".meta")) {
        continue;
      }

      const metaPath = path.join(hooksDir, file);
      let meta: HookStagingMetadata;
      try {
        const raw = fs.readFileSync(metaPath, "utf-8");
        meta = JSON.parse(raw);
      } catch {
        // Corrupted or unreadable metadata: unknown state -> RETAIN
        continue;
      }

      if (!meta || typeof meta.pid !== "number" || !Array.isArray(meta.staging_files)) {
        // Invalid schema: unknown state -> RETAIN
        continue;
      }

      // Check cross-host
      if (meta.hostname && meta.hostname !== os.hostname()) {
        // Cross-host process cannot be verified locally: RETAIN
        continue;
      }

      // Check process liveness
      const liveness = defaultProcessLivenessChecker(meta.pid, meta.created_at, meta.hostname);
      if (liveness.isVerifiedDead === true) {
        // Process is definitively verified dead: clean up its declared staging files
        for (const staged of meta.staging_files) {
          // Prevent directory traversal from malicious or corrupt metadata
          if (typeof staged !== "string" || path.basename(staged) !== staged) {
            continue;
          }
          if (
            staged.startsWith(`${hookName}.playbook-new.tmp.`) ||
            staged.startsWith(`${hookName}.playbook-orig.tmp.`)
          ) {
            try {
              const fullStagedPath = path.join(hooksDir, staged);
              if (fs.existsSync(fullStagedPath)) {
                fs.unlinkSync(fullStagedPath);
              }
            } catch {
              // Ignore individual unlink errors
            }
          }
        }

        try {
          fs.unlinkSync(metaPath);
        } catch {
          // Ignore
        }
      }
      // If process is alive, indeterminate, or unverified: RETAIN
    }
  } catch {
    // Ignore top-level directory scan errors
  }
}
