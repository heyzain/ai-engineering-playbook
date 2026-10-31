import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { advanceStage } from "../src/core/advancement.js";
import { runAdvance } from "../src/commands/advance.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  writeJournalDurable,
  computeSha256,
} from "../src/core/transaction/index.js";
import {
  TransactionLockManager,
  serializeLockMetadata,
} from "../src/core/lock/index.js";
import { DEFAULT_PATHS, STAGE_NAMES } from "../src/constants.js";
import type { ProjectState } from "../src/types/state.js";
import type { ProjectManifest } from "../src/types/manifest.js";

describe("Lifecycle Advancement Engine & CLI (playbook advance)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-advance-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore potential transient Windows file lock
      }
    }
  });

  // Scenario 11: Successful stage advancement
  test("Scenario 11: Successful stage advancement from Stage 0 to Stage 1 archives history, syncs manifest, and preserves sidecar", async () => {
    const { sidecarPath } = setupStageProject(tempDir, { stage: 0, status: "approved" });
    assert.ok(fs.existsSync(sidecarPath));

    const res = await advanceStage(tempDir);

    assert.equal(res.success, true);
    assert.equal(res.previousStage, 0);
    assert.equal(res.newStage, 1);
    assert.equal(res.isTerminalClosed, false);
    assert.ok(res.txId?.startsWith("tx-"));

    // Check state.json
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.current_stage, 1);
    assert.equal(state.stage_status, "not_started");
    assert.equal(state.stage_history.length, 1);
    assert.equal(state.stage_history[0].stage, 0);
    assert.equal(state.stage_history[0].status, "approved");
    assert.equal(state.stage_history[0].human_approval.approved_by, "Alice Engineer");
    assert.equal(state.current_stage_detail.stage, 1);
    assert.equal(state.current_stage_detail.stage_name, STAGE_NAMES[1]);
    assert.ok(state.current_stage_detail.deliverables.length > 0);

    // Check manifest.json
    const manifest: ProjectManifest = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.manifestFile), "utf-8")
    );
    assert.equal(manifest.active_lifecycle_stage, 1);

    // Check approval sidecar is preserved
    assert.ok(fs.existsSync(sidecarPath));
  });

  // Scenario 12: Manifest/state synchronization
  test("Scenario 12: Manifest and state remain strictly synchronized, detecting prior stage drift", async () => {
    const { manifestPath } = setupStageProject(tempDir, { stage: 0, status: "approved" });

    // Simulate manifest drift where manifest is at stage 2 while state is at 0
    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.active_lifecycle_stage = 2 as any;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await advanceStage(tempDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "MANIFEST_STAGE_DRIFT");
        return true;
      }
    );

    // Realign manifest and advance via runAdvance command
    manifest.active_lifecycle_stage = 0;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    const cliRes = await runAdvance({ cwd: tempDir, json: true });
    assert.equal(cliRes.success, true);
    assert.equal(cliRes.previousStage, 0);
    assert.equal(cliRes.newStage, 1);

    const manifestAfter: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const stateAfter: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(manifestAfter.active_lifecycle_stage, stateAfter.current_stage);
    assert.equal(manifestAfter.active_lifecycle_stage, 1);
  });

  // Scenario 13: Stale fingerprint detection
  test("Scenario 13: Modification to state deliverable invalidates approval fingerprint with APPROVAL_STALE", async () => {
    const { statePath } = setupStageProject(tempDir, { stage: 0, status: "approved" });

    // Modify a deliverable in state.json after approval
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current_stage_detail.deliverables[0].name = "Tampered Deliverable Name";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await advanceStage(tempDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "APPROVAL_STALE");
        return true;
      }
    );

    // Ensure state remained at Stage 0
    const stateAfter: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(stateAfter.current_stage, 0);
  });

  // Scenario 14: Stale approval after evidence modification
  test("Scenario 14: Out-of-band disk evidence modification invalidates fingerprint with APPROVAL_STALE", async () => {
    const { evidencePath, statePath } = setupStageProject(tempDir, { stage: 0, status: "approved" });

    // State is NOT touched; only the evidence file on disk is modified
    fs.appendFileSync(evidencePath, "Extra trailing test log data from rogue run.\n", "utf-8");

    await assert.rejects(
      async () => {
        await advanceStage(tempDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "APPROVAL_STALE");
        return true;
      }
    );

    // Verify stage remained at Stage 0
    const stateAfter: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(stateAfter.current_stage, 0);
  });

  // Scenario 15: Stage 6 lifecycle closure
  test("Scenario 15: Advancing approved Stage 6 executes CLOSE_LIFECYCLE, severs advancement, and writes milestone snapshot", async () => {
    setupStageProject(tempDir, { stage: 6, status: "approved", milestoneId: "M-1.0.0" });

    const res = await advanceStage(tempDir);

    assert.equal(res.success, true);
    assert.equal(res.previousStage, 6);
    assert.equal(res.newStage, 6);
    assert.equal(res.isTerminalClosed, true);
    assert.ok(res.milestoneSnapshotPath?.includes("state-M-1.0.0.json"));

    // Check state.json
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.lifecycle_status, "completed_terminal");
    assert.equal(state.current_stage, 6);
    assert.equal(state.stage_status, "approved");
    assert.equal(state.stage_history.length, 1);
    assert.equal(state.stage_history[0].stage, 6);

    // Check manifest.json
    const manifest: ProjectManifest = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.manifestFile), "utf-8")
    );
    assert.equal(manifest.active_lifecycle_stage, 6);

    // Check milestone snapshot file
    const snapshotAbsPath = path.resolve(tempDir, res.milestoneSnapshotPath!);
    assert.ok(fs.existsSync(snapshotAbsPath));
    const snapshot: ProjectState = JSON.parse(fs.readFileSync(snapshotAbsPath, "utf-8"));
    assert.equal(snapshot.lifecycle_status, "completed_terminal");
    assert.equal(snapshot.current_stage, 6);
    assert.equal(snapshot.milestone_id, "M-1.0.0");
  });

  // Scenario 16: No Stage 7 creation
  test("Scenario 16: Advance on Stage 6 never creates Stage 7; repeated advance throws ADVANCEMENT_BLOCKED", async () => {
    setupStageProject(tempDir, { stage: 6, status: "approved" });

    // First advance: closes lifecycle
    const res = await advanceStage(tempDir);
    assert.equal(res.newStage, 6);
    assert.equal(res.isTerminalClosed, true);

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.current_stage, 6);
    assert.notEqual(state.current_stage as any, 7);

    // Attempting to advance again must fail closed
    await assert.rejects(
      async () => {
        await advanceStage(tempDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        assert.equal(err.code, "ADVANCEMENT_BLOCKED");
        return true;
      }
    );
  });

  // Scenario 17: Crash recovery during advancement
  test("Scenario 17: Crash during COMMITTING phase of stage advancement rolls forward cleanly on recovery", async () => {
    setupStageProject(tempDir, { stage: 0, status: "approved" });

    const crashingTxManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failBetweenTargetWrites: true,
      },
    });

    await assert.rejects(
      async () => {
        await advanceStage(tempDir, { txManager: crashingTxManager });
      },
      (err: unknown) => {
        assert.ok(err instanceof TransactionError);
        return true;
      }
    );

    // Journal should be in COMMITTING phase on disk
    const journalPath = path.join(tempDir, DEFAULT_PATHS.transactionJournalFile);
    assert.ok(fs.existsSync(journalPath));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    assert.equal(journal.phase, "COMMITTING");
    assert.equal(journal.action, "ADVANCE_STAGE");

    // Clean recovery manager recovers transaction
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lock = await recoveryManager.lockManager.acquire();
    const recResult = await recoveryManager.recover(lock);
    await lock.release();

    assert.equal(recResult.recovered, true);
    assert.equal(recResult.actionTaken, "rolled_forward");

    // Both state.json and manifest.json are rolled forward to Stage 1
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    const manifest: ProjectManifest = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.manifestFile), "utf-8")
    );
    assert.equal(state.current_stage, 1);
    assert.equal(manifest.active_lifecycle_stage, 1);
    assert.ok(!fs.existsSync(journalPath));
  });

  // Scenario 18: WAL lock and recovery integration
  test("Scenario 18: Orphaned lock and journal from dead process are recovered before new operation executes", async () => {
    setupStageProject(tempDir, { stage: 0, status: "approved" });

    const playbookDir = path.join(tempDir, ".playbook");
    const lockPath = path.join(playbookDir, "transaction.lock");
    const journalPath = path.join(tempDir, DEFAULT_PATHS.transactionJournalFile);

    // Simulate an abandoned PREPARED transaction from a dead process
    const deadPid = 9999999;
    const deadNonce = "dead-process-nonce-1234";
    const lockMeta = serializeLockMetadata({
      pid: deadPid,
      hostname: os.hostname(),
      nonce: deadNonce,
      created_at: new Date(Date.now() - 60000).toISOString(),
    });
    fs.writeFileSync(lockPath, lockMeta, "utf-8");

    const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
    const stateContent = fs.readFileSync(statePath, "utf-8");
    const stateHash = computeSha256(stateContent);

    const abandonedJournal = {
      tx_id: "tx-dead-process-1",
      lock_nonce: deadNonce,
      phase: "PREPARED" as const,
      created_at: new Date(Date.now() - 60000).toISOString(),
      action: "SAMPLE_TX",
      files: [
        {
          target_path: ".playbook/state.json",
          tmp_path: ".playbook/state.json.tmp",
          bak_path: ".playbook/state.json.bak",
          existed_before: true,
          expected_source_hash: stateHash,
          expected_target_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          target_content: '{"dummy": true}',
          original_content: stateContent,
        },
      ],
    };
    writeJournalDurable(journalPath, abandonedJournal);

    // Mock liveness checker to confirm dead PID
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      livenessChecker: (pid) => ({
        isAlive: false,
        isVerifiedDead: true,
        reason: "Dead PID simulation",
        pid,
      }),
    });

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      lockManager,
    });

    // Now invoke advanceStage with this txManager
    const res = await advanceStage(tempDir, { txManager });

    assert.equal(res.success, true);
    assert.equal(res.newStage, 1);

    // Old lock and journal are gone, state is advanced to 1
    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.equal(state.current_stage, 1);
    assert.ok(!fs.existsSync(journalPath));
  });
});
