import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");

describe("CLI Executable Integration (playbook)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-cli-e2e-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("prints version flag --version", async () => {
    const { stdout, stderr } = await execFileAsync("node", [cliBinPath, "--version"]);
    assert.equal(stderr, "");
    assert.match(stdout, /@ai-engineering-playbook\/cli v1\.0\.0/);
    assert.match(stdout, /Playbook Standard v1\.0\.0/);
  });

  test("prints help flag --help", async () => {
    const { stdout, stderr } = await execFileAsync("node", [cliBinPath, "--help"]);
    assert.equal(stderr, "");
    assert.match(stdout, /Usage:/);
    assert.match(stdout, /playbook <command> \[options\]/);
  });

  test("executes playbook init and playbook validate end-to-end", async () => {
    // 1. Run init in temp directory
    const initRes = await execFileAsync("node", [
      cliBinPath,
      "init",
      "--cwd",
      tempDir,
      "--non-interactive",
      "--project-id",
      "test-service",
      "--name",
      "Test Service Platform",
      "--ecosystem",
      "node",
      "--language",
      "typescript",
      "--profile",
      "strict",
      "--mode",
      "solo",
    ]);

    assert.match(initRes.stdout, /AI Engineering Playbook Initialized Successfully/);
    assert.match(initRes.stdout, /Project ID:\s+test-service/);

    // Verify files on disk
    const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
    const statePath = path.join(tempDir, ".playbook", "state.json");
    assert.ok(fs.existsSync(manifestPath));
    assert.ok(fs.existsSync(statePath));

    // 2. Run validate in temp directory
    const valRes = await execFileAsync("node", [cliBinPath, "validate", "--cwd", tempDir]);
    assert.match(valRes.stdout, /\[manifest\] Valid/);
    assert.match(valRes.stdout, /\[state\] Valid/);
    assert.match(valRes.stdout, /All governance files conform to official JSON Schemas/);

    // 3. Verify collision protection without --force fails
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          cliBinPath,
          "init",
          "--cwd",
          tempDir,
          "--non-interactive",
          "--project-id",
          "test-service",
        ]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /already exists/);
        return true;
      }
    );

    // 4. Overwrite with --force succeeds
    const forceRes = await execFileAsync("node", [
      cliBinPath,
      "init",
      "--cwd",
      tempDir,
      "--non-interactive",
      "--project-id",
      "test-service-overwritten",
      "--force",
    ]);
    assert.match(forceRes.stdout, /Project ID:\s+test-service-overwritten/);
  });

  test("rejects unknown commands with non-zero exit code", async () => {
    await assert.rejects(
      async () => {
        await execFileAsync("node", [cliBinPath, "invalid-command"]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /Unknown command "invalid-command"/);
        return true;
      }
    );
  });

  test("executes playbook approve with --non-interactive and strictly rejects with TTY_REQUIRED", async () => {
    await assert.rejects(
      async () => {
        await execFileAsync("node", [
          cliBinPath,
          "approve",
          "--cwd",
          tempDir,
          "--non-interactive",
        ]);
      },
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr || "", /TTY_REQUIRED/);
        return true;
      }
    );
  });
});
