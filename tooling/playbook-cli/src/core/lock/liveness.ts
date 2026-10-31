import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { ProcessLivenessResult, ProcessLivenessChecker } from "./types.js";

/**
 * Platform-aware process liveness and PID reuse verifier.
 *
 * Implements strict fail-closed safety invariants:
 * - Age alone never establishes that a process is dead.
 * - EPERM from process.kill(pid, 0) means the process exists in another context (ALIVE).
 * - Cross-host locks cannot verify PID death; treated as alive/unverifiable.
 * - Process start-time recycling verifies PID reuse where supported.
 */
export function defaultProcessLivenessChecker(
  pid: number,
  recordedCreatedAt?: string,
  recordedHostname?: string
): ProcessLivenessResult {
  const currentHostname = os.hostname();

  // 1. Cross-host check: Local PID inspection cannot verify processes on other machines
  if (recordedHostname && recordedHostname !== currentHostname) {
    return {
      isAlive: true,
      isVerifiedDead: false,
      reason: `Process is on remote host "${recordedHostname}" (current host: "${currentHostname}"). Cross-host process checking is not supported.`,
      pid,
    };
  }

  // 2. Validate PID value
  if (!pid || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return {
      isAlive: false,
      isVerifiedDead: false,
      reason: `Invalid PID: ${pid}. Process ownership cannot be established.`,
      pid,
    };
  }

  // 3. Operating system process existence check via process.kill(pid, 0)
  let pidExists = false;
  try {
    process.kill(pid, 0);
    pidExists = true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error && error.code === "ESRCH") {
      // ESRCH proves process definitively does not exist in operating system process table
      return {
        isAlive: false,
        isVerifiedDead: true,
        reason: `Process ${pid} does not exist in operating system process table (ESRCH).`,
        pid,
      };
    }

    if (error && error.code === "EPERM") {
      // Invariant 3: EPERM indicates the process exists, but permission is denied. It is ALIVE.
      return {
        isAlive: true,
        isVerifiedDead: false,
        reason: `Process ${pid} exists but access was denied (EPERM). Process is alive.`,
        pid,
      };
    }

    // Unrecognized error code: fail closed, treat as alive
    return {
      isAlive: true,
      isVerifiedDead: false,
      reason: `Process ${pid} liveness check returned unexpected error: ${error?.message || String(err)}.`,
      pid,
    };
  }

  // 4. PID exists in OS table. Now verify if PID was recycled after lock creation.
  if (pidExists && recordedCreatedAt) {
    const lockCreatedDate = new Date(recordedCreatedAt);
    if (!isNaN(lockCreatedDate.getTime())) {
      const startTime = getProcessStartTime(pid);
      if (startTime) {
        // If process was started strictly after lock creation (with 2000ms grace for clock skew),
        // the original process terminated and the OS recycled the PID to an unrelated new process.
        const diffMs = startTime.getTime() - lockCreatedDate.getTime();
        if (diffMs > 2000) {
          return {
            isAlive: false,
            isVerifiedDead: true,
            isRecycled: true,
            reason: `Process ${pid} start time (${startTime.toISOString()}) is after lock creation (${lockCreatedDate.toISOString()}); PID was recycled.`,
            pid,
            startTime,
          };
        }

        return {
          isAlive: true,
          isVerifiedDead: false,
          isRecycled: false,
          reason: `Process ${pid} is active and process start time (${startTime.toISOString()}) precedes or matches lock creation.`,
          pid,
          startTime,
        };
      }
    }
  }

  // Fallback: PID exists and cannot be proven recycled -> must be treated as ALIVE
  return {
    isAlive: true,
    isVerifiedDead: false,
    reason: `Process ${pid} exists in operating system process table.`,
    pid,
  };
};

/**
 * Attempts to retrieve process creation/start time from operating system.
 * Returns null if start time cannot be reliably queried.
 */
export function getProcessStartTime(pid: number): Date | null {
  const platform = process.platform;

  if (platform === "linux") {
    return getLinuxProcessStartTime(pid);
  }

  if (platform === "win32") {
    return getWindowsProcessStartTime(pid);
  }

  if (platform === "darwin") {
    return getMacProcessStartTime(pid);
  }

  return null;
}

function getLinuxProcessStartTime(pid: number): Date | null {
  try {
    const statPath = `/proc/${pid}`;
    if (fs.existsSync(statPath)) {
      const stat = fs.statSync(statPath);
      // /proc/<pid> mtime reflects process creation time on Linux
      if (stat.mtime && !isNaN(stat.mtime.getTime())) {
        return stat.mtime;
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function getWindowsProcessStartTime(pid: number): Date | null {
  try {
    const psScript = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`;
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      {
        encoding: "utf-8",
        timeout: 2500,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();

    const date = new Date(output);
    if (!isNaN(date.getTime())) {
      return date;
    }
  } catch {
    // Query failed or PowerShell restricted; fallback safely to null
  }
  return null;
}

function getMacProcessStartTime(pid: number): Date | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      timeout: 2500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const date = new Date(output);
    if (!isNaN(date.getTime())) {
      return date;
    }
  } catch {
    // Query failed
  }
  return null;
}
