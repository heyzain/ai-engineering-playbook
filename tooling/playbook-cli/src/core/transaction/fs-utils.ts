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
 * Checks whether a relative path contains syntactically safe path tokens.
 * Rejects absolute paths, UNC prefixes, Windows drive prefixes, leading slashes,
 * traversal tokens ('..'), current-dir tokens ('.'), and empty tokens.
 */
export function isSyntacticallySafeRelativePath(p: unknown): boolean {
  if (typeof p !== "string" || p.trim().length === 0) {
    return false;
  }

  // Reject absolute paths, UNC paths, and drive-relative paths
  if (
    path.isAbsolute(p) ||
    p.startsWith("\\\\") ||
    p.startsWith("//") ||
    /^[a-zA-Z]:/.test(p) ||
    p.startsWith("/") ||
    p.startsWith("\\")
  ) {
    return false;
  }

  // Reject path traversal tokens, current-dir tokens, and empty segments
  const parts = p.split(/[/\\]/);
  if (parts.some((part) => part === ".." || part === "." || part === "")) {
    return false;
  }

  return true;
}

/**
 * Validates that a target path is relative and strictly contained within targetDir.
 * Defends against absolute paths, traversal (..), UNC paths, and symlink/junction escapes.
 *
 * NOTE ON TOCTOU / SYMLINK RACES:
 * Standard Node.js does not expose kernel-level dirfd-relative primitives (e.g. openat(2) with
 * RESOLVE_BENEATH / RESOLVE_NO_SYMLINKS). An unprivileged external process could theoretically
 * attempt to replace a validated parent directory with a symlink between validation and rename.
 * To mitigate this risk, the engine implements defense-in-depth:
 * 1. Dual-layer lock exclusion via TransactionLockManager.
 * 2. Strict ancestor directory lstat / realpath boundary verification.
 * 3. Same-directory staging of .tmp and .bak files.
 * 4. Fail-closed abort if any realpath diverges from canonical project root.
 */
export function validateCanonicalPath(
  targetDir: string,
  relativePath: string
): { relativePath: string; absolutePath: string } {
  if (!isSyntacticallySafeRelativePath(relativePath)) {
    throw new TransactionError(
      "TARGET_PATH_INVALID",
      `Target path is invalid or unsafe: "${relativePath}". Absolute, UNC, drive-relative, empty, and traversal paths are strictly forbidden.`
    );
  }

  const resolvedRoot = path.resolve(targetDir);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);

  // Containment check
  const isWin = process.platform === "win32";
  const normRoot = isWin ? resolvedRoot.toLowerCase() : resolvedRoot;
  const normTarget = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;
  const rootPrefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;

  if (normTarget !== normRoot && !normTarget.startsWith(rootPrefix)) {
    throw new TransactionError(
      "TARGET_PATH_INVALID",
      `Target path escapes project root boundary: "${relativePath}".`
    );
  }

  // Symlink boundary check: check both lstat and realpath for target and all ancestors up to resolvedRoot
  try {
    let checkPath = resolvedTarget;
    while (checkPath !== resolvedRoot) {
      try {
        const lstat = fs.lstatSync(checkPath);
        if (lstat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(checkPath);
          const resolvedLink = path.isAbsolute(linkTarget)
            ? path.resolve(linkTarget)
            : path.resolve(path.dirname(checkPath), linkTarget);
          const normLink = isWin ? resolvedLink.toLowerCase() : resolvedLink;
          if (normLink !== normRoot && !normLink.startsWith(rootPrefix)) {
            throw new TransactionError(
              "TARGET_PATH_INVALID",
              `Target path escapes project boundary via symlink: "${relativePath}".`
            );
          }
        }
      } catch (lstatErr: unknown) {
        if (lstatErr instanceof TransactionError) throw lstatErr;
        // File or segment does not exist yet; continue checking ancestors
      }

      const parent = path.dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }

    // Now verify existing realpath does not escape root
    let existingAncestor = resolvedTarget;
    while (!fs.existsSync(existingAncestor) && existingAncestor !== resolvedRoot) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }

    if (fs.existsSync(existingAncestor)) {
      const realAncestor = fs.realpathSync(existingAncestor);
      const realRoot = fs.realpathSync(resolvedRoot);
      const normRealAncestor = isWin ? realAncestor.toLowerCase() : realAncestor;
      const normRealRoot = isWin ? realRoot.toLowerCase() : realRoot;
      const realRootPrefix = normRealRoot.endsWith(path.sep) ? normRealRoot : normRealRoot + path.sep;

      if (
        normRealAncestor !== normRealRoot &&
        !normRealAncestor.startsWith(realRootPrefix)
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
 * If requireParentDirectoryExists is true, fails closed without implicitly recreating missing directory.
 */
export function safeWriteAndSync(
  filePath: string,
  content: string,
  options?: { requireParentDirectoryExists?: boolean }
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    if (options?.requireParentDirectoryExists) {
      throw new TransactionError(
        "PIVOT_STORAGE_LAYOUT_MISSING",
        `Required storage directory is missing for write target: "${dir}". Directory creation is not permitted under strict storage layout policy.`,
        { targetPath: filePath, missingDirectory: dir }
      );
    }
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
 * On Windows, directory fsync is unsupported by Node.js and is a safe no-op.
 *
 * Requirements:
 * - On supported POSIX filesystems, opens directory descriptor and executes fsyncSync.
 * - Throws on genuine filesystem synchronization failures (I/O error, EACCES, EPERM)
 *   so callers fail closed and preserve recovery information.
 * - Always dispatches to faultInjection.onDirectoryFsync so tests can assert directory fsync.
 */
export function safeFsyncDir(
  dirPath: string,
  faultInjectionHooks?: {
    failDirectoryFsync?: boolean;
    failDirectoryFsyncOnCommit?: boolean;
    isCommitPhase?: boolean;
    onDirectoryFsync?: (dirPath: string) => void;
  }
): void {
  // Notify spy hook for regression tests regardless of platform
  faultInjectionHooks?.onDirectoryFsync?.(dirPath);

  if (
    faultInjectionHooks?.failDirectoryFsync ||
    (faultInjectionHooks?.failDirectoryFsyncOnCommit && faultInjectionHooks?.isCommitPhase)
  ) {
    const fakeErr = new Error("EIO: simulated i/o error, fsync directory") as NodeJS.ErrnoException;
    fakeErr.code = "EIO";
    throw fakeErr;
  }

  if (process.platform === "win32") {
    // Windows NTFS directory fsync is unsupported without native Win32 bindings (FILE_FLAG_BACKUP_SEMANTICS).
    // Durability is deferred to NTFS checkpointing.
    return;
  }

  if (!fs.existsSync(dirPath)) {
    return;
  }

  // On POSIX, open directory in read-only mode to fsync directory entry
  const dirFd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    try {
      fs.closeSync(dirFd);
    } catch {
      // ignore close errors
    }
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
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      try {
        fs.chmodSync(filePath, 0o666);
        fs.unlinkSync(filePath);
        return true;
      } catch {
        // Fall through to rethrow original error if chmod+unlink still fails
      }
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
