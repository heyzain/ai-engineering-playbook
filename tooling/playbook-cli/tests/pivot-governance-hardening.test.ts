import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DEFAULT_PATHS, STAGE_NAMES, type ProjectState, type ProjectManifest } from "../src/index.js";
import {
  checkPivotEligibility,
  executeStagePivot as coreExecuteStagePivot,
  type PrePromptBaseline,
  type PivotExecutionOptions,
} from "../src/core/pivot.js";

function executeStagePivot(targetDir: string, options: PivotExecutionOptions) {
  return coreExecuteStagePivot(targetDir, { isTTY: true, ...options });
}
import { runPivot } from "../src/commands/pivot.js";
import { isForbiddenAgentName } from "../src/core/approval.js";
import { WriteAheadTransactionManager } from "../src/core/transaction/transaction-manager.js";
import { TransactionError } from "../src/core/transaction/types.js";
import type { PromptInterface } from "../src/utils/prompt.js";

class MockPrompter implements PromptInterface {
  constructor(private responses: string[] = []) {}
  async ask(): Promise<string> {
    return this.responses.shift() ?? "";
  }
  async confirm(): Promise<boolean> {
    return true;
  }
  async select<T extends string>(_q: string, _opts: readonly T[], def: T): Promise<T> {
    return (this.responses.shift() as T) ?? def;
  }
  close(): void {}
}

function bootstrapStage1MaintenanceProject(tempDir: string): void {
  const playbookDir = path.join(tempDir, ".playbook");
  const pivotsDir = path.join(playbookDir, "pivots");
  const logsDir = path.join(playbookDir, "logs");
  const milestonesDir = path.join(playbookDir, "milestones");
  const docsDir = path.join(tempDir, "docs");
  const prdDir = path.join(docsDir, "prd");
  const prdArchiveDir = path.join(prdDir, "archive");
  const docsPivotsDir = path.join(docsDir, "pivots");
  const gatesDir = path.join(docsDir, "gates");
  const rfcsDir = path.join(docsDir, "rfcs");
  const adrDir = path.join(docsDir, "adr");
  const exceptionsDir = path.join(docsDir, "exceptions");

  fs.mkdirSync(playbookDir, { recursive: true });
  fs.mkdirSync(pivotsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(milestonesDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(prdArchiveDir, { recursive: true });
  fs.mkdirSync(docsPivotsDir, { recursive: true });
  fs.mkdirSync(gatesDir, { recursive: true });
  fs.mkdirSync(rfcsDir, { recursive: true });
  fs.mkdirSync(adrDir, { recursive: true });
  fs.mkdirSync(exceptionsDir, { recursive: true });

  const prdCorePath = path.join(prdDir, "PRD-CORE.md");
  fs.writeFileSync(
    prdCorePath,
    "# Original PRD Core Problem Statement\nInitial formulation for B2C consumer app.\n",
    "utf-8"
  );

  const assessmentPath = path.join(prdDir, "PRD-CORE-ASSESSMENT.md");
  fs.writeFileSync(
    assessmentPath,
    `# Foundational PRD Applicability Assessment\nMilestone: M-1.1.0\nAuthor: Alice Engineer\nApplicability: OUTDATED\n\n## Rationale\nDomain pivoted to enterprise B2B platform.\n`,
    "utf-8"
  );

  fs.writeFileSync(
    path.join(prdDir, "REQUIREMENTS-SPEC.md"),
    "# Requirements Specification\nMaintenance requirements for milestone.\n",
    "utf-8"
  );

  const manifest: ProjectManifest = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    project_name: "Test Service",
    active_milestone_id: "M-1.1.0",
    description: "Test service for lifecycle pivot",
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
    active_lifecycle_stage: 1,
    capabilities: ["automated_testing"],
  };
  fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  const state: ProjectState = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-service",
    playbook_version: "1.0.0",
    milestone_id: "M-1.1.0",
    milestone_name: "Maintenance Milestone M-1.1.0",
    lifecycle_status: "reopened_maintenance",
    current_stage: 1,
    stage_status: "in_progress",
    current_stage_detail: {
      stage: 1,
      stage_name: STAGE_NAMES[1],
      started_at: "2026-11-01T10:00:00.000Z",
      deliverables: [
        {
          id: "REQ-SPEC",
          name: "Requirements Specification",
          artifact_path: "docs/prd/REQUIREMENTS-SPEC.md",
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
        path: "docs/gates/GATE-1-EXIT.md",
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
    archived_milestones: [
      {
        milestone_id: "M-1.0.0",
        milestone_name: "MVP Production Release",
        completed_at: "2026-10-31T12:00:00.000Z",
        final_stage: 6,
        stage_history: [],
        exit_package_ref: "docs/gates/GATE-6-EXIT.md",
        state_snapshot_ref: ".playbook/milestones/state-M-1.0.0.json",
      },
    ],
    last_updated: {
      timestamp: "2026-11-01T10:00:00.000Z",
      updated_by: "Alice Engineer",
      actor_type: "human",
      reason: "Reopened maintenance milestone at Stage 1",
    },
  };
  fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
}

describe("Task 004F.2.4-B.3 — Pivot Governance Test Hardening", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-hardening-test-"));
    bootstrapStage1MaintenanceProject(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("C6 — Unsupported Target Stage Enforcement", () => {
    test("CLI runPivot rejects target stage 1 with PIVOT_TARGET_UNSUPPORTED and zero mutations", async () => {
      const initialPrdContent = fs.readFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), "utf-8");
      const initialStateContent = fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8");
      const initialManifestContent = fs.readFileSync(path.join(tempDir, ".playbook/manifest.json"), "utf-8");

      const res = await runPivot({
        cwd: tempDir,
        stage: 1,
        isTTY: true,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Attempting to pivot to stage 1",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert.strictEqual(res.error, "PIVOT_TARGET_UNSUPPORTED");
      assert(res.message.includes("Only pivot to Stage 0 is supported"));

      // Verify zero filesystem mutations
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
      assert.strictEqual(fs.readdirSync(path.join(tempDir, ".playbook/pivots")).length, 0);
      assert.strictEqual(fs.readdirSync(path.join(tempDir, "docs/pivots")).length, 0);
      assert.strictEqual(fs.readdirSync(path.join(tempDir, "docs/prd/archive")).length, 0);
      assert.strictEqual(fs.readFileSync(path.join(tempDir, "docs/prd/PRD-CORE.md"), "utf-8"), initialPrdContent);
      assert.strictEqual(fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8"), initialStateContent);
      assert.strictEqual(fs.readFileSync(path.join(tempDir, ".playbook/manifest.json"), "utf-8"), initialManifestContent);
    });

    test("CLI runPivot rejects target stage 2, negative stages, and invalid stage numbers", async () => {
      for (const invalidStage of [2, 3, -1, 99]) {
        const res = await runPivot({
          cwd: tempDir,
          stage: invalidStage,
          isTTY: true,
          authorizedBy: "Alice Engineer",
          role: "Lead Architect",
          reason: "Invalid stage",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        });

        assert.strictEqual(res.success, false);
        assert.strictEqual(res.exitCode, 1);
        assert.strictEqual(res.error, "PIVOT_TARGET_UNSUPPORTED");
      }
    });

    test("executeStagePivot API rejects target stage != 0 without pre-prompt baseline", async () => {
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 2,
            authorizedBy: "Alice Engineer",
            role: "Lead Architect",
            reason: "Direct API invocation with unsupported target stage",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "PIVOT_TARGET_UNSUPPORTED");
          return true;
        }
      );
    });

    test("executeStagePivot API rejects target stage != 0 even when caller supplies a forged pre-prompt baseline", async () => {
      const forgedBaseline: PrePromptBaseline = {
        lifecycleStatus: "reopened_maintenance",
        milestoneId: "M-1.1.0",
        currentStage: 1,
        stageStatus: "in_progress",
        approvalDecision: null,
        stateFileHash: "dummy",
        manifestFileHash: "dummy",
        prdCoreHash: "dummy",
        assessmentPath: "docs/prd/PRD-CORE-ASSESSMENT.md",
        assessmentFileHash: "dummy",
        assessmentStatus: "OUTDATED",
        sidecarHash: null,
      };

      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 1,
            authorizedBy: "Alice Engineer",
            role: "Lead Architect",
            reason: "Attempting bypass using pre-prompt baseline",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
            baseline: forgedBaseline,
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "PIVOT_TARGET_UNSUPPORTED");
          return true;
        }
      );

      // Verify zero journal or snapshot creation
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
      assert.strictEqual(fs.readdirSync(path.join(tempDir, ".playbook/pivots")).length, 0);
    });

    test("valid target stage 0 remains supported and executes successfully", async () => {
      const result = await runPivot({
        cwd: tempDir,
        stage: 0,
        isTTY: true,
        authorizedBy: "Alice Engineer",
        role: "Lead Architect",
        reason: "Valid pivot to Stage 0 for domain reformulation",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);

      const updatedState: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8")
      );
      assert.strictEqual(updatedState.current_stage, 0);
      assert.strictEqual(updatedState.stage_status, "not_started");
      assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), false);
    });
  });

  describe("H3 — AI-Agent Identity Prohibition", () => {
    test("isForbiddenAgentName utility detects known agent names and roles", () => {
      // Forbidden agent names
      assert.strictEqual(isForbiddenAgentName("copilot"), true);
      assert.strictEqual(isForbiddenAgentName("GitHub Copilot"), true);
      assert.strictEqual(isForbiddenAgentName("chatgpt"), true);
      assert.strictEqual(isForbiddenAgentName("ChatGPT v4"), true);
      assert.strictEqual(isForbiddenAgentName("gemini"), true);
      assert.strictEqual(isForbiddenAgentName("Google Gemini Pro"), true);
      assert.strictEqual(isForbiddenAgentName("antigravity"), true);
      assert.strictEqual(isForbiddenAgentName("Antigravity Autonomous Agent"), true);
      assert.strictEqual(isForbiddenAgentName("claude-agent"), true);
      assert.strictEqual(isForbiddenAgentName("cursor"), true);
      assert.strictEqual(isForbiddenAgentName("Cursor AI"), true);
      assert.strictEqual(isForbiddenAgentName("orchestrator"), true);
      assert.strictEqual(isForbiddenAgentName("playbook-bot"), true);
      assert.strictEqual(isForbiddenAgentName("controller"), true);

      // Forbidden agent roles
      assert.strictEqual(isForbiddenAgentName("AI Coding Agent"), true);
      assert.strictEqual(isForbiddenAgentName("Autonomous Subagent"), true);
      assert.strictEqual(isForbiddenAgentName("LLM Assistant"), true);
      assert.strictEqual(isForbiddenAgentName("Playbook Controller"), true);

      // Empty or whitespace strings
      assert.strictEqual(isForbiddenAgentName(""), true);
      assert.strictEqual(isForbiddenAgentName("   "), true);

      // Valid human names and roles
      assert.strictEqual(isForbiddenAgentName("Alice Engineer"), false);
      assert.strictEqual(isForbiddenAgentName("Bob Architect"), false);
      assert.strictEqual(isForbiddenAgentName("Lead Architect"), false);
      assert.strictEqual(isForbiddenAgentName("Principal Software Engineer"), false);
      assert.strictEqual(isForbiddenAgentName("Engineering Director"), false);
    });

    test("CLI runPivot rejects agent names in authorizedBy with AGENT_APPROVAL_PROHIBITED", async () => {
      const agentNames = [
        "copilot",
        "chatgpt",
        "gemini",
        "antigravity",
        "claude-agent",
        "cursor",
        "Automated Bot",
        "Playbook Orchestrator",
      ];

      for (const agentName of agentNames) {
        const res = await runPivot({
          cwd: tempDir,
          stage: 0,
          isTTY: true,
          authorizedBy: agentName,
          role: "Lead Architect",
          reason: "Automated pivot attempt",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        });

        assert.strictEqual(res.success, false);
        assert.strictEqual(res.exitCode, 1);
        assert.strictEqual(res.error, "AGENT_APPROVAL_PROHIBITED");
        assert(res.message.includes("appears to be an automated agent"));
      }

      // Verify zero filesystem mutations
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
      assert.strictEqual(fs.readdirSync(path.join(tempDir, ".playbook/pivots")).length, 0);
    });

    test("CLI runPivot rejects agent roles with AGENT_APPROVAL_PROHIBITED", async () => {
      const agentRoles = [
        "AI Coding Agent",
        "Autonomous Subagent",
        "LLM Assistant",
        "Workflow Orchestrator",
        "Automated Bot Controller",
      ];

      for (const agentRole of agentRoles) {
        const res = await runPivot({
          cwd: tempDir,
          stage: 0,
          isTTY: true,
          authorizedBy: "Alice Engineer",
          role: agentRole,
          reason: "Valid reason with agent role",
          confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
        });

        assert.strictEqual(res.success, false);
        assert.strictEqual(res.exitCode, 1);
        assert.strictEqual(res.error, "AGENT_APPROVAL_PROHIBITED");
        assert(res.message.includes("appears to be an automated agent role"));
      }

      // Verify zero filesystem mutations
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
    });

    test("CLI runPivot rejects empty or whitespace-only identity", async () => {
      // Empty string via prompter when authorizedBy not provided
      const resEmptyAuth = await runPivot({
        cwd: tempDir,
        stage: 0,
        isTTY: true,
        prompter: new MockPrompter([""]),
        role: "Lead Architect",
        reason: "Valid reason",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });
      assert.strictEqual(resEmptyAuth.success, false);
      assert.strictEqual(resEmptyAuth.exitCode, 1);
      assert.strictEqual(resEmptyAuth.error, "AGENT_APPROVAL_PROHIBITED");

      // Whitespace string via prompter
      const resWhitespaceAuth = await runPivot({
        cwd: tempDir,
        stage: 0,
        isTTY: true,
        prompter: new MockPrompter(["   "]),
        role: "Lead Architect",
        reason: "Valid reason",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });
      assert.strictEqual(resWhitespaceAuth.success, false);
      assert.strictEqual(resWhitespaceAuth.exitCode, 1);
      assert.strictEqual(resWhitespaceAuth.error, "AGENT_APPROVAL_PROHIBITED");

      // Empty role via prompter
      const resEmptyRole = await runPivot({
        cwd: tempDir,
        stage: 0,
        isTTY: true,
        authorizedBy: "Alice Engineer",
        prompter: new MockPrompter([""]),
        reason: "Valid reason",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });
      assert.strictEqual(resEmptyRole.success, false);
      assert.strictEqual(resEmptyRole.exitCode, 1);
      assert.strictEqual(resEmptyRole.error, "PIVOT_ABORTED");
    });

    test("executeStagePivot blocks programmatic bypass attempts with agent identity or role", async () => {
      // Programmatic bypass attempt with agent authorizer
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Antigravity-Agent",
            role: "Lead Architect",
            reason: "Direct API invocation by AI subagent",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "AGENT_APPROVAL_PROHIBITED");
          return true;
        }
      );

      // Programmatic bypass attempt with agent role
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "Alice Engineer",
            role: "AI Autonomous Agent",
            reason: "Direct API invocation with agent role",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "AGENT_APPROVAL_PROHIBITED");
          return true;
        }
      );

      // Programmatic bypass attempt with empty name
      await assert.rejects(
        async () => {
          await executeStagePivot(tempDir, {
            targetStage: 0,
            authorizedBy: "  ",
            role: "Lead Architect",
            reason: "Direct API invocation without authorizer",
            confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
          });
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "AGENT_APPROVAL_PROHIBITED");
          return true;
        }
      );

      // Verify zero filesystem mutations
      assert.strictEqual(fs.existsSync(path.join(tempDir, ".playbook/tx-journal.json")), false);
      assert.strictEqual(fs.readdirSync(path.join(tempDir, ".playbook/pivots")).length, 0);
      assert.strictEqual(fs.existsSync(path.join(tempDir, "docs/prd/PRD-CORE.md")), true);
    });

    test("valid human reviewer and role succeed without impediment", async () => {
      const result = await executeStagePivot(tempDir, {
        targetStage: 0,
        authorizedBy: "Alice Engineer",
        role: "Principal Systems Architect",
        reason: "Valid human-authorized stage pivot to Stage 0",
        confirmationPhrase: "CONFIRM PIVOT TO STAGE 0 M-1.1.0",
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.fromStage, 1);
      assert.strictEqual(result.toStage, 0);

      const updatedState: ProjectState = JSON.parse(
        fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf-8")
      );
      assert.strictEqual(updatedState.current_stage, 0);
    });
  });

  describe("Transaction Prepare Options Precedence & Conflict Combinations", () => {
    test("Precedence Level 1: per-spec requireParentDirectoryExists overrides call and manager options", async () => {
      const nonExistentDir = path.join(tempDir, "non_existent_folder");
      assert.strictEqual(fs.existsSync(nonExistentDir), false);

      const targetPath = "non_existent_folder/file.txt";

      // Case A: Manager=false, Prepare=false, Spec=true -> aborts with PIVOT_STORAGE_LAYOUT_MISSING
      const txManagerA = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: false,
      });

      await assert.rejects(
        async () => {
          await txManagerA.executeTransaction("TEST_SPEC_OVERRIDE_TRUE", [
            {
              targetPath,
              content: "test content",
              requireParentDirectoryExists: true,
            },
          ]);
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "PIVOT_STORAGE_LAYOUT_MISSING");
          return true;
        }
      );

      // Verify directory was NOT created
      assert.strictEqual(fs.existsSync(nonExistentDir), false);

      // Case B: Manager=true, Prepare=true, Spec=false -> spec overrides and allows directory creation
      const txManagerB = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: true,
      });

      const resB = await txManagerB.executeTransaction(
        "TEST_SPEC_OVERRIDE_FALSE",
        [
          {
            targetPath,
            content: "test content created via spec override",
            requireParentDirectoryExists: false,
          },
        ],
        undefined,
        { requireParentDirectoriesExist: true }
      );

      assert.ok(resB.txId);
      assert.strictEqual(fs.existsSync(path.join(tempDir, targetPath)), true);
    });

    test("Precedence Level 2: call-level prepare options override manager options", async () => {
      const nonExistentDir = path.join(tempDir, "another_folder");
      assert.strictEqual(fs.existsSync(nonExistentDir), false);
      const targetPath = "another_folder/file.txt";

      // Case A: Manager=false, Call=true -> aborts with PIVOT_STORAGE_LAYOUT_MISSING
      const txManagerA = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: false,
      });

      await assert.rejects(
        async () => {
          await txManagerA.executeTransaction(
            "TEST_CALL_OVERRIDE_TRUE",
            [
              {
                targetPath,
                content: "content",
              },
            ],
            undefined,
            { requireParentDirectoriesExist: true }
          );
        },
        (err: unknown) => {
          assert(err instanceof TransactionError);
          assert.strictEqual(err.code, "PIVOT_STORAGE_LAYOUT_MISSING");
          return true;
        }
      );
      assert.strictEqual(fs.existsSync(nonExistentDir), false);

      // Case B: Manager=true, Call=false -> call overrides manager and allows directory creation
      const txManagerB = new WriteAheadTransactionManager({
        targetDir: tempDir,
        requireParentDirectoriesExist: true,
      });

      const resB = await txManagerB.executeTransaction(
        "TEST_CALL_OVERRIDE_FALSE",
        [
          {
            targetPath,
            content: "content via call override",
          },
        ],
        undefined,
        { requireParentDirectoriesExist: false }
      );

      assert.ok(resB.txId);
      assert.strictEqual(fs.existsSync(path.join(tempDir, targetPath)), true);
    });

    test("Standard workflows without explicit options retain original directory creation behavior", async () => {
      const normalTarget = "deep/nested/standard/workflow/file.json";
      const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });

      const result = await txManager.executeTransaction("STANDARD_WORKFLOW", [
        {
          targetPath: normalTarget,
          content: JSON.stringify({ hello: "world" }),
        },
      ]);

      assert.ok(result.txId);
      assert.strictEqual(fs.existsSync(path.join(tempDir, normalTarget)), true);
      const data = JSON.parse(fs.readFileSync(path.join(tempDir, normalTarget), "utf-8"));
      assert.strictEqual(data.hello, "world");
    });
  });
});
