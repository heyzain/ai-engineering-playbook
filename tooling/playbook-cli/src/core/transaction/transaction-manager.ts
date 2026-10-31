import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_PATHS } from "../../constants.js";
import { TransactionLockManager, type TransactionLockHandle } from "../lock/index.js";
import {
  type TransactionJournal,
  type JournalFileEntry,
  type FileWriteSpec,
  type RecoveryResult,
  type TransactionManagerOptions,
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
 * 2. Three-phase protocol: PREPARED -> COMMITTING -> COMMITTED.
 * 3. Complete serialized target contents in journal for zero in-memory recovery dependency.
 * 4. Deterministic recovery:
 *    - PREPARED rolls back cleanly to source state.
 *    - COMMITTING rolls forward cleanly to target state.
 *    - COMMITTED verifies targets and finalizes cleanup.
 * 5. Corrupted, unreadable, or conflicting journals fail closed immediately.
 * 6. Path containment: Target paths must be relative and strictly within project root.
 * 7. Recovery idempotency: Re-running recovery produces identical valid state without corruption.
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
  }

  /**
   * Executes a multi-file transaction protected by the transaction lock.
   * Automatically executes crash recovery on any leftover prior journal before proceeding.
   */
  async executeTransaction<T>(
    action: string,
    fileWrites: FileWriteSpec[],
    metadata?: Record<string, unknown>
  ): Promise<{ txId: string; recovery?: RecoveryResult }> {
    return await this.withTransaction(action, fileWrites, undefined, metadata);
  }

  /**
   * High-level helper that executes custom logic within a transaction.
   */
  async withTransaction<T>(
    action: string,
    fileWrites: FileWriteSpec[],
    callback?: (journal: TransactionJournal) => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<{ txId: string; result?: T; recovery?: RecoveryResult }> {
    return await this.lockManager.withLock(
      async (lockHandle) => {
        // Step 0: Crash Recovery Check
        // If an interrupted prior transaction journal exists, recover it before starting a new one
        const recovery = await this.recover(lockHandle);

        // Step 1: Prepare transaction
        const journal = await this.prepare(action, fileWrites, lockHandle, metadata);

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
   * Validates paths, records original hashes, writes temporary files and backups,
   * and durably writes the journal in PREPARED phase before live files are modified.
   */
  async prepare(
    action: string,
    fileWrites: FileWriteSpec[],
    lockHandle: TransactionLockHandle,
    metadata?: Record<string, unknown>
  ): Promise<TransactionJournal> {
    if (lockHandle.isReleased) {
      throw new TransactionError(
        "TRANSACTION_LOCK_FAILED",
        "Cannot prepare transaction: transaction lock is not active or has been released."
      );
    }

    if (!Array.isArray(fileWrites) || fileWrites.length === 0) {
      throw new TransactionError(
        "TRANSACTION_PREPARATION_FAILED",
        "Transaction must contain at least one file write specification."
      );
    }

    const txId = `tx-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const journalFiles: JournalFileEntry[] = [];

    // Ensure .playbook directory exists
    if (!fs.existsSync(this.playbookDir)) {
      fs.mkdirSync(this.playbookDir, { recursive: true });
    }

    for (const spec of fileWrites) {
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

      const targetHash = computeSha256(spec.content);
      const tmpRelative = `${relativePath}.tmp.${txId}`;
      const bakRelative = `${relativePath}.bak.${txId}`;

      journalFiles.push({
        target_path: relativePath,
        tmp_path: tmpRelative,
        bak_path: bakRelative,
        existed_before: existedBefore,
        expected_source_hash: sourceHash,
        expected_target_hash: targetHash,
        target_content: spec.content,
        original_content: originalContent,
      });
    }

    const journal: TransactionJournal = {
      tx_id: txId,
      phase: "PREPARED",
      created_at: new Date().toISOString(),
      action,
      lock_nonce: lockHandle.nonce,
      metadata,
      files: journalFiles,
    };

    // Pre-stage temporary files (.tmp) and backup files (.bak)
    for (const file of journalFiles) {
      const absTmp = path.resolve(this.targetDir, file.tmp_path);
      safeWriteAndSync(absTmp, file.target_content);

      if (file.existed_before && file.original_content !== null && file.original_content !== undefined) {
        const absBak = path.resolve(this.targetDir, file.bak_path);
        safeWriteAndSync(absBak, file.original_content);
      }
    }

    // Durably write the transaction journal in PREPARED phase
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
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
   * Transitions journal to COMMITTING, atomically renames temporary files to target paths,
   * transitions journal to COMMITTED, and finalizes cleanup of temporary and backup files.
   */
  async commit(journal: TransactionJournal, lockHandle: TransactionLockHandle): Promise<void> {
    if (lockHandle.isReleased || lockHandle.nonce !== journal.lock_nonce) {
      throw new TransactionError(
        "TRANSACTION_LOCK_FAILED",
        "Cannot commit transaction: lock ownership mismatch or lock released."
      );
    }

    // 1. Transition journal to COMMITTING
    journal.phase = "COMMITTING";
    journal.committing_at = new Date().toISOString();
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
    });

    if (this.faultInjection.failAfterEnteringCommitting) {
      throw new TransactionError(
        "TRANSACTION_COMMIT_FAILED",
        "Fault injection: crash after entering COMMITTING."
      );
    }

    // 2. Sequentially replace live target files via atomic rename
    for (let i = 0; i < journal.files.length; i++) {
      const file = journal.files[i];
      const absTarget = path.resolve(this.targetDir, file.target_path);
      const absTmp = path.resolve(this.targetDir, file.tmp_path);

      // If temporary file does not exist, recreate it from durable journal target_content
      if (!fs.existsSync(absTmp)) {
        safeWriteAndSync(absTmp, file.target_content);
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
      } catch (err: unknown) {
        throw new TransactionError(
          "TRANSACTION_COMMIT_FAILED",
          `Failed to replace target file "${file.target_path}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { originalError: err, targetPath: file.target_path }
        );
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

    // 3. Transition journal to COMMITTED
    journal.phase = "COMMITTED";
    journal.committed_at = new Date().toISOString();
    writeJournalDurable(this.journalPath, journal, {
      maxRenameRetries: this.maxRenameRetries,
      renameRetryDelayMs: this.renameRetryDelayMs,
    });

    if (this.faultInjection.failAfterCommittedBeforeCleanup) {
      throw new TransactionError(
        "TRANSACTION_COMMIT_FAILED",
        "Fault injection: crash after COMMITTED before cleanup."
      );
    }

    // 4. Finalize cleanup: remove temporary files, backup copies, and transaction journal
    this.cleanupTransactionFiles(journal);
    cleanupJournalDurable(this.journalPath, journal.tx_id);
  }

  /**
   * Deterministic crash recovery protocol.
   *
   * Executes fail-closed recovery based on durable journal state:
   * - PREPARED: Rolls back to source state; removes temporary files and journal.
   * - COMMITTING: Deterministically rolls forward using target_content; transitions to COMMITTED.
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

    const filesAffected: string[] = journal.files.map((f) => f.target_path);

    switch (journal.phase) {
      case "PREPARED": {
        // Roll Backward: The transaction never reached COMMITTING.
        // Revert any staged files and restore source state.
        for (const file of journal.files) {
          const absTarget = path.resolve(this.targetDir, file.target_path);
          const absTmp = path.resolve(this.targetDir, file.tmp_path);
          const absBak = path.resolve(this.targetDir, file.bak_path);

          safeUnlink(absTmp);

          if (file.existed_before) {
            // Restore from backup file or original_content if target was modified
            if (fs.existsSync(absBak)) {
              atomicRenameWithRetry(
                absBak,
                absTarget,
                this.maxRenameRetries,
                this.renameRetryDelayMs
              );
            } else if (file.original_content !== null && file.original_content !== undefined) {
              const currentHash = computeFileSha256(absTarget);
              if (currentHash !== file.expected_source_hash) {
                safeWriteAndSync(absTarget, file.original_content);
              }
            }
          } else {
            // File did not exist before transaction; ensure it is removed
            safeUnlink(absTarget);
            safeUnlink(absBak);
          }
        }

        cleanupJournalDurable(this.journalPath, journal.tx_id);

        return {
          recovered: true,
          actionTaken: "rolled_back",
          txId: journal.tx_id,
          originalPhase: "PREPARED",
          filesAffected,
          details: "Transaction in PREPARED phase safely rolled back; live state restored.",
        };
      }

      case "COMMITTING": {
        // Roll Forward: The transaction was in COMMITTING.
        // Deterministically complete file replacements using target_content from journal.
        for (const file of journal.files) {
          const absTarget = path.resolve(this.targetDir, file.target_path);
          const absTmp = path.resolve(this.targetDir, file.tmp_path);
          const absBak = path.resolve(this.targetDir, file.bak_path);

          // Check if target file already matches expected_target_hash
          const currentHash = computeFileSha256(absTarget);
          if (currentHash !== file.expected_target_hash) {
            // Target was not yet renamed; write payload from journal and rename into place
            safeWriteAndSync(absTmp, file.target_content);
            atomicRenameWithRetry(
              absTmp,
              absTarget,
              this.maxRenameRetries,
              this.renameRetryDelayMs
            );
          }

          // Verify target hash after roll-forward
          const finalHash = computeFileSha256(absTarget);
          if (finalHash !== file.expected_target_hash) {
            throw new TransactionError(
              "CRITICAL_RECOVERY_FAILURE",
              `Recovery roll-forward failed: target file "${file.target_path}" hash mismatch (expected ${file.expected_target_hash}, got ${finalHash}).`,
              { targetPath: file.target_path }
            );
          }

          safeUnlink(absTmp);
          safeUnlink(absBak);
        }

        // Transition journal to COMMITTED
        journal.phase = "COMMITTED";
        journal.committed_at = new Date().toISOString();
        writeJournalDurable(this.journalPath, journal, {
          maxRenameRetries: this.maxRenameRetries,
          renameRetryDelayMs: this.renameRetryDelayMs,
        });

        // Finalize cleanup
        cleanupJournalDurable(this.journalPath, journal.tx_id);

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
        // Verify all target files match expected_target_hash, then purge temporary files and journal.
        for (const file of journal.files) {
          const absTarget = path.resolve(this.targetDir, file.target_path);
          const absTmp = path.resolve(this.targetDir, file.tmp_path);
          const absBak = path.resolve(this.targetDir, file.bak_path);

          const finalHash = computeFileSha256(absTarget);
          if (finalHash !== file.expected_target_hash) {
            throw new TransactionError(
              "CRITICAL_RECOVERY_FAILURE",
              `Committed transaction verification failed during cleanup: target file "${file.target_path}" missing or modified.`,
              { targetPath: file.target_path }
            );
          }

          safeUnlink(absTmp);
          safeUnlink(absBak);
        }

        cleanupJournalDurable(this.journalPath, journal.tx_id);

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
      const absTmp = path.resolve(this.targetDir, file.tmp_path);
      const absBak = path.resolve(this.targetDir, file.bak_path);
      safeUnlink(absTmp);
      safeUnlink(absBak);
    }
  }
}
