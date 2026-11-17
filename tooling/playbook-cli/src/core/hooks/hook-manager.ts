import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  type HookType,
  TARGET_HOOKS,
  type HookStatusReport,
  type HookInstallOptions,
  type HookInstallReport,
  type SingleHookInstallResult,
  type HookUninstallOptions,
  type HookUninstallReport,
  type SingleHookUninstallResult,
  type HookRunOptions,
  type HookRunResult,
  HookError,
} from "../../types/hooks.js";
import { resolveGitHooksDir, isInsideGitRepository } from "./hook-resolver.js";
import {
  generateWrapperScript,
  buildWrapperWithPreservedUserContent,
  exciseManagedBlock,
  parseHookMarkers,
} from "./hook-wrapper.js";
import {
  inspectHookDiskState,
  toSingleHookStatus,
  archiveConflictingHooks,
  archiveUserHookFile,
  cleanupStagingFiles,
  createStagingMetadata,
} from "./hook-recovery.js";
import { atomicRenameWithRetry, computeFileSha256 } from "../transaction/fs-utils.js";
import { PreCommitEngine } from "./pre-commit-engine.js";
import { PrePushEngine } from "./pre-push-engine.js";

export class GitHookManager {
  readonly cwd: string;
  readonly hooksDirOverride?: string;

  constructor(options?: { cwd?: string; hooksDir?: string }) {
    this.cwd = path.resolve(options?.cwd || process.cwd());
    this.hooksDirOverride = options?.hooksDir;
  }

  /**
   * Resolves the effective hooks directory.
   */
  resolveHooksDir(): string {
    return resolveGitHooksDir(this.cwd, this.hooksDirOverride);
  }

  /**
   * Inspects the status of all managed Git hooks (read-only).
   */
  status(): HookStatusReport {
    const isGit = isInsideGitRepository(this.cwd);
    const hooksDir = this.resolveHooksDir();

    const hooksRecord = {} as HookStatusReport["hooks"];
    let allHealthy = true;
    let recoveryNeeded = false;

    for (const hookName of TARGET_HOOKS) {
      const diskState = inspectHookDiskState(hooksDir, hookName);
      const status = toSingleHookStatus(hookName, diskState);
      hooksRecord[hookName] = status;

      if (status.recoveryRequired) {
        allHealthy = false;
        recoveryNeeded = true;
      }
      if (status.wrapperIntegrity === "corrupt") {
        allHealthy = false;
      }
    }

    return {
      targetDir: this.cwd,
      hooksDir,
      isGitRepository: isGit,
      hooks: hooksRecord,
      allHealthy,
      recoveryNeeded,
    };
  }

  /**
   * Installs Playbook managed wrappers around Git hooks using the crash-safe 3-phase protocol.
   */
  install(options?: HookInstallOptions): HookInstallReport {
    const hooksDir = this.resolveHooksDir();
    const dryRun = Boolean(options?.dryRun);
    const force = Boolean(options?.force);
    const allowInert = Boolean(options?.allowInert) || process.env.PLAYBOOK_HOOK_ALLOW_INERT === "1";

    if (!allowInert) {
      throw new HookError(
        "HOOK_VALIDATION_INERT",
        `Playbook validation engines for pre-commit and pre-push are scheduled for Task 006C.2/006C.3.\n` +
          `Installing inert hooks without validation creates a fail-open hazard where unverified commits proceed.\n` +
          `To explicitly permit installing transitional pass-through hooks, pass --allow-inert or set PLAYBOOK_HOOK_ALLOW_INERT=1.`
      );
    }

    if (!dryRun) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const results = {} as HookInstallReport["results"];
    let allSuccess = true;

    for (const hookName of TARGET_HOOKS) {
      cleanupStagingFiles(hooksDir, hookName);
      let diskState = inspectHookDiskState(hooksDir, hookName);
      const warnings: string[] = [...diskState.warnings];
      let userBackupPath: string | null = null;

      // Handle conflicting state
      if (diskState.isConflict) {
        if (!force) {
          throw new HookError(
            "ORIGINAL_HOOK_CONFLICT",
            `Conflicting files exist for hook "${hookName}": both unmanaged hook and "${hookName}.playbook-orig" exist with different content.\n` +
              `Run with --force to preserve both files in timestamped archives and proceed, or resolve manually.`,
            { hookName, hookPath: diskState.hookPath, origPath: diskState.origPath }
          );
        }

        if (dryRun) {
          warnings.push(`[dry-run] Conflicting files for "${hookName}" would be archived to timestamped backups.`);
        } else {
          const archived = archiveConflictingHooks(hooksDir, hookName);
          userBackupPath = archived.archivedHook || archived.archivedOrig || null;
          warnings.push(`Archived conflicting hook files to timestamped user backups.`);
          diskState = inspectHookDiskState(hooksDir, hookName);
        }
      }

      // Handle corrupt wrapper state
      if (diskState.wrapperIntegrity === "corrupt") {
        if (!force) {
          throw new HookError(
            "CORRUPT_HOOK_STATE",
            `Hook file "${hookName}" contains corrupt or malformed Playbook markers.\n` +
              `Run with --force to archive the corrupt file and install a clean wrapper, or repair manually.`,
            { hookName, hookPath: diskState.hookPath }
          );
        }

        if (dryRun) {
          warnings.push(`[dry-run] Corrupt hook file "${hookName}" would be archived to a timestamped backup.`);
        } else {
          const archived = archiveConflictingHooks(hooksDir, hookName);
          userBackupPath = archived.archivedHook || null;
          warnings.push(`Archived corrupt hook "${hookName}" to timestamped user backup.`);
          diskState = inspectHookDiskState(hooksDir, hookName);
        }
      }

      // Dry run early reporting
      if (dryRun) {
        let plannedAction: SingleHookInstallResult["action"] = "created";
        if (diskState.hookExists) {
          if (diskState.wrapperIntegrity === "unmanaged") {
            plannedAction = diskState.isInterruptedPhase2 ? "recovered_and_updated" : "wrapped";
          } else if (diskState.wrapperIntegrity === "valid" || diskState.wrapperIntegrity === "modified") {
            plannedAction = "updated";
          }
        }
        results[hookName] = {
          hookName,
          action: plannedAction,
          effectivePath: diskState.hookPath,
          originalBackupPath: diskState.origExists ? diskState.origPath : null,
          userBackupPath,
          success: true,
          warnings,
        };
        continue;
      }

      // Execution: 3-Phase Crash-Safe Protocol with Verifiable Staging Metadata
      const pid = process.pid;
      const nonce = crypto.randomBytes(4).toString("hex");
      const stagingWrapperName = `${hookName}.playbook-new.tmp.${pid}.${nonce}`;
      const stagingOrigName = `${hookName}.playbook-orig.tmp.${pid}.${nonce}`;
      const stagingWrapperPath = path.join(hooksDir, stagingWrapperName);
      const stagingOrigPath = path.join(hooksDir, stagingOrigName);
      const metaPath = createStagingMetadata(hooksDir, hookName, pid, nonce, [
        stagingWrapperName,
        stagingOrigName,
      ]);

      try {
        let installAction: SingleHookInstallResult["action"] = "created";

        if (!diskState.hookExists) {
          // Case A: No hook exists
          const wrapperContent = generateWrapperScript(hookName, undefined, allowInert, false);
          fs.writeFileSync(stagingWrapperPath, wrapperContent, { mode: 0o755 });
          atomicRenameWithRetry(stagingWrapperPath, diskState.hookPath);
          fs.chmodSync(diskState.hookPath, 0o755);
          installAction = "created";
        } else if (diskState.wrapperIntegrity === "unmanaged") {
          // Case B: Unmanaged hook exists
          if (diskState.isInterruptedPhase2) {
            // Interrupted between Phase 2 and 3: .playbook-orig is already an identical copy
            const wrapperContent = generateWrapperScript(hookName, undefined, allowInert, true);
            fs.writeFileSync(stagingWrapperPath, wrapperContent, { mode: 0o755 });
            atomicRenameWithRetry(stagingWrapperPath, diskState.hookPath);
            fs.chmodSync(diskState.hookPath, 0o755);
            installAction = "recovered_and_updated";
          } else {
            // Full 3-phase wrapping
            // Phase 1: Stage the wrapper
            const wrapperContent = generateWrapperScript(hookName, undefined, allowInert, true);
            fs.writeFileSync(stagingWrapperPath, wrapperContent, { mode: 0o755 });

            // Phase 2: Copy and commit original backup
            fs.copyFileSync(diskState.hookPath, stagingOrigPath);
            fs.chmodSync(stagingOrigPath, (diskState.hookMode ?? 0o755) | 0o755);
            atomicRenameWithRetry(stagingOrigPath, diskState.origPath);

            // Phase 3: Replace primary hook with wrapper
            atomicRenameWithRetry(stagingWrapperPath, diskState.hookPath);
            fs.chmodSync(diskState.hookPath, 0o755);
            installAction = "wrapped";
          }
        } else if (diskState.wrapperIntegrity === "valid") {
          // Case C: Pure Playbook wrapper already installed
          const wrapperContent = generateWrapperScript(hookName, undefined, allowInert, diskState.origExists);
          const currentContent = fs.readFileSync(diskState.hookPath, "utf-8").replace(/\r\n/g, "\n");

          // Strip timestamp comments when checking idempotency
          if (stripTimestamp(currentContent) === stripTimestamp(wrapperContent)) {
            installAction = "skipped_up_to_date";
          } else {
            fs.writeFileSync(stagingWrapperPath, wrapperContent, { mode: 0o755 });
            atomicRenameWithRetry(stagingWrapperPath, diskState.hookPath);
            fs.chmodSync(diskState.hookPath, 0o755);
            installAction = "updated";
          }
        } else if (diskState.wrapperIntegrity === "modified") {
          // Case D: Modified wrapper (user commands preserved around markers)
          const currentContent = fs.readFileSync(diskState.hookPath, "utf-8");
          const parsed = parseHookMarkers(currentContent);
          const updatedContent = buildWrapperWithPreservedUserContent(
            parsed.contentBefore || "",
            parsed.contentAfter || "",
            hookName,
            undefined,
            allowInert,
            diskState.origExists
          );
          fs.writeFileSync(stagingWrapperPath, updatedContent, { mode: diskState.hookMode || 0o755 });
          atomicRenameWithRetry(stagingWrapperPath, diskState.hookPath);
          fs.chmodSync(diskState.hookPath, 0o755);
          installAction = "updated";
        }

        // Successfully completed: remove staging metadata descriptor
        try {
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        } catch {
          // Ignore
        }

        const finalState = inspectHookDiskState(hooksDir, hookName);
        results[hookName] = {
          hookName,
          action: installAction,
          effectivePath: finalState.hookPath,
          originalBackupPath: finalState.origExists ? finalState.origPath : null,
          userBackupPath,
          success: true,
          warnings,
        };
      } catch (err: unknown) {
        allSuccess = false;
        // Clean up temporary staging files and descriptor on error
        try {
          if (fs.existsSync(stagingWrapperPath)) fs.unlinkSync(stagingWrapperPath);
        } catch {
          // Ignore
        }
        try {
          if (fs.existsSync(stagingOrigPath)) fs.unlinkSync(stagingOrigPath);
        } catch {
          // Ignore
        }
        try {
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        } catch {
          // Ignore
        }
        throw err;
      }
    }

    return {
      targetDir: this.cwd,
      hooksDir,
      dryRun,
      results,
      allSuccess,
    };
  }

  /**
   * Safely uninstalls Playbook managed wrappers, restoring original hooks byte-for-byte.
   */
  uninstall(options?: HookUninstallOptions): HookUninstallReport {
    const hooksDir = this.resolveHooksDir();
    const force = Boolean(options?.force);

    const results = {} as HookUninstallReport["results"];
    let allSuccess = true;

    for (const hookName of TARGET_HOOKS) {
      const diskState = inspectHookDiskState(hooksDir, hookName);
      const warnings: string[] = [...diskState.warnings];

      if (!diskState.hookExists) {
        if (diskState.origExists) {
          // Orphaned backup: restore to primary hook
          atomicRenameWithRetry(diskState.origPath, diskState.hookPath);
          if (diskState.origMode) {
            fs.chmodSync(diskState.hookPath, diskState.origMode);
          }
          results[hookName] = {
            hookName,
            action: "restored_original",
            effectivePath: diskState.hookPath,
            restoredFrom: diskState.origPath,
            success: true,
            warnings: [`Restored orphaned backup "${path.basename(diskState.origPath)}" to "${hookName}".`],
          };
        } else {
          results[hookName] = {
            hookName,
            action: "skipped_not_installed",
            effectivePath: diskState.hookPath,
            restoredFrom: null,
            success: true,
            warnings,
          };
        }
        continue;
      }

      // Hook exists: check ownership
      if (diskState.wrapperIntegrity === "unmanaged") {
        if (!force) {
          throw new HookError(
            "UNMANAGED_HOOK_PRESENT",
            `Hook "${hookName}" is unmanaged and does not contain Playbook markers. Refusing to delete or overwrite.`,
            { hookName, hookPath: diskState.hookPath }
          );
        }
        // Even with force, never delete unmanaged hook; report skipped
        results[hookName] = {
          hookName,
          action: "skipped_not_installed",
          effectivePath: diskState.hookPath,
          restoredFrom: null,
          success: true,
          warnings: [`Unmanaged hook "${hookName}" retained untouched.`],
        };
        continue;
      }

      if (diskState.wrapperIntegrity === "corrupt" && !force) {
        throw new HookError(
          "CORRUPT_HOOK_STATE",
          `Hook "${hookName}" contains corrupted Playbook markers. Run with --force to remove or repair manually.`,
          { hookName, hookPath: diskState.hookPath }
        );
      }

      // Managed hook restoration
      if (diskState.origExists) {
        if (diskState.backupIntegrity === "conflict" && !force) {
          throw new HookError(
            "BACKUP_CONFLICT",
            `Original backup "${path.basename(diskState.origPath)}" conflicts with hook state. Run with --force to preserve all files in timestamped archives and restore, or resolve manually.`,
            { hookName, origPath: diskState.origPath }
          );
        }

        // If corrupt wrapper or conflict, archive the hook before overwriting it
        if ((diskState.wrapperIntegrity === "corrupt" || diskState.backupIntegrity === "conflict") && force) {
          const archived = archiveUserHookFile(hooksDir, diskState.hookPath);
          warnings.push(
            `Hook "${hookName}" archived to "${path.basename(archived.archivePath)}" before restoring backup.`
          );
        }

        // Restore original hook byte-for-byte and verify integrity
        const origHash = computeFileSha256(diskState.origPath);
        atomicRenameWithRetry(diskState.origPath, diskState.hookPath);
        if (diskState.origMode) {
          fs.chmodSync(diskState.hookPath, diskState.origMode);
        }
        const restoredHash = computeFileSha256(diskState.hookPath);
        if (origHash !== restoredHash) {
          throw new HookError(
            "RESTORE_INTEGRITY_MISMATCH",
            `Restored hook "${hookName}" SHA-256 mismatch. Expected ${origHash}, got ${restoredHash}.`
          );
        }

        results[hookName] = {
          hookName,
          action: "restored_original",
          effectivePath: diskState.hookPath,
          restoredFrom: diskState.origPath,
          success: true,
          warnings,
        };
      } else {
        // No original backup exists
        if (diskState.wrapperIntegrity === "valid") {
          // Pure wrapper: safely unlink
          fs.unlinkSync(diskState.hookPath);
          results[hookName] = {
            hookName,
            action: "unlinked_wrapper",
            effectivePath: diskState.hookPath,
            restoredFrom: null,
            success: true,
            warnings,
          };
        } else if (diskState.wrapperIntegrity === "modified") {
          // User code exists outside markers: excise managed block
          const content = fs.readFileSync(diskState.hookPath, "utf-8");
          const excised = exciseManagedBlock(content);
          fs.writeFileSync(diskState.hookPath, excised, { mode: diskState.hookMode || 0o755 });
          results[hookName] = {
            hookName,
            action: "excised_managed_block",
            effectivePath: diskState.hookPath,
            restoredFrom: null,
            success: true,
            warnings,
          };
        } else if (force) {
          // Corrupt wrapper with force: archive before unlinking so user bytes are never lost!
          const archived = archiveUserHookFile(hooksDir, diskState.hookPath);
          results[hookName] = {
            hookName,
            action: "unlinked_wrapper",
            effectivePath: diskState.hookPath,
            restoredFrom: null,
            success: true,
            warnings: [`Corrupted wrapper "${hookName}" archived to "${path.basename(archived.archivePath)}" before removal via --force.`],
          };
        }
      }
    }

    return {
      targetDir: this.cwd,
      hooksDir,
      results,
      allSuccess,
    };
  }

  /**
   * Internal dispatcher for hook execution.
   * Executes real Git validation:
   * - `pre-commit`: Staged Git index validation via PreCommitEngine
   * - `pre-push`: Pushed commit and tree validation via PrePushEngine
   */
  async run(options: HookRunOptions): Promise<HookRunResult> {
    const { hookType } = options;

    if (hookType !== "pre-commit" && hookType !== "pre-push") {
      return {
        success: false,
        exitCode: 1,
        message: `Unknown or unsupported hook type "${hookType}". Expected "pre-commit" or "pre-push".`,
      };
    }

    const allowInert = Boolean(options.allowInert) || process.env.PLAYBOOK_HOOK_ALLOW_INERT === "1";

    if (hookType === "pre-commit") {
      try {
        const engine = new PreCommitEngine(this.cwd);
        const res = await engine.validate({ allowInert });
        if (!res.success && allowInert) {
          console.error(`[playbook hook] WARNING: Pre-commit checks failed but tolerated via --allow-inert:\n${res.message}`);
          return { success: true, exitCode: 0, message: "Transitional execution permitted via --allow-inert." };
        }
        return {
          success: res.success,
          exitCode: res.exitCode,
          message: res.message,
        };
      } catch (err: unknown) {
        if (allowInert) {
          console.error(`[playbook hook] WARNING: Pre-commit error tolerated via --allow-inert: ${err}`);
          return { success: true, exitCode: 0, message: "Transitional execution permitted via --allow-inert." };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          exitCode: 1,
          message: `Pre-commit execution failed: ${msg}`,
        };
      }
    }

    if (hookType === "pre-push") {
      try {
        const engine = new PrePushEngine(this.cwd);
        const res = await engine.validate({
          stdin: options.stdin,
          args: options.args,
        });
        if (!res.success && allowInert) {
          console.error(`[playbook hook] WARNING: Pre-push checks failed but tolerated via --allow-inert:\n${res.message}`);
          return { success: true, exitCode: 0, message: "Transitional execution permitted via --allow-inert." };
        }
        return {
          success: res.success,
          exitCode: res.exitCode,
          message: res.message,
        };
      } catch (err: unknown) {
        if (allowInert) {
          console.error(`[playbook hook] WARNING: Pre-push error tolerated via --allow-inert: ${err}`);
          return { success: true, exitCode: 0, message: "Transitional execution permitted via --allow-inert." };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          exitCode: 1,
          message: `Pre-push execution failed: ${msg}`,
        };
      }
    }

    return {
      success: false,
      exitCode: 1,
      message: `Unsupported hook type: ${hookType}`,
    };
  }
}

function stripTimestamp(content: string): string {
  return content.replace(/^# Installed At:.*$/m, "");
}
