import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { HookError } from "../../types/hooks.js";
import { toPosixPath, normalizeRelativePath } from "../../utils/paths.js";
import { defaultProcessLivenessChecker } from "../lock/liveness.js";
import type { ProcessLivenessChecker } from "../lock/types.js";

export type GitObjectFormat = "sha1" | "sha256";

export interface StagedEntry {
  status: string;
  path: string;
  oldPath?: string;
}

export interface StagedFileModeEntry {
  mode: string;
  oid: string;
  stage: string;
  path: string;
}

export interface PushedRefTuple {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

export interface WorktreeManifest {
  schema_version: string;
  component: string;
  worktree_type: string;
  owner_pid: number;
  owner_host: string;
  created_at: string;
  target_commit_oid: string;
  nonce: string;
}

export interface DetachedWorktreeHandle {
  worktreePath: string;
  targetCommitOid: string;
  nonce: string;
  manifest: WorktreeManifest;
}

/**
 * Detects the Git object hash format (sha1 or sha256).
 */
export function getGitObjectFormat(cwd: string): GitObjectFormat {
  try {
    const format = execFileSync("git", ["rev-parse", "--show-object-format"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (format === "sha256") {
      return "sha256";
    }
    return "sha1";
  } catch {
    return "sha1";
  }
}

/**
 * Checks if an OID is the Git all-zeros OID (indicating deletion or non-existent remote ref).
 */
export function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid.trim());
}

/**
 * Returns the all-zeros OID for the given format.
 */
export function getZeroOid(format: GitObjectFormat = "sha1"): string {
  return "0".repeat(format === "sha256" ? 64 : 40);
}

/**
 * Returns the empty tree hash for the given format.
 * Optionally writes the empty tree object into the repository if cwd is provided.
 */
export function getEmptyTreeHash(format: GitObjectFormat = "sha1", cwd?: string): string {
  const hash =
    format === "sha256"
      ? "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
      : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  if (cwd) {
    try {
      execFileSync("git", ["hash-object", "-t", "tree", "-w", "--stdin"], {
        cwd,
        input: Buffer.alloc(0),
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      // Ignore if unable to write
    }
  }

  return hash;
}

/**
 * Checks whether the repository has no commits yet (initial commit state).
 */
export function isInitialCommit(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Retrieves staged entries from the Git index using NUL-delimited output.
 */
export function getStagedEntries(cwd: string, format: GitObjectFormat = "sha1"): StagedEntry[] {
  const initial = isInitialCommit(cwd);
  const baseTarget = initial ? getEmptyTreeHash(format, cwd) : "HEAD";

  let stdout: string;
  try {
    stdout = execFileSync(
      "git",
      ["diff-index", "--cached", "-z", "--name-status", baseTarget],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("GIT_DIFF_INDEX_FAILED", `Failed to read staged files from Git index: ${msg}`);
  }

  const entries: StagedEntry[] = [];
  if (!stdout) {
    return entries;
  }

  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const statusRaw = parts[i];
    if (!statusRaw) {
      i++;
      continue;
    }

    const statusCode = statusRaw[0];
    if (statusCode === "R" || statusCode === "C") {
      // Renames and Copies have: status, oldPath, newPath
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        entries.push({
          status: statusRaw,
          path: normalizeRelativePath(newPath),
          oldPath: normalizeRelativePath(oldPath),
        });
      }
      i += 3;
    } else {
      const filePath = parts[i + 1];
      if (filePath !== undefined) {
        entries.push({
          status: statusRaw,
          path: normalizeRelativePath(filePath),
        });
      }
      i += 2;
    }
  }

  return entries;
}

/**
 * Retrieves staged file modes, blob OIDs, and stages via `git ls-files --stage -z`.
 */
export function getStagedFileModes(cwd: string): StagedFileModeEntry[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("GIT_LS_FILES_FAILED", `Failed to read index stage info: ${msg}`);
  }

  const entries: StagedFileModeEntry[] = [];
  if (!stdout) return entries;

  const parts = stdout.split("\0");
  for (const part of parts) {
    if (!part.trim()) continue;
    // Format: "<mode> <oid> <stage>\t<path>"
    const tabIdx = part.indexOf("\t");
    if (tabIdx === -1) continue;

    const meta = part.slice(0, tabIdx).trim();
    const filePath = part.slice(tabIdx + 1);
    const metaParts = meta.split(" ");
    if (metaParts.length >= 3) {
      entries.push({
        mode: metaParts[0],
        oid: metaParts[1],
        stage: metaParts[2],
        path: normalizeRelativePath(filePath),
      });
    }
  }

  return entries;
}

/**
 * Checks for unmerged index entries (unresolved merge conflicts, stages 1/2/3).
 */
export function getUnmergedIndexEntries(cwd: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-files", "-u", "-z"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }

  if (!stdout) return [];

  const unmergedPaths = new Set<string>();
  const parts = stdout.split("\0");
  for (const part of parts) {
    if (!part.trim()) continue;
    const tabIdx = part.indexOf("\t");
    if (tabIdx !== -1) {
      const filePath = part.slice(tabIdx + 1);
      unmergedPaths.add(normalizeRelativePath(filePath));
    }
  }

  return Array.from(unmergedPaths);
}

/**
 * Reads the content of a staged file directly from the Git index.
 */
export function getStagedBlob(cwd: string, stagedPath: string): string | null {
  try {
    return execFileSync("git", ["show", `:${toPosixPath(stagedPath)}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/**
 * Captures the current index tree hash via `git write-tree`.
 */
export function writeIndexTree(cwd: string): string {
  try {
    return execFileSync("git", ["write-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("GIT_WRITE_TREE_FAILED", `Failed to inspect index tree hash: ${msg}`);
  }
}

/**
 * Extracts staged index files into a target directory using `git checkout-index`.
 */
export function extractStagedIndexToDirectory(
  cwd: string,
  destDir: string,
  targetPaths?: string[]
): void {
  fs.mkdirSync(destDir, { recursive: true });
  const prefix = toPosixPath(destDir).replace(/\/?$/, "/");

  const args = ["checkout-index", `--prefix=${prefix}`];
  if (targetPaths && targetPaths.length > 0) {
    args.push("--", ...targetPaths.map(toPosixPath));
  } else {
    args.push("-a");
  }

  try {
    execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("GIT_CHECKOUT_INDEX_FAILED", `Failed to extract staged index files: ${msg}`);
  }
}

/**
 * Parses standard input lines from `pre-push` into validated tuples.
 */
export function parsePrePushStdin(
  stdin: string,
  format: GitObjectFormat = "sha1"
): PushedRefTuple[] {
  const lines = stdin.split("\n");
  const tuples: PushedRefTuple[] = [];
  const expectedLength = format === "sha256" ? 64 : 40;
  const hexRegex = format === "sha256" ? /^[0-9a-fA-F]{64}$/ : /^[0-9a-fA-F]{40}$/;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      throw new HookError(
        "MALFORMED_PRE_PUSH_STDIN",
        `Pre-push standard input line has invalid format: "${line}". Expected "<local_ref> <local_oid> <remote_ref> <remote_oid>".`
      );
    }

    const [localRef, localOid, remoteRef, remoteOid] = parts;

    if (!hexRegex.test(localOid)) {
      throw new HookError(
        "MALFORMED_GIT_OID",
        `Invalid local Git OID in pre-push input: "${localOid}". Expected ${expectedLength}-character hex string.`
      );
    }

    if (!hexRegex.test(remoteOid)) {
      throw new HookError(
        "MALFORMED_GIT_OID",
        `Invalid remote Git OID in pre-push input: "${remoteOid}". Expected ${expectedLength}-character hex string.`
      );
    }

    tuples.push({
      localRef,
      localOid,
      remoteRef,
      remoteOid,
    });
  }

  return tuples;
}

/**
 * Peels an annotated or lightweight tag to its underlying target commit OID.
 */
export function peelTagToCommit(cwd: string, tagOid: string): string {
  try {
    return execFileSync("git", ["rev-parse", `${tagOid}^{commit}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("TAG_PEEL_FAILED", `Failed to resolve tag '${tagOid}' to commit: ${msg}`);
  }
}

/**
 * Resolves the root tree hash of a target commit.
 */
export function resolveCommitTree(cwd: string, commitOid: string): string {
  try {
    return execFileSync("git", ["rev-parse", `${commitOid}^{tree}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("TREE_RESOLVE_FAILED", `Failed to resolve tree for commit '${commitOid}': ${msg}`);
  }
}

/**
 * Checks whether the repository is a shallow clone (`--depth`).
 */
export function isShallowRepository(cwd: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

export interface PushedCommitRangeResult {
  commits: string[];
  isCompleteRange: boolean;
  warning?: string;
}

export interface CommitAuditResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

/**
 * Resolves introduced commits for a pushed ref tuple, respecting new branches,
 * existing branches, force pushes, and shallow boundaries.
 * Explicitly surfaces when a remote ref cannot be resolved locally rather than
 * silently treating an incomplete range as complete.
 */
export function resolvePushedIntroducedCommits(
  cwd: string,
  remoteName: string,
  localOid: string,
  remoteOid: string
): PushedCommitRangeResult {
  if (isZeroOid(localOid)) {
    return { commits: [], isCompleteRange: true }; // Ref deletion introduces zero commits
  }

  // Case 1: New branch (remote_oid is all zeros)
  if (isZeroOid(remoteOid)) {
    let hasRemoteTracking = false;
    try {
      const trackingRefs = execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname)", `refs/remotes/${remoteName}/*`],
        { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      hasRemoteTracking = trackingRefs.length > 0;
    } catch {
      hasRemoteTracking = false;
    }

    if (!hasRemoteTracking) {
      // Indeterminable remote base: fallback bounded to tip commit to avoid unbounded root traversal
      return {
        commits: [localOid],
        isCompleteRange: false,
        warning: `Remote tracking base for remote '${remoteName}' cannot be determined locally. Audited tip commit '${localOid}' without claiming full ancestry is complete.`,
      };
    }

    try {
      const out = execFileSync(
        "git",
        ["rev-list", localOid, "--not", `--remotes=${remoteName}`],
        {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      ).trim();
      if (out) {
        return {
          commits: out.split("\n").map((s) => s.trim()).filter(Boolean),
          isCompleteRange: true,
        };
      }
      return { commits: [localOid], isCompleteRange: true };
    } catch {
      return {
        commits: [localOid],
        isCompleteRange: false,
        warning: `Failed to query revision range against remotes for '${localOid}'. Audited tip commit without claiming full ancestry is complete.`,
      };
    }
  }

  // Case 2: Existing branch or force push (range: ^remoteOid localOid)
  let remoteOidExists = false;
  try {
    execFileSync("git", ["cat-file", "-e", remoteOid], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    remoteOidExists = true;
  } catch {
    remoteOidExists = false;
  }

  if (!remoteOidExists) {
    return {
      commits: [localOid],
      isCompleteRange: false,
      warning: `Remote OID '${remoteOid}' is not present in local Git object store (shallow repository or un-fetched remote ref). Audited tip commit '${localOid}' without claiming full range was verified.`,
    };
  }

  try {
    const out = execFileSync(
      "git",
      ["rev-list", `^${remoteOid}`, localOid],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
    if (out) {
      return {
        commits: out.split("\n").map((s) => s.trim()).filter(Boolean),
        isCompleteRange: true,
      };
    }
    return { commits: [], isCompleteRange: true };
  } catch {
    return {
      commits: [localOid],
      isCompleteRange: false,
      warning: `Traversal between '${remoteOid}' and '${localOid}' failed (shallow graft or history discontinuity). Audited tip commit '${localOid}' without claiming full range was verified.`,
    };
  }
}

/**
 * Audits unique introduced commits for message conventions, secret patterns, and forbidden files.
 */
export function auditPushedCommits(
  cwd: string,
  commits: string[],
  customSensitivePatterns?: string[]
): CommitAuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const builtInSecretPatterns = [
    /ghp_[a-zA-Z0-9]{36}/,
    /github_pat_[a-zA-Z0-9_]{82}/,
    /sk-[a-zA-Z0-9]{32,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP)?\s*PRIVATE KEY-----/,
    /Bearer\s+[a-zA-Z0-9_\-.]{25,}/i,
  ];

  const customRegexes: RegExp[] = [];
  if (customSensitivePatterns) {
    for (const pat of customSensitivePatterns) {
      try {
        customRegexes.push(new RegExp(pat));
      } catch {
        // Ignore invalid custom regex
      }
    }
  }

  const allSecretPatterns = [...builtInSecretPatterns, ...customRegexes];

  for (const commitOid of commits) {
    // 1. Commit Message Conventions
    let subject = "";
    try {
      subject = execFileSync("git", ["log", "-n", "1", "--format=%s", commitOid], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      failures.push(`[COMMIT_AUDIT] Failed to read commit message for commit '${commitOid}'.`);
      continue;
    }

    if (!subject) {
      failures.push(`[COMMIT_MSG_EMPTY] Commit '${commitOid}' has an empty commit message subject.`);
    } else if (subject.length > 100) {
      failures.push(
        `[COMMIT_MSG_TOO_LONG] Commit '${commitOid}' subject line exceeds 100 characters (${subject.length} chars): "${subject.slice(0, 60)}..."`
      );
    }

    // 2. Secret Pattern Scanning in patch diff
    let patch = "";
    try {
      patch = execFileSync("git", ["show", "--format=", "--unified=0", commitOid], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Non-fatal or root commit without diff
    }

    if (patch) {
      const addedLines = patch
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

      for (const line of addedLines) {
        for (const pattern of allSecretPatterns) {
          if (pattern.test(line)) {
            failures.push(
              `[PREPUSH_SECRET_DETECTED] Commit '${commitOid}' introduces potential secret matching pattern ${pattern.toString()}`
            );
            break;
          }
        }
      }
    }

    // 3. Forbidden paths inspection (temporary and internal lock files)
    let touchedFiles: string[] = [];
    try {
      const touchedOut = execFileSync(
        "git",
        ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commitOid],
        { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim();
      if (touchedOut) {
        touchedFiles = touchedOut.split("\n").map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean);
      }
    } catch {
      // Ignore
    }

    for (const f of touchedFiles) {
      if (
        f.startsWith(".playbook/.tmp/") ||
        f.startsWith(".playbook/logs/") ||
        f.endsWith(".playbook-worktree.json") ||
        f.includes(".tmp.")
      ) {
        failures.push(
          `[PREPUSH_FORBIDDEN_FILE] Commit '${commitOid}' touches forbidden temporary or internal artifact: '${f}'`
        );
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  };
}

/**
 * Creates an ephemeral detached Git worktree for push evaluation.
 */
export function createDetachedPushWorktree(
  repoDir: string,
  commitOid: string
): DetachedWorktreeHandle {
  const nonce = crypto.randomBytes(6).toString("hex");
  const oidPrefix = commitOid.slice(0, 8);
  const worktreeDirName = `push-${oidPrefix}-${nonce}`;
  const baseTmpDir = path.join(repoDir, ".playbook", ".tmp", "worktrees");
  fs.mkdirSync(baseTmpDir, { recursive: true });

  const worktreePath = path.join(baseTmpDir, worktreeDirName);

  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, commitOid], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HookError("WORKTREE_CREATION_FAILED", `Failed to create detached worktree for '${commitOid}': ${msg}`);
  }

  const manifest: WorktreeManifest = {
    schema_version: "1.0.0",
    component: "playbook-git-integration",
    worktree_type: "ephemeral_push_eval",
    owner_pid: process.pid,
    owner_host: os.hostname(),
    created_at: new Date().toISOString(),
    target_commit_oid: commitOid,
    nonce,
  };

  const manifestPath = path.join(worktreePath, ".playbook-worktree.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  } catch (err: unknown) {
    // Attempt cleanup on manifest failure
    removeDetachedPushWorktree(repoDir, worktreePath);
    throw new HookError("WORKTREE_MANIFEST_FAILED", `Failed to write worktree manifest: ${err}`);
  }

  // Attempt to link node_modules if present in the parent repo to allow tests/linters to run immediately
  const parentNodeModules = path.join(repoDir, "node_modules");
  const worktreeNodeModules = path.join(worktreePath, "node_modules");
  if (fs.existsSync(parentNodeModules) && !fs.existsSync(worktreeNodeModules)) {
    try {
      if (process.platform === "win32") {
        fs.symlinkSync(parentNodeModules, worktreeNodeModules, "junction");
      } else {
        fs.symlinkSync(parentNodeModules, worktreeNodeModules, "dir");
      }
    } catch {
      // Best effort; ignore if linking not permitted
    }
  }

  return {
    worktreePath,
    targetCommitOid: commitOid,
    nonce,
    manifest,
  };
}

/**
 * Removes an ephemeral detached Git worktree and prunes metadata.
 */
export function removeDetachedPushWorktree(repoDir: string, worktreePath: string): void {
  // If junction/symlink for node_modules exists, remove it first to avoid recursively walking main node_modules
  const worktreeNodeModules = path.join(worktreePath, "node_modules");
  try {
    if (fs.existsSync(worktreeNodeModules)) {
      const stat = fs.lstatSync(worktreeNodeModules);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(worktreeNodeModules);
      }
    }
  } catch {
    // Ignore
  }

  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // If git worktree remove fails, remove directory from disk if it exists
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore residual locked files
      }
    }
  }

  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Ignore
  }
}

/**
 * Scans `.playbook/.tmp/worktrees/` and safely prunes verified Playbook orphaned worktrees.
 */
export async function reapOrphanedPushWorktrees(
  repoDir: string,
  livenessChecker: ProcessLivenessChecker = defaultProcessLivenessChecker
): Promise<{ reaped: string[]; retained: string[] }> {
  const baseTmpDir = path.join(repoDir, ".playbook", ".tmp", "worktrees");
  const result = { reaped: [] as string[], retained: [] as string[] };

  if (!fs.existsSync(baseTmpDir)) {
    return result;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(baseTmpDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(baseTmpDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const manifestPath = path.join(fullPath, ".playbook-worktree.json");
    if (!fs.existsSync(manifestPath)) {
      // Unmanaged or unknown directory -> conservative retention
      result.retained.push(entry);
      continue;
    }

    let manifest: WorktreeManifest;
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      manifest = JSON.parse(raw);
    } catch {
      // Malformed manifest JSON -> conservative retention
      result.retained.push(entry);
      continue;
    }

    if (
      !manifest ||
      manifest.component !== "playbook-git-integration" ||
      manifest.worktree_type !== "ephemeral_push_eval" ||
      typeof manifest.owner_pid !== "number" ||
      manifest.owner_pid <= 0
    ) {
      // Invalid or non-Playbook metadata -> conservative retention
      result.retained.push(entry);
      continue;
    }

    // Check process liveness
    const liveness = await livenessChecker(manifest.owner_pid, manifest.created_at, manifest.owner_host);

    // Strict Fail-Closed Rule: Delete ONLY when the recorded owner process is definitively verified dead.
    // Retain if alive, indeterminate, cross-host, or unverifiable. Never delete based on age alone.
    if (liveness.isVerifiedDead === true) {
      try {
        removeDetachedPushWorktree(repoDir, fullPath);
        result.reaped.push(entry);
      } catch {
        result.retained.push(entry);
      }
    } else {
      // Active, cross-host, or indeterminate process -> conservative retention
      result.retained.push(entry);
    }
  }

  return result;
}
