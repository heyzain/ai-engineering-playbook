import path from "node:path";
import { execSync } from "node:child_process";
import { HookError } from "../../types/hooks.js";

/**
 * Checks whether the specified directory is inside a Git repository.
 */
export function isInsideGitRepository(cwd = process.cwd()): boolean {
  try {
    const stdout = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return stdout === "true";
  } catch {
    return false;
  }
}

/**
 * Resolves the top-level repository root directory.
 */
export function resolveGitRoot(cwd = process.cwd()): string {
  try {
    const stdout = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return path.resolve(cwd, stdout);
  } catch (err: unknown) {
    throw new HookError(
      "NOT_A_GIT_REPOSITORY",
      `The directory "${cwd}" is not inside a Git repository.`,
      { cwd, originalError: err instanceof Error ? err.message : String(err) }
    );
  }
}

/**
 * Resolves the authoritative physical Git hooks directory.
 *
 * Uses `git rev-parse --git-path hooks` to automatically resolve:
 * 1. Standard repositories (.git/hooks)
 * 2. Linked worktrees (resolves to common parent .git/hooks)
 * 3. Custom repository core.hooksPath configuration
 *
 * If hooksDirOverride is provided (e.g. from --hooks-dir), it takes precedence.
 */
export function resolveGitHooksDir(cwd = process.cwd(), hooksDirOverride?: string): string {
  const resolvedCwd = path.resolve(cwd);

  if (hooksDirOverride && hooksDirOverride.trim().length > 0) {
    return path.isAbsolute(hooksDirOverride)
      ? path.resolve(hooksDirOverride)
      : path.resolve(resolvedCwd, hooksDirOverride);
  }

  try {
    const stdout = execSync("git rev-parse --git-path hooks", {
      cwd: resolvedCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();

    if (!stdout) {
      throw new HookError(
        "HOOKS_PATH_UNRESOLVED",
        `Git returned an empty hooks path for directory "${resolvedCwd}".`
      );
    }

    return path.resolve(resolvedCwd, stdout);
  } catch (err: unknown) {
    if (err instanceof HookError) {
      throw err;
    }
    throw new HookError(
      "NOT_A_GIT_REPOSITORY",
      `Cannot resolve Git hooks directory for "${resolvedCwd}". Ensure the directory is inside a valid Git repository.`,
      { cwd: resolvedCwd, originalError: err instanceof Error ? err.message : String(err) }
    );
  }
}
