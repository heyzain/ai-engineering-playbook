import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { reopenLifecycle } from "../src/core/reopen.js";
import { checkGateEligibility } from "../src/core/approval.js";
import { DiagnosticsEngine } from "../src/core/diagnostics/engine.js";
import { inspectRawProject } from "../src/core/diagnostics/inspector.js";
import { WriteAheadTransactionManager, computeSha256 } from "../src/core/transaction/index.js";
import { TransactionLockManager } from "../src/core/lock/index.js";
import { DEFAULT_PATHS, STAGE_NAMES, type StageNumber } from "../src/constants.js";
import type { ProjectState } from "../src/types/state.js";
import type { ProjectManifest } from "../src/types/manifest.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");
const reopenWorkerPath = path.resolve(__dirname, "fixtures/reopen-worker.js");
const approvalWorkerPath = path.resolve(__dirname, "fixtures/approval-worker.js");

function createValidExitPackage(stage: number, stageName: string, deliverablesSummary: string): string {
  return `# Stage Gate Exit Package — Stage ${stage}: ${stageName}

## 1. Package & Stage Identification
This exit package formally documents all verified deliverables and supporting evidence for Stage ${stage} (${stageName}).
Active milestone: M-1.0.0. Project ID: test-service. All mandatory engineering invariants and gate criteria have been satisfied in full compliance with the constitution.

## 2. Deliverables Manifest & Status
The following deliverables have been produced, verified, and validated:
- ${deliverablesSummary}

## 3. Verifiable Validation Evidence
- Automated test logs and validation evidence recorded with SHA-256 verification hashes.
- 100% tests passing with zero failures.

## 4. Traceability & Sign-Off Record
- Traceability: All functional and non-functional requirements traced to verified deliverables.
- Residual Risk: Zero outstanding critical or high defects.
- Ready for formal human review.
`;
}

function bootstrapTerminalProject(tempDir: string, milestoneId = "M-1.0.0"): {
  statePath: string;
  manifestPath: string;
  snapshotPath: string;
} {
  const playbookDir = path.join(tempDir, ".playbook");
  const milestonesDir = path.join(playbookDir, "milestones");
  const docsDir = path.join(tempDir, "docs");
  const prdDir = path.join(docsDir, "prd");
  const gatesDir = path.join(docsDir, "gates");
  const logsDir = path.join(playbookDir, "logs");

  fs.mkdirSync(playbookDir, { recursive: true });
  fs.mkdirSync(milestonesDir, { recursive: true });
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(gatesDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  // Foundational PRD Core
  fs.writeFileSync(path.join(prdDir, "PRD-CORE.md"), "# PRD Core Problem Formulation\n", "utf-8");
  fs.writeFileSync(path.join(logsDir, "deploy.log"), "Deployment success verified\n", "utf-8");

  // Stage 6 Exit Package
  fs.writeFileSync(
    path.join(gatesDir, "GATE-6-EXIT-PACKAGE.md"),
    createValidExitPackage(6, STAGE_NAMES[6], "DEPLOY-LOG"),
    "utf-8"
  );

  const manifest: ProjectManifest = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    project_name: "Test Service",
    active_milestone_id: milestoneId,
    description: "Test service for lifecycle reopening",
    playbook: {
      version: "1.0.0",
      governance_profile: "strict",
      approval_mode: "solo",
    },
    tech_stack: {
      ecosystem: "node",
      primary_language: "typescript",
    },
    paths: {
      docs_root: "docs",
      prd_dir: "docs/prd",
      adr_dir: "docs/adr",
      rfc_dir: "docs/rfcs",
      gates_dir: "docs/gates",
      exceptions_dir: "docs/exceptions",
      state_file: ".playbook/state.json",
    },
    active_lifecycle_stage: 6,
    capabilities: ["automated_testing"],
  };

  const stageHistory = [];
  for (let s = 0; s <= 6; s++) {
    stageHistory.push({
      stage: s as StageNumber,
      stage_name: STAGE_NAMES[s as StageNumber],
      status: "approved" as const,
      started_at: "2026-10-31T10:00:00.000Z",
      completed_at: "2026-10-31T11:00:00.000Z",
      approved_at: "2026-10-31T11:00:00.000Z",
      exit_package_ref: `docs/gates/GATE-${s}-EXIT-PACKAGE.md`,
      human_approval: {
        approved_by: "Alice Human",
        role: "Lead Architect",
        approval_mode: "solo" as const,
        signature_reference: `Session-${s}`,
      },
    });
  }

  const state: ProjectState = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    playbook_version: "1.0.0",
    milestone_id: milestoneId,
    milestone_name: "MVP Production Release",
    lifecycle_status: "completed_terminal",
    current_stage: 6,
    stage_status: "approved",
    current_stage_detail: {
      stage: 6,
      stage_name: STAGE_NAMES[6],
      started_at: "2026-10-31T11:00:00.000Z",
      deliverables: [
        {
          id: "DEPLOY-LOG",
          name: "Deployment Execution & Monitoring Log",
          description: "Deployment execution steps and smoke tests.",
          artifact_path: "docs/ops/DEPLOYMENT-LOG.md",
          status: "verified",
          validation_status: "passed",
          exception_ref: null,
          evidence: [
            {
              requirement_id: null,
              type: "automated_test",
              procedure: "npm run deploy:verify",
              result: "passed",
              summary: "Deployment verified successfully",
              exit_code: 0,
              evidence_ref: ".playbook/logs/deploy.log",
              verified_at: "2026-10-31T11:00:00.000Z",
              verified_by: "agent:deployment-agent",
              actor_type: "agent",
              evidence_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            },
          ],
        },
      ],
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "submitted_for_review",
        path: "docs/gates/GATE-6-EXIT-PACKAGE.md",
        submitted_at: "2026-10-31T11:30:00.000Z",
      },
      human_approval: {
        status: "approved",
        approved_by: "Alice Human",
        role: "Lead Architect",
        approval_mode: "solo",
        decision: "GATE_APPROVED",
        signature_reference: "Session-6",
        approved_at: "2026-10-31T11:35:00.000Z",
        conditions: null,
      },
    },
    stage_history: stageHistory,
    archived_milestones: [],
    last_updated: {
      timestamp: "2026-10-31T11:35:00.000Z",
      updated_by: "playbook:orchestrator",
      actor_type: "human",
      reason: "Milestone sealed at Stage 6.",
    },
  };

  const statePath = path.join(tempDir, DEFAULT_PATHS.stateFile);
  const manifestPath = path.join(tempDir, DEFAULT_PATHS.manifestFile);
  const snapshotPath = path.join(milestonesDir, `state-${milestoneId}.json`);

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.writeFileSync(snapshotPath, JSON.stringify(state, null, 2) + "\n", "utf-8");

  return { statePath, manifestPath, snapshotPath };
}

describe("Controlled Lifecycle Reopening (REOPEN_LIFECYCLE)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-reopen-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore transient file lock
      }
    }
  });

  test("Scenario 1: Completed terminal project reopens successfully to Stage 1 (default)", async () => {
    const { statePath, manifestPath, snapshotPath } = bootstrapTerminalProject(tempDir);

    const res = await reopenLifecycle(tempDir, {
      milestoneId: "M-1.1.0",
      milestoneName: "Maintenance & Enhancements",
      targetStage: 1,
      reason: "Implement performance caching and fix bug 42",
      authorizedBy: "Alice Human",
      role: "Lead Architect",
    });

    assert.equal(res.success, true);
    assert.equal(res.previousMilestoneId, "M-1.0.0");
    assert.equal(res.newMilestoneId, "M-1.1.0");
    assert.equal(res.newStage, 1);
    assert.equal(res.archivedMilestonesCount, 1);

    // Validate updated state
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.lifecycle_status, "reopened_maintenance");
    assert.equal(state.milestone_id, "M-1.1.0");
    assert.equal(state.milestone_name, "Maintenance & Enhancements");
    assert.equal(state.current_stage, 1);
    assert.equal(state.stage_status, "not_started");
    assert.equal(state.stage_history.length, 0); // New milestone stage history reset to []

    // Validate archived milestones array
    assert.equal(state.archived_milestones.length, 1);
    assert.equal(state.archived_milestones[0].milestone_id, "M-1.0.0");
    assert.equal(state.archived_milestones[0].final_stage, 6);
    assert.equal(state.archived_milestones[0].stage_history.length, 7);
    assert.equal(state.archived_milestones[0].exit_package_ref, "docs/gates/GATE-6-EXIT-PACKAGE.md");

    // Validate new stage deliverables are fresh
    assert.equal(state.current_stage_detail.stage, 1);
    assert.equal(state.current_stage_detail.deliverables.length, 1);
    assert.equal(state.current_stage_detail.deliverables[0].id, "REQ-SPEC");
    assert.equal(state.current_stage_detail.deliverables[0].status, "not_started");
    assert.equal(state.current_stage_detail.deliverables[0].validation_status, "unvalidated");
    assert.equal(state.current_stage_detail.deliverables[0].evidence.length, 0);

    // Validate approval reset
    assert.equal(state.current_stage_detail.human_approval.status, "not_requested");
    assert.equal(state.current_stage_detail.human_approval.approved_by, null);

    // Validate manifest synchronization
    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.active_milestone_id, "M-1.1.0");
    assert.equal(manifest.active_lifecycle_stage, 1);

    // Validate prior snapshot remains intact
    assert.ok(fs.existsSync(snapshotPath));
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    assert.equal(snapshot.milestone_id, "M-1.0.0");
    assert.equal(snapshot.lifecycle_status, "completed_terminal");
  });

  test("Scenario 2: Explicit Stage 0 reopening for fundamental domain pivot", async () => {
    const { statePath, manifestPath } = bootstrapTerminalProject(tempDir);

    const res = await reopenLifecycle(tempDir, {
      milestoneId: "M-2.0.0",
      milestoneName: "Major Platform Pivot",
      targetStage: 0,
      reason: "Domain overhaul and new market formulation",
      authorizedBy: "Bob Architect",
      role: "VP Engineering",
    });

    assert.equal(res.success, true);
    assert.equal(res.newMilestoneId, "M-2.0.0");
    assert.equal(res.newStage, 0);

    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.current_stage, 0);
    assert.equal(state.current_stage_detail.stage, 0);
    assert.equal(state.current_stage_detail.deliverables[0].id, "PRD-CORE");

    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.active_lifecycle_stage, 0);
  });

  test("Scenario 3: Active, paused, or already reopened projects cannot be reopened", async () => {
    const { statePath } = bootstrapTerminalProject(tempDir);

    // Case A: Active project
    let state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.lifecycle_status = "active";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          reason: "Test",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "LIFECYCLE_NOT_TERMINAL");
        return true;
      }
    );

    // Case B: Paused project
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.lifecycle_status = "paused";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          reason: "Test",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "LIFECYCLE_NOT_TERMINAL");
        return true;
      }
    );

    // Case C: Already reopened project
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.lifecycle_status = "reopened_maintenance";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          reason: "Test",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "LIFECYCLE_ALREADY_REOPENED");
        return true;
      }
    );
  });

  test("Scenario 4: Milestone ID validations and collision defense", async () => {
    const { snapshotPath } = bootstrapTerminalProject(tempDir, "M-1.0.0");

    // Invalid milestone pattern
    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "v1.1.0", // missing M- prefix
          reason: "Test",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "INVALID_MILESTONE_ID");
        return true;
      }
    );

    // Collision with active milestone ID
    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.0.0", // Collides with current
          reason: "Test",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "MILESTONE_ID_COLLISION");
        return true;
      }
    );

    // Collision with existing snapshot on disk
    const collisionSnapshotPath = path.join(tempDir, ".playbook", "milestones", "state-M-1.2.0.json");
    fs.writeFileSync(collisionSnapshotPath, "{}\n", "utf-8");

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.2.0", // Snapshot file already exists
          reason: "Test",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "MILESTONE_ID_COLLISION");
        return true;
      }
    );
  });

  test("Scenario 5: Agent-like authorizer name is strictly prohibited", async () => {
    bootstrapTerminalProject(tempDir);

    const forbiddenNames = ["AI-Agent", "Bot-Reviewer", "Playbook-Controller", "Claude-Assistant", "gpt-4"];
    for (const badName of forbiddenNames) {
      await assert.rejects(
        async () => {
          await reopenLifecycle(tempDir, {
            milestoneId: "M-1.1.0",
            reason: "Maintenance",
            authorizedBy: badName,
            role: "Lead Architect",
          });
        },
        (err: { code?: string }) => {
          assert.equal(err.code, "AGENT_REOPEN_PROHIBITED");
          return true;
        }
      );
    }
  });

  test("Scenario 6: Missing prior milestone snapshot file blocks reopening", async () => {
    const { snapshotPath } = bootstrapTerminalProject(tempDir, "M-1.0.0");
    fs.unlinkSync(snapshotPath); // Remove snapshot

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          reason: "Maintenance",
          authorizedBy: "Alice Human",
          role: "Architect",
        });
      },
      (err: { code?: string }) => {
        assert.equal(err.code, "SNAPSHOT_MISSING");
        return true;
      }
    );
  });

  test("Scenario 7: CLI reopen requires interactive TTY; headless calls reject with TTY_REQUIRED", async () => {
    bootstrapTerminalProject(tempDir);

    // Real child process invocation without TTY
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          cliBinPath,
          "reopen",
          "--cwd",
          tempDir,
          "--milestone",
          "M-1.1.0",
          "--authorized-by",
          "Alice Human",
          "--role",
          "Lead Architect",
          "--reason",
          "Maintenance",
        ]);
      },
      (err: { code?: number; stderr?: string; stdout?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout || err.stderr || "", /TTY_REQUIRED/);
        return true;
      }
    );

    // Even with --json, non-TTY must reject
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          cliBinPath,
          "reopen",
          "--cwd",
          tempDir,
          "--json",
          "--milestone",
          "M-1.1.0",
        ]);
      },
      (err: { code?: number; stderr?: string; stdout?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout || err.stderr || "", /TTY_REQUIRED/);
        return true;
      }
    );
  });

  test("Scenario 8: Confirmation phrase mismatch aborts with zero mutations", async () => {
    const { statePath } = bootstrapTerminalProject(tempDir);

    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          reopenWorkerPath,
          "--cwd",
          tempDir,
          "--milestone",
          "M-1.1.0",
          "--authorized-by",
          "Alice Human",
          "--role",
          "Lead Architect",
          "--confirmation-phrase",
          "WRONG CONFIRMATION PHRASE",
        ]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /CONFIRMATION_PHRASE_MISMATCH/);
        return true;
      }
    );

    // State remains completely untouched
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.lifecycle_status, "completed_terminal");
    assert.equal(state.milestone_id, "M-1.0.0");
  });

  test("Scenario 9: Controlled worker execution with exact confirmation phrase reopens successfully", async () => {
    const { statePath, manifestPath } = bootstrapTerminalProject(tempDir);

    const workerRes = await execFileAsync("node", [
      reopenWorkerPath,
      "--cwd",
      tempDir,
      "--milestone",
      "M-1.1.0",
      "--name",
      "Q1 Maintenance",
      "--stage",
      "1",
      "--reason",
      "Bug fixes and performance caching",
      "--authorized-by",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM REOPEN MILESTONE M-1.1.0",
    ]);

    assert.equal(workerRes.stderr, "");
    assert.match(workerRes.stdout, /Lifecycle successfully reopened into maintenance mode/);

    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.lifecycle_status, "reopened_maintenance");
    assert.equal(state.milestone_id, "M-1.1.0");

    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.active_milestone_id, "M-1.1.0");
  });

  test("Scenario 10: Sidecar unlinked and lingering sidecar fails closed against new milestone", async () => {
    bootstrapTerminalProject(tempDir);

    // Create a mock sidecar on disk (from Gate 6)
    const sidecarPath = path.join(tempDir, DEFAULT_PATHS.approvalFingerprintFile);
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify(
        {
          schema_version: "1.0.0",
          gate: 6,
          milestone_id: "M-1.0.0",
          fingerprint: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
          approved_at: new Date().toISOString(),
          approved_by: "Alice Human",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    // Reopen lifecycle
    await reopenLifecycle(tempDir, {
      milestoneId: "M-1.1.0",
      reason: "Maintenance",
      authorizedBy: "Alice Human",
      role: "Architect",
    });

    // Sidecar is verified unlinked
    assert.equal(fs.existsSync(sidecarPath), false);

    // Simulate crash where an old sidecar was restored
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify(
        {
          schema_version: "1.0.0",
          gate: 6,
          milestone_id: "M-1.0.0",
          fingerprint: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
          approved_at: new Date().toISOString(),
          approved_by: "Alice Human",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    // Attempting playbook advance fails because stage_status is not_started
    await assert.rejects(
      async () => {
        await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /ADVANCEMENT_BLOCKED/);
        return true;
      }
    );
  });

  test("Scenario 11: Stage 1 inherited PRD-CORE prerequisite visibility & blocking check", async () => {
    bootstrapTerminalProject(tempDir);

    await reopenLifecycle(tempDir, {
      milestoneId: "M-1.1.0",
      targetStage: 1,
      reason: "Maintenance",
      authorizedBy: "Alice Human",
      role: "Architect",
    });

    // Case A: PRD-CORE.md exists -> Inspect shows info diagnostic
    const raw = inspectRawProject(tempDir);
    const engine = new DiagnosticsEngine();
    let report = engine.evaluate(raw);

    assert.ok(report.diagnostics.some((d) => d.code === "INHERITED_PREREQUISITE_ASSESSMENT"));

    // Case B: PRD-CORE.md missing -> CheckGateEligibility and Inspect fail
    const prdCorePath = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
    fs.unlinkSync(prdCorePath);

    report = engine.evaluate(inspectRawProject(tempDir));
    assert.ok(report.diagnostics.some((d) => d.code === "PRD_CORE_MISSING"));
    assert.equal(report.readiness.status, "blocked");

    const eligibility = checkGateEligibility(tempDir, 1);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.diagnostics.some((d) => d.code === "GATE_CRITERIA_UNMET" && d.path?.includes("PRD-CORE.md")));
  });

  test("Scenario 12: Lock contention during reopen throws LOCK_HELD_BY_ACTIVE_PROCESS", async () => {
    bootstrapTerminalProject(tempDir);

    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: path.join(tempDir, DEFAULT_PATHS.playbookDir),
    });

    // Acquire lock in this process
    const lockHandle = await lockManager.acquire({ timeoutMs: 1000 });

    try {
      await assert.rejects(
        async () => {
          await reopenLifecycle(tempDir, {
            milestoneId: "M-1.1.0",
            reason: "Maintenance",
            authorizedBy: "Alice Human",
            role: "Architect",
            lockTimeoutMs: 200,
          });
        },
        (err: { code?: string }) => {
          assert.ok(err.code === "LOCK_TIMEOUT" || err.code === "LOCK_HELD_BY_ACTIVE_PROCESS");
          return true;
        }
      );
    } finally {
      await lockHandle.release();
    }
  });

  test("Scenario 13: Multi-cycle lifecycle: M-1.0 -> M-1.1 -> Stage 6 close -> M-2.0", async () => {
    const { statePath, manifestPath } = bootstrapTerminalProject(tempDir, "M-1.0.0");

    // 1. Reopen M-1.1.0
    await reopenLifecycle(tempDir, {
      milestoneId: "M-1.1.0",
      milestoneName: "Maintenance 1.1",
      targetStage: 1,
      reason: "Feature enhancements",
      authorizedBy: "Alice Human",
      role: "Architect",
    });

    let state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.milestone_id, "M-1.1.0");
    assert.equal(state.archived_milestones.length, 1);

    // Fast-forward M-1.1.0 to Stage 6 terminal closure
    for (let s = 1; s <= 5; s++) {
      state.stage_history.push({
        stage: s as StageNumber,
        stage_name: STAGE_NAMES[s as StageNumber],
        status: "approved",
        started_at: "2026-11-01T10:00:00.000Z",
        completed_at: "2026-11-01T11:00:00.000Z",
        approved_at: "2026-11-01T11:00:00.000Z",
        exit_package_ref: `docs/gates/GATE-${s}-EXIT-PACKAGE.md`,
        human_approval: {
          approved_by: "Alice Human",
          role: "Lead Architect",
          approval_mode: "solo",
          signature_reference: `Session-${s}`,
        },
      });
    }

    state.current_stage = 6;
    state.stage_status = "pending_review";
    state.current_stage_detail = {
      stage: 6,
      stage_name: STAGE_NAMES[6],
      started_at: "2026-11-01T11:00:00.000Z",
      deliverables: [
        {
          id: "DEPLOY-LOG",
          name: "Deployment Execution & Monitoring Log",
          description: "Deployment execution steps.",
          artifact_path: "docs/ops/DEPLOYMENT-LOG.md",
          status: "verified",
          validation_status: "passed",
          exception_ref: null,
          evidence: [
            {
              requirement_id: null,
              type: "automated_test",
              procedure: "post-deploy",
              result: "passed",
              summary: "Deploy ok",
              exit_code: 0,
              evidence_ref: ".playbook/logs/stage-6.log",
              evidence_hash: computeSha256("deploy-log\n"),
              verified_at: new Date().toISOString(),
              verified_by: "human:Alice Human",
              actor_type: "human",
            },
          ],
        },
      ],
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "submitted_for_review",
        path: "docs/gates/GATE-6-EXIT-PACKAGE.md",
        submitted_at: new Date().toISOString(),
      },
      human_approval: {
        status: "pending_review",
        approved_by: null,
        role: null,
        approval_mode: "solo",
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    };

    const opsDir = path.join(tempDir, "docs", "ops");
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(path.join(opsDir, "DEPLOYMENT-LOG.md"), "# Deploy\n", "utf-8");
    fs.writeFileSync(path.join(tempDir, ".playbook", "logs", "stage-6.log"), "deploy-log\n", "utf-8");

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.active_lifecycle_stage = 6;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    // Approve Stage 6 of M-1.1.0
    await execFileAsync("node", [
      approvalWorkerPath,
      "--cwd",
      tempDir,
      "--gate",
      "6",
      "--reviewer",
      "Alice Human",
      "--role",
      "Lead Architect",
      "--confirmation-phrase",
      "CONFIRM APPROVAL GATE 6",
    ]);

    // Advance Stage 6 -> Executes CLOSE_LIFECYCLE on M-1.1.0!
    const advRes = await execFileAsync("node", [cliBinPath, "advance", "--cwd", tempDir, "--json"]);
    const advReport = JSON.parse(advRes.stdout);
    assert.equal(advReport.is_terminal_closed, true);

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.lifecycle_status, "completed_terminal");
    assert.equal(state.milestone_id, "M-1.1.0");

    // Snapshot for M-1.1.0 exists
    const snap11Path = path.join(tempDir, ".playbook", "milestones", "state-M-1.1.0.json");
    assert.ok(fs.existsSync(snap11Path));

    // 2. Reopen M-2.0.0
    await reopenLifecycle(tempDir, {
      milestoneId: "M-2.0.0",
      milestoneName: "Major Release 2.0",
      targetStage: 1,
      reason: "Next major evolution",
      authorizedBy: "Alice Human",
      role: "Chief Architect",
    });

    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.milestone_id, "M-2.0.0");
    assert.equal(state.lifecycle_status, "reopened_maintenance");

    // Archived milestones contains both M-1.0.0 and M-1.1.0!
    assert.equal(state.archived_milestones.length, 2);
    assert.equal(state.archived_milestones[0].milestone_id, "M-1.0.0");
    assert.equal(state.archived_milestones[1].milestone_id, "M-1.1.0");

    // Both snapshots exist on disk
    assert.ok(fs.existsSync(path.join(tempDir, ".playbook", "milestones", "state-M-1.0.0.json")));
    assert.ok(fs.existsSync(path.join(tempDir, ".playbook", "milestones", "state-M-1.1.0.json")));
  });

  test("Scenario 14: WAL crash recovery during PREPARED rolls back cleanly", async () => {
    const { statePath } = bootstrapTerminalProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterJournalPrepared: true, // Crash immediately after PREPARED
      },
    });

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          reason: "Maintenance",
          authorizedBy: "Alice Human",
          role: "Architect",
          txManager,
        });
      },
      (err: { message?: string }) => {
        assert.match(err.message || "", /Fault injection: crash after journal prepared/);
        return true;
      }
    );

    // Reopen was rolled back -> state remains completed_terminal at M-1.0.0
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: path.join(tempDir, DEFAULT_PATHS.playbookDir),
    });
    const lockHandle = await lockManager.acquire({ timeoutMs: 1000 });
    await recoveryManager.recover(lockHandle);
    await lockHandle.release();

    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.lifecycle_status, "completed_terminal");
    assert.equal(state.milestone_id, "M-1.0.0");
  });

  test("Scenario 15: WAL crash recovery during COMMITTING rolls forward cleanly", async () => {
    const { statePath, manifestPath } = bootstrapTerminalProject(tempDir);

    const txManager = new WriteAheadTransactionManager({
      targetDir: tempDir,
      faultInjection: {
        failAfterEnteringCommitting: true, // Crash immediately after COMMITTING
      },
    });

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          reason: "Maintenance",
          authorizedBy: "Alice Human",
          role: "Architect",
          txManager,
        });
      },
      (err: { message?: string }) => {
        assert.match(err.message || "", /Fault injection: crash after entering COMMITTING/);
        return true;
      }
    );

    // Roll forward via recovery
    const recoveryManager = new WriteAheadTransactionManager({ targetDir: tempDir });
    const lockManager = new TransactionLockManager({
      targetDir: tempDir,
      lockDir: path.join(tempDir, DEFAULT_PATHS.playbookDir),
    });
    const lockHandle = await lockManager.acquire({ timeoutMs: 1000 });
    const recRes = await recoveryManager.recover(lockHandle);
    await lockHandle.release();

    assert.equal(recRes.actionTaken, "rolled_forward");

    // State is completed to M-1.1.0
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.lifecycle_status, "reopened_maintenance");
    assert.equal(state.milestone_id, "M-1.1.0");

    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.active_milestone_id, "M-1.1.0");
  });
});
