import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { defaultProcessLivenessChecker } from "../lock/liveness.js";
import type { ProcessLivenessChecker } from "../lock/types.js";
import { DEFAULT_PATHS } from "../../constants.js";

export interface StagingMetadata {
  schema_version: string;
  pid: number;
  run_nonce: string;
  hostname: string;
  created_at: string;
  started_at_ms?: number;
  command?: string;
  args?: string[];
}

export interface ReapReport {
  reapedFiles: string[];
  retainedFiles: Array<{
    file: string;
    reason: string;
  }>;
}

/**
 * Reaps orphaned staging files from `.playbook/.tmp/` under strict conservative retention:
 * - Missing or malformed metadata -> CONSERVATIVE RETENTION.
 * - Remote hostname metadata -> CONSERVATIVE RETENTION.
 * - Process is alive or indeterminate -> CONSERVATIVE RETENTION.
 * - Process is verified dead -> Safely unlinks .meta.json and associated .log.
 * - Orphaned .log without .meta.json -> CONSERVATIVE RETENTION (Crash Window A).
 */
export async function reapStagingFiles(
  projectDir: string,
  livenessChecker: ProcessLivenessChecker = defaultProcessLivenessChecker
): Promise<ReapReport> {
  const tmpDir = path.join(path.resolve(projectDir), DEFAULT_PATHS.playbookDir, ".tmp");

  const report: ReapReport = {
    reapedFiles: [],
    retainedFiles: [],
  };

  if (!fs.existsSync(tmpDir)) {
    return report;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return report;
  }

  const metaFiles = new Set(entries.filter((f) => f.endsWith(".meta.json")));
  const logFiles = new Set(entries.filter((f) => f.endsWith(".log")));

  const currentHostname = os.hostname();

  for (const metaFileName of metaFiles) {
    const metaPath = path.join(tmpDir, metaFileName);
    const baseName = metaFileName.slice(0, -".meta.json".length);
    const associatedLogName = `${baseName}.log`;
    const associatedLogPath = path.join(tmpDir, associatedLogName);

    let raw: string;
    try {
      raw = fs.readFileSync(metaPath, "utf-8");
    } catch {
      report.retainedFiles.push({
        file: metaFileName,
        reason: "Failed to read staging metadata file; conservative retention.",
      });
      continue;
    }

    let meta: StagingMetadata;
    try {
      meta = JSON.parse(raw);
    } catch {
      report.retainedFiles.push({
        file: metaFileName,
        reason: "Malformed JSON in staging metadata; conservative retention.",
      });
      continue;
    }

    if (!meta.pid || !meta.run_nonce || typeof meta.pid !== "number") {
      report.retainedFiles.push({
        file: metaFileName,
        reason: "Missing pid or run_nonce in staging metadata; conservative retention.",
      });
      continue;
    }

    // Cross-host check: remote hostname staging files are never touched
    if (meta.hostname && meta.hostname !== currentHostname) {
      report.retainedFiles.push({
        file: metaFileName,
        reason: `Remote hostname '${meta.hostname}' does not match current host '${currentHostname}'; conservative retention.`,
      });
      continue;
    }

    // Verify process liveness
    try {
      const liveness = await livenessChecker(meta.pid, meta.created_at, meta.hostname);
      if (liveness.isVerifiedDead === true) {
        // Safe to reap dead process staging files
        try {
          if (fs.existsSync(associatedLogPath)) {
            fs.unlinkSync(associatedLogPath);
            report.reapedFiles.push(associatedLogName);
          }
          fs.unlinkSync(metaPath);
          report.reapedFiles.push(metaFileName);
        } catch {
          // Ignore unlink errors during reaping
        }
      } else {
        // Alive or indeterminate
        report.retainedFiles.push({
          file: metaFileName,
          reason: liveness.isAlive
            ? `Process ${meta.pid} is still actively running.`
            : `Process ${meta.pid} liveness status is indeterminate (${liveness.reason || "unknown"}).`,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      report.retainedFiles.push({
        file: metaFileName,
        reason: `Liveness probe error: ${msg}; conservative retention.`,
      });
    }
  }

  // Crash Window A: .log files without .meta.json
  for (const logFileName of logFiles) {
    const baseName = logFileName.slice(0, -".log".length);
    const expectedMetaName = `${baseName}.meta.json`;

    if (!metaFiles.has(expectedMetaName)) {
      report.retainedFiles.push({
        file: logFileName,
        reason: "Orphaned staging log without metadata record (Crash Window A); conservative retention.",
      });
    }
  }

  return report;
}
