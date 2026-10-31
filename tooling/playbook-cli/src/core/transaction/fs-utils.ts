import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TransactionError } from "./types.js";

/**
 * Computes canonical SHA-256 hash formatted with `sha256:` prefix.
 */
export function computeSha256(content: string | Buffer): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `sha256:${hash.toLowerCase()}`;
}

/**
 * Computes SHA-256 hash of an existing file on disk.
 * Returns null if the file does not exist or cannot be read.
 */
export function computeFileSha256(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    const content = fs.readFileSync(filePath);
    return computeSha256(content);
  } catch {
    return null;
  }
}

/**
 * Validates that a target path is relative and strictly contained within targetDir.
 * Defends against absolute paths, traversal (..), and symlink escape boundaries.
 */
export function validateCanonicalPath(
  targetDir: string,
  relativePath: string
): { relativePath: string; absolutePath: string } {
  if (!relativePath || typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new TransactionError(
      "TARGET_PATH_INVALID",
      "Transaction target path cannot be empty."
    );
  }

  // Reject absolute paths, UNC paths, and drive-relative paths
  if (
    path.isAbsolute(relativePath) ||
    relativePath.startsWith("\\\\") ||
    relativePath.startsWith("//") ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new TransactionError(
      "TARGET_PATH_INVALID",
      `Absolute, UNC, or drive-relative paths are forbidden: "${relativePath}".`
    );
  }

  // Reject path traversal tokens
  const normalizedParts = relativePath.split(/[/\\]/);
  if (normalizedParts.includes("..")) {
    throw new TransactionError(
      "TARGET_PATH_INVALID",
      `Path traversal ("..") is strictly forbidden: "${relativePath}".`
    );
  }

  const resolvedRoot = path.resolve(targetDir);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);

  // Containment check
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new TransactionError(
      "TARGET_PATH_INVALID",
      `Target path escapes project root boundary: "${relativePath}".`
    );
  }

  // Symlink boundary check: if file or parent exists, verify realpath does not escape resolvedRoot
  try {
    let checkPath = resolvedTarget;
    while (!fs.existsSync(checkPath) && checkPath !== resolvedRoot) {
      const parent = path.dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }

    if (fs.existsSync(checkPath)) {
      const realTarget = fs.realpathSync(checkPath);
      const realRoot = fs.realpathSync(resolvedRoot);
      if (
        realTarget !== realRoot &&
        !realTarget.startsWith(realRoot + path.sep)
      ) {
        throw new TransactionError(
          "TARGET_PATH_INVALID",
          `Target path escapes project boundary via symlink: "${relativePath}".`
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof TransactionError) throw err;
    // Non-fatal if parent check cannot resolve
  }

  // Return normalized relative path using forward slashes
  const cleanRelative = path.relative(resolvedRoot, resolvedTarget).replace(/\\/g, "/");
  return {
    relativePath: cleanRelative,
    absolutePath: resolvedTarget,
  };
}

/**
 * Durably writes file content using fsyncSync before closing.
 */
export function safeWriteAndSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, content, 0, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * Synchronizes containing directory metadata to disk on POSIX.
 * On Windows, directory fsync is not supported and is a safe no-op.
 */
export function safeFsyncDir(dirPath: string): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    if (fs.existsSync(dirPath)) {
      // On POSIX, open directory in read-only mode to fsync directory entry
      const dirFd = fs.openSync(dirPath, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  } catch {
    // Non-fatal if OS restricts directory open
  }
}

/**
 * Atomically renames a source file over a destination file with exponential backoff
 * retries to handle Windows transient file locks (e.g. antivirus scanning, indexers).
 */
export function atomicRenameWithRetry(
  srcPath: string,
  destPath: string,
  maxRetries = 5,
  retryDelayMs = 50,
  faultInjectionHooks?: { simulateRenameEbusyCount?: number }
): void {
  let simulatedEbusyRemaining = faultInjectionHooks?.simulateRenameEbusyCount ?? 0;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      if (simulatedEbusyRemaining > 0) {
        simulatedEbusyRemaining--;
        const fakeErr = new Error("EBUSY: resource busy or locked, rename") as NodeJS.ErrnoException;
        fakeErr.code = "EBUSY";
        throw fakeErr;
      }

      fs.renameSync(srcPath, destPath);
      return;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      const isTransientWindowsLock =
        error &&
        (error.code === "EBUSY" ||
          error.code === "EPERM" ||
          error.code === "EACCES");

      if (isTransientWindowsLock && attempt <= maxRetries) {
        // Synchronous sleep with linear/jittered backoff
        const delay = retryDelayMs * attempt;
        sleepSync(delay);
        continue;
      }

      throw error;
    }
  }
}

/**
 * Safely deletes a file if it exists, ignoring ENOENT.
 */
export function safeUnlink(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait for short retry duration
  }
}
