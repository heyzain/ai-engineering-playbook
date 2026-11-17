import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  getCiAdapter,
  initCiWorkflow,
  validateCiWorkflow,
  inspectCiStatus,
  resolveWorkflowPath,
  findWorkflowBackups,
} from "../src/core/ci/adapter.js";
import { GitHubActionsAdapter } from "../src/core/ci/adapters/github.js";
import {
  CI_REQUIRED_CHECK_NAME,
  CI_WORKFLOW_MARKERS,
  DEFAULT_GITHUB_WORKFLOW_PATH,
  CiError,
} from "../src/core/ci/types.js";
import { runCiInit, runCiValidate, runCiStatus } from "../src/commands/ci.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");

describe("Remote CI Pipeline Architecture & GitHub Actions Adapter (Task 006C.3.1)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ci-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("A. Provider Adapter & Deterministic Generation", () => {
    test("factory returns GitHubActionsAdapter for 'github'", () => {
      const adapter = getCiAdapter("github");
      assert.ok(adapter instanceof GitHubActionsAdapter);
      assert.equal(adapter.provider, "github");
      assert.equal(adapter.defaultWorkflowPath, DEFAULT_GITHUB_WORKFLOW_PATH);
      assert.equal(adapter.requiredCheckName, CI_REQUIRED_CHECK_NAME);
    });

    test("factory rejects unsupported providers with descriptive CiError", () => {
      assert.throws(
        () => getCiAdapter("gitlab"),
        (err: unknown) => {
          assert.ok(err instanceof CiError);
          assert.equal(err.code, "UNSUPPORTED_PROVIDER");
          assert.match(err.message, /provider 'gitlab' is not supported/i);
          return true;
        }
      );
    });

    test("generates deterministic workflow with immutable action SHAs and required check", () => {
      const adapter = getCiAdapter("github");
      const wf1 = adapter.generateWorkflow({ provider: "github", timestamp: "2026-11-03T16:00:00.000Z" });
      const wf2 = adapter.generateWorkflow({ provider: "github", timestamp: "2026-11-03T16:00:00.000Z" });

      // Bit-for-bit determinism
      assert.equal(wf1, wf2);

      // Markers & metadata
      assert.ok(wf1.includes(CI_WORKFLOW_MARKERS.start));
      assert.ok(wf1.includes(CI_WORKFLOW_MARKERS.end));
      assert.ok(wf1.includes("# Playbook CLI Version: 1.0.0"));
      assert.ok(wf1.includes("# Provider: github"));
      assert.ok(wf1.includes("# Generated At: 2026-11-03T16:00:00.000Z"));

      // Security & triggers
      assert.ok(wf1.includes("permissions:\n  contents: read"));
      assert.ok(wf1.includes("pull_request:"));
      assert.ok(wf1.includes("push:"));
      assert.ok(!wf1.includes("pull_request_target"));

      // Required Check Name
      assert.ok(wf1.includes(`name: "${CI_REQUIRED_CHECK_NAME}"`));

      // Pinned Action SHAs
      assert.ok(wf1.includes("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"));
      assert.ok(wf1.includes("actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af"));
      assert.ok(wf1.includes("actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882"));
    });
  });

  describe("B. Safe Workflow Initialization & Idempotency", () => {
    test("initializes canonical workflow at default path", () => {
      const result = initCiWorkflow(tempDir, { provider: "github" });
      assert.equal(result.success, true);
      assert.equal(result.action, "created");
      assert.equal(result.backupCreated, false);

      const expectedPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      assert.ok(fs.existsSync(expectedPath));

      const content = fs.readFileSync(expectedPath, "utf-8");
      assert.ok(content.includes(CI_REQUIRED_CHECK_NAME));
    });

    test("dry-run produces preview without writing to disk", () => {
      const result = initCiWorkflow(tempDir, { provider: "github", dryRun: true });
      assert.equal(result.success, true);
      assert.equal(result.action, "dry_run");
      assert.equal(result.backupCreated, false);

      const expectedPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      assert.equal(fs.existsSync(expectedPath), false);
    });

    test("initialization is strictly idempotent when existing workflow is unchanged", () => {
      // First run: creates
      const res1 = initCiWorkflow(tempDir, { provider: "github" });
      assert.equal(res1.action, "created");

      // Second run: recognizes as up to date, does not write backup
      const res2 = initCiWorkflow(tempDir, { provider: "github" });
      assert.equal(res2.action, "already_up_to_date");
      assert.equal(res2.backupCreated, false);

      const backups = findWorkflowBackups(path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH));
      assert.equal(backups.length, 0);
    });

    test("protects existing user-authored workflow by rejecting unforced init", () => {
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      fs.writeFileSync(workflowPath, "name: Custom User CI\non: push\njobs: {}", "utf-8");

      assert.throws(
        () => initCiWorkflow(tempDir, { provider: "github" }),
        (err: unknown) => {
          assert.ok(err instanceof CiError);
          assert.equal(err.code, "WORKFLOW_MODIFIED");
          assert.match(err.message, /already exists and differs/i);
          return true;
        }
      );

      // Verify original file remained intact
      const content = fs.readFileSync(workflowPath, "utf-8");
      assert.equal(content, "name: Custom User CI\non: push\njobs: {}");
    });
  });

  describe("C. Backup Collision Handling & Integrity Verification", () => {
    test("creates verified backup when force overwriting user modifications", () => {
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      const userContent = "# Custom unmanaged workflow\nname: UserWorkflow\n";
      fs.writeFileSync(workflowPath, userContent, "utf-8");
      const userHash = crypto.createHash("sha256").update(userContent).digest("hex");

      const res = initCiWorkflow(tempDir, { provider: "github", force: true });
      assert.equal(res.success, true);
      assert.equal(res.action, "overwritten");
      assert.equal(res.backupCreated, true);
      assert.ok(res.backupPath && fs.existsSync(res.backupPath));

      // Backup content & hash verification
      const backupContent = fs.readFileSync(res.backupPath!, "utf-8");
      assert.equal(backupContent, userContent);
      const backupHash = crypto.createHash("sha256").update(backupContent).digest("hex");
      assert.equal(backupHash, userHash);

      // Workflow file is now canonical
      const newContent = fs.readFileSync(workflowPath, "utf-8");
      assert.ok(newContent.includes(CI_WORKFLOW_MARKERS.start));
    });

    test("handles rapid sequential force overwrites with collision-safe numbered backups", () => {
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });

      // Run initial
      fs.writeFileSync(workflowPath, "version: 1\n", "utf-8");
      initCiWorkflow(tempDir, { provider: "github", force: true });

      // Run multiple subsequent force updates with modified content
      for (let i = 2; i <= 4; i++) {
        fs.writeFileSync(workflowPath, `version: ${i}\n`, "utf-8");
        const res = initCiWorkflow(tempDir, { provider: "github", force: true });
        assert.equal(res.backupCreated, true);
      }

      const backups = findWorkflowBackups(workflowPath);
      assert.equal(backups.length, 4);

      // Verify all backups are unique and non-empty
      const backupSet = new Set(backups);
      assert.equal(backupSet.size, 4);
      for (const b of backups) {
        assert.ok(fs.statSync(b).size > 0);
      }
    });

    test("cleans up stale staging files from dead processes", () => {
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      const dir = path.dirname(workflowPath);
      fs.mkdirSync(dir, { recursive: true });

      // Write dead staging file with non-existent PID 9999999
      const staleStaging = path.join(dir, `quality-gate.yml.playbook-tmp.9999999.${Date.now()}`);
      fs.writeFileSync(staleStaging, "abandoned staging content", "utf-8");

      assert.ok(fs.existsSync(staleStaging));

      // Running init should clean up dead process staging
      initCiWorkflow(tempDir, { provider: "github" });

      assert.equal(fs.existsSync(staleStaging), false);
    });
  });

  describe("D. Validation Engine & Security Invariants", () => {
    test("validates canonical generated workflow successfully", () => {
      const adapter = getCiAdapter("github");
      const canonical = adapter.generateWorkflow({ provider: "github" });

      const result = validateCiWorkflow(tempDir, { provider: "github", content: canonical });
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
      assert.equal(result.isPlaybookManaged, true);
      assert.equal(result.permissionsValid, true);
      assert.equal(result.triggersValid, true);
      assert.equal(result.pinnedActionsValid, true);
    });

    test("fails closed when forbidden pull_request_target trigger is used", () => {
      const adapter = getCiAdapter("github");
      const content = adapter
        .generateWorkflow({ provider: "github" })
        .replace("pull_request:", "pull_request_target:");

      const result = validateCiWorkflow(tempDir, { provider: "github", content });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("pull_request_target")));
    });

    test("fails closed when mandatory triggers are missing", () => {
      const adapter = getCiAdapter("github");
      const content = adapter
        .generateWorkflow({ provider: "github" })
        .replace("push:", "# push disabled:");

      const result = validateCiWorkflow(tempDir, { provider: "github", content });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("mandatory trigger 'push'")));
    });

    test("fails closed when write permissions are granted", () => {
      const adapter = getCiAdapter("github");
      const writeCases = [
        "permissions:\n  contents: write",
        "permissions:\n  pull-requests: write\n  contents: read",
        "permissions: write-all",
        "permissions:\n  id-token: write",
      ];

      for (const perm of writeCases) {
        const content = adapter
          .generateWorkflow({ provider: "github" })
          .replace("permissions:\n  contents: read", perm);

        const result = validateCiWorkflow(tempDir, { provider: "github", content });
        assert.equal(result.valid, false, `Expected permission failure for: ${perm}`);
        assert.ok(
          result.errors.some((e) => e.includes("forbidden write permission") || e.includes("read-only")),
          `Expected read-only error for: ${perm}`
        );
      }
    });

    test("fails closed when third-party action is not pinned to 40-character commit SHA", () => {
      const adapter = getCiAdapter("github");
      const mutableActions = [
        adapter
          .generateWorkflow({ provider: "github" })
          .replace(/actions\/checkout@[a-f0-9]{40}/, "actions/checkout@v4"),
        adapter
          .generateWorkflow({ provider: "github" })
          .replace(/actions\/setup-node@[a-f0-9]{40}/, "actions/setup-node@main"),
        adapter
          .generateWorkflow({ provider: "github" })
          .replace(/actions\/upload-artifact@[a-f0-9]{40}/, "actions/upload-artifact@v4.4.3"),
      ];

      for (const content of mutableActions) {
        const result = validateCiWorkflow(tempDir, { provider: "github", content });
        assert.equal(result.valid, false);
        assert.ok(
          result.errors.some((e) => e.includes("pinned to an immutable 40-character commit SHA")),
          "Expected immutable SHA error"
        );
      }
    });

    test("fails closed when required check name is missing or altered", () => {
      const adapter = getCiAdapter("github");
      const content = adapter
        .generateWorkflow({ provider: "github" })
        .replace(`name: "${CI_REQUIRED_CHECK_NAME}"`, 'name: "Generic CI Check"');

      const result = validateCiWorkflow(tempDir, { provider: "github", content });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("missing required check name")));
    });

    test("fails closed when managed markers are malformed or missing", () => {
      const adapter = getCiAdapter("github");
      const baseContent = adapter.generateWorkflow({ provider: "github" });

      // Missing end marker
      const missingEnd = baseContent.replace(CI_WORKFLOW_MARKERS.end, "");
      const res1 = validateCiWorkflow(tempDir, { provider: "github", content: missingEnd });
      assert.equal(res1.valid, false);
      assert.ok(res1.errors.some((e) => e.includes("Malformed or corrupted")));

      // Unmanaged file (no markers)
      const noMarkers = baseContent
        .replace(CI_WORKFLOW_MARKERS.start, "")
        .replace(CI_WORKFLOW_MARKERS.end, "");
      const res2 = validateCiWorkflow(tempDir, { provider: "github", content: noMarkers });
      assert.equal(res2.isPlaybookManaged, false);
      assert.ok(res2.errors.some((e) => e.includes("missing Playbook management markers")));
    });

    test("fails closed when core quality gate execution steps are removed", () => {
      const adapter = getCiAdapter("github");
      const stepsToTest = [
        "@ai-engineering-playbook/cli validate",
        "playbook lint",
        "@ai-engineering-playbook/cli inspect",
        "@ai-engineering-playbook/cli gate verify",
        "@ai-engineering-playbook/cli gate run --headless",
        "@ai-engineering-playbook/cli verify-evidence",
        "@ai-engineering-playbook/cli ci report",
        "actions/upload-artifact@",
      ];

      for (const step of stepsToTest) {
        const content = adapter.generateWorkflow({ provider: "github" }).replace(step, "# step removed");
        const result = validateCiWorkflow(tempDir, { provider: "github", content });
        assert.equal(result.valid, false, `Expected failure when removing step: ${step}`);
        assert.ok(result.errors.some((e) => e.includes("missing required step") || e.includes("missing required")));
      }
    });
  });

  describe("E. Status Inspection Subsystem", () => {
    test("reports 'missing' when workflow file does not exist", () => {
      const status = inspectCiStatus(tempDir, { provider: "github" });
      assert.equal(status.installed, false);
      assert.equal(status.status, "missing");
      assert.equal(status.isPlaybookManaged, false);
      assert.equal(status.requiredCheckName, CI_REQUIRED_CHECK_NAME);
    });

    test("reports 'valid' when canonical workflow is installed", () => {
      initCiWorkflow(tempDir, { provider: "github" });
      const status = inspectCiStatus(tempDir, { provider: "github" });
      assert.equal(status.installed, true);
      assert.equal(status.status, "valid");
      assert.equal(status.isPlaybookManaged, true);
      assert.equal(status.errors.length, 0);
    });

    test("reports 'modified' when workflow contains user edits outside canonical template", () => {
      initCiWorkflow(tempDir, { provider: "github" });
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      const existing = fs.readFileSync(workflowPath, "utf-8");
      // Add custom environment variable step
      fs.writeFileSync(workflowPath, existing.replace("npm ci", "npm ci --prefer-offline"), "utf-8");

      const status = inspectCiStatus(tempDir, { provider: "github" });
      assert.equal(status.installed, true);
      assert.equal(status.status, "modified");
      assert.equal(status.isPlaybookManaged, true);
    });

    test("reports 'unmanaged' when file exists without Playbook markers", () => {
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      fs.writeFileSync(workflowPath, "name: Unmanaged Workflow\non: [push]\njobs: {}", "utf-8");

      const status = inspectCiStatus(tempDir, { provider: "github" });
      assert.equal(status.installed, true);
      assert.equal(status.status, "unmanaged");
      assert.equal(status.isPlaybookManaged, false);
    });
  });

  describe("F. Programmatic Command Execution & Exit Codes", () => {
    test("runCiInit creates workflow and returns exitCode 0", () => {
      const res = runCiInit({ cwd: tempDir, provider: "github" });
      assert.equal(res.success, true);
      assert.equal(res.exitCode, 0);
      assert.equal(res.data?.action, "created");
    });

    test("runCiValidate returns exitCode 0 on valid workflow", () => {
      runCiInit({ cwd: tempDir, provider: "github" });
      const res = runCiValidate({ cwd: tempDir, provider: "github" });
      assert.equal(res.success, true);
      assert.equal(res.exitCode, 0);
      assert.equal(res.data?.valid, true);
    });

    test("runCiValidate returns exitCode 2 when file does not exist", () => {
      const res = runCiValidate({ cwd: tempDir, provider: "github" });
      assert.equal(res.success, false);
      assert.equal(res.exitCode, 2);
      assert.equal(res.error, "WORKFLOW_NOT_FOUND");
    });

    test("runCiStatus returns exitCode 0 when valid, 1 when missing", () => {
      // Missing
      const res1 = runCiStatus({ cwd: tempDir, provider: "github" });
      assert.equal(res1.success, false);
      assert.equal(res1.exitCode, 1);

      // Valid
      runCiInit({ cwd: tempDir, provider: "github" });
      const res2 = runCiStatus({ cwd: tempDir, provider: "github" });
      assert.equal(res2.success, true);
      assert.equal(res2.exitCode, 0);
    });

    test("supports custom output path via options", () => {
      const customPath = "custom/workflows/gate.yml";
      const initRes = runCiInit({ cwd: tempDir, output: customPath });
      assert.equal(initRes.success, true);
      assert.ok(fs.existsSync(path.join(tempDir, customPath)));

      const valRes = runCiValidate({ cwd: tempDir, file: customPath });
      assert.equal(valRes.success, true);
      assert.equal(valRes.exitCode, 0);
    });
  });

  describe("G. CLI Binary Invocation via playbook ci", () => {
    test("executes 'playbook ci init' via child process", async () => {
      const { stdout, stderr } = await execFileAsync("node", [
        cliBinPath,
        "ci",
        "init",
        "--cwd",
        tempDir,
        "--provider",
        "github",
      ]);

      assert.equal(stderr, "");
      assert.match(stdout, /Playbook Remote CI Workflow Initialization/);
      assert.match(stdout, /Successfully created Playbook CI workflow/);

      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      assert.ok(fs.existsSync(workflowPath));
    });

    test("executes 'playbook ci status --json' via child process", async () => {
      await execFileAsync("node", [cliBinPath, "ci", "init", "--cwd", tempDir]);

      const { stdout, stderr } = await execFileAsync("node", [
        cliBinPath,
        "ci",
        "status",
        "--cwd",
        tempDir,
        "--json",
      ]);

      assert.equal(stderr, "");
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.installed, true);
      assert.equal(parsed.status, "valid");
      assert.equal(parsed.requiredCheckName, CI_REQUIRED_CHECK_NAME);
    });

    test("executes 'playbook ci validate' via child process with exitCode 0", async () => {
      await execFileAsync("node", [cliBinPath, "ci", "init", "--cwd", tempDir]);

      const { stdout, stderr } = await execFileAsync("node", [
        cliBinPath,
        "ci",
        "validate",
        "--cwd",
        tempDir,
      ]);

      assert.equal(stderr, "");
      assert.match(stdout, /Playbook Remote CI Workflow Validation/);
      assert.match(stdout, /Overall Status:\s+✔ PASS/);
    });

    test("CLI returns exitCode 1 when validating an invalid workflow", async () => {
      const workflowPath = path.join(tempDir, DEFAULT_GITHUB_WORKFLOW_PATH);
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      fs.writeFileSync(workflowPath, "name: Invalid\non:\n  pull_request_target:\npermissions:\n  contents: write\n", "utf-8");

      try {
        await execFileAsync("node", [cliBinPath, "ci", "validate", "--cwd", tempDir]);
        assert.fail("Expected CLI command to fail with exitCode 1");
      } catch (err: unknown) {
        const error = err as { code: number; stdout: string; stderr: string };
        assert.equal(error.code, 1);
        assert.match(error.stdout, /Overall Status:\s+✖ FAIL/);
        assert.match(error.stdout, /pull_request_target/);
        assert.match(error.stdout, /forbidden write permission/);
      }
    });
  });
});
