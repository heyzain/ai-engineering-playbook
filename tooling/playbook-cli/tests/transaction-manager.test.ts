import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  WriteAheadTransactionManager,
  TransactionError,
  createTransactionDiagnostic,
  computeSha256,
  computeFileSha256,
  validateCanonicalPath,
  serializeJournal,
  readJournal,
  writeJournalDurable,
  atomicRenameWithRetry,
} from "../src/core/transaction/index.js";
import {
  TransactionLockManager,
  serializeLockMetadata,
  defaultProcessLivenessChecker,
  type ProcessLivenessResult,
} from "../src/core/lock/index.js";

describe("WriteAheadTransactionManager (WAL Engine)", () => {
  let tempDir: string;
  let playbookDir: string;
  let journalPath: string;
  let statePath: string;
  let manifestPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-wal-test-"));
    playbookDir = path.join(tempDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });
    journalPath = path.join(playbookDir, "tx-journal.json");
    statePath = path.join(playbookDir, "state.json");
    manifestPath = path.join(playbookDir, "manifest.json");

    // Initialize baseline files
    fs.writeFileSync(statePath, JSON.stringify({ stage: 0, status: "pending_review" }, null, 2) + "\n", "utf-8");
    fs.writeFileSync(manifestPath, JSON.stringify({ name: "test-app", active_stage: 0 }, null, 2) + "\n", "utf-8");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore Windows file locks in cleanup
      }
    }
  });

  // 1. Successful transaction execution
  test("Scenario 1: Successful multi-file transaction execution and clean final state", async () => {
    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });

    const newStateContent = JSON.stringify({ stage: 1, status: "not_started" }, null, 2) + "\n";
    const newManifestContent = JSON.stringify({ name: "test-app", active_stage: 1 }, null, 2) + "\n";

    const result = await txManager.executeTransaction("ADVANCE_STAGE", [
      { targetPath: ".playbook/state.json", content: newStateContent },
      { targetPath: ".playbook/manifest.json", content: newManifestContent },
    ]);

    assert.ok(result.txId);
    assert.match(result.txId, /^tx-\d+-[a-f0-9]{8}$/);

    // Verify target files updated to new content
    assert.equal(fs.readFileSync(statePath, "utf-8"), newStateContent);
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), newManifestContent);

    // Verify journal and temporary files were cleaned up
    assert.ok(!fs.existsSync(journalPath), "Journal must be deleted after successful commit");
    const dirEntries = fs.readdirSync(playbookDir);
    assert.ok(dirEntries.every((e) => !e.includes(".tmp.") && !e.includes(".bak.")), "No temp or bak files left");
  });

  // 2. Crash after journal preparation (PREPARED) -> rollback
  test("Scenario 2: Crash after journal preparation (PREPARED) triggers clean rollback to source state", async () => {
    const originalState = fs.readFileSync(statePath, "utf-8");
    const originalManifest = fs.readFileSync(manifestPath, "utf-8");

    const crashingManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPrepared: true,
      },
    });

    const newState = JSON.stringify({ stage: 1, status: "mutated" }, null, 2) + "\n";

    await assert.rejects(
      async () => {
        await crashingManager.executeTransaction("ADVANCE_STAGE", [
          { targetPath: ".playbook/state.json", content: newState },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_PREPARATION_FAILED");
        return true;
      }
    );

    // Journal exists in PREPARED
    const { journal, isCorrupted } = readJournal(journalPath);
    assert.equal(isCorrupted, false);
    assert.ok(journal);
    assert.equal(journal.phase, "PREPARED");

    // Live state file was untouched prior to commit
    assert.equal(fs.readFileSync(statePath, "utf-8"), originalState);

    // Subsequent process recovers
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const recoveryLock = await recoveryManager.lockManager.acquire();

    const recResult = await recoveryManager.recover(recoveryLock);
    assert.equal(recResult.recovered, true);
    assert.equal(recResult.actionTaken, "rolled_back");
    assert.equal(recResult.originalPhase, "PREPARED");

    // Live state remains original
    assert.equal(fs.readFileSync(statePath, "utf-8"), originalState);
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), originalManifest);

    // Journal and temp files deleted
    assert.ok(!fs.existsSync(journalPath));

    await recoveryLock.release();
  });

  // 3. Crash after entering COMMITTING -> roll forward
  test("Scenario 3: Crash after entering COMMITTING triggers deterministic roll-forward to target state", async () => {
    const crashingManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterEnteringCommitting: true,
      },
    });

    const newState = JSON.stringify({ stage: 2, status: "committing_target" }, null, 2) + "\n";
    const newManifest = JSON.stringify({ name: "test-app", active_stage: 2 }, null, 2) + "\n";

    await assert.rejects(
      async () => {
        await crashingManager.executeTransaction("ADVANCE_STAGE", [
          { targetPath: ".playbook/state.json", content: newState },
          { targetPath: ".playbook/manifest.json", content: newManifest },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_COMMIT_FAILED");
        return true;
      }
    );

    // Journal is in COMMITTING phase
    const { journal } = readJournal(journalPath);
    assert.ok(journal);
    assert.equal(journal.phase, "COMMITTING");

    // Subsequent process executes recovery
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();

    const recResult = await recoveryManager.recover(lock);
    assert.equal(recResult.recovered, true);
    assert.equal(recResult.actionTaken, "rolled_forward");
    assert.equal(recResult.originalPhase, "COMMITTING");

    // Target files must now be in the committed target state
    assert.equal(fs.readFileSync(statePath, "utf-8"), newState);
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), newManifest);

    // Journal cleaned up
    assert.ok(!fs.existsSync(journalPath));

    await lock.release();
  });

  // 4. Crash after first target write (partial commit) -> roll forward
  test("Scenario 4: Crash after first target write in multi-file transaction rolls forward all files", async () => {
    const crashingManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterFirstTargetWrite: true,
      },
    });

    const newState = JSON.stringify({ stage: 3, status: "written_file_1" }, null, 2) + "\n";
    const newManifest = JSON.stringify({ name: "test-app", active_stage: 3, updated: true }, null, 2) + "\n";

    await assert.rejects(
      async () => {
        await crashingManager.executeTransaction("ADVANCE_STAGE", [
          { targetPath: ".playbook/state.json", content: newState },
          { targetPath: ".playbook/manifest.json", content: newManifest },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Partial commit state: state.json was replaced, but manifest.json was not yet replaced!
    assert.equal(fs.readFileSync(statePath, "utf-8"), newState);
    assert.ok(fs.readFileSync(manifestPath, "utf-8") !== newManifest);

    // Recover from partial state
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();

    const recResult = await recoveryManager.recover(lock);
    assert.equal(recResult.recovered, true);
    assert.equal(recResult.actionTaken, "rolled_forward");

    // Both files now cleanly synchronized to target state
    assert.equal(fs.readFileSync(statePath, "utf-8"), newState);
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), newManifest);
    assert.ok(!fs.existsSync(journalPath));

    await lock.release();
  });

  // 5. Crash between multiple target writes (3 files)
  test("Scenario 5: Crash between multiple target writes (3 files) reconciles remaining files", async () => {
    const docPath = path.join(tempDir, "docs", "summary.md");
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, "# Old Summary\n", "utf-8");

    const crashingManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failBetweenTargetWrites: true, // fails on file index 1
      },
    });

    const newState = JSON.stringify({ stage: 4, file: 1 }, null, 2) + "\n";
    const newManifest = JSON.stringify({ active_stage: 4, file: 2 }, null, 2) + "\n";
    const newDoc = "# New Summary v4\n";

    await assert.rejects(
      async () => {
        await crashingManager.executeTransaction("CUSTOM_SYNC", [
          { targetPath: ".playbook/state.json", content: newState },
          { targetPath: ".playbook/manifest.json", content: newManifest },
          { targetPath: "docs/summary.md", content: newDoc },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Recovery completes all 3 files
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();
    const recResult = await recoveryManager.recover(lock);

    assert.equal(recResult.recovered, true);
    assert.equal(recResult.actionTaken, "rolled_forward");
    assert.equal(fs.readFileSync(statePath, "utf-8"), newState);
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), newManifest);
    assert.equal(fs.readFileSync(docPath, "utf-8"), newDoc);

    await lock.release();
  });

  // 6. Crash after all targets written before COMMITTED
  test("Scenario 6: Crash after all targets written before COMMITTED finalizes cleanly", async () => {
    const crashingManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterAllTargetsWrittenBeforeCommitted: true,
      },
    });

    const newState = JSON.stringify({ stage: 5, status: "all_written" }, null, 2) + "\n";

    await assert.rejects(
      async () => {
        await crashingManager.executeTransaction("ADVANCE_STAGE", [
          { targetPath: ".playbook/state.json", content: newState },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Targets were written, journal still in COMMITTING
    assert.equal(fs.readFileSync(statePath, "utf-8"), newState);
    const { journal } = readJournal(journalPath);
    assert.equal(journal?.phase, "COMMITTING");

    // Recovery finalizes
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();
    const rec = await recoveryManager.recover(lock);

    assert.equal(rec.recovered, true);
    assert.equal(rec.actionTaken, "rolled_forward");
    assert.ok(!fs.existsSync(journalPath));

    await lock.release();
  });

  // 7. Crash after COMMITTED before cleanup
  test("Scenario 7: Crash after COMMITTED before cleanup finalizes cleanup without mutating targets", async () => {
    const crashingManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterCommittedBeforeCleanup: true,
      },
    });

    const newState = JSON.stringify({ stage: 6, status: "committed_phase" }, null, 2) + "\n";

    await assert.rejects(
      async () => {
        await crashingManager.executeTransaction("CLOSE_LIFECYCLE", [
          { targetPath: ".playbook/state.json", content: newState },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Journal is in COMMITTED phase
    const { journal } = readJournal(journalPath);
    assert.equal(journal?.phase, "COMMITTED");

    // Recovery finalizes cleanup
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();
    const rec = await recoveryManager.recover(lock);

    assert.equal(rec.recovered, true);
    assert.equal(rec.actionTaken, "finalized_cleanup");
    assert.equal(fs.readFileSync(statePath, "utf-8"), newState);
    assert.ok(!fs.existsSync(journalPath));

    await lock.release();
  });

  // 8. Corrupt or incomplete journal fails closed
  test("Scenario 8: Corrupt or incomplete 0-byte journal fails closed with CRITICAL_RECOVERY_FAILURE", async () => {
    fs.writeFileSync(journalPath, "{ invalid json", "utf-8");

    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();

    await assert.rejects(
      async () => {
        await recoveryManager.recover(lock);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "CRITICAL_RECOVERY_FAILURE");
        return true;
      }
    );

    // Journal file MUST remain untouched for operator triage
    assert.ok(fs.existsSync(journalPath));
    assert.equal(fs.readFileSync(journalPath, "utf-8"), "{ invalid json");

    await lock.release();
  });

  // 9. Missing temporary files during COMMITTING recovery reconstructs from durable target_content
  test("Scenario 9: Missing temporary files during COMMITTING recovery reconstructs from journal target_content", async () => {
    const targetContent = JSON.stringify({ reconstructed: true, timestamp: Date.now() }, null, 2) + "\n";
    const targetHash = computeSha256(targetContent);

    // Manually write a COMMITTING journal whose .tmp file does NOT exist on disk
    writeJournalDurable(journalPath, {
      tx_id: "tx-test-reconstruct-123",
      phase: "COMMITTING",
      created_at: new Date().toISOString(),
      action: "TEST_RECONSTRUCT",
      lock_nonce: "fake-nonce",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: ".playbook/state.json.tmp.nonexistent",
          bak_path: ".playbook/state.json.bak.nonexistent",
          existed_before: true,
          expected_source_hash: null,
          expected_target_hash: targetHash,
          target_content: targetContent,
        },
      ],
    });

    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();

    const rec = await recoveryManager.recover(lock);
    assert.equal(rec.recovered, true);
    assert.equal(rec.actionTaken, "rolled_forward");
    assert.equal(fs.readFileSync(statePath, "utf-8"), targetContent);

    await lock.release();
  });

  // 10. Path and traversal safety
  test("Scenario 10: Path traversal (..) and absolute paths are rejected before touching disk", async () => {
    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });

    // Traversal path
    await assert.rejects(
      async () => {
        await txManager.executeTransaction("ILLEGAL_TRAVERSAL", [
          { targetPath: "../../traversal.txt", content: "illegal" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TARGET_PATH_INVALID");
        return true;
      }
    );

    // Absolute path
    await assert.rejects(
      async () => {
        await txManager.executeTransaction("ILLEGAL_ABSOLUTE", [
          { targetPath: path.resolve(tempDir, "outside.txt"), content: "illegal" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TARGET_PATH_INVALID");
        return true;
      }
    );

    assert.ok(!fs.existsSync(journalPath));
  });

  // 11. Concurrent transaction attempts respect lock mutual exclusion
  test("Scenario 11: Concurrent transaction attempts respect lock mutual exclusion", async () => {
    const manager1 = new WriteAheadTransactionManager({ targetDir: tempDir, lockTimeoutMs: 5000 });
    const manager2 = new WriteAheadTransactionManager({
      targetDir: tempDir,
      lockTimeoutMs: 250,
      lockManager: new TransactionLockManager({
        targetDir: tempDir,
        pid: process.pid + 100,
        timeoutMs: 250,
        retryDelayMs: 20,
        maxRetryDelayMs: 40,
      }),
    });

    // Manager 1 holds the lock in a long callback
    let manager1Finished = false;
    const p1 = manager1.withTransaction("LONG_TX", [
      { targetPath: ".playbook/state.json", content: '{"stage": 1}\n' },
    ], async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      manager1Finished = true;
    });

    // Wait a brief moment to ensure Manager 1 acquired lock
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Manager 2 tries to acquire and must time out because Manager 1 holds lock
    await assert.rejects(
      async () => {
        await manager2.executeTransaction("CONTENDER_TX", [
          { targetPath: ".playbook/state.json", content: '{"stage": 99}\n' },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );

    await p1;
    assert.equal(manager1Finished, true);
    assert.equal(fs.readFileSync(statePath, "utf-8"), '{"stage": 1}\n');
  });

  // 12. Lock acquisition and stale dead process reclamation interaction
  test("Scenario 12: Stale dead process lock with unfinished journal is reclaimed and recovered by new process", async () => {
    const deadPid = 929292;
    const targetContent = JSON.stringify({ recovered_from_dead_process: true }, null, 2) + "\n";
    const targetHash = computeSha256(targetContent);

    // Stale lock held by dead process
    const lockPath = path.join(playbookDir, "transaction.lock");
    fs.writeFileSync(
      lockPath,
      serializeLockMetadata({
        pid: deadPid,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 30000).toISOString(),
        nonce: "dead-tx-lock-nonce",
      }),
      "utf-8"
    );

    // Unfinished COMMITTING journal left by dead process
    writeJournalDurable(journalPath, {
      tx_id: "tx-dead-proc-1",
      phase: "COMMITTING",
      created_at: new Date(Date.now() - 30000).toISOString(),
      action: "CRASHED_TX",
      lock_nonce: "dead-tx-lock-nonce",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: ".playbook/state.json.tmp.dead",
          bak_path: ".playbook/state.json.bak.dead",
          existed_before: true,
          expected_source_hash: null,
          expected_target_hash: targetHash,
          target_content: targetContent,
        },
      ],
    });

    // Custom liveness checker confirming PID is dead
    const livenessChecker = (pid: number): ProcessLivenessResult => {
      if (pid === deadPid) {
        return { isAlive: false, isVerifiedDead: true, reason: "Dead PID (ESRCH)", pid };
      }
      return defaultProcessLivenessChecker(pid);
    };

    const newManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      lockManager: new TransactionLockManager({
        targetDir: tempDir,
        livenessChecker,
      }),
    });

    // New process executes a transaction: it must reclaim dead lock, recover unfinished journal, and execute
    const newTxResult = await newManager.executeTransaction("NEW_TX", [
      { targetPath: ".playbook/manifest.json", content: '{"active_stage": 10}\n' },
    ]);

    assert.ok(newTxResult.txId);
    assert.equal(newTxResult.recovery?.recovered, true);
    assert.equal(newTxResult.recovery?.actionTaken, "rolled_forward");

    // Both the recovered file and the new file are correctly committed
    assert.equal(fs.readFileSync(statePath, "utf-8"), targetContent);
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), '{"active_stage": 10}\n');
    assert.ok(!fs.existsSync(journalPath));
  });

  // 13. Recovery idempotency
  test("Scenario 13: Recovery idempotency: running recovery twice produces identical clean result", async () => {
    const targetContent = JSON.stringify({ idempotent: true }, null, 2) + "\n";
    const targetHash = computeSha256(targetContent);

    writeJournalDurable(journalPath, {
      tx_id: "tx-idempotent-test",
      phase: "COMMITTING",
      created_at: new Date().toISOString(),
      action: "IDEMPOTENT_ACTION",
      lock_nonce: "nonce-1",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: ".playbook/state.json.tmp.idemp",
          bak_path: ".playbook/state.json.bak.idemp",
          existed_before: true,
          expected_source_hash: null,
          expected_target_hash: targetHash,
          target_content: targetContent,
        },
      ],
    });

    const manager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await manager.lockManager.acquire();

    // Run 1: Recovers from COMMITTING
    const rec1 = await manager.recover(lock);
    assert.equal(rec1.recovered, true);
    assert.equal(rec1.actionTaken, "rolled_forward");
    assert.equal(fs.readFileSync(statePath, "utf-8"), targetContent);
    assert.ok(!fs.existsSync(journalPath));

    // Run 2: Immediately running recovery again is a clean no-op
    const rec2 = await manager.recover(lock);
    assert.equal(rec2.recovered, false);
    assert.equal(rec2.actionTaken, "none");
    assert.equal(fs.readFileSync(statePath, "utf-8"), targetContent);

    await lock.release();
  });

  // 14. Windows-specific atomic rename with retry
  test("Scenario 14: atomicRenameWithRetry retries on simulated transient EBUSY locks and succeeds", () => {
    const src = path.join(tempDir, "rename-src.tmp");
    const dest = path.join(tempDir, "rename-dest.txt");
    fs.writeFileSync(src, "transient-rename-data", "utf-8");

    // Simulate EBUSY twice, maxRetries = 4 -> must succeed
    atomicRenameWithRetry(src, dest, 4, 10, {
      simulateRenameEbusyCount: 2,
    });

    assert.ok(!fs.existsSync(src));
    assert.ok(fs.existsSync(dest));
    assert.equal(fs.readFileSync(dest, "utf-8"), "transient-rename-data");
  });

  // 15. Structured diagnostics mapping
  test("Scenario 15: Structured diagnostics mapping formats transaction error codes with actionable remediation", () => {
    const codes = [
      "TRANSACTION_JOURNAL_CORRUPT",
      "CRITICAL_RECOVERY_FAILURE",
      "TRANSACTION_PREPARATION_FAILED",
      "TRANSACTION_COMMIT_FAILED",
      "TARGET_PATH_INVALID",
      "EXTERNAL_TARGET_MODIFIED",
    ] as const;

    for (const code of codes) {
      const err = new TransactionError(code, `Test message for ${code}`);
      const diag = createTransactionDiagnostic(err, tempDir);
      assert.ok(diag.code);
      assert.equal(diag.severity, "error");
      assert.ok(diag.message.includes(code));
      assert.ok(diag.remediation.length > 15);
    }
  });

  // 16. Non-destructive inspection
  test("Scenario 16: inspectJournal non-destructively inspects journal status", async () => {
    const manager = new WriteAheadTransactionManager({ targetDir: tempDir });

    // Case 1: No journal
    const insp1 = await manager.inspectJournal();
    assert.equal(insp1.exists, false);
    assert.equal(insp1.journal, null);
    assert.equal(insp1.isCorrupted, false);

    // Case 2: Valid journal
    writeJournalDurable(journalPath, {
      tx_id: "tx-insp-1",
      phase: "PREPARED",
      created_at: new Date().toISOString(),
      action: "INSPECT_TEST",
      lock_nonce: "nonce-1",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: ".playbook/state.json.tmp",
          bak_path: ".playbook/state.json.bak",
          existed_before: true,
          expected_source_hash: null,
          expected_target_hash: "sha256:" + "a".repeat(64),
          target_content: "content",
        },
      ],
    });

    const insp2 = await manager.inspectJournal();
    assert.equal(insp2.exists, true);
    assert.ok(insp2.journal);
    assert.equal(insp2.journal?.tx_id, "tx-insp-1");
    assert.equal(insp2.isCorrupted, false);

    // Case 3: Corrupted journal
    fs.writeFileSync(journalPath, "{ corrupted json", "utf-8");
    const insp3 = await manager.inspectJournal();
    assert.equal(insp3.exists, true);
    assert.equal(insp3.journal, null);
    assert.equal(insp3.isCorrupted, true);
  });

  // 17. Parent-directory synchronization for each affected target directory (F-01)
  test("Scenario 17: Parent-directory synchronization is invoked for each affected target directory", async () => {
    const syncedDirs: string[] = [];
    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        onDirectoryFsync: (dirPath) => {
          syncedDirs.push(path.resolve(dirPath));
        },
      },
    });

    // Create nested directory for a secondary target
    const docsGatesDir = path.join(tempDir, "docs", "gates");
    fs.mkdirSync(docsGatesDir, { recursive: true });
    const gateFilePath = path.join(docsGatesDir, "GATE-1.md");
    fs.writeFileSync(gateFilePath, "old gate\n", "utf-8");

    const result = await txManager.executeTransaction("ADVANCE_STAGE", [
      { targetPath: ".playbook/state.json", content: "new state\n" },
      { targetPath: "docs/gates/GATE-1.md", content: "new gate\n" },
    ]);

    assert.ok(result.txId);
    assert.equal(fs.readFileSync(gateFilePath, "utf-8"), "new gate\n");

    // Verify parent directories were synchronized
    const expectedPlaybookDir = path.resolve(playbookDir);
    const expectedDocsGatesDir = path.resolve(docsGatesDir);

    assert.ok(
      syncedDirs.includes(expectedPlaybookDir),
      "Must synchronize .playbook directory"
    );
    assert.ok(
      syncedDirs.includes(expectedDocsGatesDir),
      "Must synchronize docs/gates directory"
    );
  });

  // 18. Directory synchronization failure prevents unsafe journal cleanup (F-01)
  test("Scenario 18: Directory synchronization failure prevents unsafe journal cleanup and fails closed", async () => {
    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failDirectoryFsyncOnCommit: true,
      },
    });

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("ADVANCE_STAGE", [
          { targetPath: ".playbook/state.json", content: "mutated\n" },
        ]);
      },
      (err: any) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );

    // Verify journal file was NOT deleted / is safely preserved because sync failed during commit
    assert.ok(
      fs.existsSync(journalPath),
      "Journal file must be preserved on disk when directory synchronization fails"
    );
    const insp = await txManager.inspectJournal();
    assert.equal(insp.journal?.phase, "COMMITTING", "Journal must be preserved in COMMITTING phase");
  });

  // 19. Malicious journal with path traversal (..) rejected during recovery (F-02)
  test("Scenario 19: Recovery rejects malicious journal containing path traversal (..) and fails closed", async () => {
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: playbookDir,
    });

    const maliciousJournal = {
      tx_id: "tx-traversal-attack",
      phase: "COMMITTING",
      created_at: new Date().toISOString(),
      action: "ATTACK",
      lock_nonce: "nonce-attack",
      files: [
        {
          target_path: "../../../escaped-target.txt",
          tmp_path: "../../../escaped-target.txt.tmp",
          bak_path: "../../../escaped-target.txt.bak",
          existed_before: false,
          expected_source_hash: null,
          expected_target_hash: computeSha256("malicious content\n"),
          target_content: "malicious content\n",
        },
      ],
    };

    fs.writeFileSync(journalPath, JSON.stringify(maliciousJournal, null, 2) + "\n", "utf-8");

    const outsidePath = path.resolve(tempDir, "..", "escaped-target.txt");
    assert.ok(!fs.existsSync(outsidePath), "External file must not exist beforehand");

    const recoveryManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      lockManager,
    });

    await assert.rejects(
      async () => {
        await lockManager.withLock(async (handle) => {
          await recoveryManager.recover(handle);
        });
      },
      (err: any) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "CRITICAL_RECOVERY_FAILURE");
        return true;
      }
    );

    // Assert malicious file was NOT written outside project
    assert.ok(!fs.existsSync(outsidePath), "Recovery must never write files outside project root");
    // Assert journal was strictly preserved on disk for triage
    assert.ok(fs.existsSync(journalPath), "Tampered journal must be preserved on disk for operator triage");
  });

  // 20. Recovery rejects absolute, Windows drive, or UNC paths (F-02)
  test("Scenario 20: Recovery rejects absolute, Windows drive, and UNC paths in journal", async () => {
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: playbookDir,
    });

    const testPaths = [
      process.platform === "win32" ? "C:\\evil\\target.txt" : "/tmp/evil/target.txt",
      "\\\\remote-share\\volume\\evil.txt",
      "//unc-share/volume/evil.txt",
    ];

    for (const badPath of testPaths) {
      const badJournal = {
        tx_id: "tx-bad-path",
        phase: "COMMITTING",
        created_at: new Date().toISOString(),
        action: "ATTACK",
        lock_nonce: "nonce-1",
        files: [
          {
            target_path: badPath,
            tmp_path: ".playbook/valid.tmp",
            bak_path: ".playbook/valid.bak",
            existed_before: false,
            expected_source_hash: null,
            expected_target_hash: computeSha256("payload"),
            target_content: "payload",
          },
        ],
      };

      fs.writeFileSync(journalPath, JSON.stringify(badJournal, null, 2) + "\n", "utf-8");

      const manager = new WriteAheadTransactionManager({ targetDir: tempDir, lockManager });

      await assert.rejects(
        async () => {
          await lockManager.withLock(async (handle) => {
            await manager.recover(handle);
          });
        },
        (err: any) => {
          assert.ok(err instanceof TransactionError);
          assert.equal(err.code, "CRITICAL_RECOVERY_FAILURE");
          return true;
        }
      );

      assert.ok(fs.existsSync(journalPath), "Journal preserved on failure");
    }
  });

  // 21. Recovery rejects malicious temporary or backup paths (F-02)
  test("Scenario 21: Recovery rejects malicious temporary and backup paths in journal", async () => {
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: playbookDir,
    });

    const badTmpJournal = {
      tx_id: "tx-bad-tmp",
      phase: "COMMITTING",
      created_at: new Date().toISOString(),
      action: "ATTACK",
      lock_nonce: "nonce-1",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: "../../outside.tmp",
          bak_path: ".playbook/valid.bak",
          existed_before: true,
          expected_source_hash: null,
          expected_target_hash: computeSha256("payload"),
          target_content: "payload",
        },
      ],
    };

    fs.writeFileSync(journalPath, JSON.stringify(badTmpJournal, null, 2) + "\n", "utf-8");

    const manager = new WriteAheadTransactionManager({ targetDir: tempDir, lockManager });

    await assert.rejects(
      async () => {
        await lockManager.withLock(async (handle) => {
          await manager.recover(handle);
        });
      },
      (err: any) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "CRITICAL_RECOVERY_FAILURE");
        return true;
      }
    );

    assert.ok(fs.existsSync(journalPath), "Journal preserved on failure");
  });

  // 22. Recovery rejects symlink escaping project boundary (F-02)
  test("Scenario 22: Path validation rejects symlinked parent directory or target escaping project boundary", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-outside-"));
    const symlinkDir = path.join(tempDir, "escaped_link");

    try {
      // Create junction/symlink directory pointing outside
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(outsideDir, symlinkDir, linkType);

      const lockManager = new TransactionLockManager({
        targetDir: tempDir,
        lockDir: playbookDir,
      });

      const symlinkJournal = {
        tx_id: "tx-symlink-escape",
        phase: "COMMITTING",
        created_at: new Date().toISOString(),
        action: "ATTACK",
        lock_nonce: "nonce-1",
        files: [
          {
            target_path: "escaped_link/target.txt",
            tmp_path: "escaped_link/target.txt.tmp",
            bak_path: "escaped_link/target.txt.bak",
            existed_before: false,
            expected_source_hash: null,
            expected_target_hash: computeSha256("payload"),
            target_content: "payload",
          },
        ],
      };

      fs.writeFileSync(journalPath, JSON.stringify(symlinkJournal, null, 2) + "\n", "utf-8");

      const manager = new WriteAheadTransactionManager({ targetDir: tempDir, lockManager });

      await assert.rejects(
        async () => {
          await lockManager.withLock(async (handle) => {
            await manager.recover(handle);
          });
        },
        (err: any) => {
          assert.ok(err instanceof TransactionError);
          assert.equal(err.code, "CRITICAL_RECOVERY_FAILURE");
          return true;
        }
      );

      assert.ok(fs.existsSync(journalPath), "Journal preserved");
    } finally {
      if (fs.existsSync(symlinkDir)) {
        try {
          fs.unlinkSync(symlinkDir);
        } catch {
          // ignore
        }
      }
      if (fs.existsSync(outsideDir)) {
        try {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });

  // 23. PREPARED rollback hash mismatch detection (F-03)
  test("Scenario 23: PREPARED rollback detects hash mismatch on restored target and fails closed", async () => {
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: playbookDir,
    });

    const originalContent = fs.readFileSync(statePath, "utf-8");
    const originalHash = computeSha256(originalContent);

    // Staged backup file contains corrupted content
    const corruptedBackupContent = "CORRUPTED BACKUP CONTENT\n";
    const bakPath = path.join(playbookDir, "state.json.bak.tx-corrupt-bak");
    fs.writeFileSync(bakPath, corruptedBackupContent, "utf-8");

    const preparedJournal = {
      tx_id: "tx-corrupt-bak",
      phase: "PREPARED",
      created_at: new Date().toISOString(),
      action: "ADVANCE_STAGE",
      lock_nonce: "nonce-1",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: ".playbook/state.json.tmp.tx-corrupt-bak",
          bak_path: ".playbook/state.json.bak.tx-corrupt-bak",
          existed_before: true,
          expected_source_hash: originalHash,
          expected_target_hash: computeSha256("new content"),
          target_content: "new content",
          original_content: originalContent,
        },
      ],
    };

    fs.writeFileSync(journalPath, JSON.stringify(preparedJournal, null, 2) + "\n", "utf-8");

    const manager = new WriteAheadTransactionManager({ targetDir: tempDir, lockManager });

    await assert.rejects(
      async () => {
        await lockManager.withLock(async (handle) => {
          await manager.recover(handle);
        });
      },
      (err: any) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "CRITICAL_RECOVERY_FAILURE");
        assert.ok(err.message.includes("PREPARED rollback verification failed"));
        return true;
      }
    );

    // Journal must be strictly preserved on disk for triage
    assert.ok(fs.existsSync(journalPath), "Journal preserved on hash mismatch");
  });

  // 24. External target modification between prepare and commit triggers EXTERNAL_TARGET_MODIFIED (F-05)
  test("Scenario 24: External target modification between prepare and commit triggers EXTERNAL_TARGET_MODIFIED", async () => {
    const manager = new WriteAheadTransactionManager({ targetDir: tempDir });

    const externalModifiedContent = JSON.stringify({ stage: 0, status: "externally_edited" }, null, 2) + "\n";

    await assert.rejects(
      async () => {
        await manager.withTransaction(
          "ADVANCE_STAGE",
          [{ targetPath: ".playbook/state.json", content: "new content\n" }],
          async () => {
            // External actor edits target file after prepare() but before commit()
            fs.writeFileSync(statePath, externalModifiedContent, "utf-8");
          }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXTERNAL_TARGET_MODIFIED");
        assert.equal(err.details?.targetPath, ".playbook/state.json");
        assert.equal(err.details?.reason, "hash_mismatch");
        return true;
      }
    );

    // Target must retain external modification, not overwritten by transaction
    assert.equal(fs.readFileSync(statePath, "utf-8"), externalModifiedContent);

    // Journal remains in PREPARED on disk, preserving backups
    assert.ok(fs.existsSync(journalPath), "Journal in PREPARED remains on disk");
    const insp = await manager.inspectJournal();
    assert.equal(insp.journal?.phase, "PREPARED");
  });

  // 25. External target deletion between prepare and commit triggers EXTERNAL_TARGET_MODIFIED (F-05)
  test("Scenario 25: External target deletion between prepare and commit triggers EXTERNAL_TARGET_MODIFIED", async () => {
    const manager = new WriteAheadTransactionManager({ targetDir: tempDir });

    await assert.rejects(
      async () => {
        await manager.withTransaction(
          "ADVANCE_STAGE",
          [{ targetPath: ".playbook/state.json", content: "new content\n" }],
          async () => {
            // External actor deletes target file after prepare() but before commit()
            fs.unlinkSync(statePath);
          }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXTERNAL_TARGET_MODIFIED");
        assert.equal(err.details?.targetPath, ".playbook/state.json");
        assert.equal(err.details?.reason, "file_deleted_externally");
        return true;
      }
    );

    // File was deleted externally and must not have been blindly recreated by commit
    assert.ok(!fs.existsSync(statePath));
  });

  // 26. Repeated recovery after failed validation fails closed deterministically (F-02)
  test("Scenario 26: Repeated recovery after failed validation fails closed deterministically", async () => {
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: playbookDir,
    });

    const malformedPathJournal = {
      tx_id: "tx-repeat-failure",
      phase: "COMMITTING",
      created_at: new Date().toISOString(),
      action: "ATTACK",
      lock_nonce: "nonce-1",
      files: [
        {
          target_path: "subdir/../../escaped.txt",
          tmp_path: ".playbook/test.tmp",
          bak_path: ".playbook/test.bak",
          existed_before: false,
          expected_source_hash: null,
          expected_target_hash: computeSha256("payload"),
          target_content: "payload",
        },
      ],
    };

    fs.writeFileSync(journalPath, JSON.stringify(malformedPathJournal, null, 2) + "\n", "utf-8");

    const manager = new WriteAheadTransactionManager({ targetDir: tempDir, lockManager });

    // Attempt 1: Fails closed
    await assert.rejects(
      async () => {
        await lockManager.withLock(async (handle) => {
          await manager.recover(handle);
        });
      },
      (err: any) => err instanceof TransactionError && err.code === "CRITICAL_RECOVERY_FAILURE"
    );
    assert.ok(fs.existsSync(journalPath));

    // Attempt 2: Re-running recovery still fails closed identically without side effects
    await assert.rejects(
      async () => {
        await lockManager.withLock(async (handle) => {
          await manager.recover(handle);
        });
      },
      (err: any) => err instanceof TransactionError && err.code === "CRITICAL_RECOVERY_FAILURE"
    );
    assert.ok(fs.existsSync(journalPath));
  });
});
