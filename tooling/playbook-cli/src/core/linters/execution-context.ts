import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { LinterError } from "./errors.js";
import { toPosixPath, normalizeRelativePath } from "../../utils/paths.js";
import { matchesAnyGlob } from "../quality-gates/glob.js";
import type {
  RuleExecutionContext,
  ExecutionLimits,
  FileStat,
} from "./types.js";

/**
 * Standard default execution and resource limits.
 */
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxFileSizeBytes: 5 * 1024 * 1024, // 5 MB per file
  maxFilesScanned: 10000,           // 10,000 files maximum
  timeoutMs: 30000,                 // 30 seconds per rule
};

/**
 * Default directory names unconditionally ignored during repository file scanning.
 */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".playbook/.tmp",
  ".expo",
  "dist",
  "build",
  "coverage",
]);

/**
 * Controlled, read-only execution context implementation.
 *
 * Security & Isolation Notice:
 * This execution context provides an in-process, cooperative read-only interface.
 * It strictly bounds file sizes, prevents path traversal outside the repository root,
 * and rejects escaping symlinks. It does not provide OS-level kernel sandboxing or
 * protect against untrusted native code execution.
 */
export class DefaultRuleExecutionContext implements RuleExecutionContext {
  readonly projectDir: string;
  readonly realProjectDir: string;
  readonly limits: ExecutionLimits;
  private scannedFilesCount: number = 0;

  constructor(projectDir: string, customLimits?: Partial<ExecutionLimits>) {
    if (!projectDir || typeof projectDir !== "string" || !projectDir.trim()) {
      throw new LinterError("INVALID_CONFIG", "projectDir must be a non-empty string path.");
    }

    const resolved = path.resolve(projectDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new LinterError(
        "INVALID_CONFIG",
        `Target project directory does not exist or is not a directory: ${resolved}`
      );
    }

    this.projectDir = resolved;
    this.realProjectDir = fs.realpathSync(resolved);
    this.limits = {
      maxFileSizeBytes: customLimits?.maxFileSizeBytes ?? DEFAULT_EXECUTION_LIMITS.maxFileSizeBytes,
      maxFilesScanned: customLimits?.maxFilesScanned ?? DEFAULT_EXECUTION_LIMITS.maxFilesScanned,
      timeoutMs: customLimits?.timeoutMs ?? DEFAULT_EXECUTION_LIMITS.timeoutMs,
    };
  }

  /**
   * Asserts that a relative path is safely confined within the repository root.
   * Throws PATH_TRAVERSAL_DETECTED or SYMLINK_ESCAPE_DETECTED on boundary violation.
   * Returns the resolved absolute file path.
   */
  public assertSafePath(relativeFilePath: string): string {
    if (!relativeFilePath || typeof relativeFilePath !== "string") {
      throw new LinterError("PATH_TRAVERSAL_DETECTED", "Relative file path must be a non-empty string.");
    }

    // Reject absolute paths, drive-relative paths, and UNC network paths
    if (path.isAbsolute(relativeFilePath) || /^[A-Za-z]:[\\/]/.test(relativeFilePath) || relativeFilePath.startsWith("\\\\")) {
      throw new LinterError(
        "PATH_TRAVERSAL_DETECTED",
        `Absolute or drive-qualified paths are forbidden in execution context: '${relativeFilePath}'`
      );
    }

    // Normalize relative path
    const normalizedRel = path.normalize(relativeFilePath);
    if (normalizedRel.startsWith("..") || normalizedRel === ".." || path.isAbsolute(normalizedRel)) {
      throw new LinterError(
        "PATH_TRAVERSAL_DETECTED",
        `Path traversal escaping project root is strictly prohibited: '${relativeFilePath}'`
      );
    }

    const resolved = path.resolve(this.projectDir, normalizedRel);

    // Ensure resolved path starts with projectDir
    const relToRoot = path.relative(this.projectDir, resolved);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      throw new LinterError(
        "PATH_TRAVERSAL_DETECTED",
        `Resolved path '${resolved}' escapes project root '${this.projectDir}'.`
      );
    }

    // Check symlink escapes if target exists
    if (fs.existsSync(resolved)) {
      try {
        const realTarget = fs.realpathSync(resolved);
        const relToRealRoot = path.relative(this.realProjectDir, realTarget);
        if (relToRealRoot.startsWith("..") || path.isAbsolute(relToRealRoot)) {
          throw new LinterError(
            "SYMLINK_ESCAPE_DETECTED",
            `Symbolic link '${relativeFilePath}' resolves outside repository root to '${realTarget}'.`
          );
        }
      } catch (err: unknown) {
        if (err instanceof LinterError) throw err;
        // Ignore realpath error if file cannot be resolved
      }
    }

    return resolved;
  }

  /**
   * Safely reads text contents of a relative file path with UTF-8 validation and size bounds.
   */
  public readFile(relativeFilePath: string): string {
    const resolved = this.assertSafePath(relativeFilePath);

    if (!fs.existsSync(resolved)) {
      throw new LinterError("INVALID_CONFIG", `File does not exist: ${relativeFilePath}`);
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new LinterError("INVALID_CONFIG", `Cannot read directory as file: ${relativeFilePath}`);
    }

    if (stat.size > this.limits.maxFileSizeBytes) {
      throw new LinterError(
        "FILE_TOO_LARGE",
        `File '${relativeFilePath}' exceeds size limit (${stat.size} bytes > ${this.limits.maxFileSizeBytes} bytes).`,
        { filePath: relativeFilePath, size: stat.size, limit: this.limits.maxFileSizeBytes }
      );
    }

    const buffer = fs.readFileSync(resolved);

    // Validate UTF-8 strictly using TextDecoder fatal mode
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text: string;
    try {
      text = decoder.decode(buffer);
    } catch {
      throw new LinterError(
        "INVALID_UTF8",
        `File '${relativeFilePath}' contains invalid or malformed UTF-8 byte sequences.`
      );
    }

    // Strip BOM if present
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    return text;
  }

  /**
   * Safely reads raw binary bytes of a relative file path with size bounds.
   */
  public readFileBuffer(relativeFilePath: string): Buffer {
    const resolved = this.assertSafePath(relativeFilePath);

    if (!fs.existsSync(resolved)) {
      throw new LinterError("INVALID_CONFIG", `File does not exist: ${relativeFilePath}`);
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new LinterError("INVALID_CONFIG", `Cannot read directory as file buffer: ${relativeFilePath}`);
    }

    if (stat.size > this.limits.maxFileSizeBytes) {
      throw new LinterError(
        "FILE_TOO_LARGE",
        `File '${relativeFilePath}' exceeds size limit (${stat.size} bytes > ${this.limits.maxFileSizeBytes} bytes).`,
        { filePath: relativeFilePath, size: stat.size, limit: this.limits.maxFileSizeBytes }
      );
    }

    return fs.readFileSync(resolved);
  }

  /**
   * Checks whether a relative path exists within the repository root.
   */
  public fileExists(relativeFilePath: string): boolean {
    try {
      const resolved = this.assertSafePath(relativeFilePath);
      return fs.existsSync(resolved);
    } catch (err: unknown) {
      if (err instanceof LinterError && (err.code === "PATH_TRAVERSAL_DETECTED" || err.code === "SYMLINK_ESCAPE_DETECTED")) {
        throw err;
      }
      return false;
    }
  }

  /**
   * Returns metadata for a relative path within the repository root.
   */
  public statFile(relativeFilePath: string): FileStat {
    const resolved = this.assertSafePath(relativeFilePath);
    if (!fs.existsSync(resolved)) {
      throw new LinterError("INVALID_CONFIG", `Path does not exist: ${relativeFilePath}`);
    }

    const stat = fs.lstatSync(resolved);
    return {
      size: stat.size,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  }

  /**
   * Normalizes a file path to POSIX forward-slash format without leading './'.
   */
  public normalizePath(filePath: string): string {
    return normalizeRelativePath(toPosixPath(filePath));
  }

  /**
   * Scans and returns relative POSIX file paths matching target globs, respecting exclusions and limits.
   */
  public listFiles(globs?: string[], excludeGlobs?: string[]): string[] {
    this.scannedFilesCount = 0;
    const results: string[] = [];

    const walk = (currentDir: string, relativeDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const name = entry.name;
        const entryRelPath = relativeDir ? `${relativeDir}/${name}` : name;
        const entryPosix = toPosixPath(entryRelPath);

        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(name) || DEFAULT_IGNORED_DIRS.has(entryPosix)) {
            continue;
          }
          if (excludeGlobs && matchesAnyGlob(entryPosix, excludeGlobs)) {
            continue;
          }
          walk(path.join(currentDir, name), entryRelPath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          this.scannedFilesCount++;
          if (this.scannedFilesCount > this.limits.maxFilesScanned) {
            throw new LinterError(
              "FILE_COUNT_EXCEEDED",
              `File scan exceeded maximum limit of ${this.limits.maxFilesScanned} files.`,
              { limit: this.limits.maxFilesScanned }
            );
          }

          if (excludeGlobs && matchesAnyGlob(entryPosix, excludeGlobs)) {
            continue;
          }

          if (globs && globs.length > 0) {
            if (!matchesAnyGlob(entryPosix, globs)) {
              continue;
            }
          }

          results.push(entryPosix);
        }
      }
    };

    walk(this.projectDir, "");
    return results.sort((a, b) => a.localeCompare(b));
  }
}
