import fs from "node:fs";
import path from "node:path";
import {
  safeWriteAndSync,
  atomicRenameWithRetry,
  safeFsyncDir,
  safeUnlink,
  isSyntacticallySafeRelativePath,
} from "./fs-utils.js";
import {
  type TransactionJournal,
  type TransactionPhase,
  type JournalFileEntry,
  type TransactionFaultInjectionHooks,
  TransactionError,
} from "./types.js";

/**
 * Serializes a transaction journal to canonical JSON string.
 */
export function serializeJournal(journal: TransactionJournal): string {
  return JSON.stringify(journal, null, 2) + "\n";
}

/**
 * Validates and parses raw JSON string into a strongly-typed TransactionJournal.
 * Returns null if content is empty or structurally invalid.
 */
export function parseJournal(content: string): TransactionJournal | null {
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return null;
  }

  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }

    if (
      typeof data.tx_id !== "string" ||
      data.tx_id.trim().length === 0 ||
      (data.phase !== "PREPARED" && data.phase !== "COMMITTING" && data.phase !== "COMMITTED") ||
      typeof data.created_at !== "string" ||
      isNaN(Date.parse(data.created_at)) ||
      typeof data.action !== "string" ||
      data.action.trim().length === 0 ||
      typeof data.lock_nonce !== "string" ||
      data.lock_nonce.trim().length === 0 ||
      !Array.isArray(data.files) ||
      data.files.length === 0
    ) {
      return null;
    }

    const validatedFiles: JournalFileEntry[] = [];
    for (const f of data.files) {
      if (
        !f ||
        typeof f !== "object" ||
        !isSyntacticallySafeRelativePath(f.target_path) ||
        !isSyntacticallySafeRelativePath(f.tmp_path) ||
        !isSyntacticallySafeRelativePath(f.bak_path) ||
        typeof f.existed_before !== "boolean" ||
        (f.expected_source_hash !== null && typeof f.expected_source_hash !== "string") ||
        typeof f.expected_target_hash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(f.expected_target_hash) ||
        typeof f.target_content !== "string"
      ) {
        return null;
      }

      validatedFiles.push({
        target_path: f.target_path,
        tmp_path: f.tmp_path,
        bak_path: f.bak_path,
        existed_before: f.existed_before,
        expected_source_hash: f.expected_source_hash ?? null,
        expected_target_hash: f.expected_target_hash,
        target_content: f.target_content,
        original_content: typeof f.original_content === "string" ? f.original_content : null,
      });
    }

    return {
      tx_id: data.tx_id,
      phase: data.phase as TransactionPhase,
      created_at: data.created_at,
      committing_at: typeof data.committing_at === "string" ? data.committing_at : undefined,
      committed_at: typeof data.committed_at === "string" ? data.committed_at : undefined,
      action: data.action,
      lock_nonce: data.lock_nonce,
      metadata: typeof data.metadata === "object" && data.metadata !== null ? data.metadata : undefined,
      files: validatedFiles,
    };
  } catch {
    return null;
  }
}

/**
 * Reads and inspects the transaction journal file on disk.
 */
export function readJournal(journalPath: string): {
  exists: boolean;
  journal: TransactionJournal | null;
  isCorrupted: boolean;
  rawError?: string;
} {
  if (!fs.existsSync(journalPath)) {
    return { exists: false, journal: null, isCorrupted: false };
  }

  let content = "";
  try {
    content = fs.readFileSync(journalPath, "utf-8");
  } catch (err: unknown) {
    return {
      exists: true,
      journal: null,
      isCorrupted: true,
      rawError: `Unreadable journal file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = parseJournal(content);
  if (!parsed) {
    return {
      exists: true,
      journal: null,
      isCorrupted: true,
      rawError: "Journal file exists on disk but is 0-byte, incomplete, malformed JSON, or contains invalid/escaping paths.",
    };
  }

  return { exists: true, journal: parsed, isCorrupted: false };
}

/**
 * Durably writes or updates the transaction journal using temporary write + fsync + atomic rename.
 */
export function writeJournalDurable(
  journalPath: string,
  journal: TransactionJournal,
  options?: {
    maxRenameRetries?: number;
    renameRetryDelayMs?: number;
    faultInjection?: TransactionFaultInjectionHooks;
  }
): void {
  const tmpPath = `${journalPath}.tmp.${journal.tx_id}`;
  const payload = serializeJournal(journal);

  // 1. Write and fsync temporary journal file
  safeWriteAndSync(tmpPath, payload);

  // 2. Atomically rename temporary journal to active journalPath with Windows retry
  try {
    atomicRenameWithRetry(
      tmpPath,
      journalPath,
      options?.maxRenameRetries ?? 5,
      options?.renameRetryDelayMs ?? 50,
      options?.faultInjection
    );
  } catch (err: unknown) {
    safeUnlink(tmpPath);
    throw new TransactionError(
      "TRANSACTION_COMMIT_FAILED",
      `Failed to atomically commit transaction journal to "${journalPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      { originalError: err, journalPath }
    );
  }

  // 3. Sync containing directory metadata on POSIX
  try {
    safeFsyncDir(path.dirname(journalPath), options?.faultInjection);
  } catch (err: unknown) {
    throw new TransactionError(
      "TRANSACTION_COMMIT_FAILED",
      `Failed to synchronize journal directory metadata for "${journalPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      { originalError: err, journalPath }
    );
  }
}

/**
 * Deletes the transaction journal file and any transient backup/temp journal files.
 */
export function cleanupJournalDurable(
  journalPath: string,
  txId?: string,
  options?: { faultInjection?: TransactionFaultInjectionHooks }
): void {
  safeUnlink(journalPath);
  if (txId) {
    safeUnlink(`${journalPath}.tmp.${txId}`);
  }
  safeFsyncDir(path.dirname(journalPath), options?.faultInjection);
}
