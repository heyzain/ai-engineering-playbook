import fs from "node:fs";
import path from "node:path";
import {
  getGitObjectFormat,
  isZeroOid,
  parsePrePushStdin,
  peelTagToCommit,
  resolveCommitTree,
  resolvePushedIntroducedCommits,
  auditPushedCommits,
  createDetachedPushWorktree,
  removeDetachedPushWorktree,
  reapOrphanedPushWorktrees,
  type PushedRefTuple,
  type DetachedWorktreeHandle,
} from "./git-utils.js";
import { HookError } from "../../types/hooks.js";
import { QualityGateRunner, QualityGateExecutionError } from "../quality-gates/runner.js";
import { loadQualityGatesConfig } from "../quality-gates/config.js";
import { SchemaValidator } from "../validator.js";
import { defaultProcessLivenessChecker } from "../lock/liveness.js";
import type { ProcessLivenessChecker } from "../lock/types.js";

export interface PrePushOptions {
  stdin?: string;
  args?: string[];
  livenessChecker?: ProcessLivenessChecker;
}

export interface PrePushResult {
  success: boolean;
  exitCode: number;
  message: string;
  pushedRefsCount?: number;
  uniqueTreesCount?: number;
  auditedCommitsCount?: number;
  warnings?: string[];
}

export class PrePushEngine {
  readonly targetDir: string;
  readonly livenessChecker: ProcessLivenessChecker;

  constructor(targetDir?: string, livenessChecker: ProcessLivenessChecker = defaultProcessLivenessChecker) {
    this.targetDir = path.resolve(targetDir || process.cwd());
    this.livenessChecker = livenessChecker;
  }

  /**
   * Validates pushed Git commit and tree objects in isolated detached worktrees.
   */
  async validate(options: PrePushOptions = {}): Promise<PrePushResult> {
    const stdinContent = options.stdin || "";
    const rawArgs = options.args || [];
    const remoteName = rawArgs[0] || "origin";

    // 0. Garbage-collect any stale orphaned worktrees from previous interrupted runs
    await reapOrphanedPushWorktrees(this.targetDir, this.livenessChecker);

    if (!stdinContent.trim()) {
      return {
        success: true,
        exitCode: 0,
        message: "No pushed refs provided on standard input. Pre-push check skipped.",
        pushedRefsCount: 0,
      };
    }

    const objectFormat = getGitObjectFormat(this.targetDir);
    const tuples = parsePrePushStdin(stdinContent, objectFormat);

    // 1. Separate deletions (local_oid == ZERO_OID) from active creations/updates
    // Explicitly covers both branch deletions and tag deletions (lightweight and annotated)
    const activeTuples: PushedRefTuple[] = [];
    const deletedTuples: PushedRefTuple[] = [];

    for (const tuple of tuples) {
      if (isZeroOid(tuple.localOid)) {
        deletedTuples.push(tuple);
      } else {
        activeTuples.push(tuple);
      }
    }

    if (activeTuples.length === 0) {
      return {
        success: true,
        exitCode: 0,
        message: `All pushed refs are branch/tag deletions (${deletedTuples.length} ref(s) deleted). Pre-push check skipped.`,
        pushedRefsCount: tuples.length,
      };
    }

    // 2. Resolve target commits, deduplicate by final pushed tree hash, and gather introduced commits
    interface UniqueTreeTarget {
      treeHash: string;
      commitOid: string;
      refName: string;
    }

    const uniqueTrees = new Map<string, UniqueTreeTarget>();
    const allIntroducedCommits = new Set<string>();
    const rangeWarnings: string[] = [];

    for (const tuple of activeTuples) {
      let commitOid = tuple.localOid;

      // Handle tags: peel tag object to commit ONLY for non-deleted refs
      if (tuple.localRef.startsWith("refs/tags/")) {
        try {
          commitOid = peelTagToCommit(this.targetDir, tuple.localOid);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            exitCode: 1,
            message: `[PREPUSH_TAG_ERROR] Failed to peel tag ref '${tuple.localRef}': ${msg}`,
          };
        }
      }

      // Resolve tree hash
      let treeHash: string;
      try {
        treeHash = resolveCommitTree(this.targetDir, commitOid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          exitCode: 1,
          message: `[PREPUSH_TREE_ERROR] Failed to resolve tree for commit '${commitOid}': ${msg}`,
        };
      }

      // Resolve introduced commits for range auditing
      const rangeResult = resolvePushedIntroducedCommits(
        this.targetDir,
        remoteName,
        commitOid,
        tuple.remoteOid
      );

      for (const c of rangeResult.commits) {
        allIntroducedCommits.add(c);
      }

      if (rangeResult.warning) {
        rangeWarnings.push(rangeResult.warning);
      }

      if (!uniqueTrees.has(treeHash)) {
        uniqueTrees.set(treeHash, {
          treeHash,
          commitOid,
          refName: tuple.localRef,
        });
      }
    }

    // 3. Commit-Range Audit: Evaluate each unique newly introduced commit
    const uniqueCommitsArray = Array.from(allIntroducedCommits);
    if (uniqueCommitsArray.length > 0) {
      let customSensitivePatterns: string[] | undefined;
      try {
        const config = loadQualityGatesConfig(this.targetDir, { validator: new SchemaValidator() });
        customSensitivePatterns = config.global_settings?.sensitive_patterns;
      } catch {
        // If config is missing or invalid on disk, use built-in secret patterns
      }

      const auditResult = auditPushedCommits(this.targetDir, uniqueCommitsArray, customSensitivePatterns);
      if (!auditResult.passed) {
        const failuresText = auditResult.failures.map((f) => `  ✖ ${f}`).join("\n");
        return {
          success: false,
          exitCode: 1,
          message: `[PREPUSH_COMMIT_AUDIT_FAILED] Pushed commit range failed security / message audit:\n${failuresText}`,
          pushedRefsCount: tuples.length,
          uniqueTreesCount: uniqueTrees.size,
          auditedCommitsCount: uniqueCommitsArray.length,
          warnings: rangeWarnings,
        };
      }
    }

    // 4. Quality Gate Execution: Validate each unique final pushed tree once in detached worktree
    for (const [treeHash, target] of uniqueTrees.entries()) {
      let worktreeHandle: DetachedWorktreeHandle | null = null;

      try {
        // Provision isolated detached worktree at .playbook/.tmp/worktrees/push-<oid>-<nonce>
        worktreeHandle = createDetachedPushWorktree(this.targetDir, target.commitOid);

        const worktreePlaybook = path.join(worktreeHandle.worktreePath, ".playbook");
        const manifestPath = path.join(worktreePlaybook, "manifest.json");
        const statePath = path.join(worktreePlaybook, "state.json");
        const configPath = path.join(worktreePlaybook, "quality-gates.json");

        // If the pushed tree does not have governance files, skip gate evaluation for this tree
        if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath) || !fs.existsSync(configPath)) {
          continue;
        }

        // Run QualityGateRunner inside the detached worktree in headless mode
        const runner = new QualityGateRunner(worktreeHandle.worktreePath);
        const report = await runner.run({
          headless: true, // CI / Detached worktree execution tier
        });

        if (report.overall_outcome !== "passed") {
          const failedChecks = report.checks
            .filter((c) => c.outcome === "failed")
            .map((c) => `  ✖ [${c.check_id}] ${c.name}: ${c.error_message || "Check failed"}`)
            .join("\n");

          return {
            success: false,
            exitCode: 1,
            message:
              `[PREPUSH_GATE_FAILED] Push rejected: target commit '${target.commitOid}' ` +
              `(${target.refName}, tree: ${treeHash.slice(0, 8)}) failed Quality Gates:\n${failedChecks}`,
            pushedRefsCount: tuples.length,
            uniqueTreesCount: uniqueTrees.size,
            auditedCommitsCount: uniqueCommitsArray.length,
            warnings: rangeWarnings,
          };
        }
      } catch (err: unknown) {
        if (err instanceof QualityGateExecutionError) {
          return {
            success: false,
            exitCode: err.exitCode,
            message: `[PREPUSH_GATE_FAILED] Target commit '${target.commitOid}' failed quality gate: ${err.message}`,
            pushedRefsCount: tuples.length,
            uniqueTreesCount: uniqueTrees.size,
            auditedCommitsCount: uniqueCommitsArray.length,
            warnings: rangeWarnings,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          exitCode: 1,
          message: `[PREPUSH_EXECUTION_ERROR] Unexpected error evaluating commit '${target.commitOid}': ${msg}`,
          pushedRefsCount: tuples.length,
          uniqueTreesCount: uniqueTrees.size,
          auditedCommitsCount: uniqueCommitsArray.length,
          warnings: rangeWarnings,
        };
      } finally {
        if (worktreeHandle) {
          removeDetachedPushWorktree(this.targetDir, worktreeHandle.worktreePath);
        }
      }
    }

    let completionMessage = `Pre-push validation passed successfully (${uniqueTrees.size} unique tree snapshot(s) verified, ${uniqueCommitsArray.length} commit(s) audited).`;
    if (rangeWarnings.length > 0) {
      completionMessage += `\nAdvisory Warnings:\n${rangeWarnings.map((w) => `  ⚠ ${w}`).join("\n")}`;
    }

    return {
      success: true,
      exitCode: 0,
      message: completionMessage,
      pushedRefsCount: tuples.length,
      uniqueTreesCount: uniqueTrees.size,
      auditedCommitsCount: uniqueCommitsArray.length,
      warnings: rangeWarnings,
    };
  }
}
