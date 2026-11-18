import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { QualityGateRunner, scrubSecrets, truncateLogIfNeeded } from "../src/core/quality-gates/runner.js";
import { QualityGateVerifier } from "../src/core/quality-gates/verifier.js";
import { reapStagingFiles } from "../src/core/quality-gates/reaper.js";
import { runGateList, runGateRun, runGateVerify } from "../src/commands/gate.js";
import { DEFAULT_PATHS } from "../src/constants.js";

describe("Quality Gates Execution Pipeline & Transaction Durability", () => {
  let tmpDir: string;
  let playbookDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-qg-test-"));
    playbookDir = path.join(tmpDir, DEFAULT_PATHS.playbookDir);
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "docs/prd"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs/prd/PRD-CORE.md"), "# PRD Core\n\nProblem statement.\n", "utf-8");

    // Initialize minimal valid manifest.json
    const manifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      project_id: "test-app",
      project_name: "Test Application",
      active_milestone_id: "M-1.0.0",
      playbook: {
        version: "1.0.0",
        governance_profile: "standard",
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
        exceptions_dir: "governance/exceptions",
        state_file: ".playbook/state.json",
      },
      active_lifecycle_stage: 0,
      capabilities: [],
    };
    fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    // Initialize minimal valid state.json
    const state = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
      schema_version: "1.1.0",
      transaction_sequence: 0,
      audit_trail: [],
      project_id: "test-app",
      playbook_version: "1.0.0",
      milestone_id: "M-1.0.0",
      milestone_name: "Initial Release",
      lifecycle_status: "active",
      current_stage: 0,
      stage_status: "in_progress",
      current_stage_detail: {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        started_at: "2026-11-02T12:00:00.000Z",
        deliverables: [
          {
            id: "PRD-CORE",
            name: "Problem Statement Document (PRD Core)",
            artifact_path: "docs/prd/PRD-CORE.md",
            status: "in_progress",
            validation_status: "unvalidated",
            exception_ref: null,
            evidence: [],
          },
        ],
        rfcs: [],
        adrs: [],
        exceptions: [],
        exit_package: {
          status: "not_drafted",
          path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        },
        human_approval: {
          status: "not_requested",
          approved_by: null,
          role: null,
          approval_mode: null,
          decision: null,
          signature_reference: null,
          approved_at: null,
          conditions: null,
        },
      },
      stage_history: [],
      archived_milestones: [],
      last_updated: {
        timestamp: "2026-11-02T12:00:00.000Z",
        updated_by: "agent:test",
        actor_type: "agent",
        reason: "Test setup",
      },
    };
    fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");

    // Initialize valid quality-gates.json
    const qgConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "test-app",
      default_profile: "standard",
      global_settings: {
        default_timeout_ms: 30000,
        max_concurrency: 2,
        mask_secrets: true,
        log_retention_runs: 5,
        max_journaled_log_bytes: 1048576,
        env_allowlist: ["NODE_ENV", "PATH"],
      },
      gates: [
        {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          checks: [
            {
              id: "prd-check",
              name: "PRD Syntax & Spec Check",
              type: "static_analysis",
              deliverable_id: "PRD-CORE",
              command: "node",
              args: ["-e", "console.log('PRD specification verified'); process.exit(0);"],
              inputs: ["docs/prd/**/*.md"],
            },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows
    }
  });

  test("runs successful check, creates canonical log, and atomically registers verified evidence in state.json", async () => {
    const runner = new QualityGateRunner(tmpDir);
    const report = await runner.run();

    assert.equal(report.overall_outcome, "passed");
    assert.equal(report.summary.passed, 1);
    assert.equal(report.summary.failed, 0);

    const checkRes = report.checks[0];
    assert.equal(checkRes.outcome, "passed");
    assert.equal(checkRes.exit_code, 0);
    assert.ok(checkRes.canonical_log_path.startsWith(".playbook/logs/gate-stage-0-prd-check-"));

    // Verify canonical log exists on disk and contains expected header and output
    const logAbsolute = path.join(tmpDir, checkRes.canonical_log_path);
    assert.ok(fs.existsSync(logAbsolute));
    const logContent = fs.readFileSync(logAbsolute, "utf-8");
    assert.ok(logContent.includes("=== PLAYBOOK QUALITY-GATE EXECUTION LOG ==="));
    assert.ok(logContent.includes("PRD specification verified"));
    assert.ok(logContent.includes("=== EXECUTION RESULT ==="));
    assert.ok(logContent.includes("Outcome:         PASSED"));

    // Verify non-circular SHA-256 hash
    const expectedHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(logContent, "utf-8")).digest("hex")}`;
    assert.equal(checkRes.canonical_log_sha256, expectedHash);

    // Verify state.json was updated atomically
    const stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    const updatedState = JSON.parse(stateRaw);
    const deliverable = updatedState.current_stage_detail.deliverables[0];

    assert.equal(deliverable.status, "verified");
    assert.equal(deliverable.validation_status, "passed");
    assert.equal(deliverable.evidence.length, 1);

    const ev = deliverable.evidence[0];
    assert.equal(ev.result, "passed");
    assert.equal(ev.evidence_hash, expectedHash);
    assert.equal(ev.evidence_ref, checkRes.canonical_log_path);
    assert.equal(ev.rif, checkRes.rif);
    assert.equal(ev.actor_type, "agent");
    assert.equal(ev.verified_by, "agent:quality-gate-engine");

    // Verify read-only verifier confirms freshness
    const verifier = new QualityGateVerifier(tmpDir);
    const verifyReport = verifier.verify();
    assert.equal(verifyReport.all_fresh, true);
    assert.equal(verifyReport.checks[0].is_fresh, true);
  });

  test("runs failing blocking check, transitions deliverable to in_progress, and reports failure", async () => {
    // Update check to fail
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    qgConfig.gates[0].checks[0].args = ["-e", "console.error('Syntax error in PRD'); process.exit(1);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);
    const report = await runner.run();

    assert.equal(report.overall_outcome, "failed");
    assert.equal(report.summary.passed, 0);
    assert.equal(report.summary.failed, 1);

    const stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    const updatedState = JSON.parse(stateRaw);
    const deliverable = updatedState.current_stage_detail.deliverables[0];

    assert.equal(deliverable.status, "in_progress");
    assert.equal(deliverable.validation_status, "failed");
    assert.equal(deliverable.evidence.length, 1);
    assert.equal(deliverable.evidence[0].result, "failed");
  });

  test("secret scrubbing masks common token formats from output streams", () => {
    const rawOutput = "Authentication token: ghp_123456789012345678901234567890123456 and sk-abcdef1234567890abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const scrubbed = scrubSecrets(rawOutput);

    assert.ok(!scrubbed.includes("ghp_123456789012345678901234567890123456"));
    assert.ok(!scrubbed.includes("sk-abcdef1234567890abcdef1234567890"));
    assert.ok(scrubbed.includes("ghp_***[REDACTED]"));
    assert.ok(scrubbed.includes("sk-***[REDACTED]"));
  });

  test("log middle-truncation preserves head and tail on oversized logs", () => {
    const huge = "A".repeat(1000) + "B".repeat(2000) + "C".repeat(1000);
    const { content, truncated } = truncateLogIfNeeded(huge, 1000);

    assert.equal(truncated, true);
    assert.ok(content.startsWith("A"));
    assert.ok(content.endsWith("C"));
    assert.ok(content.includes("[MIDDLE TRUNCATED:"));
  });

  test("staging reaper conservatively retains unverified or orphaned logs (Crash Window A)", async () => {
    const tmpStagingDir = path.join(playbookDir, ".tmp");
    fs.mkdirSync(tmpStagingDir, { recursive: true });

    // Crash Window A: .log exists without .meta.json
    const orphanedLog = path.join(tmpStagingDir, "proc-99999-orphan.log");
    fs.writeFileSync(orphanedLog, "some log output", "utf-8");

    const reapRes = await reapStagingFiles(tmpDir);
    assert.equal(reapRes.reapedFiles.length, 0);
    assert.ok(reapRes.retainedFiles.some((f) => f.file === "proc-99999-orphan.log"));
    assert.ok(fs.existsSync(orphanedLog)); // Preserved!
  });

  test("CLI commands gate list, gate run, and gate verify execute correctly", async () => {
    // 1. gate list
    const listRes = runGateList({ cwd: tmpDir });
    assert.equal(listRes.exitCode, 0);

    // 2. gate run
    const runRes = await runGateRun({ cwd: tmpDir });
    assert.equal(runRes.exitCode, 0);

    // 3. gate verify
    const verifyRes = runGateVerify({ cwd: tmpDir });
    assert.equal(verifyRes.exitCode, 0);
  });

  test("DAG dependency failure prevents dependent check from running", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    // check 1 fails
    qgConfig.gates[0].checks[0].args = ["-e", "process.exit(1);"];
    // check 2 depends on check 1
    qgConfig.gates[0].checks.push({
      id: "dependent-check",
      name: "Dependent Check",
      type: "automated_test",
      deliverable_id: "PRD-CORE",
      command: "node",
      args: ["-e", "console.log('Should not run'); process.exit(0);"],
      depends_on: ["prd-check"],
    });
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);
    // Run WITHOUT fail-fast
    const report = await runner.run({ failFast: false });

    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.skipped, 1);

    const depCheck = report.checks.find((c) => c.check_id === "dependent-check");
    assert.ok(depCheck);
    assert.equal(depCheck.outcome, "skipped");
    assert.ok(depCheck.error_message?.includes("upstream dependency failed"));
  });

  test("halt-on-failure transitions stage_status to blocked under lock", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    qgConfig.gates[0].checks[0].args = ["-e", "process.exit(1);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);
    const report = await runner.run({ haltOnFailure: true });

    assert.equal(report.overall_outcome, "halted");

    const stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw);
    assert.equal(state.stage_status, "blocked");
    assert.ok(state.last_updated.reason.includes("Controller Halt triggered"));
  });

  test("process timeout terminates child process tree and reports timed_out", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    // Run long-running child with a 1000ms timeout
    qgConfig.gates[0].checks[0].timeout_ms = 1000;
    qgConfig.gates[0].checks[0].args = ["-e", "setTimeout(() => {}, 60000);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);
    const report = await runner.run();

    assert.equal(report.overall_outcome, "failed");
    assert.equal(report.checks[0].outcome, "timed_out");
    assert.ok(report.checks[0].error_message?.includes("Timed out"));
  });

  test("failed rerun scenario: preserves historical passing evidence and marks deliverable as failed", async () => {
    // 1. Initial successful run
    const runner = new QualityGateRunner(tmpDir);
    const passReport = await runner.run();
    assert.equal(passReport.overall_outcome, "passed");

    const statePassRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    const statePass = JSON.parse(statePassRaw);
    const delivPass = statePass.current_stage_detail.deliverables[0];
    assert.equal(delivPass.status, "verified");
    assert.equal(delivPass.validation_status, "passed");
    assert.equal(delivPass.evidence.length, 1);
    const passEvidence = delivPass.evidence[0];
    assert.equal(passEvidence.result, "passed");

    // Read-only verifier confirms fresh and verified
    const verifier = new QualityGateVerifier(tmpDir);
    assert.equal(verifier.verify().all_fresh, true);

    // 2. Rerun the same check, but this time it fails
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    qgConfig.gates[0].checks[0].args = ["-e", "console.error('Check failed on rerun'); process.exit(1);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const failReport = await runner.run();
    assert.equal(failReport.overall_outcome, "failed");

    // 3. Inspect state after failed rerun
    const stateFailRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    const stateFail = JSON.parse(stateFailRaw);
    const delivFail = stateFail.current_stage_detail.deliverables[0];

    // Deliverable cannot remain verified using stale evidence!
    assert.equal(delivFail.status, "in_progress");
    assert.equal(delivFail.validation_status, "failed");

    // Previous passing evidence remains preserved and auditable (length 2)
    assert.equal(delivFail.evidence.length, 2);
    assert.equal(delivFail.evidence[0].result, "passed");
    assert.equal(delivFail.evidence[0].evidence_ref, passEvidence.evidence_ref);
    assert.ok(fs.existsSync(path.join(tmpDir, passEvidence.evidence_ref))); // pass log preserved!

    // Latest evidence record represents failed attempt
    const latestEvidence = delivFail.evidence[1];
    assert.equal(latestEvidence.result, "failed");
    assert.equal(latestEvidence.exit_code, 1);
    assert.ok(fs.existsSync(path.join(tmpDir, latestEvidence.evidence_ref)));

    // 4. Read-only verifier confirms deliverable is no longer fresh/verified
    const verifyAfterFail = verifier.verify();
    assert.equal(verifyAfterFail.all_fresh, false);
    assert.equal(verifyAfterFail.checks[0].is_fresh, false);
    assert.ok(verifyAfterFail.checks[0].reason?.includes("FAILED"));
  });

  test("read-only verification strictly preserves filesystem and detects pending WAL journal", () => {
    const verifier = new QualityGateVerifier(tmpDir);

    // Create an unrecovered journal file on disk to simulate interrupted transaction
    const journalPath = path.join(playbookDir, "tx-journal.json");
    const journalContent = JSON.stringify({ tx_id: "tx-pending-123", phase: "PREPARED", files: [] }, null, 2);
    fs.writeFileSync(journalPath, journalContent, "utf-8");

    const stateBefore = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    const report = verifier.verify();

    // Verification must detect pending journal
    assert.equal(report.pending_recovery, true);
    assert.ok(report.diagnostics?.some((d) => d.code === "PENDING_WAL_RECOVERY"));

    // Strictly read-only: journal and state MUST remain untouched!
    assert.ok(fs.existsSync(journalPath));
    assert.equal(fs.readFileSync(journalPath, "utf-8"), journalContent);
    assert.equal(fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8"), stateBefore);

    fs.unlinkSync(journalPath);
  });

  test("Windows child-process tree termination terminates grandchild processes without orphans", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    qgConfig.gates[0].checks[0].timeout_ms = 1200;

    // Command spawns a grandchild process and sleeps
    const pidFile = path.join(tmpDir, "grandchild.pid");
    qgConfig.gates[0].checks[0].args = [
      "-e",
      `const { spawn } = require('child_process');
       const fs = require('fs');
       const sub = spawn('node', ['-e', 'setInterval(() => {}, 1000);']);
       fs.writeFileSync('${pidFile.replace(/\\/g, "/")}', String(sub.pid), 'utf-8');
       setInterval(() => {}, 1000);`,
    ];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);
    const report = await runner.run();

    assert.equal(report.overall_outcome, "failed");
    assert.equal(report.checks[0].outcome, "timed_out");

    // Verify grandchild process was terminated
    assert.ok(fs.existsSync(pidFile));
    const grandchildPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    assert.ok(grandchildPid > 0);

    // Wait a brief moment to allow taskkill /T to complete
    await new Promise((r) => setTimeout(r, 600));

    let isAlive = false;
    try {
      process.kill(grandchildPid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    assert.equal(isAlive, false, "Grandchild process must be terminated, no orphans");
  });

  test("fail-fast vs halt-on-failure behavioral distinction", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    // check 1 fails
    qgConfig.gates[0].checks[0].args = ["-e", "process.exit(1);"];
    // check 2 independent
    qgConfig.gates[0].checks.push({
      id: "second-independent-check",
      name: "Second Check",
      type: "automated_test",
      deliverable_id: "PRD-CORE",
      command: "node",
      args: ["-e", "process.exit(0);"],
    });
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);

    // Run 1: --fail-fast only (haltOnFailure: false)
    const failFastReport = await runner.run({ failFast: true, haltOnFailure: false });
    assert.equal(failFastReport.overall_outcome, "failed");
    assert.equal(failFastReport.summary.skipped, 1);

    // Verify state was NOT blocked
    let stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    let state = JSON.parse(stateRaw);
    assert.equal(state.stage_status, "in_progress");

    // Run 2: --halt-on-failure (failFast: false)
    const haltReport = await runner.run({ failFast: false, haltOnFailure: true });
    assert.equal(haltReport.overall_outcome, "halted");

    // Verify state WAS blocked
    stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    state = JSON.parse(stateRaw);
    assert.equal(state.stage_status, "blocked");

    // Subsequent run must be barred with STAGE_BLOCKED
    await assert.rejects(
      async () => runner.run(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as any).code, "STAGE_BLOCKED");
        return true;
      }
    );
  });

  test("complete block -> human recovery -> permitted execution sequence", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    qgConfig.gates[0].checks[0].args = ["-e", "process.exit(1);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);

    // 1. Check fails and triggers Controller Halt
    const haltReport = await runner.run({ haltOnFailure: true });
    assert.equal(haltReport.overall_outcome, "halted");

    let stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    let state = JSON.parse(stateRaw);
    assert.equal(state.stage_status, "blocked");
    assert.equal(state.current_stage_detail.deliverables[0].status, "in_progress");
    assert.equal(state.current_stage_detail.deliverables[0].validation_status, "failed");

    // 2. Automated gate run attempted while blocked: strictly barred
    await assert.rejects(
      async () => runner.run(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as any).code, "STAGE_BLOCKED");
        return true;
      }
    );

    // 3. Human recovery workflow:
    // Human resolves defect in codebase/spec (in this case, check passes)
    qgConfig.gates[0].checks[0].args = ["-e", "console.log('Spec resolved by engineer'); process.exit(0);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    // Human operator unblocks state, recording non-repudiable audit metadata
    state.stage_status = "in_progress";
    state.last_updated = {
      timestamp: new Date().toISOString(),
      updated_by: "human:lead-engineer",
      actor_type: "human",
      reason: "Human recovery: resolved PRD specification defect and unblocked Stage 0 for re-evaluation.",
    };
    fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8");

    // 4. State validates against canonical schema
    const validationRes = runner.validator.validateState(state);
    assert.equal(validationRes.valid, true);

    // 5. Subsequent gate execution is now permitted and succeeds
    const recoveredReport = await runner.run();
    assert.equal(recoveredReport.overall_outcome, "passed");
    assert.equal(recoveredReport.summary.passed, 1);

    // Deliverable is now verified
    stateRaw = fs.readFileSync(path.join(playbookDir, "state.json"), "utf-8");
    state = JSON.parse(stateRaw);
    assert.equal(state.current_stage_detail.deliverables[0].status, "verified");
    assert.equal(state.current_stage_detail.deliverables[0].validation_status, "passed");

    // Crucial: Stage is NOT approved by unblocking or gate run; approval requirements remain intact!
    assert.equal(state.stage_status, "in_progress");
    assert.equal(state.current_stage_detail.human_approval.status, "not_requested");
  });

  test("Windows process lifecycle: handles already-exited processes and forced escalation without orphans", async () => {
    const qgConfig = JSON.parse(fs.readFileSync(path.join(playbookDir, "quality-gates.json"), "utf-8"));
    qgConfig.gates[0].checks[0].timeout_ms = 1000;

    // Fast-exiting process: already exited before any kill attempt
    qgConfig.gates[0].checks[0].args = ["-e", "process.exit(0);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const runner = new QualityGateRunner(tmpDir);
    const fastReport = await runner.run();
    assert.equal(fastReport.overall_outcome, "passed");

    // Long-running process ignoring voluntary exit: requires forced escalation
    qgConfig.gates[0].checks[0].args = ["-e", "setInterval(() => {}, 1000);"];
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(qgConfig, null, 2), "utf-8");

    const timeoutReport = await runner.run();
    assert.equal(timeoutReport.overall_outcome, "failed");
    assert.equal(timeoutReport.checks[0].outcome, "timed_out");
  });
});
