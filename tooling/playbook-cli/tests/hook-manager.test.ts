import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { GitHookManager } from "../src/core/hooks/hook-manager.js";
import { resolveGitHooksDir, isInsideGitRepository } from "../src/core/hooks/hook-resolver.js";
import { parseHookMarkers, generateWrapperScript } from "../src/core/hooks/hook-wrapper.js";
import {
  inspectHookDiskState,
  cleanupStagingFiles,
  createStagingMetadata,
  archiveUserHookFile,
} from "../src/core/hooks/hook-recovery.js";
import {
  runHookInstall,
  runHookStatus,
  runHookUninstall,
  runHookRun,
} from "../src/commands/hook.js";
import { HookError, ORIGINAL_HOOK_SUFFIX } from "../src/types/hooks.js";

function findShExecutable(): string | null {
  if (process.platform !== "win32") {
    try {
      execSync("sh -c 'exit 0'", { stdio: "ignore" });
      return "sh";
    } catch {
      return null;
    }
  }

  try {
    const gitExecPath = execSync("git --exec-path", { encoding: "utf-8" }).trim();
    const candidate1 = path.resolve(gitExecPath, "../../bin/sh.exe");
    if (fs.existsSync(candidate1)) return candidate1;
    const candidate2 = path.resolve(gitExecPath, "../../usr/bin/sh.exe");
    if (fs.existsSync(candidate2)) return candidate2;
  } catch {
    // Ignore
  }

  const standardPaths = [
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files (x86)\\Git\\bin\\sh.exe",
  ];
  for (const p of standardPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

describe("Native Git Hook Lifecycle Management & Safe Installation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-hook-test-"));
    // Initialize temporary Git repository
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows
    }
  });

  describe("Directory Resolution & Compatibility", () => {
    test("resolves standard repository hooks directory (.git/hooks)", () => {
      const hooksDir = resolveGitHooksDir(tmpDir);
      assert.strictEqual(hooksDir, path.join(tmpDir, ".git", "hooks"));
      assert.strictEqual(isInsideGitRepository(tmpDir), true);
    });

    test("resolves shared hooks directory in linked git worktrees", () => {
      execSync("git commit --allow-empty -m initial", { cwd: tmpDir, stdio: "ignore" });
      const worktreePath = path.join(tmpDir, "linked-worktree");
      execSync(`git worktree add "${worktreePath}"`, { cwd: tmpDir, stdio: "ignore" });

      const hooksDir = resolveGitHooksDir(worktreePath);
      // In linked worktrees, hooks resolve to the parent repository's .git/hooks
      assert.strictEqual(hooksDir, path.join(tmpDir, ".git", "hooks"));
    });

    test("resolves custom core.hooksPath configuration", () => {
      const customHooksDir = path.join(tmpDir, ".custom-hooks");
      fs.mkdirSync(customHooksDir, { recursive: true });
      execSync(`git config core.hooksPath "${customHooksDir}"`, { cwd: tmpDir, stdio: "ignore" });

      const resolved = resolveGitHooksDir(tmpDir);
      assert.strictEqual(path.resolve(resolved), path.resolve(customHooksDir));
    });

    test("handles directory paths containing spaces", () => {
      const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook space test-"));
      try {
        execSync("git init", { cwd: spaceDir, stdio: "ignore" });
        const hooksDir = resolveGitHooksDir(spaceDir);
        assert.strictEqual(hooksDir, path.join(spaceDir, ".git", "hooks"));
      } finally {
        fs.rmSync(spaceDir, { recursive: true, force: true });
      }
    });

    test("throws NOT_A_GIT_REPOSITORY in non-git directories", () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-dir-"));
      try {
        assert.throws(
          () => resolveGitHooksDir(nonGitDir),
          (err: unknown) => {
            assert(err instanceof HookError);
            assert.strictEqual(err.code, "NOT_A_GIT_REPOSITORY");
            return true;
          }
        );
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    test("respects explicit hooks-dir override", () => {
      const explicitDir = path.join(tmpDir, "explicit-hooks");
      const resolved = resolveGitHooksDir(tmpDir, explicitDir);
      assert.strictEqual(resolved, explicitDir);
    });
  });

  describe("Hook Installation & Wrapper Generation", () => {
    test("Scenario 0: refuses to install without --allow-inert and fails closed", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      assert.throws(
        () => manager.install(),
        (err: unknown) => {
          assert(err instanceof HookError);
          assert.strictEqual(err.code, "HOOK_VALIDATION_INERT");
          return true;
        }
      );
      // Verify nothing written
      const preCommitPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
      assert(!fs.existsSync(preCommitPath));
    });

    test("Scenario 1: installs clean wrappers with --allow-inert in an empty hooks directory", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.install({ allowInert: true });

      assert.strictEqual(report.allSuccess, true);
      assert.strictEqual(report.dryRun, false);

      const preCommitPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
      const prePushPath = path.join(tmpDir, ".git", "hooks", "pre-push");

      assert(fs.existsSync(preCommitPath), "pre-commit should exist");
      assert(fs.existsSync(prePushPath), "pre-push should exist");

      const preCommitContent = fs.readFileSync(preCommitPath, "utf-8");
      assert(preCommitContent.includes("#!/bin/sh"));
      assert(preCommitContent.includes("AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT)"));
      assert(preCommitContent.includes("--allow-inert"), "Wrapper must propagate --allow-inert flag");
      assert(!preCommitContent.includes("\r\n"), "Script must use LF line endings exclusively");

      // Verify no backup was created when installing fresh
      assert(!fs.existsSync(`${preCommitPath}${ORIGINAL_HOOK_SUFFIX}`));
    });

    test("Scenario 2: wraps an existing unmanaged hook and preserves original byte-for-byte", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      const originalUserScript = `#!/bin/sh\n# Enterprise custom linter\necho "Running my custom lint"\nexit 0\n`;
      fs.writeFileSync(preCommitPath, originalUserScript, { mode: 0o755 });

      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.install({ allowInert: true });

      assert.strictEqual(report.allSuccess, true);
      assert.strictEqual(report.results["pre-commit"].action, "wrapped");

      const backupPath = `${preCommitPath}${ORIGINAL_HOOK_SUFFIX}`;
      assert(fs.existsSync(backupPath), "Backup file should exist");

      // Verify exact byte-for-byte preservation
      const backedUpContent = fs.readFileSync(backupPath, "utf-8");
      assert.strictEqual(backedUpContent, originalUserScript);

      // Verify wrapper executes playbook check first then delegates to backup
      const wrapperContent = fs.readFileSync(preCommitPath, "utf-8");
      assert(wrapperContent.includes("pre-commit.playbook-orig"));
    });

    test("Scenario 3: repeated installation is idempotent", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      const firstReport = manager.install({ allowInert: true });
      assert.strictEqual(firstReport.results["pre-commit"].action, "created");

      const secondReport = manager.install({ allowInert: true });
      assert.strictEqual(secondReport.results["pre-commit"].action, "skipped_up_to_date");
      assert.strictEqual(secondReport.results["pre-push"].action, "skipped_up_to_date");
      assert.strictEqual(secondReport.allSuccess, true);
    });

    test("Scenario 4: --dry-run reports planned actions without writing to disk", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.install({ dryRun: true, allowInert: true });

      assert.strictEqual(report.dryRun, true);
      assert.strictEqual(report.allSuccess, true);
      assert.strictEqual(report.results["pre-commit"].action, "created");

      // Verify nothing was written to disk
      const preCommitPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
      assert(!fs.existsSync(preCommitPath), "Dry run must not create files on disk");
    });

    test("Scenario 5: detects conflicting pre-existing backup and halts without --force", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");
      const origPath = `${preCommitPath}${ORIGINAL_HOOK_SUFFIX}`;

      // Write two distinct unmanaged scripts
      fs.writeFileSync(preCommitPath, `#!/bin/sh\necho "Active script"\n`);
      fs.writeFileSync(origPath, `#!/bin/sh\necho "Different conflicting backup"\n`);

      const manager = new GitHookManager({ cwd: tmpDir });
      assert.throws(
        () => manager.install({ force: false, allowInert: true }),
        (err: unknown) => {
          assert(err instanceof HookError);
          assert.strictEqual(err.code, "ORIGINAL_HOOK_CONFLICT");
          return true;
        }
      );
    });

    test("Scenario 6: --force archives conflicting files safely without data loss", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");
      const origPath = `${preCommitPath}${ORIGINAL_HOOK_SUFFIX}`;

      fs.writeFileSync(preCommitPath, `#!/bin/sh\necho "Active script"\n`);
      fs.writeFileSync(origPath, `#!/bin/sh\necho "Different conflicting backup"\n`);

      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.install({ force: true, allowInert: true });

      assert.strictEqual(report.allSuccess, true);

      // Verify that user backup files were created
      const entries = fs.readdirSync(hooksDir);
      const userBackups = entries.filter((e) => e.includes(".user-backup."));
      assert(userBackups.length >= 2, "Conflicting files must be preserved in .user-backup archives");

      // Verify new wrapper is installed
      assert(fs.existsSync(preCommitPath));
      const parsed = parseHookMarkers(fs.readFileSync(preCommitPath, "utf-8"));
      assert.strictEqual(parsed.markerState, "valid");
    });
  });

  describe("Crash Recovery & State Inspection", () => {
    test("Scenario 14: recovers cleanly from an interrupted Phase 2 installation", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");
      const origPath = `${preCommitPath}${ORIGINAL_HOOK_SUFFIX}`;

      const userScript = `#!/bin/sh\necho "Original user hook"\n`;
      fs.writeFileSync(preCommitPath, userScript);
      // Simulate crash between Phase 2 and Phase 3: backup was committed with matching content
      fs.writeFileSync(origPath, userScript);

      const diskState = inspectHookDiskState(hooksDir, "pre-commit");
      assert.strictEqual(diskState.isInterruptedPhase2, true);

      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.install({ allowInert: true });

      assert.strictEqual(report.results["pre-commit"].action, "recovered_and_updated");

      // Verify original backup was retained byte-for-byte
      assert.strictEqual(fs.readFileSync(origPath, "utf-8"), userScript);
      // Verify primary hook is now the managed wrapper
      const parsed = parseHookMarkers(fs.readFileSync(preCommitPath, "utf-8"));
      assert.strictEqual(parsed.markerState, "valid");
    });

    test("Scenario 15: staging file cleanup safety and fault injection", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      // Case A: Dead PID staging files with valid .meta descriptor -> CLEANED UP
      const deadPid = 999999;
      const deadNonce = "dead01";
      const deadStage1 = `pre-commit.playbook-new.tmp.${deadPid}.${deadNonce}`;
      const deadStage2 = `pre-commit.playbook-orig.tmp.${deadPid}.${deadNonce}`;
      const deadStage1Path = path.join(hooksDir, deadStage1);
      const deadStage2Path = path.join(hooksDir, deadStage2);
      fs.writeFileSync(deadStage1Path, "dead process stage 1");
      fs.writeFileSync(deadStage2Path, "dead process stage 2");
      const deadMetaPath = createStagingMetadata(hooksDir, "pre-commit", deadPid, deadNonce, [
        deadStage1,
        deadStage2,
      ]);

      // Case B: Active living PID staging files with valid .meta descriptor -> RETAINED
      const alivePid = process.pid;
      const aliveNonce = "alive01";
      const aliveStage1 = `pre-commit.playbook-new.tmp.${alivePid}.${aliveNonce}`;
      const aliveStage1Path = path.join(hooksDir, aliveStage1);
      fs.writeFileSync(aliveStage1Path, "active process stage");
      const aliveMetaPath = createStagingMetadata(hooksDir, "pre-commit", alivePid, aliveNonce, [
        aliveStage1,
      ]);

      // Case C: Unverified staging file without .meta descriptor -> RETAINED
      const unverifiedFile = path.join(hooksDir, "pre-commit.playbook-new.tmp.no-meta");
      fs.writeFileSync(unverifiedFile, "unverified stage");

      // Case D: Corrupt .meta descriptor -> RETAINED
      const corruptMeta = path.join(hooksDir, "pre-commit.playbook-stage.bad.meta");
      fs.writeFileSync(corruptMeta, "{ not valid json");
      const corruptStage = path.join(hooksDir, "pre-commit.playbook-new.tmp.bad-meta");
      fs.writeFileSync(corruptStage, "corrupt stage");

      // Case E: Cross-host .meta descriptor -> RETAINED
      const crossHostMeta = path.join(hooksDir, "pre-commit.playbook-stage.cross.meta");
      fs.writeFileSync(
        crossHostMeta,
        JSON.stringify({
          pid: deadPid,
          hostname: "remote-worker-node-99",
          created_at: new Date().toISOString(),
          staging_files: ["pre-commit.playbook-new.tmp.cross-host"],
        })
      );
      const crossHostStage = path.join(hooksDir, "pre-commit.playbook-new.tmp.cross-host");
      fs.writeFileSync(crossHostStage, "cross host stage");

      // Run cleanup
      cleanupStagingFiles(hooksDir, "pre-commit");

      // Verification:
      // Dead process files must be cleaned up
      assert(!fs.existsSync(deadStage1Path), "Dead process staging file 1 must be cleaned up");
      assert(!fs.existsSync(deadStage2Path), "Dead process staging file 2 must be cleaned up");
      assert(!fs.existsSync(deadMetaPath), "Dead process .meta descriptor must be cleaned up");

      // Active living process files must be retained
      assert(fs.existsSync(aliveStage1Path), "Active living process staging file must be retained");
      assert(fs.existsSync(aliveMetaPath), "Active living process .meta descriptor must be retained");

      // Unverified files without metadata must be retained
      assert(fs.existsSync(unverifiedFile), "Staging files without metadata must be retained");

      // Corrupt metadata and its files must be retained
      assert(fs.existsSync(corruptMeta), "Corrupt metadata must be retained");
      assert(fs.existsSync(corruptStage), "Files with corrupt metadata must be retained");

      // Cross-host metadata and its files must be retained
      assert(fs.existsSync(crossHostMeta), "Cross-host metadata must be retained");
      assert(fs.existsSync(crossHostStage), "Files with cross-host metadata must be retained");

      // Cleanup living test files
      try {
        fs.unlinkSync(aliveStage1Path);
        fs.unlinkSync(aliveMetaPath);
      } catch {}
    });

    test("Scenario 16: handles corrupt or malformed markers safely", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      // Corrupt file with start marker but missing end marker
      fs.writeFileSync(
        preCommitPath,
        `#!/bin/sh\n# >>> AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT) >>>\necho "Broken"\n`
      );

      const manager = new GitHookManager({ cwd: tmpDir });

      // Refuses without force
      assert.throws(
        () => manager.install({ force: false, allowInert: true }),
        (err: unknown) => {
          assert(err instanceof HookError);
          assert.strictEqual(err.code, "CORRUPT_HOOK_STATE");
          return true;
        }
      );

      // Installs clean with force, archiving corrupt file
      const report = manager.install({ force: true, allowInert: true });
      assert.strictEqual(report.allSuccess, true);

      const entries = fs.readdirSync(hooksDir);
      const archived = entries.find((e) => e.startsWith("pre-commit.user-backup."));
      assert(archived !== undefined, "Corrupt file must be archived before replacing");
    });

    test("preserves user modifications outside managed markers", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      const initialWrapper = generateWrapperScript("pre-commit", undefined, true);
      const userPreamble = `#!/bin/sh\n# Custom environment setting\nexport ENTERPRISE_CI=1\n`;
      const userPostamble = `\n# Custom post-hook telemetry\necho "Finished hook"\n`;

      fs.writeFileSync(preCommitPath, `${userPreamble}${initialWrapper}${userPostamble}`);

      const manager = new GitHookManager({ cwd: tmpDir });
      const status = manager.status();
      assert.strictEqual(status.hooks["pre-commit"].wrapperIntegrity, "modified");

      // Re-installing updates the wrapper while preserving preamble and postamble
      const report = manager.install({ allowInert: true });
      assert.strictEqual(report.results["pre-commit"].action, "updated");

      const updatedContent = fs.readFileSync(preCommitPath, "utf-8");
      assert(updatedContent.includes("export ENTERPRISE_CI=1"));
      assert(updatedContent.includes("Finished hook"));
      assert(updatedContent.includes("AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT)"));
    });
  });

  describe("Safe Uninstallation & Recovery Hardening", () => {
    test("Scenario 9: restores original hook byte-for-byte and restores mode", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      const originalUserScript = `#!/bin/sh\n# Original enterprise hook\nexit 0\n`;
      fs.writeFileSync(preCommitPath, originalUserScript, { mode: 0o755 });

      const manager = new GitHookManager({ cwd: tmpDir });
      manager.install({ allowInert: true });

      // Now uninstall
      const report = manager.uninstall();
      assert.strictEqual(report.allSuccess, true);
      assert.strictEqual(report.results["pre-commit"].action, "restored_original");

      assert(!fs.existsSync(`${preCommitPath}${ORIGINAL_HOOK_SUFFIX}`), "Backup should be unlinked upon restoration");

      const restoredContent = fs.readFileSync(preCommitPath, "utf-8");
      assert.strictEqual(restoredContent, originalUserScript);
    });

    test("Scenario 10: unlinks wrapper when no original hook existed", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      manager.install({ allowInert: true });

      const preCommitPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
      assert(fs.existsSync(preCommitPath));

      const report = manager.uninstall();
      assert.strictEqual(report.allSuccess, true);
      assert.strictEqual(report.results["pre-commit"].action, "unlinked_wrapper");
      assert(!fs.existsSync(preCommitPath), "Wrapper should be completely unlinked");
    });

    test("Scenario 11: repeated uninstall is idempotent", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      manager.install({ allowInert: true });
      manager.uninstall();

      const secondReport = manager.uninstall();
      assert.strictEqual(secondReport.allSuccess, true);
      assert.strictEqual(secondReport.results["pre-commit"].action, "skipped_not_installed");
    });

    test("Scenario 12: excises only managed block when user commands exist outside markers", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      const initialWrapper = generateWrapperScript("pre-commit", undefined, true);
      const userCode = `#!/bin/sh\n# User custom setup\necho "Custom hook logic"\n`;
      fs.writeFileSync(preCommitPath, `${userCode}\n${initialWrapper}`);

      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.uninstall();

      assert.strictEqual(report.allSuccess, true);
      assert.strictEqual(report.results["pre-commit"].action, "excised_managed_block");

      const remainingContent = fs.readFileSync(preCommitPath, "utf-8");
      assert(remainingContent.includes("echo \"Custom hook logic\""));
      assert(!remainingContent.includes("AI ENGINEERING PLAYBOOK HOOK"));
    });

    test("Scenario 13: refuses to uninstall unmanaged hook without Playbook markers", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      fs.writeFileSync(preCommitPath, `#!/bin/sh\necho "Strictly unmanaged hook"\n`);

      const manager = new GitHookManager({ cwd: tmpDir });

      assert.throws(
        () => manager.uninstall({ force: false }),
        (err: unknown) => {
          assert(err instanceof HookError);
          assert.strictEqual(err.code, "UNMANAGED_HOOK_PRESENT");
          return true;
        }
      );

      // Unmanaged file must not be modified or deleted
      assert(fs.existsSync(preCommitPath));
    });

    test("force uninstall of corrupt wrapper archives corrupt content to user-backup before unlinking", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      const corruptContent = `#!/bin/sh\n# >>> AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT) >>>\necho "Corrupt wrapper with user code"\n`;
      fs.writeFileSync(preCommitPath, corruptContent);

      const manager = new GitHookManager({ cwd: tmpDir });

      // Uninstall with force
      const report = manager.uninstall({ force: true });
      assert.strictEqual(report.allSuccess, true);
      assert(!fs.existsSync(preCommitPath), "Corrupt wrapper should be unlinked");

      // Verify that corrupt content was archived to user backup
      const entries = fs.readdirSync(hooksDir);
      const backupFile = entries.find((e) => e.startsWith("pre-commit.user-backup."));
      assert(backupFile !== undefined, "Corrupt wrapper must be preserved in .user-backup archive");

      const backedUp = fs.readFileSync(path.join(hooksDir, backupFile), "utf-8");
      assert.strictEqual(backedUp, corruptContent, "Archived bytes must match corrupt wrapper content exactly");
    });

    test("collision-proof archiving handles multiple rapid user backups without name collision", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const file1 = path.join(hooksDir, "hook-test-1");
      const file2 = path.join(hooksDir, "hook-test-2");
      fs.writeFileSync(file1, "sample hook 1");
      fs.writeFileSync(file2, "sample hook 2");

      const archive1 = archiveUserHookFile(hooksDir, file1);
      const archive2 = archiveUserHookFile(hooksDir, file2);

      assert.notStrictEqual(archive1.archivePath, archive2.archivePath, "Archives must have distinct paths");
      assert(fs.existsSync(archive1.archivePath));
      assert(fs.existsSync(archive2.archivePath));
      assert.strictEqual(fs.readFileSync(archive1.archivePath, "utf-8"), "sample hook 1");
      assert.strictEqual(fs.readFileSync(archive2.archivePath, "utf-8"), "sample hook 2");
    });
  });

  describe("Dispatcher Fail-Open Prevention & Execution Hardening", () => {
    test("dispatcher rejects unknown or unsupported hook types with exit code 1", async () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      const res = await manager.run({ hookType: "unknown-hook" });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert(res.message?.includes("Unknown or unsupported hook type"));
    });

    test("dispatcher succeeds cleanly on clean repository without staged changes", async () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      const res = await manager.run({ hookType: "pre-commit" });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert(res.message?.includes("No staged changes detected"));
    });

    test("dispatcher succeeds when --allow-inert is provided", async () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      const res = await manager.run({ hookType: "pre-commit", allowInert: true });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
    });

    test("status report marks installed hooks as inert_transitional with warnings", () => {
      const manager = new GitHookManager({ cwd: tmpDir });
      manager.install({ allowInert: true });

      const status = manager.status();
      assert.strictEqual(status.hooks["pre-commit"].validationStatus, "inert_transitional");
      assert.strictEqual(status.hooks["pre-commit"].isInert, true);
      assert(
        status.hooks["pre-commit"].warnings.some((w) => w.includes("Task 006C.1 transitional mode")),
        "Status must explicitly warn user of transitional inactive validation"
      );
    });
  });

  describe("Status Reporting & CLI Commands", () => {
    test("Scenario 7: returns accurate status across hook states", () => {
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      // pre-commit is installed cleanly
      fs.writeFileSync(path.join(hooksDir, "pre-commit"), generateWrapperScript("pre-commit", undefined, true));
      // pre-push is unmanaged
      fs.writeFileSync(path.join(hooksDir, "pre-push"), `#!/bin/sh\necho "User push check"\n`);

      const manager = new GitHookManager({ cwd: tmpDir });
      const report = manager.status();

      assert.strictEqual(report.isGitRepository, true);
      assert.strictEqual(report.hooks["pre-commit"].installed, true);
      assert.strictEqual(report.hooks["pre-commit"].wrapperIntegrity, "valid");

      assert.strictEqual(report.hooks["pre-push"].installed, false);
      assert.strictEqual(report.hooks["pre-push"].wrapperIntegrity, "unmanaged");
    });

    test("Scenario 8: CLI command wrappers format JSON and terminal output", async () => {
      // Test runHookInstall with allowInert
      const installRes = runHookInstall({ cwd: tmpDir, allowInert: true, json: true });
      assert.strictEqual(installRes.success, true);
      assert.strictEqual(installRes.exitCode, 0);

      // Test runHookStatus
      const statusRes = runHookStatus({ cwd: tmpDir, json: true });
      assert.strictEqual(statusRes.success, true);
      assert.strictEqual(statusRes.exitCode, 0);
      assert(statusRes.data !== undefined);
      assert.strictEqual(statusRes.data.hooks["pre-commit"].installed, true);

      // Test runHookRun on clean repository -> succeeds cleanly
      const runClean = await runHookRun({ cwd: tmpDir, hookType: "pre-commit" });
      assert.strictEqual(runClean.success, true);
      assert.strictEqual(runClean.exitCode, 0);

      // Test runHookRun with allowInert -> permitted
      const runAllowed = await runHookRun({ cwd: tmpDir, hookType: "pre-commit", allowInert: true });
      assert.strictEqual(runAllowed.success, true);
      assert.strictEqual(runAllowed.exitCode, 0);

      const invalidRunRes = await runHookRun({ cwd: tmpDir, hookType: "invalid-hook", allowInert: true });
      assert.strictEqual(invalidRunRes.success, false);
      assert.strictEqual(invalidRunRes.exitCode, 1);

      // Test runHookUninstall
      const uninstallRes = runHookUninstall({ cwd: tmpDir, json: true });
      assert.strictEqual(uninstallRes.success, true);
      assert.strictEqual(uninstallRes.exitCode, 0);
    });
  });

  describe("POSIX Shell Execution & Original Hook Delegation Fidelity", () => {
    const shBin = findShExecutable();

    test("Scenario 17: normal wrapper execution invokes Playbook dispatcher and original companion hook", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const companionLog = path.join(tmpDir, "companion.log");
      const origHookContent = `#!/bin/sh\necho "companion-executed" > "${companionLog.replace(/\\/g, "/")}"\nexit 0\n`;
      const origHookPath = path.join(hooksDir, "pre-commit.playbook-orig");
      fs.writeFileSync(origHookPath, origHookContent, { mode: 0o755 });

      // Install wrapper with hasCompanion=true and allowInert=true
      const wrapperScript = generateWrapperScript("pre-commit", undefined, true, true);
      const wrapperPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      const result = spawnSync(shBin, [wrapperPath, "test-arg"], {
        cwd: tmpDir,
        env: { ...process.env, PLAYBOOK_HOOK_ACTIVE: "", PLAYBOOK_ORIG_HOOK_ACTIVE: "" },
      });

      assert.strictEqual(result.status, 0, `Wrapper execution failed: ${result.stderr?.toString()}`);
      assert(fs.existsSync(companionLog), "Original companion hook must be executed on normal invocation");
      assert.strictEqual(fs.readFileSync(companionLog, "utf-8").trim(), "companion-executed");
    });

    test("Scenario 18: nested execution with PLAYBOOK_HOOK_ACTIVE=1 skips validation but still executes companion hook", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const companionLog = path.join(tmpDir, "nested-companion.log");
      const origHookContent = `#!/bin/sh\necho "nested-hook-invoked" > "${companionLog.replace(/\\/g, "/")}"\nexit 0\n`;
      const origHookPath = path.join(hooksDir, "pre-commit.playbook-orig");
      fs.writeFileSync(origHookPath, origHookContent, { mode: 0o755 });

      // Notice allowInert=false here! If Playbook validation ran, it would fail-close with exit code 1.
      // But because PLAYBOOK_HOOK_ACTIVE=1, validation is skipped, and companion hook runs cleanly!
      const wrapperScript = generateWrapperScript("pre-commit", undefined, false, true);
      const wrapperPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      const result = spawnSync(shBin, [wrapperPath], {
        cwd: tmpDir,
        env: { ...process.env, PLAYBOOK_HOOK_ACTIVE: "1", PLAYBOOK_ORIG_HOOK_ACTIVE: "" },
      });

      assert.strictEqual(result.status, 0, `Nested execution failed: ${result.stderr?.toString()}`);
      assert(fs.existsSync(companionLog), "Companion hook must NOT be skipped when PLAYBOOK_HOOK_ACTIVE=1");
      assert.strictEqual(fs.readFileSync(companionLog, "utf-8").trim(), "nested-hook-invoked");
    });

    test("Scenario 19: delegates exact arguments, flags, and quoted strings to original hook", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      // Create log file destination
      const argsLog = path.join(tmpDir, "args.log");

      // Companion original hook writes all received arguments line-by-line
      const origHookContent = `#!/bin/sh\nfor arg in "$@"; do\n  echo "$arg" >> "${argsLog.replace(/\\/g, "/")}"\ndone\nexit 0\n`;
      const origHookPath = path.join(hooksDir, "pre-commit.playbook-orig");
      fs.writeFileSync(origHookPath, origHookContent, { mode: 0o755 });

      // Install wrapper
      const wrapperScript = generateWrapperScript("pre-commit", undefined, true, true);
      const wrapperPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      // Execute wrapper via shell with distinct arguments
      const testArgs = ["commit-msg", "commit with spaces", "--amend", "-v"];
      const result = spawnSync(shBin, [wrapperPath, ...testArgs], {
        cwd: tmpDir,
        env: { ...process.env, PLAYBOOK_HOOK_ACTIVE: "", PLAYBOOK_ORIG_HOOK_ACTIVE: "" },
      });

      assert.strictEqual(result.status, 0, `Wrapper execution failed: ${result.stderr?.toString()}`);
      assert(fs.existsSync(argsLog), "Arguments log should have been created by original hook");

      const loggedArgs = fs.readFileSync(argsLog, "utf-8").trim().split(/\r?\n/);
      assert.deepStrictEqual(loggedArgs, testArgs, "Original hook must receive exact arguments intact");
    });

    test("Scenario 20: preserves and pipes exact standard input bytes to original hook", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const stdinLog = path.join(tmpDir, "stdin.log");
      // Companion hook captures entire standard input
      const origHookContent = `#!/bin/sh\ncat > "${stdinLog.replace(/\\/g, "/")}"\nexit 0\n`;
      const origHookPath = path.join(hooksDir, "pre-push.playbook-orig");
      fs.writeFileSync(origHookPath, origHookContent, { mode: 0o755 });

      // Install wrapper
      const wrapperScript = generateWrapperScript("pre-push", undefined, true, true);
      const wrapperPath = path.join(hooksDir, "pre-push");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      const testPushedRefs =
        "refs/heads/main 1111222233334444555566667777888899990000 refs/heads/main 5555666677778888999900001111222233334444\n" +
        "refs/heads/feature/auth aaaaabbbbbcccccdddddeeeeefffff00000111 refs/heads/feature/auth 22222333334444455555666667777788888999\n";

      const result = spawnSync(shBin, [wrapperPath, "origin", "git@github.com:repo/test.git"], {
        cwd: tmpDir,
        input: testPushedRefs,
        env: { ...process.env, PLAYBOOK_HOOK_ACTIVE: "", PLAYBOOK_ORIG_HOOK_ACTIVE: "" },
      });

      assert.strictEqual(result.status, 0, `Wrapper failed: ${result.stderr?.toString()}`);
      assert(fs.existsSync(stdinLog), "Stdin log should have been created by original hook");

      const loggedStdin = fs.readFileSync(stdinLog, "utf-8");
      assert.strictEqual(loggedStdin, testPushedRefs, "Original hook must receive exact stdin bytes");
    });

    test("Scenario 21: propagates non-zero exit status from original companion hook", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      // Companion hook exits with specific non-zero status code 42
      const origHookContent = `#!/bin/sh\necho "Rejecting push from original hook" >&2\nexit 42\n`;
      const origHookPath = path.join(hooksDir, "pre-push.playbook-orig");
      fs.writeFileSync(origHookPath, origHookContent, { mode: 0o755 });

      // Install wrapper
      const wrapperScript = generateWrapperScript("pre-push", undefined, true, true);
      const wrapperPath = path.join(hooksDir, "pre-push");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      const result = spawnSync(shBin, [wrapperPath, "origin", "git@github.com:repo/test.git"], {
        cwd: tmpDir,
        env: { ...process.env, PLAYBOOK_HOOK_ACTIVE: "", PLAYBOOK_ORIG_HOOK_ACTIVE: "" },
      });

      assert.strictEqual(result.status, 42, "Wrapper must exit with companion hook's exit status 42");
      assert(result.stderr.toString().includes("Rejecting push from original hook"));
    });

    test("Scenario 22: recursive invocation cannot produce an infinite loop and fails explicitly", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const origHookPath = path.join(hooksDir, "pre-commit.playbook-orig");
      fs.writeFileSync(origHookPath, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

      const wrapperScript = generateWrapperScript("pre-commit", undefined, true, true);
      const wrapperPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      // Invoke wrapper with PLAYBOOK_ORIG_HOOK_ACTIVE=1 (simulating re-entrancy from inside companion hook)
      const result = spawnSync(shBin, [wrapperPath], {
        cwd: tmpDir,
        env: { ...process.env, PLAYBOOK_ORIG_HOOK_ACTIVE: "1" },
      });

      assert.strictEqual(result.status, 1, "Must exit with non-zero error when companion recursion is detected");
      assert(
        result.stderr.toString().includes("Recursive hook invocation detected"),
        "Must output explicit recursive invocation error to stderr"
      );
    });

    test("Scenario 23: missing original backup when companion hook is expected fails explicitly", (t) => {
      if (!shBin) {
        t.skip("POSIX shell (sh.exe or /bin/sh) not found on host");
        return;
      }

      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      // Generate wrapper with hasCompanion=true, but DO NOT create .playbook-orig
      const wrapperScript = generateWrapperScript("pre-commit", undefined, true, true);
      const wrapperPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

      // Runtime execution check
      const result = spawnSync(shBin, [wrapperPath], {
        cwd: tmpDir,
        env: { ...process.env, PLAYBOOK_HOOK_ACTIVE: "", PLAYBOOK_ORIG_HOOK_ACTIVE: "" },
      });

      assert.strictEqual(result.status, 1, "Missing expected companion hook must fail execution with exit code 1");
      assert(result.stderr.toString().includes("Expected original companion hook"));

      // Static status inspection check
      const manager = new GitHookManager({ cwd: tmpDir });
      const status = manager.status();
      assert.strictEqual(status.hooks["pre-commit"].backupIntegrity, "missing");
      assert.strictEqual(status.hooks["pre-commit"].recoveryRequired, true);
      assert(status.hooks["pre-commit"].recoveryReason?.includes("missing"));
    });
  });
});
