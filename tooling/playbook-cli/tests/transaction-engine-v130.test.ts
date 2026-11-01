import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WriteAheadTransactionManager } from "../src/core/transaction/transaction-manager.js";
import { readJournal } from "../src/core/transaction/journal.js";
import { computeSha256 } from "../src/core/transaction/fs-utils.js";
import { TransactionError } from "../src/core/transaction/types.js";
import { ProjectScaffolder } from "../src/core/scaffold.js";
import { createInitialManifest } from "../src/templates/manifest-template.js";
import { createInitialState } from "../src/templates/state-template.js";
import { DEFAULT_PATHS } from "../src/constants.js";

describe("WriteAheadTransactionManager v1.3.0 Engine & Storage Upgrades", () => {
  let tempDir: string;
  let playbookDir: string;
  let journalPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-tx-v130-"));
    playbookDir = path.join(tempDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });
    journalPath = path.join(playbookDir, "tx-journal.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      // Ensure all files are writable so rmSync succeeds on Windows
      try {
        const makeWritable = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              makeWritable(fullPath);
            } else {
              try { fs.chmodSync(fullPath, 0o666); } catch {}
            }
          }
        };
        makeWritable(tempDir);
      } catch {}
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("Invariant 1: Journal-first staging writes PREPARING journal before staging .tmp files", async () => {
    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      journalPath,
      faultInjection: {
        failAfterJournalPreparing: true,
      },
    });

    const targetFile = "docs/test.txt";

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_JOURNAL_FIRST", [
          { targetPath: targetFile, content: "hello world" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_PREPARATION_FAILED");
        return true;
      }
    );

    // Assert journal exists and is in PREPARING phase
    const journalState = readJournal(journalPath);
    assert.equal(journalState.exists, true);
    assert.equal(journalState.isCorrupted, false);
    assert.equal(journalState.journal?.phase, "PREPARING");

    // Assert NO .tmp staging files exist on disk
    const stagedTmpFile = path.join(tempDir, `${targetFile}.tmp.${journalState.journal?.tx_id}`);
    assert.equal(fs.existsSync(stagedTmpFile), false);
    assert.equal(fs.existsSync(path.join(tempDir, targetFile)), false);

    // Test rollback recovery from PREPARING phase
    const recoveringManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });
    const recoveryResult = await recoveringManager.lockManager.withLock(async (handle) => {
      return await recoveringManager.recover(handle);
    });

    assert.equal(recoveryResult.recovered, true);
    assert.equal(recoveryResult.actionTaken, "rolled_back");
    assert.equal(recoveryResult.originalPhase, "PREPARING");
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(path.join(tempDir, targetFile)), false);
  });

  test("Invariant 2: Crash after staging before PREPARED rolls back cleanly", async () => {
    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      journalPath,
      faultInjection: {
        failAfterStagingBeforePrepared: true,
      },
    });

    const targetFile = "docs/sample.txt";

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_STAGING_CRASH", [
          { targetPath: targetFile, content: "staged content" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_PREPARATION_FAILED");
        return true;
      }
    );

    const journalState = readJournal(journalPath);
    assert.equal(journalState.journal?.phase, "PREPARING");
    const tmpPath = path.join(tempDir, `${targetFile}.tmp.${journalState.journal?.tx_id}`);
    assert.equal(fs.existsSync(tmpPath), true); // staging file was created

    // Recover
    const recoveringManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });
    const recovery = await recoveringManager.lockManager.withLock(async (handle) => {
      return await recoveringManager.recover(handle);
    });

    assert.equal(recovery.recovered, true);
    assert.equal(recovery.actionTaken, "rolled_back");
    assert.equal(fs.existsSync(tmpPath), false);
    assert.equal(fs.existsSync(journalPath), false);
  });

  test("Invariant 3: createOnly prevents overwriting existing targets", async () => {
    const existingFile = "docs/snapshot.json";
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, existingFile), '{"pre": true}', "utf-8");

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_CREATE_ONLY", [
          {
            operation: "write",
            targetPath: existingFile,
            content: '{"new": true}',
            createOnly: true,
          },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TARGET_ALREADY_EXISTS");
        return true;
      }
    );

    // Existing file must be unaltered
    assert.equal(fs.readFileSync(path.join(tempDir, existingFile), "utf-8"), '{"pre": true}');
  });

  test("Invariant 4: expectedPreviousSha256 validates source hash prior to mutation", async () => {
    const stateFile = ".playbook/state.json";
    fs.writeFileSync(path.join(tempDir, stateFile), '{"stage": 1}', "utf-8");
    const actualHash = computeSha256('{"stage": 1}');
    const wrongHash = computeSha256('{"stage": 0}');

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });

    // Mismatched expected hash rejects with EXTERNAL_TARGET_MODIFIED
    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_HASH_MISMATCH", [
          {
            targetPath: stateFile,
            content: '{"stage": 0}',
            expectedPreviousSha256: wrongHash,
          },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "EXTERNAL_TARGET_MODIFIED");
        return true;
      }
    );

    // Matching hash succeeds
    await txManager.executeTransaction("TEST_HASH_MATCH", [
      {
        targetPath: stateFile,
        content: '{"stage": 0}',
        expectedPreviousSha256: actualHash,
      },
    ]);

    assert.equal(fs.readFileSync(path.join(tempDir, stateFile), "utf-8"), '{"stage": 0}');
  });

  test("Invariant 5: readOnlyOnCommit applies read-only permissions on target file", async () => {
    const snapshotFile = ".playbook/pivots/state-PVT-001.json";
    fs.mkdirSync(path.join(tempDir, ".playbook/pivots"), { recursive: true });

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });

    await txManager.executeTransaction("TEST_READ_ONLY", [
      {
        targetPath: snapshotFile,
        content: '{"snapshot": "preserved"}',
        readOnlyOnCommit: true,
      },
    ]);

    const absPath = path.join(tempDir, snapshotFile);
    assert.ok(fs.existsSync(absPath));

    // Verify file content
    assert.equal(fs.readFileSync(absPath, "utf-8"), '{"snapshot": "preserved"}');

    // On Windows or POSIX, verify write restriction
    if (process.platform !== "win32") {
      const stat = fs.statSync(absPath);
      // Mode 0o444 corresponds to octal 444
      assert.equal(stat.mode & 0o777, 0o444);
    }
  });

  test("Invariant 6: FileUnlinkSpec safely deletes existing file and supports safe no-ops", async () => {
    const prdPath = "docs/prd/PRD-CORE.md";
    fs.mkdirSync(path.join(tempDir, "docs/prd"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, prdPath), "# Outdated PRD", "utf-8");
    const prdHash = computeSha256("# Outdated PRD");

    const txManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });

    // Test unlinking existing file with matching expected hash + optional absent file with mustExist: false
    await txManager.executeTransaction("TEST_UNLINK", [
      {
        operation: "unlink",
        targetPath: prdPath,
        expectedSha256: prdHash,
      },
      {
        operation: "unlink",
        targetPath: ".playbook/approval-fingerprint.json",
        mustExist: false,
      },
    ]);

    assert.equal(fs.existsSync(path.join(tempDir, prdPath)), false);
    assert.equal(fs.existsSync(path.join(tempDir, ".playbook/approval-fingerprint.json")), false);
  });

  test("Invariant 7: Missing staged .tmp during COMMITTING is reconstructed from durable journal content", async () => {
    const targetFile = "docs/reconstructed.md";
    const expectedContent = "# Reconstructed Content";

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      journalPath,
      faultInjection: {
        failAfterEnteringCommitting: true,
      },
    });

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_CRASH_COMMITTING", [
          { targetPath: targetFile, content: expectedContent },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_COMMIT_FAILED");
        return true;
      }
    );

    const journalState = readJournal(journalPath);
    assert.equal(journalState.journal?.phase, "COMMITTING");
    const tmpPath = path.join(tempDir, `${targetFile}.tmp.${journalState.journal?.tx_id}`);

    // Simulate loss of the temporary file prior to recovery roll-forward
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
    assert.equal(fs.existsSync(tmpPath), false);

    // Recover: should reconstruct .tmp from journal target_content and roll forward
    const recoveringManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });
    const recovery = await recoveringManager.lockManager.withLock(async (handle) => {
      return await recoveringManager.recover(handle);
    });

    assert.equal(recovery.recovered, true);
    assert.equal(recovery.actionTaken, "rolled_forward");
    assert.equal(recovery.originalPhase, "COMMITTING");
    assert.equal(fs.existsSync(path.join(tempDir, targetFile)), true);
    assert.equal(fs.readFileSync(path.join(tempDir, targetFile), "utf-8"), expectedContent);
    assert.equal(fs.existsSync(journalPath), false);
  });

  test("Invariant 8: Crash during unlink in COMMITTING rolls forward to ensure unlink completes", async () => {
    const targetFile = "docs/to-unlink.txt";
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, targetFile), "delete me", "utf-8");

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      journalPath,
      faultInjection: {
        failDuringUnlinkCommit: true,
      },
    });

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_UNLINK_CRASH", [
          { operation: "unlink", targetPath: targetFile, mustExist: true },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_COMMIT_FAILED");
        return true;
      }
    );

    const journalState = readJournal(journalPath);
    assert.equal(journalState.journal?.phase, "COMMITTING");

    // Recover
    const recoveringManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });
    const recovery = await recoveringManager.lockManager.withLock(async (handle) => {
      return await recoveringManager.recover(handle);
    });

    assert.equal(recovery.recovered, true);
    assert.equal(recovery.actionTaken, "rolled_forward");
    assert.equal(fs.existsSync(path.join(tempDir, targetFile)), false);
    assert.equal(fs.existsSync(journalPath), false);
  });

  test("Invariant 9: Create-only collision during COMMITTING recovery fails closed with TRANSACTION_RECOVERY_REQUIRED", async () => {
    const collisionTarget = "docs/collision.txt";

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      journalPath,
      faultInjection: {
        failAfterEnteringCommitting: true,
      },
    });

    await assert.rejects(
      async () => {
        await txManager.executeTransaction("TEST_COLLISION_SETUP", [
          {
            operation: "write",
            targetPath: collisionTarget,
            content: "intended content",
            createOnly: true,
          },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Simulate an unexpected collision on disk before recovery runs
    fs.writeFileSync(path.join(tempDir, collisionTarget), "rogue unexpected content", "utf-8");

    // Recover should fail closed without destroying the unexpected artifact
    const recoveringManager = new WriteAheadTransactionManager({ targetDir: tempDir, journalPath });
    await assert.rejects(
      async () => {
        await recoveringManager.lockManager.withLock(async (handle) => {
          return await recoveringManager.recover(handle);
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "TRANSACTION_RECOVERY_REQUIRED");
        return true;
      }
    );

    // Verify unexpected content is preserved and journal remains for manual triage
    assert.equal(fs.readFileSync(path.join(tempDir, collisionTarget), "utf-8"), "rogue unexpected content");
    assert.equal(fs.existsSync(journalPath), true);
  });

  test("Storage Scaffolding: ProjectScaffolder provisions pivots and prd/archive layout", () => {
    const scaffolder = new ProjectScaffolder();
    const manifest = createInitialManifest({
      projectId: "scaffold-app",
      projectName: "Scaffold App",
    });
    const state = createInitialState({ projectId: "scaffold-app" });

    scaffolder.scaffold({
      targetDir: tempDir,
      manifest,
      state,
      createGitkeeps: true,
    });

    // Check newly provisioned directories
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir)));
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.prdArchiveDir)));
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.docsPivotsDir)));

    // Check .gitkeep files exist
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir, ".gitkeep")));
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.prdArchiveDir, ".gitkeep")));
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.docsPivotsDir, ".gitkeep")));
  });

  test("Storage Scaffolding: ensureStorageLayout non-destructively provisions layout on existing projects", () => {
    const scaffolder = new ProjectScaffolder();
    const manifest = createInitialManifest({
      projectId: "existing-app",
      projectName: "Existing App",
    });
    const state = createInitialState({ projectId: "existing-app" });

    // Initial scaffold
    scaffolder.scaffold({
      targetDir: tempDir,
      manifest,
      state,
    });

    // Remove one of the new directories to simulate an older layout
    fs.rmSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir), { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir)), false);

    // Run ensureStorageLayout
    const result = scaffolder.ensureStorageLayout(tempDir, true);
    assert.ok(result.createdDirs.some((d) => d.includes(path.normalize(DEFAULT_PATHS.pivotsDir))));
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir)));
    assert.ok(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.pivotsDir, ".gitkeep")));
  });
});
