import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DEFAULT_PATHS } from "../../constants.js";
import { defaultProcessLivenessChecker } from "./liveness.js";
import { createLockDiagnostic } from "./diagnostics.js";
import {
  LockError,
  type LockMetadata,
  type ReclaimMetadata,
  type TransactionLockHandle,
  type LockManagerOptions,
  type LockInspection,
  type ProcessLivenessChecker,
  type FilesystemChecker,
  type FaultInjectionHooks,
} from "./types.js";

/**
 * Serializes lock metadata conforming to canonical format.
 */
export function serializeLockMetadata(meta: LockMetadata): string {
  return (
    JSON.stringify(
      {
        pid: meta.pid,
        hostname: meta.hostname,
        created_at: meta.created_at,
        nonce: meta.nonce,
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Validates and parses lock metadata from raw string content.
 * Returns null if content is empty, malformed, or missing required fields.
 */
export function parseLockMetadata(content: string): LockMetadata | null {
  if (!content || content.trim().length === 0) {
    return null;
  }
  try {
    const data = JSON.parse(content);
    if (
      typeof data === "object" &&
      data !== null &&
      typeof data.pid === "number" &&
      Number.isInteger(data.pid) &&
      data.pid > 0 &&
      typeof data.hostname === "string" &&
      data.hostname.length > 0 &&
      typeof data.created_at === "string" &&
      !isNaN(Date.parse(data.created_at)) &&
      typeof data.nonce === "string" &&
      data.nonce.length > 0
    ) {
      return {
        pid: data.pid,
        hostname: data.hostname,
        created_at: data.created_at,
        nonce: data.nonce,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serializes reclamation metadata conforming to canonical format.
 */
export function serializeReclaimMetadata(meta: ReclaimMetadata): string {
  return (
    JSON.stringify(
      {
        reclaiming_pid: meta.reclaiming_pid,
        hostname: meta.hostname,
        target_nonce: meta.target_nonce,
        created_at: meta.created_at,
        nonce: meta.nonce,
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Validates and parses reclamation metadata from raw string content.
 * Returns null if content is empty, malformed, or missing required fields.
 */
export function parseReclaimMetadata(content: string): ReclaimMetadata | null {
  if (!content || content.trim().length === 0) {
    return null;
  }
  try {
    const data = JSON.parse(content);
    if (
      typeof data === "object" &&
      data !== null &&
      typeof data.reclaiming_pid === "number" &&
      Number.isInteger(data.reclaiming_pid) &&
      data.reclaiming_pid > 0 &&
      typeof data.hostname === "string" &&
      data.hostname.length > 0 &&
      typeof data.target_nonce === "string" &&
      data.target_nonce.length > 0 &&
      typeof data.created_at === "string" &&
      !isNaN(Date.parse(data.created_at)) &&
      typeof data.nonce === "string" &&
      data.nonce.length > 0
    ) {
      return {
        reclaiming_pid: data.reclaiming_pid,
        hostname: data.hostname,
        target_nonce: data.target_nonce,
        created_at: data.created_at,
        nonce: data.nonce,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Default filesystem checker. Rejects remote UNC and unsupported shared paths.
 */
export const defaultFilesystemChecker: FilesystemChecker = (dirPath: string) => {
  // Check for UNC network share paths on Windows (e.g. \\server\share or //server/share)
  if (dirPath.startsWith("\\\\") || dirPath.startsWith("//")) {
    return {
      supported: false,
      reason: `Network UNC share detected: "${dirPath}". Atomic O_EXCL mutual exclusion is not guaranteed on networked storage.`,
    };
  }

  // Check test override environment flag
  if (process.env.PLAYBOOK_UNSUPPORTED_FS === "1") {
    return {
      supported: false,
      reason: "Simulated unsupported networked filesystem via PLAYBOOK_UNSUPPORTED_FS.",
    };
  }

  return { supported: true };
};

/**
 * TransactionLockManager enforces mutual exclusion across Playbook CLI write operations.
 *
 * Implements strict fail-closed safety invariants:
 * 1. Never steal a lock solely because of elapsed time.
 * 2. Never remove a lock owned by a process that is demonstrably alive.
 * 3. Never treat EPERM from process-liveness checks as proof of process death.
 * 4. If process ownership cannot be established, fail closed.
 * 5. A reclaimer must not lose ownership solely because of TTL expiration.
 * 6. A process must never release a lock whose nonce differs from its own.
 * 7. All contenders must respect the reclamation protocol.
 * 8. Malformed or empty locks must not be automatically deleted by background agents.
 * 9. Unsupported filesystem conditions must be reported explicitly.
 * 10. Split-brain risk is bounded by atomic directory entry creation (O_CREAT | O_EXCL) on verified local filesystems.
 */
export class TransactionLockManager {
  readonly targetDir: string;
  readonly lockDir: string;
  readonly transactionLockPath: string;
  readonly reclaimLockPath: string;
  readonly pid: number;
  readonly hostname: string;

  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly transientGracePeriodMs: number;
  private readonly timeoutMs: number;
  private readonly livenessChecker: ProcessLivenessChecker;
  private readonly filesystemChecker: FilesystemChecker;
  private readonly faultInjection: FaultInjectionHooks;

  constructor(options?: LockManagerOptions) {
    this.targetDir = path.resolve(options?.targetDir || process.cwd());
    this.lockDir = path.resolve(options?.lockDir || path.join(this.targetDir, DEFAULT_PATHS.playbookDir));
    this.transactionLockPath = path.join(this.lockDir, "transaction.lock");
    this.reclaimLockPath = path.join(this.lockDir, "reclaim.lock");

    this.pid = options?.pid || process.pid;
    this.hostname = options?.hostname || os.hostname();

    this.retryAttempts = options?.retryAttempts ?? 40;
    this.retryDelayMs = options?.retryDelayMs ?? 50;
    this.maxRetryDelayMs = options?.maxRetryDelayMs ?? 250;
    this.transientGracePeriodMs = options?.transientGracePeriodMs ?? 1000;
    this.timeoutMs = options?.timeoutMs ?? 10000;

    this.livenessChecker = options?.livenessChecker || defaultProcessLivenessChecker;
    this.filesystemChecker = options?.filesystemChecker || defaultFilesystemChecker;
    this.faultInjection = options?.faultInjection || {};
  }

  /**
   * Acquires the exclusive transaction lock.
   *
   * Executes the full atomic dual-lock protocol:
   * 1. Inspects reclaim.lock (waits if active reclamation in progress).
   * 2. Attempts atomic creation of transaction.lock via O_CREAT | O_EXCL.
   * 3. Writes and fsyncs LockMetadata payload.
   * 4. Post-acquisition check: verifies reclaim.lock did not appear concurrently.
   * 5. If contended by stale dead process, competes for atomic reclamation.
   */
  async acquire(options?: { timeoutMs?: number }): Promise<TransactionLockHandle> {
    const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;
    const startTime = Date.now();

    // Invariant 9: Unsupported filesystem check
    const fsCheck = this.filesystemChecker(this.lockDir);
    if (!fsCheck.supported) {
      throw new LockError("UNSUPPORTED_FILESYSTEM", fsCheck.reason || "Unsupported filesystem.");
    }

    // Ensure containing directory exists
    if (!fs.existsSync(this.lockDir)) {
      fs.mkdirSync(this.lockDir, { recursive: true });
    }

    let attempt = 0;

    while (true) {
      attempt++;
      const elapsed = Date.now() - startTime;
      if (elapsed > effectiveTimeout) {
        throw new LockError(
          "LOCK_TIMEOUT",
          `Lock acquisition timed out after ${elapsed}ms (${attempt} attempts).`
        );
      }

      // Step 1: Pre-Acquisition Guard Inspection (reclaim.lock)
      if (fs.existsSync(this.reclaimLockPath)) {
        const reclaimResolved = await this.evaluateReclaimMarker();
        if (!reclaimResolved) {
          // Reclamation is actively in progress by a live reclaimer; back off and retry
          await this.sleepJitter();
          continue;
        }
      }

      // Step 2: Primary Lock Creation Attempt (transaction.lock via 'wx')
      let fd: number | null = null;
      try {
        fd = fs.openSync(this.transactionLockPath, "wx");
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error && error.code === "EEXIST") {
          fd = null;
        } else {
          throw new LockError(
            "LOCK_ACQUISITION_FAILED",
            `Filesystem error while opening transaction lock: ${error?.message || String(err)}`
          );
        }
      }

      // Case A: File was created exclusively
      if (fd !== null) {
        try {
          if (this.faultInjection.failAfterLockCreatedBeforePayload) {
            fs.closeSync(fd);
            throw new LockError("LOCK_ACQUISITION_FAILED", "Fault injection: crash after lock created before write.");
          }

          const nonce = crypto.randomUUID();
          const meta: LockMetadata = {
            pid: this.pid,
            hostname: this.hostname,
            created_at: new Date().toISOString(),
            nonce,
          };

          const payload = serializeLockMetadata(meta);
          fs.writeSync(fd, payload, 0, "utf-8");

          if (this.faultInjection.failAfterLockPayloadWrittenBeforeClose) {
            fs.closeSync(fd);
            throw new LockError("LOCK_ACQUISITION_FAILED", "Fault injection: crash after payload written before close.");
          }

          fs.fsyncSync(fd);
          fs.closeSync(fd);

          // Step 3: Post-Acquisition Invariant Re-Check
          if (this.faultInjection.delayBeforePostCheckMs) {
            await this.sleep(this.faultInjection.delayBeforePostCheckMs);
          }

          if (this.faultInjection.simulateConcurrentReclaimBeforePostCheck) {
            fs.writeFileSync(
              this.reclaimLockPath,
              serializeReclaimMetadata({
                reclaiming_pid: this.pid + 9999,
                hostname: this.hostname,
                target_nonce: "other-nonce",
                created_at: new Date().toISOString(),
                nonce: crypto.randomUUID(),
              })
            );
          }

          if (fs.existsSync(this.reclaimLockPath)) {
            // Concurrent reclamation appeared during acquisition; roll back our lock and back off
            try {
              const currentContent = fs.readFileSync(this.transactionLockPath, "utf-8");
              const currentMeta = parseLockMetadata(currentContent);
              if (currentMeta && currentMeta.nonce === nonce && currentMeta.pid === this.pid) {
                fs.unlinkSync(this.transactionLockPath);
              }
            } catch {
              // Ignore rollback errors
            }

            await this.sleepJitter();
            continue;
          }

          // Lock acquisition confirmed exclusive and verified
          let released = false;
          const handle: TransactionLockHandle = {
            nonce,
            pid: this.pid,
            hostname: this.hostname,
            createdAt: meta.created_at,
            lockPath: this.transactionLockPath,
            get isReleased() {
              return released;
            },
            release: async () => {
              if (released) return;
              await this.release(handle);
              released = true;
            },
          };

          return handle;
        } catch (innerErr) {
          // In case of write failure on our newly opened file, attempt cleanup if open
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
          throw innerErr;
        }
      }

      // Case B: transaction.lock already exists on disk (EEXIST)
      const contentionResult = await this.evaluateContendedLock();
      if (contentionResult.status === "reclaimed" && contentionResult.handle) {
        return contentionResult.handle;
      }

      // Back off and retry
      await this.sleepJitter();
    }
  }

  /**
   * Releases an acquired transaction lock after strictly verifying ownership nonce and PID.
   *
   * Invariant 6: A process must NEVER release a lock whose nonce differs from its own.
   */
  async release(handle: TransactionLockHandle): Promise<void> {
    if (handle.isReleased) {
      return;
    }

    if (!fs.existsSync(this.transactionLockPath)) {
      throw new LockError(
        "LOCK_LOST_DURING_TRANSACTION",
        "Cannot release lock: transaction.lock does not exist on disk."
      );
    }

    let currentMeta: LockMetadata | null = null;
    try {
      const content = fs.readFileSync(this.transactionLockPath, "utf-8");
      currentMeta = parseLockMetadata(content);
    } catch (err: unknown) {
      throw new LockError(
        "LOCK_METADATA_UNREADABLE",
        `Cannot release lock: transaction.lock is unreadable (${err instanceof Error ? err.message : String(err)}).`
      );
    }

    if (!currentMeta) {
      throw new LockError(
        "LOCK_METADATA_UNREADABLE",
        "Cannot release lock: transaction.lock contains unparseable metadata."
      );
    }

    // Ownership verification: nonce and pid must strictly match
    if (currentMeta.nonce !== handle.nonce || currentMeta.pid !== handle.pid) {
      throw new LockError(
        "LOCK_LOST_DURING_TRANSACTION",
        `Lock ownership verification failed during release. Expected nonce ${handle.nonce} (PID ${handle.pid}), found ${currentMeta.nonce} (PID ${currentMeta.pid}). Lock was lost during transaction.`
      );
    }

    // Safe to unlink verified owned lock
    try {
      fs.unlinkSync(this.transactionLockPath);
    } catch (err: unknown) {
      throw new LockError(
        "LOCK_ACQUISITION_FAILED",
        `Failed to unlink transaction.lock during release: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Helper that executes an operation within the protection of the transaction lock.
   * Automatically guarantees release() upon completion or error.
   */
  async withLock<T>(fn: (lock: TransactionLockHandle) => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    const lock = await this.acquire(options);
    try {
      return await fn(lock);
    } finally {
      if (!lock.isReleased) {
        try {
          await lock.release();
        } catch (releaseErr) {
          // Re-throw if the original fn didn't already throw
          throw releaseErr;
        }
      }
    }
  }

  /**
   * Non-destructive inspection of lock files on disk.
   */
  async inspect(): Promise<LockInspection> {
    const lockExists = fs.existsSync(this.transactionLockPath);
    const reclaimExists = fs.existsSync(this.reclaimLockPath);

    let lockMetadata: LockMetadata | null = null;
    let lockStatus: LockInspection["lockStatus"] = "unlocked";
    let holderLiveness: LockInspection["holderLiveness"];
    let diagnostic: LockInspection["diagnostic"];

    if (lockExists) {
      try {
        const content = fs.readFileSync(this.transactionLockPath, "utf-8");
        lockMetadata = parseLockMetadata(content);
      } catch {
        lockMetadata = null;
      }

      if (!lockMetadata) {
        lockStatus = "unreadable";
        diagnostic = createLockDiagnostic(
          new LockError("LOCK_METADATA_UNREADABLE", "transaction.lock has unreadable or empty metadata."),
          this.targetDir
        );
      } else if (lockMetadata.hostname !== this.hostname) {
        lockStatus = "cross_host";
        diagnostic = createLockDiagnostic(
          new LockError("CROSS_HOST_LOCK_UNVERIFIABLE", `Lock held by remote host "${lockMetadata.hostname}".`),
          this.targetDir
        );
      } else {
        const liveness = await this.livenessChecker(lockMetadata.pid, lockMetadata.created_at, lockMetadata.hostname);
        holderLiveness = liveness;
        if (liveness.isAlive) {
          lockStatus = "held";
        } else if (liveness.isVerifiedDead) {
          lockStatus = "stale";
        } else {
          lockStatus = "unreadable";
        }
      }
    }

    let reclaimMetadata: ReclaimMetadata | null = null;
    let reclaimStatus: LockInspection["reclaimStatus"] = "none";

    if (reclaimExists) {
      try {
        const content = fs.readFileSync(this.reclaimLockPath, "utf-8");
        reclaimMetadata = parseReclaimMetadata(content);
      } catch {
        reclaimMetadata = null;
      }

      if (!reclaimMetadata) {
        reclaimStatus = "unreadable";
      } else if (reclaimMetadata.hostname !== this.hostname) {
        reclaimStatus = "cross_host";
      } else {
        const liveness = await this.livenessChecker(
          reclaimMetadata.reclaiming_pid,
          reclaimMetadata.created_at,
          reclaimMetadata.hostname
        );
        if (liveness.isAlive) {
          reclaimStatus = "active";
        } else if (liveness.isVerifiedDead) {
          reclaimStatus = "stale";
        } else {
          reclaimStatus = "unreadable";
        }
      }
    }

    return {
      lockExists,
      lockPath: this.transactionLockPath,
      lockMetadata,
      lockStatus,
      reclaimExists,
      reclaimPath: this.reclaimLockPath,
      reclaimMetadata,
      reclaimStatus,
      holderLiveness,
      diagnostic,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal Protocol Implementation Methods
  // ---------------------------------------------------------------------------

  /**
   * Evaluates existing reclaim.lock.
   * Returns true if reclaim.lock is no longer active (cleared), or false if active reclamation is ongoing.
   * Throws LockError if unreadable or unverifiable.
   */
  private async evaluateReclaimMarker(): Promise<boolean> {
    if (!fs.existsSync(this.reclaimLockPath)) {
      return true;
    }

    // Read marker content with transient grace period polling for in-flight writes
    const content = await this.readWithTransientGrace(this.reclaimLockPath);
    const meta = parseReclaimMetadata(content);

    if (!meta) {
      // Invariant 4 & 8: Unreadable marker -> FAIL CLOSED
      throw new LockError(
        "RECLAIM_MARKER_UNVERIFIABLE",
        "Found empty or malformed reclaim.lock. Cannot verify reclaimer process ownership. Automatic recovery is barred."
      );
    }

    // Invariant 5: A live reclaimer never loses ownership due to elapsed time
    const liveness = await this.livenessChecker(meta.reclaiming_pid, meta.created_at, meta.hostname);

    if (liveness.isAlive) {
      // Reclaimer is actively alive; contender must not proceed
      return false;
    }

    if (liveness.isVerifiedDead) {
      // Reclaimer crashed; safely remove dead reclaim.lock
      try {
        const current = fs.readFileSync(this.reclaimLockPath, "utf-8");
        const currentMeta = parseReclaimMetadata(current);
        if (currentMeta && currentMeta.nonce === meta.nonce && currentMeta.reclaiming_pid === meta.reclaiming_pid) {
          fs.unlinkSync(this.reclaimLockPath);
          return true;
        }
      } catch {
        // Ignored; another process may have cleared it
      }
      return !fs.existsSync(this.reclaimLockPath);
    }

    // If liveness cannot be established (e.g. cross-host): fail closed
    throw new LockError(
      "CROSS_HOST_LOCK_UNVERIFIABLE",
      `reclaim.lock held by host "${meta.hostname}". Process liveness cannot be verified across physical machines.`
    );
  }

  /**
   * Evaluates existing transaction.lock when EEXIST was returned.
   * Attempts atomic reclamation if owner is verified dead.
   */
  private async evaluateContendedLock(): Promise<{ status: "active" | "reclaimed" | "retry"; handle?: TransactionLockHandle }> {
    if (!fs.existsSync(this.transactionLockPath)) {
      return { status: "retry" };
    }

    const content = await this.readWithTransientGrace(this.transactionLockPath);
    const meta = parseLockMetadata(content);

    if (!meta) {
      // Invariant 1, 4 & 8: Unreadable/0-byte lock -> FAIL CLOSED
      throw new LockError(
        "LOCK_METADATA_UNREADABLE",
        "transaction.lock exists but contains unreadable, truncated, or empty metadata. Cannot verify process ownership. Automatic recovery is barred."
      );
    }

    if (meta.hostname !== this.hostname) {
      throw new LockError(
        "CROSS_HOST_LOCK_UNVERIFIABLE",
        `transaction.lock held by remote host "${meta.hostname}". Process liveness cannot be verified across physical machines.`
      );
    }

    // Check liveness of recorded PID
    const liveness = await this.livenessChecker(meta.pid, meta.created_at, meta.hostname);

    if (liveness.isAlive) {
      // Invariant 2: Never remove a lock owned by a process that is demonstrably alive
      return { status: "active" };
    }

    if (liveness.isVerifiedDead) {
      // Owner is verified dead! Execute atomic reclamation protocol
      const reclaimedHandle = await this.reclaimStaleLock(meta);
      if (reclaimedHandle) {
        return { status: "reclaimed", handle: reclaimedHandle };
      }
      return { status: "retry" };
    }

    throw new LockError(
      "LOCK_ACQUISITION_FAILED",
      `Cannot establish verified death for PID ${meta.pid}: ${liveness.reason}`
    );
  }

  /**
   * Executes atomic stale-lock reclamation protocol.
   * Competes for reclaim.lock, verifies stale target, unlinks target, acquires new lock, releases reclaim.
   */
  private async reclaimStaleLock(staleLockMeta: LockMetadata): Promise<TransactionLockHandle | null> {
    // 1. Compete for atomic reclamation mutex
    let reclaimFd: number | null = null;
    try {
      reclaimFd = fs.openSync(this.reclaimLockPath, "wx");
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error && error.code === "EEXIST") {
        // Another contender acquired reclamation mutex; we lost
        return null;
      }
      throw new LockError(
        "LOCK_ACQUISITION_FAILED",
        `Failed opening reclaim.lock: ${error?.message || String(err)}`
      );
    }

    const reclaimNonce = crypto.randomUUID();

    try {
      if (this.faultInjection.failAfterReclaimCreatedBeforePayload) {
        fs.closeSync(reclaimFd);
        throw new LockError("LOCK_ACQUISITION_FAILED", "Fault injection: crash after reclaim created before payload.");
      }

      const reclaimMeta: ReclaimMetadata = {
        reclaiming_pid: this.pid,
        hostname: this.hostname,
        target_nonce: staleLockMeta.nonce,
        created_at: new Date().toISOString(),
        nonce: reclaimNonce,
      };

      fs.writeSync(reclaimFd, serializeReclaimMetadata(reclaimMeta), 0, "utf-8");
      fs.fsyncSync(reclaimFd);
      fs.closeSync(reclaimFd);

      if (this.faultInjection.failAfterReclaimBeforeUnlinkTarget) {
        throw new LockError("LOCK_ACQUISITION_FAILED", "Fault injection: crash after reclaim written before unlink target.");
      }

      // 2. Verify stale target in transaction.lock has not changed
      if (!fs.existsSync(this.transactionLockPath)) {
        this.safeUnlinkReclaim(reclaimNonce);
        return null;
      }

      let currentTargetMeta: LockMetadata | null = null;
      try {
        const currentTargetContent = fs.readFileSync(this.transactionLockPath, "utf-8");
        currentTargetMeta = parseLockMetadata(currentTargetContent);
      } catch {
        // Target unreadable
      }

      if (!currentTargetMeta || currentTargetMeta.nonce !== staleLockMeta.nonce) {
        // Target was already modified, renewed, or reclaimed; abort reclamation
        this.safeUnlinkReclaim(reclaimNonce);
        return null;
      }

      // 3. Unlink stale transaction.lock
      fs.unlinkSync(this.transactionLockPath);

      if (this.faultInjection.failAfterUnlinkTargetBeforeNewLock) {
        throw new LockError("LOCK_ACQUISITION_FAILED", "Fault injection: crash after target unlinked before new lock.");
      }

      // 4. Create replacement transaction.lock
      let newFd: number | null = null;
      try {
        if (this.faultInjection.failReplacementLockWithEexist) {
          // Simulate that a competing live contender created transaction.lock before we could
          fs.writeFileSync(
            this.transactionLockPath,
            serializeLockMetadata({
              pid: this.pid + 9999,
              hostname: this.hostname,
              created_at: new Date().toISOString(),
              nonce: "competing-winner-nonce",
            })
          );
          const fakeErr = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
          fakeErr.code = "EEXIST";
          throw fakeErr;
        }
        newFd = fs.openSync(this.transactionLockPath, "wx");
      } catch (err: unknown) {
        const openErr = err as NodeJS.ErrnoException;
        if (openErr && openErr.code === "EEXIST") {
          // Collision: Another contender acquired transaction.lock immediately after target was unlinked.
          // Clean up our reclamation marker and yield to the winner.
          this.safeUnlinkReclaim(reclaimNonce);
          return null;
        }

        // Other filesystem failure creating replacement lock
        this.safeUnlinkReclaim(reclaimNonce);
        throw new LockError(
          "LOCK_ACQUISITION_FAILED",
          `Filesystem error creating replacement transaction lock: ${openErr?.message || String(err)}`,
          { originalError: err }
        );
      }

      const newNonce = crypto.randomUUID();
      const newMeta: LockMetadata = {
        pid: this.pid,
        hostname: this.hostname,
        created_at: new Date().toISOString(),
        nonce: newNonce,
      };

      try {
        fs.writeSync(newFd, serializeLockMetadata(newMeta), 0, "utf-8");
        fs.fsyncSync(newFd);
        fs.closeSync(newFd);
        newFd = null;
      } catch (writeErr) {
        try {
          if (newFd !== null) fs.closeSync(newFd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(this.transactionLockPath);
        } catch {
          // ignore
        }
        this.safeUnlinkReclaim(reclaimNonce);
        throw writeErr;
      }

      if (this.faultInjection.failAfterNewLockBeforeUnlinkReclaim) {
        throw new LockError("LOCK_ACQUISITION_FAILED", "Fault injection: crash after new lock before unlink reclaim.");
      }

      // 5. Release reclamation mutex
      this.safeUnlinkReclaim(reclaimNonce);

      // Successfully reclaimed
      let released = false;
      const handle: TransactionLockHandle = {
        nonce: newNonce,
        pid: this.pid,
        hostname: this.hostname,
        createdAt: newMeta.created_at,
        lockPath: this.transactionLockPath,
        get isReleased() {
          return released;
        },
        release: async () => {
          if (released) return;
          await this.release(handle);
          released = true;
        },
      };

      return handle;
    } catch (err) {
      try {
        if (reclaimFd !== null) fs.closeSync(reclaimFd);
      } catch {
        // ignore
      }
      // If error was not a crash point simulation, ensure reclamation marker is cleaned up if owned
      const isCrashSimulation =
        this.faultInjection.failAfterReclaimCreatedBeforePayload ||
        this.faultInjection.failAfterReclaimBeforeUnlinkTarget ||
        this.faultInjection.failAfterUnlinkTargetBeforeNewLock ||
        this.faultInjection.failAfterNewLockBeforeUnlinkReclaim;

      if (!isCrashSimulation) {
        try {
          this.safeUnlinkReclaim(reclaimNonce);
        } catch {
          // ignore cleanup error if re-throwing original error
        }
      }
      throw err;
    }
  }

  /**
   * Safely unlinks reclaim.lock asserting ownership nonce.
   * Returns true if marker was cleanly unlinked or did not exist.
   * Returns false if marker was owned by another process or unreadable.
   * Throws LockError if cleanup failed due to a filesystem error (e.g. EPERM).
   */
  safeUnlinkReclaim(expectedNonce: string): boolean {
    if (!fs.existsSync(this.reclaimLockPath)) {
      return true;
    }

    if (this.faultInjection.failReclaimCleanup) {
      const err = new Error("EPERM: operation not permitted, unlink") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw new LockError(
        "LOCK_ACQUISITION_FAILED",
        `Failed to clean up reclamation marker after operation: ${err.message}`,
        { originalError: err, reclaimNonce: expectedNonce }
      );
    }

    let meta: ReclaimMetadata | null = null;
    try {
      const content = fs.readFileSync(this.reclaimLockPath, "utf-8");
      meta = parseReclaimMetadata(content);
    } catch {
      // Unreadable marker; do not delete (fail closed)
      return false;
    }

    if (!meta || meta.nonce !== expectedNonce || meta.reclaiming_pid !== this.pid) {
      // Not owned by this process; do NOT delete
      return false;
    }

    try {
      fs.unlinkSync(this.reclaimLockPath);
      return true;
    } catch (unlinkErr: unknown) {
      const err = unlinkErr as NodeJS.ErrnoException;
      throw new LockError(
        "LOCK_ACQUISITION_FAILED",
        `Failed to clean up reclamation marker after operation: ${err?.message || String(unlinkErr)}`,
        { originalError: unlinkErr, reclaimNonce: expectedNonce }
      );
    }
  }

  /**
   * Reads a file with a bounded transient grace period to accommodate in-flight flushes.
   */
  private async readWithTransientGrace(filePath: string): Promise<string> {
    const startTime = Date.now();
    let content = "";

    while (Date.now() - startTime <= this.transientGracePeriodMs) {
      try {
        if (!fs.existsSync(filePath)) {
          return "";
        }
        content = fs.readFileSync(filePath, "utf-8");
        if (content.trim().length > 0) {
          return content;
        }
      } catch {
        // Wait and retry
      }
      await this.sleep(25);
    }

    return content;
  }

  private async sleepJitter(): Promise<void> {
    const jitter = Math.floor(Math.random() * (this.maxRetryDelayMs - this.retryDelayMs)) + this.retryDelayMs;
    await this.sleep(jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
