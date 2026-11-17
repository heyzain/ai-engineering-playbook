import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { PrePushEngine } from "../src/core/hooks/pre-push-engine.js";
import {
  parsePrePushStdin,
  isZeroOid,
  getZeroOid,
  createDetachedPushWorktree,
  removeDetachedPushWorktree,
  reapOrphanedPushWorktrees,
  auditPushedCommits,
  resolvePushedIntroducedCommits,
} from "../src/core/hooks/git-utils.js";
import { HookError } from "../src/types/hooks.js";
import type { ProcessLivenessResult } from "../src/core/lock/types.js";

describe("PrePushEngine — Pushed Git Object & Detached Worktree Validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-prepush-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.name "Push Test Engineer"', { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.email "pushtest@example.com"', { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore locks
    }
  });

  test("returns success and exit 0 when stdin is empty", async () => {
    const engine = new PrePushEngine(tmpDir);
    const res = await engine.validate({ stdin: "" });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert(res.message.includes("No pushed refs provided"));
  });

  test("rejects malformed stdin line format", async () => {
    const engine = new PrePushEngine(tmpDir);
    await assert.rejects(
      async () => {
        await engine.validate({ stdin: "invalid-line-without-four-fields\n" });
      },
      (err: unknown) => {
        assert(err instanceof HookError);
        assert.strictEqual(err.code, "MALFORMED_PRE_PUSH_STDIN");
        return true;
      }
    );
  });

  test("rejects invalid Git OIDs that are not 40 or 64 hex characters", async () => {
    const engine = new PrePushEngine(tmpDir);
    await assert.rejects(
      async () => {
        await engine.validate({
          stdin: "refs/heads/main not-a-valid-sha refs/heads/main 0000000000000000000000000000000000000000\n",
        });
      },
      (err: unknown) => {
        assert(err instanceof HookError);
        assert.strictEqual(err.code, "MALFORMED_GIT_OID");
        return true;
      }
    );
  });

  describe("Ref Deletion Handling (Zero Local OIDs)", () => {
    test("skips evaluation on remote branch deletion (local_oid is ZERO_OID)", async () => {
      const zeroSha = getZeroOid("sha1");
      const fakeRemoteSha = "1".repeat(40);
      const stdin = `refs/heads/feature-branch ${zeroSha} refs/heads/feature-branch ${fakeRemoteSha}\n`;

      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert(res.message.includes("All pushed refs are branch/tag deletions"));
    });

    test("handles lightweight tag deletion without attempting tag peeling", async () => {
      const zeroSha = getZeroOid("sha1");
      const remoteSha = "a".repeat(40);
      const stdin = `refs/tags/v1.0.0 ${zeroSha} refs/tags/v1.0.0 ${remoteSha}\n`;

      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert(res.message.includes("All pushed refs are branch/tag deletions"));
    });

    test("handles annotated tag deletion without attempting tag peeling", async () => {
      const zeroSha = getZeroOid("sha1");
      const remoteSha = "b".repeat(40);
      const stdin = `refs/tags/release-2026.1 ${zeroSha} refs/tags/release-2026.1 ${remoteSha}\n`;

      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert(res.message.includes("All pushed refs are branch/tag deletions"));
    });

    test("handles mixed multi-ref updates: skips deletion and validates active refs", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello\n", "utf-8");
      execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "active ref commit"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const zeroSha = getZeroOid("sha1");
      const remoteSha = "c".repeat(40);

      // Multi-ref: one tag deletion, one branch deletion, one active branch creation
      const stdin = [
        `refs/tags/old-tag ${zeroSha} refs/tags/old-tag ${remoteSha}`,
        `refs/heads/old-branch ${zeroSha} refs/heads/old-branch ${remoteSha}`,
        `refs/heads/main ${headSha} refs/heads/main ${zeroSha}`,
      ].join("\n");

      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.uniqueTreesCount, 1);
    });
  });

  describe("Detached Worktree Lifecycle & Garbage Collection Safety", () => {
    test("provisions detached worktree, writes manifest, and cleans up cleanly", async () => {
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Initial Commit\n", "utf-8");
      execSync("git add README.md", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: "ignore" });

      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);
      assert(fs.existsSync(handle.worktreePath));

      const manifestPath = path.join(handle.worktreePath, ".playbook-worktree.json");
      assert(fs.existsSync(manifestPath));

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      assert.strictEqual(manifest.component, "playbook-git-integration");
      assert.strictEqual(manifest.worktree_type, "ephemeral_push_eval");
      assert.strictEqual(manifest.target_commit_oid, headSha);

      removeDetachedPushWorktree(tmpDir, handle.worktreePath);
      assert(!fs.existsSync(handle.worktreePath));
    });

    test("reaps orphaned worktrees ONLY when owning process is verified dead", async () => {
      fs.writeFileSync(path.join(tmpDir, "code.ts"), "export const x = 1;\n", "utf-8");
      execSync("git add code.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "add code"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);
      assert(fs.existsSync(handle.worktreePath));

      const deadLivenessChecker = (): ProcessLivenessResult => ({
        isAlive: false,
        isVerifiedDead: true,
        isRecycled: false,
        isIndeterminate: false,
        reason: "Simulated verified dead process.",
        pid: handle.manifest.owner_pid,
      });

      const reapResult = await reapOrphanedPushWorktrees(tmpDir, deadLivenessChecker);
      assert.strictEqual(reapResult.reaped.length, 1);
      assert(!fs.existsSync(handle.worktreePath));
    });

    test("retains worktrees when owning process is active (alive)", async () => {
      fs.writeFileSync(path.join(tmpDir, "active.ts"), "export const active = true;\n", "utf-8");
      execSync("git add active.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "active work"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);

      const aliveLivenessChecker = (): ProcessLivenessResult => ({
        isAlive: true,
        isVerifiedDead: false,
        isRecycled: false,
        isIndeterminate: false,
        reason: "Simulated active process.",
        pid: handle.manifest.owner_pid,
      });

      try {
        const reapResult = await reapOrphanedPushWorktrees(tmpDir, aliveLivenessChecker);
        assert.strictEqual(reapResult.reaped.length, 0);
        assert.strictEqual(reapResult.retained.length, 1);
        assert(fs.existsSync(handle.worktreePath));
      } finally {
        removeDetachedPushWorktree(tmpDir, handle.worktreePath);
      }
    });

    test("retains worktrees when process liveness is indeterminate or unknown", async () => {
      fs.writeFileSync(path.join(tmpDir, "unknown.ts"), "export const u = 1;\n", "utf-8");
      execSync("git add unknown.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "unknown work"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);

      const unknownLivenessChecker = (): ProcessLivenessResult => ({
        isAlive: false,
        isVerifiedDead: false,
        isRecycled: false,
        isIndeterminate: true,
        reason: "Indeterminate OS state.",
        pid: handle.manifest.owner_pid,
      });

      try {
        const reapResult = await reapOrphanedPushWorktrees(tmpDir, unknownLivenessChecker);
        assert.strictEqual(reapResult.reaped.length, 0);
        assert.strictEqual(reapResult.retained.length, 1);
        assert(fs.existsSync(handle.worktreePath));
      } finally {
        removeDetachedPushWorktree(tmpDir, handle.worktreePath);
      }
    });

    test("retains worktrees with cross-host ownership metadata", async () => {
      fs.writeFileSync(path.join(tmpDir, "cross.ts"), "export const c = 1;\n", "utf-8");
      execSync("git add cross.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "cross work"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);

      // Mutate manifest to simulate another host
      const manifestPath = path.join(handle.worktreePath, ".playbook-worktree.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.owner_host = "REMOTE-BUILD-SERVER-99";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      try {
        const reapResult = await reapOrphanedPushWorktrees(tmpDir);
        assert.strictEqual(reapResult.reaped.length, 0);
        assert.strictEqual(reapResult.retained.length, 1);
        assert(fs.existsSync(handle.worktreePath));
      } finally {
        removeDetachedPushWorktree(tmpDir, handle.worktreePath);
      }
    });

    test("retains worktrees with corrupt or missing manifest files", async () => {
      fs.writeFileSync(path.join(tmpDir, "corrupt.ts"), "export const cr = 1;\n", "utf-8");
      execSync("git add corrupt.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "corrupt work"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);
      const manifestPath = path.join(handle.worktreePath, ".playbook-worktree.json");

      // Write corrupt JSON
      fs.writeFileSync(manifestPath, "{ corrupted json syntax", "utf-8");

      try {
        const reapResult = await reapOrphanedPushWorktrees(tmpDir);
        assert.strictEqual(reapResult.reaped.length, 0);
        assert.strictEqual(reapResult.retained.length, 1);
        assert(fs.existsSync(handle.worktreePath));
      } finally {
        removeDetachedPushWorktree(tmpDir, handle.worktreePath);
      }
    });

    test("never deletes based on age alone (conservative retention)", async () => {
      fs.writeFileSync(path.join(tmpDir, "aged.ts"), "export const aged = 1;\n", "utf-8");
      execSync("git add aged.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "aged work"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      const handle = createDetachedPushWorktree(tmpDir, headSha);
      const manifestPath = path.join(handle.worktreePath, ".playbook-worktree.json");

      // Set creation date to 10 days ago
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.created_at = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      // Liveness returns alive
      const aliveChecker = (): ProcessLivenessResult => ({
        isAlive: true,
        isVerifiedDead: false,
        isRecycled: false,
        isIndeterminate: false,
        reason: "Process active.",
        pid: handle.manifest.owner_pid,
      });

      try {
        const reapResult = await reapOrphanedPushWorktrees(tmpDir, aliveChecker);
        assert.strictEqual(reapResult.reaped.length, 0);
        assert.strictEqual(reapResult.retained.length, 1);
        assert(fs.existsSync(handle.worktreePath));
      } finally {
        removeDetachedPushWorktree(tmpDir, handle.worktreePath);
      }
    });
  });

  describe("Pre-Push Commit-Range Audit & Security Scanning", () => {
    test("rejects commit introducing sensitive secret pattern (e.g. GitHub PAT)", async () => {
      fs.writeFileSync(path.join(tmpDir, "config.ts"), 'export const token = "ghp_123456789012345678901234567890123456";\n', "utf-8");
      execSync("git add config.ts", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "introduce secret token"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();
      const zeroSha = getZeroOid("sha1");

      const stdin = `refs/heads/main ${headSha} refs/heads/main ${zeroSha}\n`;
      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert(res.message.includes("[PREPUSH_COMMIT_AUDIT_FAILED]"));
      assert(res.message.includes("[PREPUSH_SECRET_DETECTED]"));
    });

    test("rejects commit attempting to commit internal Playbook lock or tmp artifacts", async () => {
      const playbookTmp = path.join(tmpDir, ".playbook", ".tmp");
      fs.mkdirSync(playbookTmp, { recursive: true });
      fs.writeFileSync(path.join(playbookTmp, "scratch.tmp.lock"), "locked\n", "utf-8");
      execSync("git add -f .playbook/.tmp/scratch.tmp.lock", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "accidentally commit temp lock"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();
      const zeroSha = getZeroOid("sha1");

      const stdin = `refs/heads/main ${headSha} refs/heads/main ${zeroSha}\n`;
      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert(res.message.includes("[PREPUSH_COMMIT_AUDIT_FAILED]"));
      assert(res.message.includes("[PREPUSH_FORBIDDEN_FILE]"));
    });

    test("rejects commit with empty subject line", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "data\n", "utf-8");
      execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit --allow-empty-message -m ""', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();
      const zeroSha = getZeroOid("sha1");

      const stdin = `refs/heads/main ${headSha} refs/heads/main ${zeroSha}\n`;
      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert(res.message.includes("[COMMIT_MSG_EMPTY]"));
    });

    test("rejects commit with subject line exceeding 100 characters", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "data\n", "utf-8");
      execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
      const longSubject = "a".repeat(105);
      execSync(`git commit -m "${longSubject}"`, { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();
      const zeroSha = getZeroOid("sha1");

      const stdin = `refs/heads/main ${headSha} refs/heads/main ${zeroSha}\n`;
      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert(res.message.includes("[COMMIT_MSG_TOO_LONG]"));
    });

    test("handles unresolvable remote OIDs with explicit advisory warning (no silent pass)", async () => {
      fs.writeFileSync(path.join(tmpDir, "safe.txt"), "safe data\n", "utf-8");
      execSync("git add safe.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "clean commit"', { cwd: tmpDir, stdio: "ignore" });
      const headSha = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

      // Remote sha does not exist in local repo
      const nonExistentRemoteSha = "d".repeat(40);
      const stdin = `refs/heads/main ${headSha} refs/heads/main ${nonExistentRemoteSha}\n`;

      const engine = new PrePushEngine(tmpDir);
      const res = await engine.validate({ stdin });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert(res.warnings !== undefined && res.warnings.length > 0);
      assert(res.warnings[0].includes("Remote OID"));
      assert(res.warnings[0].includes("is not present in local Git object store"));
    });
  });

  describe("SHA-256 Git Repository Object Format Integration", () => {
    test("processes pushes and executes audits in actual SHA-256 Git repository", async () => {
      const sha256Dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-sha256-test-"));
      try {
        execSync("git init --object-format=sha256", { cwd: sha256Dir, stdio: "ignore" });
        execSync('git config user.name "SHA256 Tester"', { cwd: sha256Dir, stdio: "ignore" });
        execSync('git config user.email "sha256@example.com"', { cwd: sha256Dir, stdio: "ignore" });

        fs.writeFileSync(path.join(sha256Dir, "app.ts"), "export const mode = 'sha256';\n", "utf-8");
        execSync("git add app.ts", { cwd: sha256Dir, stdio: "ignore" });
        execSync('git commit -m "sha256 initial commit"', { cwd: sha256Dir, stdio: "ignore" });

        const sha256Head = execSync("git rev-parse HEAD", { cwd: sha256Dir, encoding: "utf-8" }).trim();
        assert.strictEqual(sha256Head.length, 64, "SHA-256 OID must be exactly 64 characters");

        const zeroSha256 = getZeroOid("sha256");
        assert.strictEqual(zeroSha256.length, 64);

        const stdin = `refs/heads/main ${sha256Head} refs/heads/main ${zeroSha256}\n`;

        const engine = new PrePushEngine(sha256Dir);
        const res = await engine.validate({ stdin });

        assert.strictEqual(res.success, true);
        assert.strictEqual(res.exitCode, 0);
        assert.strictEqual(res.uniqueTreesCount, 1);
        assert.strictEqual(res.auditedCommitsCount, 1);
      } finally {
        try {
          fs.rmSync(sha256Dir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });
  });
});
