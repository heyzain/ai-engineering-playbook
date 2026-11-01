import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_PATHS } from "../../constants.js";
import { TransactionLockManager, type TransactionLockHandle } from "../lock/index.js";
import {
  type TransactionJournal,
  type JournalFileEntry,
  type FileWriteSpec,
  type FileUnlinkSpec,
  type FileOperationSpec,
  type RecoveryResult,
  type TransactionManagerOptions,
  type TransactionPrepareOptions,
  type TransactionFaultInjectionHooks,
  TransactionError,
} from "./types.js";
import {
  computeSha256,
  computeFileSha256,
  validateCanonicalPath,
  safeWriteAndSync,
  safeFsyncDir,
  atomicRenameWithRetry,
  safeUnlink,
} from "./fs-utils.js";
import {
  readJournal,
  writeJournalDurable,
  cleanupJournalDurable,
} from "./journal.js";

/**
 * WriteAheadTransactionManager coordinates multi-file write-ahead transactions
 * with crash-recoverable, fail-closed guarantees across governance operations.
 *
 * Implements strict safety invariants:
 * 1. Lock integration: All operations run under the exclusive TransactionLockManager.
 * 2. Four-phase protocol: PREPARING -> PREPARED -> COMMITTING -> COMMITTED.
 * 3. Journal-first staging invariant: PREPARING journal is durably written before staging files exist.
 * 4. Multi-operation support: Atomic multi-file writes (createOnly, expectedPreviousSha256, readOnlyOnCommit)
 *    and unlinks (mustExist, expectedSha256).
 * 5. Complete serialized target contents in journal for zero in-memory recovery dependency.
 * 6. Deterministic recovery:
 *    - PREPARING and PREPARED roll back cleanly to source state.
 *    - COMMITTING rolls forward cleanly to target state.
 *    - COMMITTED verifies targets and finalizes cleanup.
 * 7. Corrupted, unreadable, or conflicting journals fail closed immediately.
 * 8. Path containment: Target paths must be relative and strictly within project root.
 * 9. Recovery idempotency: Re-running recovery produces identical valid state without corruption.
 */
export class WriteAheadTransactionManager {
  readonly targetDir: string;
  readonly playbookDir: string;
  readonly journalPath: string;
  readonly lockManager: TransactionLockManager;
  readonly lockTimeoutMs: number;
  readonly maxRenameRetries: number;
  readonly renameRetryDelayMs: number;
  readonly faultInjection: TransactionFaultInjectionHooks;
  readonly requireParentDirectoriesExist: boolean;

  constructor(options?: TransactionManagerOptions) {
    this.targetDir = path.resolve(options?.targetDir || process.cwd());
    this.playbookDir = path.resolve(path.join(this.targetDir, DEFAULT_PATHS.playbookDir));
    this.journalPath = path.resolve(
      options?.journalPath || path.join(this.playbookDir, "tx-journal.json")
    );
    this.lockManager =
      options?.lockManager ||
      new TransactionLockManager({
        targetDir: this.targetDir,
        lockDir: this.playbookDir,
      });
    this.lockTimeoutMs = options?.lockTimeoutMs ?? 10000;
    this.maxRenameRetries = options?.maxRenameRetries ?? 5;
    this.renameRetryDelayMs = options?.renameRetryDelayMs ?? 50;
    this.faultInjection = options?.faultInjection || {};
    this.requireParentDirectoriesExist = options?.requireParentDirectoriesExist ?? false;
  }

  /**
   * Executes a multi-file transaction protected by the transaction lock.
   * Automatically executes crash recovery on any leftover prior journal before proceeding.
   */
  async executeTransaction<T>(
    action: string,
    fileOperations: (FileWriteSpec | FileOperationSpec)[],
    metadata?: Record<string, unknown>,
    options?: TransactionPrepareOptions
  ): Promise<{ txId: string; recovery?: RecoveryResult }> {
    return await this.withTransaction(action, fileOperations, undefined, metadata, options);
  }

  /**
   * High-level helper that executes custom logic within a transaction.
   */
  async withTransaction<T>(
    action: string,
    fileOperations: (FileWriteSpec | FileOperationSpec)[],
    callback?: (journal: TransactionJournal) => Promise<T>,
    metadata?: Record<string, unknown>,
    options?: TransactionPrepareOptions
  ): Promise<{ txId: string; result?: T; recovery?: RecoveryResult }> {
    return await this.lockManager.withLock(
      async (lockHandle) => {
        // Step 0: Crash Recovery Check
        // If an interrupted prior transaction journal exists, recover it before starting a new one
        const recovery = await this.recover(lockHandle);

        // Step 1: Prepare transaction
        const journal = await this.prepare(action, fileOperations, lockHandle, metadata, options);

        // Optional callback prior to commit
        let result: T | undefined;
        if (callback) {
          result = await callback(journal);
        }

        // Step 2: Commit transaction
        await this.commit(journal, lockHandle);

        return { txId: journal.tx_id, result, recovery };
      },
      { timeoutMs: this.lockTimeoutMs }
    );
  }

  /**
   * Phase 1: Prepares the transaction journal.
   * Validates paths, records original hashes, creates PREPARING journal first,
   * stages temporary files, and transitions journal to PREPARED phase before live files are modified.
   */
  async prepare(
    action: string,
    fileOperations: (FileWriteSpec | FileOperationSpec)[],
    lockHandle: TransactionLockHandle,
    metadata?: Record<string, unknown>,
    options?: TransactionPrepareOptions
  ): Promise<TransactionJournal> {
    if (lockHandle.isReleased) {
      throw new TransactionError(
        "TRANSACTION_LOCK_FAILED",
        "Cannot prepare transaction: transaction lock is not active or has been released."
      );
    }

    if (!Array.isArray(fileOperations) || fileOperations.length === 0) {
      throw new TransactionError(
        "TRANSACTION_PREPARATION_FAILED",
        "Transaction must contain at least one file operation specification."
      );
    }

    const requireParent =
      options?.requireParentDirectoriesExist ?? this.requireParentDirectoriesExist;

    const txId = `tx-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const journalFiles: JournalFileEntry[] = [];

    // Ensure .playbook directory exists
    if (!fs.existsSync(this.playbookDir)) {
      if (requireParent) {
        throw new TransactionError(
          "PIVOT_STORAGE_LAYOUT_MISSING",
          `Required storage directory is missing: "${DEFAULT_PATHS.playbookDir}". Directory creation is not permitted as an unjournaled side effect.`,
          { targetPath: DEFAULT_PATHS.playbookDir, missingDirectory: DEFAULT_PATHS.playbookDir }
        );
      }
      fs.mkdirSync(this.playbookDir, { recursive: true });
    }

    for (const spec of fileOperations) {
      const opType: "write" | "unlink" =
        "operation" in spec && spec.operation === "unlink" ? "unlink" : "write";
      const { relativePath, absolutePath } = validateCanonicalPath(this.targetDir, spec.targetPath);
      const existedBefore = fs.existsSync(absolutePath);

      let originalContent: string | null = null;
      let sourceHash: string | null = null;

      if (existedBefore) {
        try {
          originalContent = fs.readFileSync(absolutePath, "utf-8");
          sourceHash = computeSha256(originalContent);
        } catch (err: unknown) {
          throw new TransactionError(
            "TRANSACTION_PREPARATION_FAILED",
            `Failed to read existing target file "${relativePath}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            { originalError: err, targetPath: relativePath }
          );
        }
      }

      const tmpRelative = `${relativePath}.tmp.${txId}`;
      const bakRelative = `${relativePath}.bak.${txId}`;

      if (opType === "unlink") {
        const unlinkSpec = spec as FileUnlinkSpec;
        const mustExist = unlinkSpec.mustExist !== false;

        if (unlinkSpec.expectedSha256) {
          if (!existedBefore) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${relativePath}" expected to exist with hash ${unlinkSpec.expectedSha256}, but was not found.`,
              { targetPath: relativePath, expectedHash: unlinkSpec.expectedSha256 }
            );
          }
          if (sourceHash !== unlinkSpec.expectedSha256) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${relativePath}" hash mismatch prior to unlink (expected ${unlinkSpec.expectedSha256}, found ${sourceHash}).`,
              {
                targetPath: relativePath,
                expectedHash: unlinkSpec.expectedSha256,
                actualHash: sourceHash,
              }
            );
          }
        } else if (mustExist && !existedBefore) {
          throw new TransactionError(
            "TRANSACTION_PREPARATION_FAILED",
            `Target file "${relativePath}" is required to exist for unlink, but was not found.`,
            { targetPath: relativePath }
          );
        }

        journalFiles.push({
          operation: "unlink",
          target_path: relativePath,
          tmp_path: tmpRelative,
          bak_path: bakRelative,
          existed_before: existedBefore,
          expected_source_hash: sourceHash,
          original_content: originalContent,
          must_exist: mustExist,
        });
      } else {
        const writeSpec = spec as FileWriteSpec;
        const targetParentDir = path.dirname(absolutePath);
        const requireParentForSpec =
          writeSpec.requireParentDirectoryExists ?? requireParent;

        if (requireParentForSpec && !fs.existsSync(targetParentDir)) {
          const relParent = path.relative(this.targetDir, targetParentDir);
          throw new TransactionError(
            "PIVOT_STORAGE_LAYOUT_MISSING",
            `Required storage directory is missing for "${relativePath}": "${relParent}". Directory creation is not permitted as an unjournaled side effect.`,
            { targetPath: relativePath, missingDirectory: relParent }
          );
        }

        if (writeSpec.createOnly && existedBefore) {
          throw new TransactionError(
            "TARGET_ALREADY_EXISTS",
            `Target file "${relativePath}" already exists on disk, but createOnly was specified.`,
            { targetPath: relativePath }
          );
        }

        if (writeSpec.expectedPreviousSha256) {
          if (!existedBefore) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${relativePath}" was expected to have prior hash ${writeSpec.expectedPreviousSha256}, but file does not exist.`,
              { targetPath: relativePath, expectedHash: writeSpec.expectedPreviousSha256 }
            );
          }
          if (sourceHash !== writeSpec.expectedPreviousSha256) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${relativePath}" hash mismatch prior to write (expected ${writeSpec.expectedPreviousSha256}, found ${sourceHash}).`,
              {
                targetPath: relativePath,
                expectedHash: writeSpec.expectedPreviousSha256,
                actualHash: sourceHash,
              }
            );
          }
        }

        const targetHash = computeSha256(writeSpec.content);
        journalFiles.push({
          operation: "write",
          target_path: relativePath,
          tmp_path: tmpRelative,
          bak_path: bakRelative,
          existed_before: existedBefore,
          expected_source_hash: sourceHash,
          expected_target_hash: targetHash,
          target_content: writeSpec.content,
          original_content: originalContent,
          create_only: writeSpec.createOnly,
          read_only_on_commit: writeSpec.readOnlyOnCommit,
        });
      }
    }

    const journal: TransactionJournal = {
      tx_id: txId,
      phase: "PREPARING",
      created_at: new Date().toISOString(),
      action,
      lock_nonce: lockHandle.nonce,
      metadata,
      files: journalFiles,
    };

    // 1. Journal-First Invariant: Durably write journal in PREPARING phase before staging files
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
      faultInjection: this.faultInjection,
    });

    if (this.faultInjection.failAfterJournalPreparing) {
      throw new TransactionError(
        "TRANSACTION_PREPARATION_FAILED",
        "Fault injection: crash after journal in PREPARING phase."
      );
    }

    // 2. Pre-stage temporary files (.tmp) only for write operations
    for (const file of journalFiles) {
      if (file.operation !== "unlink") {
        const { absolutePath: absTmp } = validateCanonicalPath(this.targetDir, file.tmp_path);
        const tmpDir = path.dirname(absTmp);
        if (!fs.existsSync(tmpDir)) {
          if (requireParent) {
            const relTmp = path.relative(this.targetDir, tmpDir);
            throw new TransactionError(
              "PIVOT_STORAGE_LAYOUT_MISSING",
              `Required storage directory is missing for staging file: "${relTmp}". Directory creation is not permitted as an unjournaled side effect.`,
              { targetPath: file.target_path, missingDirectory: relTmp }
            );
          }
          fs.mkdirSync(tmpDir, { recursive: true });
        }
        safeWriteAndSync(absTmp, file.target_content!);
        safeFsyncDir(tmpDir, this.faultInjection);

        const stagedHash = computeFileSha256(absTmp);
        if (stagedHash !== file.expected_target_hash) {
          throw new TransactionError(
            "TRANSACTION_PREPARATION_FAILED",
            `Staged temporary file "${file.tmp_path}" hash verification failed (expected ${file.expected_target_hash}, got ${stagedHash}).`
          );
        }
      }
    }

    if (this.faultInjection.failAfterStagingBeforePrepared) {
      throw new TransactionError(
        "TRANSACTION_PREPARATION_FAILED",
        "Fault injection: crash after staging files before PREPARED."
      );
    }

    // 3. Atomically transition journal to PREPARED phase
    journal.phase = "PREPARED";
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
      faultInjection: this.faultInjection,
    });

    if (this.faultInjection.failAfterJournalPrepared) {
      throw new TransactionError(
        "TRANSACTION_PREPARATION_FAILED",
        "Fault injection: crash after journal prepared."
      );
    }

    return journal;
  }

  /**
   * Phase 2 & 3: Commits the transaction.
   * Transitions journal to COMMITTING, atomically applies writes and unlinks,
   * transitions journal to COMMITTED, and finalizes cleanup of temporary and backup files.
   */
  async commit(journal: TransactionJournal, lockHandle: TransactionLockHandle): Promise<void> {
    if (lockHandle.isReleased || lockHandle.nonce !== journal.lock_nonce) {
      throw new TransactionError(
        "TRANSACTION_LOCK_FAILED",
        "Cannot commit transaction: lock ownership mismatch or lock released."
      );
    }

    // Step 0: Check for unexpected external modifications/drift before entering COMMITTING phase
    for (const file of journal.files) {
      const { absolutePath: absTarget } = validateCanonicalPath(this.targetDir, file.target_path);
      const existsNow = fs.existsSync(absTarget);
      const op = file.operation ?? "write";

      if (op === "unlink") {
        if (file.existed_before) {
          if (!existsNow && file.must_exist) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${file.target_path}" was deleted externally after transaction preparation. Aborting commit to prevent data loss.`,
              { targetPath: file.target_path, reason: "file_deleted_externally" }
            );
          }
          if (existsNow) {
            const currentHash = computeFileSha256(absTarget);
            if (file.expected_source_hash && currentHash !== file.expected_source_hash) {
              throw new TransactionError(
                "EXTERNAL_TARGET_MODIFIED",
                `Target file "${file.target_path}" was modified externally after transaction preparation (expected ${file.expected_source_hash}, found ${currentHash}). Aborting commit.`,
                {
                  targetPath: file.target_path,
                  expectedHash: file.expected_source_hash,
                  actualHash: currentHash,
                  reason: "hash_mismatch",
                }
              );
            }
          }
        } else {
          if (existsNow) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${file.target_path}" was created externally after transaction preparation. Aborting commit.`,
              { targetPath: file.target_path, reason: "file_created_externally" }
            );
          }
        }
      } else {
        // write
        if (file.create_only && existsNow) {
          throw new TransactionError(
            "EXTERNAL_TARGET_MODIFIED",
            `Target file "${file.target_path}" already exists for create-only write. Aborting commit.`,
            { targetPath: file.target_path, reason: "target_already_exists" }
          );
        }
        if (file.existed_before && !existsNow) {
          throw new TransactionError(
            "EXTERNAL_TARGET_MODIFIED",
            `Target file "${file.target_path}" was deleted externally after transaction preparation. Aborting commit to prevent data loss.`,
            { targetPath: file.target_path, reason: "file_deleted_externally" }
          );
        }
        if (!file.existed_before && existsNow) {
          throw new TransactionError(
            "EXTERNAL_TARGET_MODIFIED",
            `Target file "${file.target_path}" was created externally after transaction preparation. Aborting commit to prevent data loss.`,
            { targetPath: file.target_path, reason: "file_created_externally" }
          );
        }
        if (file.existed_before && existsNow) {
          const currentHash = computeFileSha256(absTarget);
          if (file.expected_source_hash && currentHash !== file.expected_source_hash) {
            throw new TransactionError(
              "EXTERNAL_TARGET_MODIFIED",
              `Target file "${file.target_path}" was modified externally after transaction preparation (expected ${file.expected_source_hash}, found ${currentHash}). Aborting commit to prevent overwriting external changes.`,
              {
                targetPath: file.target_path,
                expectedHash: file.expected_source_hash,
                actualHash: currentHash,
                reason: "hash_mismatch",
              }
            );
          }
        }
      }
    }

    // 1. Transition journal to COMMITTING
    journal.phase = "COMMITTING";
    journal.committing_at = new Date().toISOString();
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
      faultInjection: this.faultInjection,
    });

    if (this.faultInjection.failAfterEnteringCommitting) {
      throw new TransactionError(
        "TRANSACTION_COMMIT_FAILED",
        "Fault injection: crash after entering COMMITTING."
      );
    }

    // 2. Sequentially apply operations
    for (let i = 0; i < journal.files.length; i++) {
      const file = journal.files[i];
      const op = file.operation ?? "write";
      const { absolutePath: absTarget } = validateCanonicalPath(this.targetDir, file.target_path);
      const { absolutePath: absTmp } = validateCanonicalPath(this.targetDir, file.tmp_path);
      const { absolutePath: absBak } = validateCanonicalPath(this.targetDir, file.bak_path);

      if (op === "unlink") {
        if (this.faultInjection.failDuringUnlinkCommit) {
          throw new TransactionError(
            "TRANSACTION_COMMIT_FAILED",
            "Fault injection: crash during unlink commit."
          );
        }

        if (fs.existsSync(absTarget)) {
          if (!fs.existsSync(absBak)) {
            try {
              fs.chmodSync(absTarget, 0o666);
            } catch {
              // ignore
            }
            atomicRenameWithRetry(
              absTarget,
              absBak,
              this.maxRenameRetries,
              this.renameRetryDelayMs,
              this.faultInjection
            );
          } else {
            safeUnlink(absTarget);
          }
          safeFsyncDir(path.dirname(absTarget), {
            ...this.faultInjection,
            isCommitPhase: true,
          });
        }
      } else {
        // write
        if (file.create_only && fs.existsSync(absTarget)) {
          const currentHash = computeFileSha256(absTarget);
          if (currentHash !== file.expected_target_hash) {
            throw new TransactionError(
              "TRANSACTION_RECOVERY_REQUIRED",
              `Create-only target collision: target "${file.target_path}" unexpectedly exists with different content during commit.`,
              { targetPath: file.target_path }
            );
          }
        }

        // If mutable target existed before, back it up to absBak if not already done
        if (file.existed_before && fs.existsSync(absTarget) && !fs.existsSync(absBak)) {
          try {
            fs.copyFileSync(absTarget, absBak);
            safeFsyncDir(path.dirname(absBak), this.faultInjection);
          } catch (err: unknown) {
            throw new TransactionError(
              "TRANSACTION_COMMIT_FAILED",
              `Failed to create backup copy of "${file.target_path}": ${
                err instanceof Error ? err.message : String(err)
              }`,
              { originalError: err, targetPath: file.target_path }
            );
          }
        }

        // If temporary file does not exist, recreate it from durable journal target_content
        if (!fs.existsSync(absTmp)) {
          safeWriteAndSync(absTmp, file.target_content!);
        }

        // If target exists and is read-only, ensure target is writable before renaming over it
        if (fs.existsSync(absTarget)) {
          try {
            fs.chmodSync(absTarget, 0o666);
          } catch {
            // ignore
          }
        }

        // Atomically rename temporary file over destination
        try {
          atomicRenameWithRetry(
            absTmp,
            absTarget,
            this.maxRenameRetries,
            this.renameRetryDelayMs,
            this.faultInjection
          );
          safeFsyncDir(path.dirname(absTarget), {
            ...this.faultInjection,
            isCommitPhase: true,
          });
        } catch (err: unknown) {
          throw new TransactionError(
            "TRANSACTION_COMMIT_FAILED",
            `Failed to replace target file "${file.target_path}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            { originalError: err, targetPath: file.target_path }
          );
        }

        // If readOnlyOnCommit is set, apply 0o444 permissions
        if (file.read_only_on_commit) {
          try {
            fs.chmodSync(absTarget, 0o444);
          } catch {
            // ignore chmod failures on unsupported platforms
          }
        }
      }

      // Fault injection points
      if (i === 0 && this.faultInjection.failAfterFirstTargetWrite) {
        throw new TransactionError(
          "TRANSACTION_COMMIT_FAILED",
          "Fault injection: crash after first target write."
        );
      }

      if (i >= 1 && this.faultInjection.failBetweenTargetWrites) {
        throw new TransactionError(
          "TRANSACTION_COMMIT_FAILED",
          "Fault injection: crash between target writes."
        );
      }
    }

    if (this.faultInjection.failAfterAllTargetsWrittenBeforeCommitted) {
      throw new TransactionError(
        "TRANSACTION_COMMIT_FAILED",
        "Fault injection: crash after all targets written before COMMITTED."
      );
    }

    // 3. Post-mutation verification
    for (const file of journal.files) {
      const { absolutePath: absTarget } = validateCanonicalPath(this.targetDir, file.target_path);
      const op = file.operation ?? "write";
      if (op === "unlink") {
        if (fs.existsSync(absTarget)) {
          throw new TransactionError(
            "TRANSACTION_COMMIT_FAILED",
            `Verification failed: target file "${file.target_path}" was scheduled for unlink but is still present.`
          );
        }
      } else {
        const finalHash = computeFileSha256(absTarget);
        if (finalHash !== file.expected_target_hash) {
          throw new TransactionError(
            "TRANSACTION_COMMIT_FAILED",
            `Verification failed: target file "${file.target_path}" content hash mismatch (expected ${file.expected_target_hash}, found ${finalHash}).`
          );
        }
      }
    }

    // 4. Transition journal to COMMITTED
    journal.phase = "COMMITTED";
    journal.committed_at = new Date().toISOString();
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
      faultInjection: this.faultInjection,
    });

    if (this.faultInjection.failAfterCommittedBeforeCleanup) {
      throw new TransactionError(
        "TRANSACTION_COMMIT_FAILED",
        "Fault injection: crash after COMMITTED before cleanup."
      );
    }

    // 5. Finalize cleanup: remove temporary files, backup copies, and transaction journal
    this.cleanupTransactionFiles(journal);
    cleanupJournalDurable(this.journalPath, journal.tx_id, {
      faultInjection: this.faultInjection,
    });
  }

  /**
   * Deterministic crash recovery protocol.
   *
   * Executes fail-closed recovery based on durable journal state:
   * - PREPARING & PREPARED: Roll back to source state; remove temporary files and journal.
   * - COMMITTING: Deterministically rolls forward using target_content and unlink plan; transitions to COMMITTED.
   * - COMMITTED: Verifies targets and finalizes cleanup.
   * - Corrupted / Unreadable: Fails closed (CRITICAL_RECOVERY_FAILURE).
   */
  async recover(lockHandle: TransactionLockHandle): Promise<RecoveryResult> {
    if (lockHandle.isReleased) {
      throw new TransactionError(
        "TRANSACTION_LOCK_FAILED",
        "Cannot perform transaction recovery: transaction lock is released."
      );
    }

    const { journal, isCorrupted, rawError } = readJournal(this.journalPath);

    if (isCorrupted) {
      throw new TransactionError(
        "CRITICAL_RECOVERY_FAILURE",
        `Found corrupted, incomplete, or unreadable transaction journal at "${this.journalPath}". Automatic recovery is barred to prevent split-brain state mutations. Operator manual triage required. Reason: ${rawError}`,
        { journalPath: this.journalPath, rawError }
      );
    }

    if (!journal) {
      return {
        recovered: false,
        actionTaken: "none",
        filesAffected: [],
      };
    }

    // Step 0: Validate all journal paths against project root and symlink boundaries
    for (const file of journal.files) {
      try {
        validateCanonicalPath(this.targetDir, file.target_path);
        validateCanonicalPath(this.targetDir, file.tmp_path);
        validateCanonicalPath(this.targetDir, file.bak_path);
      } catch (err: unknown) {
        throw new TransactionError(
          "CRITICAL_RECOVERY_FAILURE",
          `Transaction recovery aborted: journal contains invalid or escaping path (target: "${file.target_path}"). Reason: ${
            err instanceof Error ? err.message : String(err)
          }. Operator triage required. Journal preserved on disk.`,
          { journalPath: this.journalPath, originalError: err }
        );
      }
    }

    const filesAffected: string[] = journal.files.map((f) => f.target_path);

    switch (journal.phase) {
      case "PREPARING":
      case "PREPARED": {
        // Roll Backward: The transaction never reached COMMITTING.
        // Revert any staged files and restore source state.
        for (const file of journal.files) {
          const { absolutePath: absTarget } = validateCanonicalPath(this.targetDir, file.target_path);
          const { absolutePath: absTmp } = validateCanonicalPath(this.targetDir, file.tmp_path);
          const { absolutePath: absBak } = validateCanonicalPath(this.targetDir, file.bak_path);

          safeUnlink(absTmp);

          if (file.existed_before) {
            if (fs.existsSync(absBak)) {
              if (fs.existsSync(absTarget)) {
                try {
                  fs.chmodSync(absTarget, 0o666);
                } catch {
                  // ignore
                }
              }
              atomicRenameWithRetry(
                absBak,
                absTarget,
                this.maxRenameRetries,
                this.renameRetryDelayMs,
                this.faultInjection
              );
            } else if (file.original_content !== null && file.original_content !== undefined) {
              const currentHash = computeFileSha256(absTarget);
              if (currentHash !== file.expected_source_hash) {
                if (fs.existsSync(absTarget)) {
                  try {
                    fs.chmodSync(absTarget, 0o666);
                  } catch {
                    // ignore
                  }
                }
                safeWriteAndSync(absTarget, file.original_content);
              }
            }
            safeFsyncDir(path.dirname(absTarget), this.faultInjection);

            if (file.expected_source_hash) {
              const restoredHash = computeFileSha256(absTarget);
              if (restoredHash !== file.expected_source_hash) {
                throw new TransactionError(
                  "CRITICAL_RECOVERY_FAILURE",
                  `${journal.phase} rollback verification failed: target file "${file.target_path}" does not match expected source hash (expected ${file.expected_source_hash}, got ${restoredHash}). Journal preserved for operator triage.`,
                  {
                    targetPath: file.target_path,
                    expectedHash: file.expected_source_hash,
                    actualHash: restoredHash,
                  }
                );
              }
            }
          } else {
            // File did not exist before transaction
            safeUnlink(absTarget);
            safeUnlink(absBak);
            safeFsyncDir(path.dirname(absTarget), this.faultInjection);

            if (fs.existsSync(absTarget)) {
              throw new TransactionError(
                "CRITICAL_RECOVERY_FAILURE",
                `${journal.phase} rollback verification failed: target file "${file.target_path}" should not exist, but is still present on disk. Journal preserved for operator triage.`,
                { targetPath: file.target_path }
              );
            }
          }
        }

        cleanupJournalDurable(this.journalPath, journal.tx_id, {
          faultInjection: this.faultInjection,
        });

        return {
          recovered: true,
          actionTaken: "rolled_back",
          txId: journal.tx_id,
          originalPhase: journal.phase,
          filesAffected,
          details: `Transaction in ${journal.phase} phase safely rolled back; live state restored.`,
        };
      }

      case "COMMITTING": {
        // Roll Forward: The transaction was in COMMITTING.
        // Deterministically complete operations using target_content and unlink plan from journal.
        for (const file of journal.files) {
          const { absolutePath: absTarget } = validateCanonicalPath(this.targetDir, file.target_path);
          const { absolutePath: absTmp } = validateCanonicalPath(this.targetDir, file.tmp_path);
          const { absolutePath: absBak } = validateCanonicalPath(this.targetDir, file.bak_path);
          const op = file.operation ?? "write";

          if (op === "unlink") {
            if (fs.existsSync(absTarget)) {
              if (!fs.existsSync(absBak)) {
                try {
                  fs.chmodSync(absTarget, 0o666);
                } catch {
                  // ignore
                }
                atomicRenameWithRetry(
                  absTarget,
                  absBak,
                  this.maxRenameRetries,
                  this.renameRetryDelayMs,
                  this.faultInjection
                );
              } else {
                safeUnlink(absTarget);
              }
              safeFsyncDir(path.dirname(absTarget), this.faultInjection);
            }

            if (fs.existsSync(absTarget)) {
              throw new TransactionError(
                "CRITICAL_RECOVERY_FAILURE",
                `Recovery roll-forward failed: unlink target "${file.target_path}" is still present on disk.`,
                { targetPath: file.target_path }
              );
            }

            safeUnlink(absTmp);
            safeUnlink(absBak);
            safeFsyncDir(path.dirname(absTmp), this.faultInjection);
          } else {
            // write
            if (file.create_only && fs.existsSync(absTarget)) {
              const currentHash = computeFileSha256(absTarget);
              if (currentHash !== file.expected_target_hash) {
                throw new TransactionError(
                  "TRANSACTION_RECOVERY_REQUIRED",
                  `Create-only target collision during recovery roll-forward: "${file.target_path}" exists with unexpected content. Manual resolution required.`,
                  { targetPath: file.target_path }
                );
              }
            }

            const currentHash = computeFileSha256(absTarget);
            if (currentHash !== file.expected_target_hash) {
              safeWriteAndSync(absTmp, file.target_content!);
              if (fs.existsSync(absTarget)) {
                try {
                  fs.chmodSync(absTarget, 0o666);
                } catch {
                  // ignore
                }
              }
              atomicRenameWithRetry(
                absTmp,
                absTarget,
                this.maxRenameRetries,
                this.renameRetryDelayMs,
                this.faultInjection
              );
            }
            safeFsyncDir(path.dirname(absTarget), this.faultInjection);

            const finalHash = computeFileSha256(absTarget);
            if (finalHash !== file.expected_target_hash) {
              throw new TransactionError(
                "CRITICAL_RECOVERY_FAILURE",
                `Recovery roll-forward failed: target file "${file.target_path}" hash mismatch (expected ${file.expected_target_hash}, got ${finalHash}).`,
                { targetPath: file.target_path }
              );
            }

            if (file.read_only_on_commit) {
              try {
                fs.chmodSync(absTarget, 0o444);
              } catch {
                // ignore
              }
            }

            safeUnlink(absTmp);
            safeUnlink(absBak);
            safeFsyncDir(path.dirname(absTmp), this.faultInjection);
          }
        }

        journal.phase = "COMMITTED";
        journal.committed_at = new Date().toISOString();
        writeJournalDurable(this.journalPath, journal, {
          maxRenameRetries: this.maxRenameRetries,
          renameRetryDelayMs: this.renameRetryDelayMs,
          faultInjection: this.faultInjection,
        });

        cleanupJournalDurable(this.journalPath, journal.tx_id, {
          faultInjection: this.faultInjection,
        });

        return {
          recovered: true,
          actionTaken: "rolled_forward",
          txId: journal.tx_id,
          originalPhase: "COMMITTING",
          filesAffected,
          details: "Transaction in COMMITTING phase deterministically rolled forward and completed.",
        };
      }

      case "COMMITTED": {
        // Finalize Cleanup: The transaction committed successfully, but cleanup was interrupted.
        // Verify all target files match their expected post-condition, then purge temporary files and journal.
        for (const file of journal.files) {
          const { absolutePath: absTarget } = validateCanonicalPath(this.targetDir, file.target_path);
          const { absolutePath: absTmp } = validateCanonicalPath(this.targetDir, file.tmp_path);
          const { absolutePath: absBak } = validateCanonicalPath(this.targetDir, file.bak_path);
          const op = file.operation ?? "write";

          if (op === "unlink") {
            if (fs.existsSync(absTarget)) {
              throw new TransactionError(
                "CRITICAL_RECOVERY_FAILURE",
                `Committed transaction verification failed during cleanup: target file "${file.target_path}" was scheduled for unlink but is present.`,
                { targetPath: file.target_path }
              );
            }
          } else {
            const finalHash = computeFileSha256(absTarget);
            if (finalHash !== file.expected_target_hash) {
              throw new TransactionError(
                "CRITICAL_RECOVERY_FAILURE",
                `Committed transaction verification failed during cleanup: target file "${file.target_path}" missing or modified.`,
                { targetPath: file.target_path }
              );
            }
          }

          safeUnlink(absTmp);
          safeUnlink(absBak);
          safeFsyncDir(path.dirname(absTmp), this.faultInjection);
        }

        cleanupJournalDurable(this.journalPath, journal.tx_id, {
          faultInjection: this.faultInjection,
        });

        return {
          recovered: true,
          actionTaken: "finalized_cleanup",
          txId: journal.tx_id,
          originalPhase: "COMMITTED",
          filesAffected,
          details: "Committed transaction verified and residual temporary files cleaned up.",
        };
      }

      default: {
        throw new TransactionError(
          "CRITICAL_RECOVERY_FAILURE",
          `Transaction journal has unrecognized phase "${(journal as any).phase}". Recovery cannot proceed safely.`,
          { journal }
        );
      }
    }
  }

  /**
   * Non-destructive inspection of on-disk journal state.
   */
  async inspectJournal(): Promise<{
    exists: boolean;
    journal: TransactionJournal | null;
    isCorrupted: boolean;
    rawError?: string;
  }> {
    return readJournal(this.journalPath);
  }

  private cleanupTransactionFiles(journal: TransactionJournal): void {
    for (const file of journal.files) {
      const { absolutePath: absTmp } = validateCanonicalPath(this.targetDir, file.tmp_path);
      const { absolutePath: absBak } = validateCanonicalPath(this.targetDir, file.bak_path);
      safeUnlink(absTmp);
      safeUnlink(absBak);
      safeFsyncDir(path.dirname(absTmp), this.faultInjection);
    }
  }
}
