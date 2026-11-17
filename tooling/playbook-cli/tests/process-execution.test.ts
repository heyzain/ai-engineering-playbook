import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { resolveExecutable, findNpmCliScript } from "../src/core/process-execution.js";
import { QualityGateRunner } from "../src/core/quality-gates/runner.js";
import type { QualityGatesConfig } from "../src/types/quality-gates.js";

describe("Cross-Platform Process Execution & Hardening (Task 007D.2.2)", () => {
  let tmpDir: string;
  let playbookDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-proc-test-"));
    playbookDir = path.join(tmpDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.mkdirSync(path.join(playbookDir, "logs"), { recursive: true });

    // Seed state.json
    const state = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
      schema_version: "1.1.0",
      project_id: "proc-test",
      playbook_version: "1.0.0",
      milestone_id: "M-1.0.0",
      milestone_name: "Initial MVP Release",
      lifecycle_status: "active",
      current_stage: 4,
      stage_status: "in_progress",
      stage_history: [],
      archived_milestones: [],
      last_updated: {
        timestamp: new Date().toISOString(),
        updated_by: "agent:test",
        actor_type: "agent",
        reason: "Test initialization",
      },
      current_stage_detail: {
        stage: 4,
        stage_name: "Integration & System Verification",
        started_at: new Date().toISOString(),
        deliverables: [
          {
            id: "CODE-IMPL",
            name: "Production Source Code Implementation",
            description: "Implementation",
            artifact_path: "src/",
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
          path: "docs/gates/GATE-4-EXIT-PACKAGE.md",
          submitted_at: null,
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
    };
    fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");

    // Seed manifest.json
    const manifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      project_id: "proc-test",
      project_name: "Process Execution Test",
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
      active_lifecycle_stage: 4,
      capabilities: [],
      technology_stacks: [],
    };
    fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup locks
    }
  });

  describe("1. Executable Resolution Strategy", () => {
    test("findNpmCliScript locates npm-cli.js and npx-cli.js", () => {
      const npmScript = findNpmCliScript("npm");
      const npxScript = findNpmCliScript("npx");
      assert.ok(npmScript, "npm CLI script should be located");
      assert.ok(npxScript, "npx CLI script should be located");
      assert.ok(fs.existsSync(npmScript), `npm script must exist on disk: ${npmScript}`);
      assert.ok(fs.existsSync(npxScript), `npx script must exist on disk: ${npxScript}`);
      assert.match(npmScript, /npm-cli\.js$/i);
      assert.match(npxScript, /npx-cli\.js$/i);
    });

    test("resolves 'node' directly to process.execPath", () => {
      const resolved = resolveExecutable("node", ["-v"]);
      assert.equal(resolved.file, process.execPath);
      assert.deepEqual(resolved.args, ["-v"]);
    });

    test("resolves 'npm' to process.execPath with npm-cli entrypoint", () => {
      const resolved = resolveExecutable("npm", ["--version"]);
      assert.equal(resolved.file, process.execPath);
      assert.ok(resolved.args.length >= 2);
      assert.match(resolved.args[0], /npm-cli\.js$/i);
      assert.equal(resolved.args[1], "--version");
    });

    test("resolves 'npx' to process.execPath with npx-cli entrypoint", () => {
      const resolved = resolveExecutable("npx", ["--version"]);
      assert.equal(resolved.file, process.execPath);
      assert.ok(resolved.args.length >= 2);
      assert.match(resolved.args[0], /npx-cli\.js$/i);
      assert.equal(resolved.args[1], "--version");
    });

    test("preserves Linux/macOS standard commands without regression", () => {
      const resolved = resolveExecutable("cat", ["file.txt"]);
      if (process.platform !== "win32") {
        assert.equal(resolved.file, "cat");
        assert.deepEqual(resolved.args, ["file.txt"]);
      } else {
        assert.ok(resolved.file);
      }
    });

    test("resolves local node_modules tsc when available", () => {
      // Create mock node_modules/typescript/bin/tsc
      const mockTsc = path.join(tmpDir, "node_modules", "typescript", "bin", "tsc");
      fs.mkdirSync(path.dirname(mockTsc), { recursive: true });
      fs.writeFileSync(mockTsc, "console.log('mock tsc');", "utf-8");

      const resolved = resolveExecutable("tsc", ["--noEmit"], { cwd: tmpDir });
      assert.equal(resolved.file, process.execPath);
      assert.equal(resolved.args[0], mockTsc);
      assert.equal(resolved.args[1], "--noEmit");
    });
  });

  describe("2. Argument Boundary Preservation & Shell Neutrality", () => {
    test("preserves spaces and shell meta-characters without shell execution", async () => {
      const testArgs = [
        "argument with spaces",
        "arg;with&pipe|and<redirection>",
        "double \"quoted\" and single 'quoted'",
        "path\\with\\backslashes",
      ];

      const resolved = resolveExecutable("node", [
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1)))",
        ...testArgs,
      ]);

      const captured = await new Promise<string[]>((resolve, reject) => {
        let output = "";
        const child = spawn(resolved.file, resolved.args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", (d) => (output += d.toString()));
        child.on("close", (code) => {
          if (code === 0) {
            resolve(JSON.parse(output.trim()));
          } else {
            reject(new Error(`Child exited with code ${code}`));
          }
        });
      });

      assert.deepEqual(captured, testArgs, "Every argument must be preserved verbatim without shell word splitting");
    });
  });

  describe("3. QualityGateRunner Integration & Process Execution", () => {
    function setupQualityGatesConfig(checkCommand: string, checkArgs: string[], extraSettings?: any): QualityGatesConfig {
      const config: QualityGatesConfig = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: "proc-test",
        default_profile: "standard",
        global_settings: {
          default_timeout_ms: 30000,
          max_concurrency: 1,
          mask_secrets: true,
          log_retention_runs: 5,
          max_journaled_log_bytes: 1048576,
          env_allowlist: ["NODE_ENV", "PATH"],
          ...(extraSettings || {}),
        },
        gates: [
          {
            stage: 4,
            stage_name: "Integration & System Verification",
            checks: [
              {
                id: "test-proc-check",
                name: "Process Execution Check",
                type: "static_analysis",
                deliverable_id: "CODE-IMPL",
                command: checkCommand,
                args: checkArgs,
                inputs: ["src/**/*"],
                severity: "blocking",
              },
            ],
          },
        ],
      };
      fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(config, null, 2), "utf-8");
      return config;
    }

    test("successfully executes 'node' check and captures stdout/stderr", async () => {
      setupQualityGatesConfig("node", [
        "-e",
        "console.log('stdout message'); console.error('stderr message'); process.exit(0);",
      ]);

      const runner = new QualityGateRunner(tmpDir);
      const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

      assert.equal(report.overall_outcome, "passed");
      assert.equal(report.checks.length, 1);
      assert.equal(report.checks[0].outcome, "passed");
      assert.equal(report.checks[0].exit_code, 0);

      // Verify canonical log captures stdout and stderr
      const logFiles = fs.readdirSync(path.join(playbookDir, "logs")).filter((f) => f.endsWith(".log"));
      assert.ok(logFiles.length >= 1, "Log file should be produced");
      const logContent = fs.readFileSync(path.join(playbookDir, "logs", logFiles[0]), "utf-8");
      assert.match(logContent, /stdout message/);
      assert.match(logContent, /stderr message/);
    });

    test("successfully resolves and executes 'npm' check via QualityGateRunner", async () => {
      setupQualityGatesConfig("npm", ["--version"]);

      const runner = new QualityGateRunner(tmpDir);
      const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

      assert.equal(report.overall_outcome, "passed");
      assert.equal(report.checks[0].outcome, "passed");
      assert.equal(report.checks[0].exit_code, 0);
    });

    test("successfully resolves and executes 'npx' check via QualityGateRunner", async () => {
      setupQualityGatesConfig("npx", ["--version"]);

      const runner = new QualityGateRunner(tmpDir);
      const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

      assert.equal(report.overall_outcome, "passed");
      assert.equal(report.checks[0].outcome, "passed");
      assert.equal(report.checks[0].exit_code, 0);
    });

    test("propagates non-zero exit code accurately", async () => {
      setupQualityGatesConfig("node", ["-e", "console.error('Fatal failure'); process.exit(42);"]);

      const runner = new QualityGateRunner(tmpDir);
      const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

      assert.equal(report.overall_outcome, "failed");
      assert.equal(report.checks[0].outcome, "failed");
      assert.equal(report.checks[0].exit_code, 42);
    });

    test("handles non-existent command with clean ENOENT failure without crashing", async () => {
      setupQualityGatesConfig("completely-non-existent-binary-xyz-987", ["--flag"]);

      const runner = new QualityGateRunner(tmpDir);
      const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

      assert.equal(report.overall_outcome, "failed");
      assert.equal(report.checks[0].outcome, "failed");
      assert.equal(report.checks[0].exit_code, null);
    });

    test("handles command timeout and terminates process tree", async () => {
      setupQualityGatesConfig(
        "node",
        ["-e", "setInterval(() => {}, 1000);"], // infinite loop
        { default_timeout_ms: 1000 } // 1 second timeout
      );

      const runner = new QualityGateRunner(tmpDir);
      const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

      assert.equal(report.overall_outcome, "failed");
      assert.equal(report.checks[0].outcome, "timed_out");
    });

    test("strictly enforces environment allowlist against unpermitted variables", async () => {
      process.env.FORBIDDEN_SECRET_KEY = "super-secret-token";
      try {
        setupQualityGatesConfig("node", [
          "-e",
          "if (process.env.FORBIDDEN_SECRET_KEY) { process.exit(99); } else { process.exit(0); }",
        ]);

        const runner = new QualityGateRunner(tmpDir);
        const report = await runner.run({ stage: 4, checkId: "test-proc-check" });

        assert.equal(report.overall_outcome, "passed", "Forbidden secret must not leak to child process");
        assert.equal(report.checks[0].exit_code, 0);
      } finally {
        delete process.env.FORBIDDEN_SECRET_KEY;
      }
    });
  });
});
