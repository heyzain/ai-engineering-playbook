import path from "node:path";

/**
 * Normalizes any filesystem path to a standard POSIX-style path with forward slashes.
 * Crucial for cross-platform stability (Windows/Linux/macOS) in JSON manifests and state files.
 */
export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Normalizes relative paths ensuring no leading "./" and using forward slashes.
 */
export function normalizeRelativePath(filePath: string): string {
  const posix = toPosixPath(filePath);
  if (posix.startsWith("./")) {
    return posix.slice(2);
  }
  return posix;
}
