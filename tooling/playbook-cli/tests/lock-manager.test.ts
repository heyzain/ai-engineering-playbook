import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  TransactionLockManager,
  serializeLockMetadata,
  serializeReclaimMetadata,
  LockError,
  defaultProcessLivenessChecker,
  createLockDiagnostic,
  getLinuxProcessStartTime,
  getWindowsProcessStartTime,
  getMacProcessStartTime,
  type ProcessLivenessResult,
} from "../src/core/lock/index.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, "fixtures/lock-worker.js");

describe("TransactionLockManager & Atomic Concurrency", () => {
  let tempDir: string;
  let lockDir: string;
  let txLockPath: string;
  let reclaimLockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-lock-test-"));
    lockDir = path.join(tempDir, ".playbook");
    fs.mkdirSync(lockDir, { recursive: true });
    txLockPath = path.join(lockDir, "transaction.lock");
    reclaimLockPath = path.join(lockDir, "reclaim.lock");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on Windows
      }
    }
  });

  // 1. Successful lock acquisition and release
  test("Scenario 1: Successful lock acquisition and clean release", async () => {
    const manager = new TransactionLockManager({ targetDir: tempDir });
    const lock = await manager.acquire();

    assert.ok(lock.nonce, "Nonce must be generated");
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.isReleased, false);
    assert.ok(fs.existsSync(txLockPath), "transaction.lock must exist on disk");

    const content = JSON.parse(fs.readFileSync(txLockPath, "utf-8"));
    assert.equal(content.nonce, lock.nonce);
    assert.equal(content.pid, process.pid);
    assert.equal(content.hostname, os.hostname());
    assert.ok(content.created_at);

    await lock.release();
    assert.equal(lock.isReleased, true);
    assert.ok(!fs.existsSync(txLockPath), "transaction.lock must be unlinked after release");
  });

  // 2. Simultaneous competing processes (Multi-Process)
  test("Scenario 2: Simultaneous competing multi-process contention guarantees mutual exclusion", async () => {
    const logFile = path.join(tempDir, "concurrency.log");
    fs.writeFileSync(logFile, "", "utf-8");

    // Spawn 3 concurrent processes competing for the lock
    const p1 = execFileAsync("node", [
      workerPath,
      "--targetDir",
      tempDir,
      "--id",
      "worker-1",
      "--holdMs",
      "80",
      "--logFile",
      logFile,
      "--timeoutMs",
      "12000",
    ]);

    const p2 = execFileAsync("node", [
      workerPath,
      "--targetDir",
      tempDir,
      "--id",
      "worker-2",
      "--holdMs",
      "80",
      "--logFile",
      logFile,
      "--timeoutMs",
      "12000",
    ]);

    const p3 = execFileAsync("node", [
      workerPath,
      "--targetDir",
      tempDir,
      "--id",
      "worker-3",
      "--holdMs",
      "80",
      "--logFile",
      logFile,
      "--timeoutMs",
      "12000",
    ]);

    const results = await Promise.all([p1, p2, p3]);
    for (const r of results) {
      assert.equal(r.stderr, "");
    }

    // Inspect concurrency log
    const lines = fs
      .readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    const acquiredEvents = lines.filter((l) => l.event === "acquired");
    const releasedEvents = lines.filter((l) => l.event === "released");

    assert.equal(acquiredEvents.length, 3, "All 3 workers must acquire the lock");
    assert.equal(releasedEvents.length, 3, "All 3 workers must release the lock");

    // Verify non-overlapping intervals across all workers
    interface Interval {
      id: string;
      acquired: number;
      released: number;
    }
    const intervals: Interval[] = [];
    for (const workerId of ["worker-1", "worker-2", "worker-3"]) {
      const acq = acquiredEvents.find((e) => e.id === workerId)!.timestamp;
      const rel = releasedEvents.find((e) => e.id === workerId)!.timestamp;
      assert.ok(rel >= acq, "Release must happen after acquire");
      intervals.push({ id: workerId, acquired: acq, released: rel });
    }

    intervals.sort((a, b) => a.acquired - b.acquired);

    for (let i = 0; i < intervals.length - 1; i++) {
      const current = intervals[i];
      const next = intervals[i + 1];
      assert.ok(
        next.acquired >= current.released,
        `Process overlap violation between ${current.id} (released at ${current.released}) and ${next.id} (acquired at ${next.acquired})`
      );
    }
  });

  // 3. Lock ownership nonce mismatch
  test("Scenario 3: Lock ownership nonce mismatch strictly prevents unlinking and raises LOCK_LOST_DURING_TRANSACTION", async () => {
    const manager = new TransactionLockManager({ targetDir: tempDir });
    const lock = await manager.acquire();

    // Overwrite transaction.lock with a different nonce (simulating lock lost/reclaimed)
    const forgedPayload = serializeLockMetadata({
      pid: process.pid,
      hostname: os.hostname(),
      created_at: new Date().toISOString(),
      nonce: "forged-foreign-nonce-12345",
    });
    fs.writeFileSync(txLockPath, forgedPayload, "utf-8");

    // Attempting release must throw LOCK_LOST_DURING_TRANSACTION
    await assert.rejects(
      async () => {
        await lock.release();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_LOST_DURING_TRANSACTION");
        return true;
      }
    );

    // Invariant: The foreign lock MUST NOT be unlinked
    assert.ok(fs.existsSync(txLockPath), "transaction.lock must remain untouched when nonce mismatches");
    const remaining = JSON.parse(fs.readFileSync(txLockPath, "utf-8"));
    assert.equal(remaining.nonce, "forged-foreign-nonce-12345");
  });

  // 4. Live process protection
  test("Scenario 4: Live process protection prevents lock theft even after time elapses", async () => {
    // Write a lock file owned by the current process (which is demonstrably alive).
    // The lock created_at must match or follow the process's actual start time to prove it is the original process.
    const originalNonce = "original-live-nonce";
    const liveLockPayload = serializeLockMetadata({
      pid: process.pid,
      hostname: os.hostname(),
      created_at: new Date(Date.now() + 5000).toISOString(),
      nonce: originalNonce,
    });
    fs.writeFileSync(txLockPath, liveLockPayload, "utf-8");

    // Contender with short timeout tries to acquire
    const contender = new TransactionLockManager({
      targetDir: tempDir,
      pid: process.pid + 1000,
      timeoutMs: 300,
      retryDelayMs: 25,
      maxRetryDelayMs: 50,
    });

    await assert.rejects(
      async () => {
        await contender.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_TIMEOUT");
        return true;
      }
    );

    // Verify lock was NOT stolen and still has original nonce
    assert.ok(fs.existsSync(txLockPath));
    const current = JSON.parse(fs.readFileSync(txLockPath, "utf-8"));
    assert.equal(current.nonce, originalNonce, "Lock must not be stolen from a living process");
  });

  // 5. Dead process detection and reclamation
  test("Scenario 5: Dead process detection allows safe atomic reclamation", async () => {
    const deadPid = 99999999; // Non-existent PID
    const stalePayload = serializeLockMetadata({
      pid: deadPid,
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 60000).toISOString(),
      nonce: "stale-dead-nonce",
    });
    fs.writeFileSync(txLockPath, stalePayload, "utf-8");

    // Custom liveness checker confirming PID is verified dead
    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead test process (ESRCH)", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const manager = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 2000,
    });

    const lock = await manager.acquire();
    assert.ok(lock.nonce);
    assert.notEqual(lock.nonce, "stale-dead-nonce");
    assert.equal(lock.pid, process.pid);

    // Verify new lock is written and reclaim.lock is unlinked
    assert.ok(fs.existsSync(txLockPath));
    assert.ok(!fs.existsSync(reclaimLockPath));

    await lock.release();
  });

  // 6. PID reuse handling where supported
  test("Scenario 6: PID reuse detection identifies recycled PIDs and reclaims stale lock", async () => {
    const reusedPid = 4242;
    const lockCreatedAt = new Date(Date.now() - 30000).toISOString(); // 30s ago
    const stalePayload = serializeLockMetadata({
      pid: reusedPid,
      hostname: os.hostname(),
      created_at: lockCreatedAt,
      nonce: "reused-pid-nonce",
    });
    fs.writeFileSync(txLockPath, stalePayload, "utf-8");

    // Liveness checker that simulates PID recycling: process is alive now, but start time is AFTER lock creation
    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === reusedPid) {
        return {
          isAlive: false,
          isVerifiedDead: true,
          isRecycled: true,
          reason: "PID was recycled by OS after lock creation",
          pid,
          startTime: new Date(Date.now() - 5000), // started 5s ago, after lock was created 30s ago
        };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const manager = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 2000,
    });

    const lock = await manager.acquire();
    assert.ok(lock.nonce);
    assert.notEqual(lock.nonce, "reused-pid-nonce");

    await lock.release();
  });

  // 7. Empty lock metadata fails closed
  test("Scenario 7: Empty 0-byte lock metadata fails closed immediately without deleting file", async () => {
    fs.writeFileSync(txLockPath, "", "utf-8"); // 0 bytes

    const manager = new TransactionLockManager({
      targetDir: tempDir,
      transientGracePeriodMs: 100, // fast test grace
      timeoutMs: 1000,
    });

    await assert.rejects(
      async () => {
        await manager.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_METADATA_UNREADABLE");
        return true;
      }
    );

    // Invariant 8: Empty lock file must NOT be automatically deleted
    assert.ok(fs.existsSync(txLockPath), "0-byte lock file must remain on disk (fail closed)");
    assert.equal(fs.statSync(txLockPath).size, 0);
  });

  // 8. Malformed lock metadata fails closed
  test("Scenario 8: Malformed lock metadata fails closed without deleting file", async () => {
    fs.writeFileSync(txLockPath, "{\"pid\": 123, \"malformed\": true", "utf-8");

    const manager = new TransactionLockManager({
      targetDir: tempDir,
      transientGracePeriodMs: 100,
      timeoutMs: 1000,
    });

    await assert.rejects(
      async () => {
        await manager.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_METADATA_UNREADABLE");
        return true;
      }
    );

    assert.ok(fs.existsSync(txLockPath), "Malformed lock file must remain on disk (fail closed)");
  });

  // 9. Empty and malformed reclamation markers fail closed
  test("Scenario 9: Empty or malformed reclaim.lock fails closed without deleting marker", async () => {
    fs.writeFileSync(reclaimLockPath, "", "utf-8"); // empty marker

    const manager = new TransactionLockManager({
      targetDir: tempDir,
      transientGracePeriodMs: 100,
      timeoutMs: 1000,
    });

    await assert.rejects(
      async () => {
        await manager.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "RECLAIM_MARKER_UNVERIFIABLE");
        return true;
      }
    );

    assert.ok(fs.existsSync(reclaimLockPath), "Empty reclaim marker must not be deleted");
  });

  // 10. Reclaimer process termination
  test("Scenario 10: Dead reclaimer process allows subsequent process to safely unwind marker", async () => {
    const deadReclaimerPid = 88888888;
    const deadReclaimerMarker = serializeReclaimMetadata({
      reclaiming_pid: deadReclaimerPid,
      hostname: os.hostname(),
      target_nonce: "stale-target-nonce",
      created_at: new Date(Date.now() - 10000).toISOString(),
      nonce: "dead-reclaimer-nonce",
    });
    fs.writeFileSync(reclaimLockPath, deadReclaimerMarker, "utf-8");

    // Dead target lock
    const deadTargetPid = 77777777;
    const deadTargetLock = serializeLockMetadata({
      pid: deadTargetPid,
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 30000).toISOString(),
      nonce: "stale-target-nonce",
    });
    fs.writeFileSync(txLockPath, deadTargetLock, "utf-8");

    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadReclaimerPid || pid === deadTargetPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead PID (ESRCH)", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const manager = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 2000,
    });

    const lock = await manager.acquire();
    assert.ok(lock.nonce);
    assert.ok(!fs.existsSync(reclaimLockPath), "Dead reclaim.lock must be cleaned up");
    assert.ok(fs.existsSync(txLockPath), "New transaction.lock must be created");

    await lock.release();
  });

  // 11. Reclamation contention
  test("Scenario 11: Reclamation contention: losing contender backs off when another reclaimer holds marker", async () => {
    const deadOwnerPid = 55555555;
    const stalePayload = serializeLockMetadata({
      pid: deadOwnerPid,
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 60000).toISOString(),
      nonce: "target-stale-nonce",
    });
    fs.writeFileSync(txLockPath, stalePayload, "utf-8");

    // Process B is already actively reclaiming
    const liveReclaimerPid = process.pid;
    const activeReclaimMarker = serializeReclaimMetadata({
      reclaiming_pid: liveReclaimerPid,
      hostname: os.hostname(),
      target_nonce: "target-stale-nonce",
      created_at: new Date().toISOString(),
      nonce: "active-reclaimer-nonce",
    });
    fs.writeFileSync(reclaimLockPath, activeReclaimMarker, "utf-8");

    // Process C attempts to acquire
    const contender = new TransactionLockManager({
      targetDir: tempDir,
      pid: process.pid + 500,
      timeoutMs: 250,
      retryDelayMs: 20,
      maxRetryDelayMs: 40,
    });

    await assert.rejects(
      async () => {
        await contender.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_TIMEOUT");
        return true;
      }
    );

    // Contender C must NOT touch reclaim.lock or transaction.lock
    assert.ok(fs.existsSync(reclaimLockPath));
    assert.ok(fs.existsSync(txLockPath));
  });

  // 12. Acquisition racing with reclamation (post-acquisition rollback)
  test("Scenario 12: Acquisition racing with reclamation triggers safe rollback of transaction.lock", async () => {
    const manager = new TransactionLockManager({
      targetDir: tempDir,
      faultInjection: {
        simulateConcurrentReclaimBeforePostCheck: true,
      },
      timeoutMs: 300,
      retryDelayMs: 25,
      maxRetryDelayMs: 50,
    });

    // Contender should detect concurrent reclaim in post-check and roll back its transaction.lock
    await assert.rejects(
      async () => {
        await manager.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_TIMEOUT");
        return true;
      }
    );

    // Verify transaction.lock was rolled back and is not held by manager
    assert.ok(
      !fs.existsSync(txLockPath),
      "transaction.lock must be cleanly rolled back when concurrent reclaim is detected"
    );
  });

  // 13. Process termination during lock acquisition (fault injection)
  test("Scenario 13: Process termination during lock creation leaves empty file, subsequent contender fails closed", async () => {
    const crashingManager = new TransactionLockManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterLockCreatedBeforePayload: true,
      },
    });

    await assert.rejects(
      async () => {
        await crashingManager.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.match(err.message, /Fault injection/);
        return true;
      }
    );

    // 0-byte file remains
    assert.ok(fs.existsSync(txLockPath));
    assert.equal(fs.statSync(txLockPath).size, 0);

    // Subsequent contender must fail closed
    const contender = new TransactionLockManager({
      targetDir: tempDir,
      transientGracePeriodMs: 50,
      timeoutMs: 300,
    });

    await assert.rejects(
      async () => {
        await contender.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_METADATA_UNREADABLE");
        return true;
      }
    );
  });

  // 14. Process termination during lock release
  test("Scenario 14: Process termination before release leaves valid lock; subsequent process reclaims upon death", async () => {
    const deadWorkerPid = 616161;
    const workerLock = serializeLockMetadata({
      pid: deadWorkerPid,
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 20000).toISOString(),
      nonce: "unreleased-worker-nonce",
    });
    fs.writeFileSync(txLockPath, workerLock, "utf-8");

    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadWorkerPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Worker crashed before release (ESRCH)", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const nextManager = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 2000,
    });

    const newLock = await nextManager.acquire();
    assert.ok(newLock.nonce);
    assert.notEqual(newLock.nonce, "unreleased-worker-nonce");
    await newLock.release();
  });

  // 15. Unsupported filesystem behavior
  test("Scenario 15: Unsupported filesystem path (UNC share) fails closed with UNSUPPORTED_FILESYSTEM", async () => {
    const uncManager = new TransactionLockManager({
      targetDir: "\\\\storage-server\\playbook-share\\my-app",
    });

    await assert.rejects(
      async () => {
        await uncManager.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "UNSUPPORTED_FILESYSTEM");
        return true;
      }
    );
  });

  // Helper withLock test
  test("Helper withLock executes critical section and guarantees release", async () => {
    const manager = new TransactionLockManager({ targetDir: tempDir });
    let executed = false;

    const result = await manager.withLock(async (lock) => {
      assert.ok(fs.existsSync(txLockPath));
      executed = true;
      return "success-result";
    });

    assert.equal(result, "success-result");
    assert.equal(executed, true);
    assert.ok(!fs.existsSync(txLockPath), "Lock must be released automatically");
  });

  // Diagnostics mapping test
  test("Structured diagnostics mapping formats all lock error codes with actionable remediation", () => {
    const codes = [
      "LOCK_ACQUISITION_FAILED",
      "LOCK_HELD_BY_ACTIVE_PROCESS",
      "LOCK_METADATA_UNREADABLE",
      "RECLAIM_MARKER_UNVERIFIABLE",
      "RECLAMATION_IN_PROGRESS",
      "LOCK_LOST_DURING_TRANSACTION",
      "CROSS_HOST_LOCK_UNVERIFIABLE",
      "UNSUPPORTED_FILESYSTEM",
      "LOCK_TIMEOUT",
    ] as const;

    for (const code of codes) {
      const err = new LockError(code, `Test error message for ${code}`);
      const diag = createLockDiagnostic(err, tempDir);
      assert.equal(diag.code, code);
      assert.equal(diag.severity, "error");
      assert.ok(diag.message.includes(code));
      assert.ok(diag.remediation.length > 10, "Remediation advice must be meaningful");
    }
  });

  // Non-destructive inspection test
  test("Non-destructive inspection accurately reports lock and reclaim states", async () => {
    const manager = new TransactionLockManager({ targetDir: tempDir });

    // State 1: Unlocked
    const insp1 = await manager.inspect();
    assert.equal(insp1.lockExists, false);
    assert.equal(insp1.lockStatus, "unlocked");
    assert.equal(insp1.reclaimExists, false);

    // State 2: Locked by active process
    const lock = await manager.acquire();
    const insp2 = await manager.inspect();
    assert.equal(insp2.lockExists, true);
    assert.equal(insp2.lockStatus, "held");
    assert.equal(insp2.lockMetadata?.nonce, lock.nonce);

    await lock.release();

    // State 3: Unreadable
    fs.writeFileSync(txLockPath, "{ corrupted", "utf-8");
    const insp3 = await manager.inspect();
    assert.equal(insp3.lockExists, true);
    assert.equal(insp3.lockStatus, "unreadable");
    assert.ok(insp3.diagnostic);
    assert.equal(insp3.diagnostic.code, "LOCK_METADATA_UNREADABLE");
  });

  // ---------------------------------------------------------------------------
  // F-01: Linux Process Start-Time Detection & Indeterminate Identity
  // ---------------------------------------------------------------------------

  test("F-01.1: getLinuxProcessStartTime strictly returns null and never uses /proc mtime", () => {
    const result = getLinuxProcessStartTime(process.pid);
    assert.equal(result, null, "getLinuxProcessStartTime must return null to fail closed on indeterminate identity");
  });

  test("F-01.2: A live process with indeterminate start-time is never classified as recycled or dead", () => {
    // Calling getLinuxProcessStartTime directly proves Linux fails closed without /proc mtime:
    assert.equal(getLinuxProcessStartTime(process.pid), null);

    // When start-time is indeterminate (null), defaultProcessLivenessChecker treats process as alive
    const res = defaultProcessLivenessChecker(process.pid);
    assert.equal(res.isAlive, true);
    assert.equal(res.isVerifiedDead, false);
    assert.equal(res.isRecycled, false);
  });

  test("F-01.3: Indeterminate process identity strictly prevents lock reclamation", async () => {
    // Hold lock with an active process whose start-time is indeterminate
    const holderPid = 717171;
    const lockPayload = serializeLockMetadata({
      pid: holderPid,
      hostname: os.hostname(),
      created_at: "2020-01-01T00:00:00.000Z",
      nonce: "indeterminate-holder-nonce",
    });
    fs.writeFileSync(txLockPath, lockPayload, "utf-8");

    // Liveness checker returns indeterminate (process is alive in OS table, start time unknown)
    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === holderPid) {
        return {
          isAlive: true,
          isVerifiedDead: false,
          isIndeterminate: true,
          reason: "PID exists in OS table; start-time cannot be determined. Treated as alive.",
          pid,
        };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const contender = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 300,
      retryDelayMs: 25,
      maxRetryDelayMs: 50,
    });

    // Contender must NOT reclaim or steal the lock; it must time out
    await assert.rejects(
      async () => {
        await contender.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_TIMEOUT");
        return true;
      }
    );

    // Verify lock remains untouched
    assert.ok(fs.existsSync(txLockPath));
    const content = JSON.parse(fs.readFileSync(txLockPath, "utf-8"));
    assert.equal(content.nonce, "indeterminate-holder-nonce");
  });

  test("F-01.4: Dead processes remain detectable through reliable OS evidence (ESRCH)", async () => {
    // Non-existent PID
    const nonExistentPid = 999999999;
    const result = defaultProcessLivenessChecker(nonExistentPid);
    assert.equal(result.isAlive, false);
    assert.equal(result.isVerifiedDead, true);
    assert.equal(result.isIndeterminate, false);
    assert.match(result.reason, /ESRCH/);
  });

  // ---------------------------------------------------------------------------
  // F-02: Reclamation Marker Cleanup on Replacement Collision & Failures
  // ---------------------------------------------------------------------------

  test("F-02.1: Replacement lock creation returning EEXIST cleanly cleans up reclaim.lock without leaving orphaned marker", async () => {
    const deadPid = 818181;
    const stalePayload = serializeLockMetadata({
      pid: deadPid,
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 60000).toISOString(),
      nonce: "stale-dead-target",
    });
    fs.writeFileSync(txLockPath, stalePayload, "utf-8");

    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead target (ESRCH)", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    // Reclaimer configured with fault injection: replacement lock open throws EEXIST
    const reclaimer = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      faultInjection: {
        failReplacementLockWithEexist: true,
      },
      timeoutMs: 300,
      retryDelayMs: 25,
      maxRetryDelayMs: 50,
    });

    // Reclaimer will encounter EEXIST, clean up its reclaim marker, and retry until timeout
    await assert.rejects(
      async () => {
        await reclaimer.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_TIMEOUT");
        return true;
      }
    );

    // Critical assertion: reclaim.lock MUST NOT be left orphaned on disk!
    assert.ok(
      !fs.existsSync(reclaimLockPath),
      "reclaim.lock must be cleanly removed after EEXIST replacement collision"
    );

    // Critical assertion: replacement lock owned by competitor MUST NOT be deleted
    assert.ok(fs.existsSync(txLockPath), "transaction.lock owned by competitor must remain intact");
    const content = JSON.parse(fs.readFileSync(txLockPath, "utf-8"));
    assert.equal(content.nonce, "competing-winner-nonce");
  });

  test("F-02.2: safeUnlinkReclaim strictly preserves markers owned by other processes", () => {
    const manager = new TransactionLockManager({
      targetDir: tempDir,
      pid: 11111,
    });

    // Write a marker owned by process 22222 with foreign nonce
    const foreignMarker = serializeReclaimMetadata({
      reclaiming_pid: 22222,
      hostname: os.hostname(),
      target_nonce: "some-target",
      created_at: new Date().toISOString(),
      nonce: "foreign-nonce-abc",
    });
    fs.writeFileSync(reclaimLockPath, foreignMarker, "utf-8");

    // Manager 11111 attempts to unlink with its own nonce
    const unlinked = manager.safeUnlinkReclaim("my-own-nonce");
    assert.equal(unlinked, false, "Must return false when marker is owned by another process");

    // Marker MUST remain intact on disk
    assert.ok(fs.existsSync(reclaimLockPath));
    const content = JSON.parse(fs.readFileSync(reclaimLockPath, "utf-8"));
    assert.equal(content.nonce, "foreign-nonce-abc");
    assert.equal(content.reclaiming_pid, 22222);
  });

  test("F-02.3: safeUnlinkReclaim throws structured LockError when cleanup itself fails", () => {
    const manager = new TransactionLockManager({
      targetDir: tempDir,
      faultInjection: {
        failReclaimCleanup: true,
      },
    });

    const myNonce = "my-nonce-xyz";
    const myMarker = serializeReclaimMetadata({
      reclaiming_pid: manager.pid,
      hostname: os.hostname(),
      target_nonce: "target-123",
      created_at: new Date().toISOString(),
      nonce: myNonce,
    });
    fs.writeFileSync(reclaimLockPath, myMarker, "utf-8");

    assert.throws(
      () => {
        manager.safeUnlinkReclaim(myNonce);
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "LOCK_ACQUISITION_FAILED");
        assert.match(err.message, /Failed to clean up reclamation marker/);
        assert.ok(err.details?.originalError);
        return true;
      }
    );
  });

  test("F-02.4: Fault-injection: crash after reclaim.lock created before payload fails closed", async () => {
    const deadPid = 333333;
    fs.writeFileSync(
      txLockPath,
      serializeLockMetadata({
        pid: deadPid,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 30000).toISOString(),
        nonce: "dead-target-payload-crash",
      }),
      "utf-8"
    );

    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const crashingReclaimer = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      faultInjection: {
        failAfterReclaimCreatedBeforePayload: true,
      },
    });

    await assert.rejects(
      async () => {
        await crashingReclaimer.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.match(err.message, /Fault injection: crash after reclaim created before payload/);
        return true;
      }
    );

    // 0-byte reclaim.lock is on disk
    assert.ok(fs.existsSync(reclaimLockPath));
    assert.equal(fs.statSync(reclaimLockPath).size, 0);

    // Subsequent contender must fail closed with RECLAIM_MARKER_UNVERIFIABLE
    const nextContender = new TransactionLockManager({
      targetDir: tempDir,
      transientGracePeriodMs: 50,
      timeoutMs: 300,
    });

    await assert.rejects(
      async () => {
        await nextContender.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.equal(err.code, "RECLAIM_MARKER_UNVERIFIABLE");
        return true;
      }
    );
  });

  test("F-02.5: Fault-injection: crash after target unlinked before new lock allows subsequent reclaimer to acquire", async () => {
    const deadPid = 444444;
    fs.writeFileSync(
      txLockPath,
      serializeLockMetadata({
        pid: deadPid,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 30000).toISOString(),
        nonce: "dead-target-unlink-crash",
      }),
      "utf-8"
    );

    const deadReclaimerPid = 555555;
    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadPid || pid === deadReclaimerPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead process", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const crashingReclaimer = new TransactionLockManager({
      targetDir: tempDir,
      pid: deadReclaimerPid,
      livenessChecker,
      faultInjection: {
        failAfterUnlinkTargetBeforeNewLock: true,
      },
    });

    await assert.rejects(
      async () => {
        await crashingReclaimer.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.match(err.message, /Fault injection: crash after target unlinked/);
        return true;
      }
    );

    // At this point: transaction.lock was unlinked, and dead reclaim.lock is on disk
    assert.ok(!fs.existsSync(txLockPath));
    assert.ok(fs.existsSync(reclaimLockPath));

    // Next contender should detect dead reclaimer, clean up reclaim.lock, and acquire transaction.lock cleanly
    const subsequentContender = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 2000,
    });

    const lock = await subsequentContender.acquire();
    assert.ok(lock.nonce);
    assert.ok(fs.existsSync(txLockPath));
    assert.ok(!fs.existsSync(reclaimLockPath));
    await lock.release();
  });

  test("F-02.6: Fault-injection: crash after new lock before unlink reclaim allows subsequent recovery", async () => {
    const deadPid = 666666;
    fs.writeFileSync(
      txLockPath,
      serializeLockMetadata({
        pid: deadPid,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 30000).toISOString(),
        nonce: "dead-target-before-new-lock-crash",
      }),
      "utf-8"
    );

    const deadReclaimerPid = 777777;
    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadPid || pid === deadReclaimerPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead process", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const crashingReclaimer = new TransactionLockManager({
      targetDir: tempDir,
      pid: deadReclaimerPid,
      livenessChecker,
      faultInjection: {
        failAfterNewLockBeforeUnlinkReclaim: true,
      },
    });

    await assert.rejects(
      async () => {
        await crashingReclaimer.acquire();
      },
      (err: unknown) => {
        assert.ok(err instanceof LockError);
        assert.match(err.message, /Fault injection: crash after new lock before unlink reclaim/);
        return true;
      }
    );

    // Both transaction.lock (owned by dead reclaimer) and reclaim.lock (owned by dead reclaimer) are on disk
    assert.ok(fs.existsSync(txLockPath));
    assert.ok(fs.existsSync(reclaimLockPath));

    // Next contender should unwind dead reclaim.lock, detect dead owner in transaction.lock, and reclaim it
    const subsequentContender = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker,
      timeoutMs: 3000,
    });

    const lock = await subsequentContender.acquire();
    assert.ok(lock.nonce);
    assert.ok(fs.existsSync(txLockPath));
    assert.ok(!fs.existsSync(reclaimLockPath));
    await lock.release();
  });
});
