import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { DEFAULT_PATHS, STAGE_NAMES, type ProjectState, type ProjectManifest } from "../src/index.js";
import { reopenLifecycle } from "../src/core/reopen.js";
import { runReopen } from "../src/commands/reopen.js";
import { TransactionError } from "../src/core/transaction/types.js";
import type { PromptInterface } from "../src/utils/prompt.js";

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

  fs.writeFileSync(path.join(prdDir, "PRD-CORE.md"), "# PRD Core Problem Formulation\n", "utf-8");
  fs.writeFileSync(path.join(logsDir, "deploy.log"), "Deployment success verified\n", "utf-8");

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
    description: "Test service for lifecycle reopening TTY alignment",
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
      stage: s as any,
      stage_name: STAGE_NAMES[s as any],
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

class MockPrompter implements PromptInterface {
  constructor(private readonly answers: Record<string, string> = {}) {}

  async ask(question: string, defaultValue?: string): Promise<string> {
    for (const [key, val] of Object.entries(this.answers)) {
      if (question.includes(key)) return val;
    }
    return defaultValue ?? "";
  }

  async confirm(_question: string, defaultYes = false): Promise<boolean> {
    return defaultYes;
  }

  async select<T extends string>(_question: string, _options: readonly T[], defaultValue: T): Promise<T> {
    return defaultValue;
  }

  close(): void {}
}

describe("Reopen API TTY Enforcement & Programmatic Alignment", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-reopen-tty-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  test("1. Explicit isTTY: true succeeds when valid human authorization is supplied", async () => {
    const { statePath } = bootstrapTerminalProject(tempDir);

    const res = await reopenLifecycle(tempDir, {
      milestoneId: "M-1.1.0",
      milestoneName: "Maintenance Sprint 1",
      targetStage: 1,
      reason: "Quarterly feature updates",
      authorizedBy: "Alice Human",
      role: "Lead Architect",
      isTTY: true,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.newMilestoneId, "M-1.1.0");
    assert.strictEqual(res.newStage, 1);
    assert.strictEqual(res.archivedMilestonesCount, 1);
    assert.ok(res.txId?.startsWith("tx-"));

    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.strictEqual(state.lifecycle_status, "reopened_maintenance");
    assert.strictEqual(state.milestone_id, "M-1.1.0");
    assert.strictEqual(state.current_stage, 1);
  });

  test("2. Explicit isTTY: false rejects with TTY_REQUIRED and zero mutations", async () => {
    const { statePath, manifestPath } = bootstrapTerminalProject(tempDir);
    const initialManifestContent = fs.readFileSync(manifestPath, "utf-8");
    const initialStateContent = fs.readFileSync(statePath, "utf-8");

    await assert.rejects(
      async () => {
        await reopenLifecycle(tempDir, {
          milestoneId: "M-1.1.0",
          milestoneName: "Maintenance Sprint 1",
          targetStage: 1,
          reason: "Quarterly feature updates",
          authorizedBy: "Alice Human",
          role: "Lead Architect",
          isTTY: false,
        });
      },
      (err: unknown) => {
        assert(err instanceof TransactionError);
        assert.strictEqual(err.code, "TTY_REQUIRED");
        assert(err.message.includes("requires an interactive terminal session with human attestation"));
        return true;
      }
    );

    // Verify zero mutations
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/milestones/state-M-1.1.0.json")), false);
    assert.strictEqual(fs.readFileSync(manifestPath, "utf-8"), initialManifestContent);
    assert.strictEqual(fs.readFileSync(statePath, "utf-8"), initialStateContent);

    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.strictEqual(state.lifecycle_status, "completed_terminal");
    assert.strictEqual(state.milestone_id, "M-1.0.0");
    assert.strictEqual(state.current_stage, 6);
  });

  test("3. Omitted isTTY in headless execution fails closed with TTY_REQUIRED", async () => {
    const { statePath, manifestPath } = bootstrapTerminalProject(tempDir);
    const initialManifestContent = fs.readFileSync(manifestPath, "utf-8");
    const initialStateContent = fs.readFileSync(statePath, "utf-8");

    // In a test runner without interactive stdin/stdout TTY, omitting isTTY derives false
    const origStdinIsTTY = process.stdin.isTTY;
    const origStdoutIsTTY = process.stdout.isTTY;
    try {
      (process.stdin as any).isTTY = undefined;
      (process.stdout as any).isTTY = undefined;

      await assert.rejects(
        async () => {
          await reopenLifecycle(tempDir, {
            milestoneId: "M-1.1.0",
            reason: "Headless programmatic call",
            authorizedBy: "Alice Human",
            role: "Lead Architect",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "TTY_REQUIRED");
          return true;
        }
      );
    } finally {
      (process.stdin as any).isTTY = origStdinIsTTY;
      (process.stdout as any).isTTY = origStdoutIsTTY;
    }

    // Verify zero mutations
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    assert.strictEqual(fs.readFileSync(manifestPath, "utf-8"), initialManifestContent);
    assert.strictEqual(fs.readFileSync(statePath, "utf-8"), initialStateContent);
  });

  test("4. Omitted isTTY in a real headless child process fails closed with TTY_REQUIRED", () => {
    const { statePath } = bootstrapTerminalProject(tempDir);

    const scriptPath = path.join(tempDir, "headless-reopen-runner.mjs");
    const reopenUrl = new URL("../src/core/reopen.js", import.meta.url).href;
    const targetDirPath = tempDir.replace(/\\/g, "/");

    const scriptContent = `
      import { reopenLifecycle } from "${reopenUrl}";
      async function main() {
        try {
          await reopenLifecycle("${targetDirPath}", {
            milestoneId: "M-1.1.0",
            authorizedBy: "Alice Human",
            role: "Lead Architect",
            reason: "Headless child process reopening attempt"
          });
          process.exit(0);
        } catch (err) {
          if (err && err.code === "TTY_REQUIRED") {
            process.exit(42);
          }
          console.error("DEBUG err in headless-reopen-runner:", err);
          process.exit(1);
        }
      }
      main();
    `;
    fs.writeFileSync(scriptPath, scriptContent, "utf-8");

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [scriptPath], {
        cwd: tempDir,
        stdio: "pipe", // non-interactive pipe: process.stdin.isTTY and stdout are false/undefined
      });
    } catch (err: any) {
      exitCode = err.status;
      if (exitCode !== 42) {
        console.error("Subprocess stderr:", err.stderr?.toString());
        console.error("Subprocess stdout:", err.stdout?.toString());
      }
    }

    assert.strictEqual(exitCode, 42, "Headless subprocess must fail closed with exit code 42 (TTY_REQUIRED)");

    // Verify zero mutations
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/milestones/state-M-1.1.0.json")), false);
    const state: ProjectState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.strictEqual(state.lifecycle_status, "completed_terminal");
  });

  test("5. Asymmetric TTY states (stdin true / stdout false and vice-versa) fail closed", async () => {
    bootstrapTerminalProject(tempDir);

    const origStdinIsTTY = process.stdin.isTTY;
    const origStdoutIsTTY = process.stdout.isTTY;

    try {
      // Case A: stdin true, stdout false
      (process.stdin as any).isTTY = true;
      (process.stdout as any).isTTY = false;

      await assert.rejects(
        async () => {
          await reopenLifecycle(tempDir, {
            milestoneId: "M-1.1.0",
            reason: "Piped stdout attempt",
            authorizedBy: "Alice Human",
            role: "Lead Architect",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "TTY_REQUIRED");
          return true;
        }
      );

      // Case B: stdin false, stdout true
      (process.stdin as any).isTTY = false;
      (process.stdout as any).isTTY = true;

      await assert.rejects(
        async () => {
          await reopenLifecycle(tempDir, {
            milestoneId: "M-1.1.0",
            reason: "Piped stdin attempt",
            authorizedBy: "Alice Human",
            role: "Lead Architect",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "TTY_REQUIRED");
          return true;
        }
      );
    } finally {
      (process.stdin as any).isTTY = origStdinIsTTY;
      (process.stdout as any).isTTY = origStdoutIsTTY;
    }
  });

  test("6. CLI runReopen forwards isTTY: true to core and completes successfully", async () => {
    bootstrapTerminalProject(tempDir);

    const prompter = new MockPrompter({
      "Confirmation phrase": "CONFIRM REOPEN MILESTONE M-1.1.0",
    });

    const res = await runReopen({
      cwd: tempDir,
      milestone: "M-1.1.0",
      name: "Maintenance Milestone 1.1",
      stage: 1,
      reason: "Scheduled maintenance cycle",
      authorizedBy: "Alice Human",
      role: "Lead Architect",
      confirmationPhrase: "CONFIRM REOPEN MILESTONE M-1.1.0",
      isTTY: true,
      prompter,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.newMilestoneId, "M-1.1.0");

    const state: ProjectState = JSON.parse(
      fs.readFileSync(path.join(tempDir, DEFAULT_PATHS.stateFile), "utf-8")
    );
    assert.strictEqual(state.lifecycle_status, "reopened_maintenance");
    assert.strictEqual(state.milestone_id, "M-1.1.0");
  });

  test("7. CLI runReopen rejects when isTTY: false or nonInteractive: true", async () => {
    bootstrapTerminalProject(tempDir);

    const prompter = new MockPrompter();

    // With isTTY: false
    const res1 = await runReopen({
      cwd: tempDir,
      milestone: "M-1.1.0",
      isTTY: false,
      prompter,
    });
    assert.strictEqual(res1.success, false);
    assert.strictEqual(res1.exitCode, 1);
    assert.strictEqual(res1.error, "TTY_REQUIRED");

    // With nonInteractive: true
    const res2 = await runReopen({
      cwd: tempDir,
      milestone: "M-1.1.0",
      nonInteractive: true,
      prompter,
    });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.exitCode, 1);
    assert.strictEqual(res2.error, "TTY_REQUIRED");
  });

  test("8. TTY guard executes before any file reading or lock acquisition", async () => {
    // Non-existent directory - no manifest or state exists at all
    const emptyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-empty-"));
    try {
      await assert.rejects(
        async () => {
          await reopenLifecycle(emptyTempDir, {
            milestoneId: "M-1.1.0",
            reason: "Testing guard order",
            authorizedBy: "Alice Human",
            role: "Lead Architect",
            isTTY: false,
          });
        },
        (err: unknown) => {
          // If file reading or uninitialized checks came first, error would be PROJECT_UNINITIALIZED.
          // Because TTY check comes first, error must be TTY_REQUIRED.
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "TTY_REQUIRED");
          return true;
        }
      );
    } finally {
      fs.rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });
});
