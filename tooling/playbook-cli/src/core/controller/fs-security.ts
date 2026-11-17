import fs from "node:fs";
import crypto from "node:crypto";
import { validateCanonicalPath, TransactionError } from "../transaction/index.js";
import { ControllerError } from "./types.js";

export interface SecureEvidenceFileResult {
  absolutePath: string;
  relativePath: string;
  fileHash: string;
  size: number;
}

/**
 * Validates and hashes an evidence file using defense-in-depth file descriptor checks.
 *
 * Implements:
 * 1. Canonical path containment and symlink escape defense via `validateCanonicalPath`.
 * 2. Kernel file descriptor inspection via `fs.openSync` and `fstatSync(fd)`.
 * 3. Pre- and post-read stat comparisons detecting concurrent file modifications.
 * 4. Streaming SHA-256 byte hashing formatted with canonical `sha256:` prefix.
 */
export function inspectAndHashEvidenceFile(
  targetDir: string,
  evidenceRef: string
): SecureEvidenceFileResult {
  let validated: { relativePath: string; absolutePath: string };
  try {
    validated = validateCanonicalPath(targetDir, evidenceRef);
  } catch (err: unknown) {
    if (err instanceof TransactionError) {
      throw new ControllerError(err.code, err.message, { path: evidenceRef });
    }
    throw new ControllerError(
      "TARGET_PATH_INVALID",
      `Invalid evidence path: ${err instanceof Error ? err.message : String(err)}`,
      { path: evidenceRef }
    );
  }

  const absPath = validated.absolutePath;
  if (!fs.existsSync(absPath)) {
    throw new ControllerError(
      "EVIDENCE_FILE_NOT_FOUND",
      `Evidence file does not exist on disk: "${evidenceRef}".`,
      { path: evidenceRef, absolutePath: absPath }
    );
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, "r");
    const preStat = fs.fstatSync(fd);

    if (!preStat.isFile()) {
      throw new ControllerError(
        "EVIDENCE_NOT_A_FILE",
        `Evidence path is not a regular file: "${evidenceRef}".`,
        { path: evidenceRef }
      );
    }

    if (preStat.size === 0) {
      throw new ControllerError(
        "EVIDENCE_FILE_EMPTY",
        `Evidence file is empty (0 bytes): "${evidenceRef}". Automated evidence requires non-empty proof.`,
        { path: evidenceRef }
      );
    }

    const preSize = preStat.size;
    const preMtime = preStat.mtimeMs;

    // Read bytes from the open file descriptor to compute hash
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(65536); // 64KB read chunks
    let bytesRead = 0;
    let position = 0;

    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    // Post-stream stat comparison to detect concurrent modification during read
    const postStat = fs.fstatSync(fd);
    if (postStat.size !== preSize || postStat.mtimeMs !== preMtime) {
      throw new ControllerError(
        "CONCURRENT_FILE_MODIFICATION_DETECTED",
        `Evidence file "${evidenceRef}" was modified concurrently during hash calculation.`,
        {
          path: evidenceRef,
          preSize,
          postSize: postStat.size,
          preMtime,
          postMtime: postStat.mtimeMs,
        }
      );
    }

    const calculatedHash = `sha256:${hash.digest("hex").toLowerCase()}`;

    return {
      absolutePath: absPath,
      relativePath: validated.relativePath,
      fileHash: calculatedHash,
      size: preSize,
    };
  } catch (err: unknown) {
    if (err instanceof ControllerError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ControllerError(
      "EVIDENCE_FILE_UNREADABLE",
      `Failed to read evidence file "${evidenceRef}": ${msg}`,
      { path: evidenceRef }
    );
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Safe ignore
      }
    }
  }
}
