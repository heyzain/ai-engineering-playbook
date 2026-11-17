import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { PreCommitEngine } from "../src/core/hooks/pre-commit-engine.js";
import {
  writeIndexTree,
  getStagedEntries,
  extractStagedIndexToDirectory,
  getUnmergedIndexEntries,
} from "../src/core/hooks/git-utils.js";
import { createInitialManifest } from "../src/templates/manifest-template.js";
import { createInitialState } from "../src/templates/state-template.js";

describe("PreCommitEngine — Staged Index Validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-precommit-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.name "Test Engineer"', { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks
    }
  });

  test("returns success and exit 0 when no files are staged", async () => {
    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.stagedFilesCount, 0);
    assert(res.message.includes("No staged changes detected"));
  });

  test("rejects commit when staged manifest.json violates schema", async () => {
    const playbookDir = path.join(tmpDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });

    const invalidManifest = { schema_version: "1.0.0", invalid: true };
    fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(invalidManifest), "utf-8");
    execSync("git add .playbook/manifest.json", { cwd: tmpDir, stdio: "ignore" });

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.exitCode, 1);
    assert(res.message.includes("[PRECOMMIT_GOVERNANCE_INVALID]"));
    assert(res.message.includes("manifest.json failed schema validation"));
  });

  test("rejects commit when staged state.json contains invalid JSON syntax", async () => {
    const playbookDir = path.join(tmpDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });

    fs.writeFileSync(path.join(playbookDir, "state.json"), "{ invalid json string", "utf-8");
    execSync("git add .playbook/state.json", { cwd: tmpDir, stdio: "ignore" });

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.exitCode, 1);
    assert(res.message.includes("[PRECOMMIT_GOVERNANCE_INVALID]"));
    assert(res.message.includes("contains invalid JSON"));
  });

  test("rejects commit when staged state.json violates state schema", async () => {
    const playbookDir = path.join(tmpDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });

    const invalidState = { schema_version: "1.0.0", stage_status: "not_a_valid_status" };
    fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(invalidState), "utf-8");
    execSync("git add .playbook/state.json", { cwd: tmpDir, stdio: "ignore" });

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.exitCode, 1);
    assert(res.message.includes("[PRECOMMIT_GOVERNANCE_INVALID]"));
    assert(res.message.includes("state.json failed schema validation"));
  });

  test("passes validation when staged governance files conform to schemas", async () => {
    const playbookDir = path.join(tmpDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });

    const validManifest = createInitialManifest({
      projectId: "test-project",
      projectName: "Test Project",
    });

    const validState = createInitialState({
      projectId: "test-project",
    });

    fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(validManifest, null, 2), "utf-8");
    fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(validState, null, 2), "utf-8");

    execSync("git add .playbook/manifest.json .playbook/state.json", { cwd: tmpDir, stdio: "ignore" });

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
  });

  test("fails closed when repository contains unmerged index entries (merge conflicts)", async () => {
    const conflictFile = path.join(tmpDir, "conflict.txt");
    fs.writeFileSync(conflictFile, "base line\n", "utf-8");
    execSync("git add conflict.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "base commit"', { cwd: tmpDir, stdio: "ignore" });

    const defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Branch A
    execSync("git checkout -b branch-a", { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(conflictFile, "line from branch A\n", "utf-8");
    execSync("git add conflict.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "branch A edit"', { cwd: tmpDir, stdio: "ignore" });

    // Back to default branch
    execSync(`git checkout ${defaultBranch}`, { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(conflictFile, "line from main\n", "utf-8");
    execSync("git add conflict.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "main edit"', { cwd: tmpDir, stdio: "ignore" });

    // Merge branch-a to induce conflict
    try {
      execSync("git merge branch-a", { cwd: tmpDir, stdio: "ignore" });
    } catch {
      // Expected conflict
    }

    const unmerged = getUnmergedIndexEntries(tmpDir);
    assert(unmerged.length > 0, "Merge conflict must create unmerged index entries");

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.exitCode, 1);
    assert(res.message.includes("[UNMERGED_INDEX_ENTRIES]"));
    assert(res.message.includes("conflict.txt"));
  });

  test("accurately preserves and extracts binary files without corruption", async () => {
    const binaryData = Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const binaryPath = path.join(tmpDir, "asset.bin");
    fs.writeFileSync(binaryPath, binaryData);
    execSync("git add asset.bin", { cwd: tmpDir, stdio: "ignore" });

    const shadowDir = path.join(tmpDir, ".playbook", ".tmp", "test-binary-extract");
    extractStagedIndexToDirectory(tmpDir, shadowDir);

    const extractedBinary = fs.readFileSync(path.join(shadowDir, "asset.bin"));
    assert.deepStrictEqual(extractedBinary, binaryData, "Binary file bytes must be preserved byte-for-byte");
  });

  test("accurately handles staged renames and deletions in shadow extraction", async () => {
    fs.writeFileSync(path.join(tmpDir, "old-name.txt"), "rename test\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "delete-me.txt"), "delete test\n", "utf-8");
    execSync("git add old-name.txt delete-me.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "initial files"', { cwd: tmpDir, stdio: "ignore" });

    // Rename old-name.txt -> new-name.txt
    execSync("git mv old-name.txt new-name.txt", { cwd: tmpDir, stdio: "ignore" });
    // Delete delete-me.txt
    execSync("git rm delete-me.txt", { cwd: tmpDir, stdio: "ignore" });

    const shadowDir = path.join(tmpDir, ".playbook", ".tmp", "test-rename-delete");
    extractStagedIndexToDirectory(tmpDir, shadowDir);

    assert(fs.existsSync(path.join(shadowDir, "new-name.txt")), "Renamed file must exist at new path");
    assert(!fs.existsSync(path.join(shadowDir, "old-name.txt")), "Old renamed path must not exist");
    assert(!fs.existsSync(path.join(shadowDir, "delete-me.txt")), "Deleted file must not be extracted");
  });

  test("respects partial staging: extracts strictly staged index content into shadow directory", async () => {
    const testFile = path.join(tmpDir, "sample.txt");
    fs.writeFileSync(testFile, "initial content\n", "utf-8");
    execSync("git add sample.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: "ignore" });

    // Modify file on disk and stage only partial change
    fs.writeFileSync(testFile, "staged line\n", "utf-8");
    execSync("git add sample.txt", { cwd: tmpDir, stdio: "ignore" });

    // Now modify working tree WITHOUT staging
    fs.writeFileSync(testFile, "unstaged dirty modifications\n", "utf-8");

    // PreCommitEngine should read the staged content from index, not the dirty working tree
    const entries = getStagedEntries(tmpDir);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].path, "sample.txt");

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);

    // Working tree file must remain completely untouched
    assert.strictEqual(fs.readFileSync(testFile, "utf-8"), "unstaged dirty modifications\n");
  });

  test("safely cleans up ephemeral shadow extraction sandbox", async () => {
    const playbookDir = path.join(tmpDir, ".playbook");
    fs.mkdirSync(playbookDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello world\n", "utf-8");
    execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });

    const engine = new PreCommitEngine(tmpDir);
    const res = await engine.validate();
    assert.strictEqual(res.success, true);

    const tmpPath = path.join(tmpDir, ".playbook", ".tmp");
    if (fs.existsSync(tmpPath)) {
      const dirs = fs.readdirSync(tmpPath).filter((d) => d.startsWith("staged-"));
      assert.strictEqual(dirs.length, 0, "All staged shadow extraction directories must be cleaned up");
    }
  });

  test("executes pre-commit staged validation in actual SHA-256 Git repository", async () => {
    const sha256Dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-precommit-sha256-"));
    try {
      execSync("git init --object-format=sha256", { cwd: sha256Dir, stdio: "ignore" });
      execSync('git config user.name "SHA256 Commit Tester"', { cwd: sha256Dir, stdio: "ignore" });
      execSync('git config user.email "sha256commit@example.com"', { cwd: sha256Dir, stdio: "ignore" });

      fs.writeFileSync(path.join(sha256Dir, "index.ts"), "export const hello = 'sha256';\n", "utf-8");
      execSync("git add index.ts", { cwd: sha256Dir, stdio: "ignore" });

      const engine = new PreCommitEngine(sha256Dir);
      const res = await engine.validate();

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.stagedFilesCount, 1);
    } finally {
      try {
        fs.rmSync(sha256Dir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });
});
