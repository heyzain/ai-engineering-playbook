import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { normalizeRelativePath } from "../../utils/paths.js";
import type { WorkingTreeTier } from "../../types/quality-gates.js";

export interface WorkingTreeStatus {
  isClean: boolean;
  tier: WorkingTreeTier;
  modifiedFiles: string[];
  untrackedFiles: string[];
  headCommitSha: string | null;
}

/**
 * Inspects working tree cleanliness using git status --porcelain.
 * Gracefully handles non-git repositories.
 */
export function inspectWorkingTree(
  projectDir: string,
  tier: WorkingTreeTier = "local"
): WorkingTreeStatus {
  const resolvedDir = path.resolve(projectDir);

  let gitOutput = "";
  let headSha: string | null = null;

  try {
    // Check if git is available and repo exists
    headSha = execSync("git rev-parse HEAD", {
      cwd: resolvedDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    gitOutput = execSync("git status --porcelain", {
      cwd: resolvedDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Non-git directory or git error
    return {
      isClean: true,
      tier,
      modifiedFiles: [],
      untrackedFiles: [],
      headCommitSha: null,
    };
  }

  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  const lines = gitOutput.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const filePath = normalizeRelativePath(line.slice(3).trim());

    // Ignore temporary playbook directories
    if (filePath.startsWith(".playbook/.tmp") || filePath.startsWith(".playbook/logs")) {
      continue;
    }

    if (status.includes("?")) {
      untrackedFiles.push(filePath);
    } else {
      modifiedFiles.push(filePath);
    }
  }

  const isClean = modifiedFiles.length === 0 && untrackedFiles.length === 0;

  return {
    isClean,
    tier,
    modifiedFiles,
    untrackedFiles,
    headCommitSha: headSha,
  };
}

/**
 * Asserts working tree requirements for the given tier.
 * Throws an Error if tier requirements are violated.
 */
export function assertWorkingTreePolicy(
  projectDir: string,
  tier: WorkingTreeTier,
  targetDeliverablePaths?: string[]
): WorkingTreeStatus {
  const status = inspectWorkingTree(projectDir, tier);

  if (tier === "ci") {
    // Tier 3: CI requires 100% clean tree
    if (!status.isClean) {
      const allDirty = [...status.modifiedFiles, ...status.untrackedFiles];
      throw new Error(
        `[PRECONDITION_FAILED] Working tree is dirty under CI (Tier 3) execution. Modified/untracked files:\n${allDirty.map((f) => `  - ${f}`).join("\n")}`
      );
    }
  } else if (tier === "handover") {
    // Tier 2: Handover requires clean deliverable paths and manifests
    if (targetDeliverablePaths && targetDeliverablePaths.length > 0) {
      const dirtyDeliverables = targetDeliverablePaths.filter(
        (p) => status.modifiedFiles.includes(p) || status.untrackedFiles.includes(p)
      );
      if (dirtyDeliverables.length > 0) {
        throw new Error(
          `[PRECONDITION_FAILED] Deliverables have uncommitted changes under Handover (Tier 2):\n${dirtyDeliverables.map((f) => `  - ${f}`).join("\n")}`
        );
      }
    }
  }

  // Tier 1: Local development allows dirty tree
  return status;
}
