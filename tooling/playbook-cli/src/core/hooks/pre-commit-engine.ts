import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getGitObjectFormat,
  getStagedEntries,
  getStagedFileModes,
  getStagedBlob,
  extractStagedIndexToDirectory,
  writeIndexTree,
  getUnmergedIndexEntries,
} from "./git-utils.js";
import { HookError } from "../../types/hooks.js";
import { SchemaValidator } from "../validator.js";
import { loadQualityGatesConfig, getStageQualityGate, filterChecksForProfile } from "../quality-gates/config.js";
import { QualityGateRunner } from "../quality-gates/runner.js";
import { matchesAnyGlob } from "../quality-gates/glob.js";
import type { ProjectManifest } from "../../types/manifest.js";
import type { ProjectState } from "../../types/state.js";
import type { QualityGateCheck, QualityGatesConfig } from "../../types/quality-gates.js";

export interface PreCommitOptions {
  allowInert?: boolean;
}

export interface PreCommitResult {
  success: boolean;
  exitCode: number;
  message: string;
  stagedFilesCount?: number;
  checksRunCount?: number;
}

export class PreCommitEngine {
  readonly targetDir: string;
  readonly validator: SchemaValidator;

  constructor(targetDir?: string) {
    this.targetDir = path.resolve(targetDir || process.cwd());
    this.validator = new SchemaValidator();
  }

  /**
   * Validates the staged Git index snapshot against governance rules and quality gates.
   */
  async validate(options: PreCommitOptions = {}): Promise<PreCommitResult> {
    // 0. Fail-Closed Barrier: Verify no unresolved merge conflicts exist in index
    const unmergedEntries = getUnmergedIndexEntries(this.targetDir);
    if (unmergedEntries.length > 0) {
      return {
        success: false,
        exitCode: 1,
        message:
          `[UNMERGED_INDEX_ENTRIES] Repository contains unmerged index entries (unresolved merge conflicts) in:\n` +
          unmergedEntries.map((f) => `  - ${f}`).join("\n") +
          `\nResolve all conflicts and stage resolution before running pre-commit validation.`,
      };
    }

    const objectFormat = getGitObjectFormat(this.targetDir);

    // 1. Discover staged files from index
    const stagedEntries = getStagedEntries(this.targetDir, objectFormat);
    if (stagedEntries.length === 0) {
      return {
        success: true,
        exitCode: 0,
        message: "No staged changes detected in Git index. Pre-commit check skipped.",
        stagedFilesCount: 0,
      };
    }

    // 2. Governance Schema Guard: Validate staged governance files in-memory
    for (const entry of stagedEntries) {
      const posixPath = entry.path.replace(/\\/g, "/");
      if (posixPath === ".playbook/manifest.json") {
        const raw = getStagedBlob(this.targetDir, entry.path);
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw);
            const val = this.validator.validateManifest(parsed);
            if (!val.valid) {
              return {
                success: false,
                exitCode: 1,
                message: `[PRECOMMIT_GOVERNANCE_INVALID] Staged .playbook/manifest.json failed schema validation:\n${val.formattedErrors}`,
              };
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              exitCode: 1,
              message: `[PRECOMMIT_GOVERNANCE_INVALID] Staged .playbook/manifest.json contains invalid JSON: ${msg}`,
            };
          }
        }
      } else if (posixPath === ".playbook/state.json") {
        const raw = getStagedBlob(this.targetDir, entry.path);
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw);
            const val = this.validator.validateState(parsed);
            if (!val.valid) {
              return {
                success: false,
                exitCode: 1,
                message: `[PRECOMMIT_GOVERNANCE_INVALID] Staged .playbook/state.json failed schema validation:\n${val.formattedErrors}`,
              };
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              exitCode: 1,
              message: `[PRECOMMIT_GOVERNANCE_INVALID] Staged .playbook/state.json contains invalid JSON: ${msg}`,
            };
          }
        }
      } else if (posixPath === ".playbook/quality-gates.json") {
        const raw = getStagedBlob(this.targetDir, entry.path);
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw);
            const val = this.validator.validateQualityGates(parsed);
            if (!val.valid) {
              return {
                success: false,
                exitCode: 1,
                message: `[PRECOMMIT_GOVERNANCE_INVALID] Staged .playbook/quality-gates.json failed schema validation:\n${val.formattedErrors}`,
              };
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              exitCode: 1,
              message: `[PRECOMMIT_GOVERNANCE_INVALID] Staged .playbook/quality-gates.json contains invalid JSON: ${msg}`,
            };
          }
        }
      }
    }

    // 3. Mode Inspection & Symlink Capability Probe
    const fileModes = getStagedFileModes(this.targetDir);
    const symlinks = fileModes.filter((m) => m.mode === "120000");

    if (symlinks.length > 0) {
      // Probe true symlink capability of host environment
      const tmpBase = path.join(this.targetDir, ".playbook", ".tmp");
      fs.mkdirSync(tmpBase, { recursive: true });
      const probePath = path.join(tmpBase, `probe-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);

      let hostSupportsSymlinks = true;
      try {
        fs.symlinkSync("target", probePath);
        fs.unlinkSync(probePath);
      } catch {
        hostSupportsSymlinks = false;
      }

      if (!hostSupportsSymlinks) {
        return {
          success: false,
          exitCode: 1,
          message:
            `[UNSUPPORTED_PLATFORM_CAPABILITY] Staged symbolic link detected at '${symlinks[0].path}', ` +
            `but the host environment lacks true filesystem symlink privileges.\n` +
            `Remediation: Enable Developer Mode in Windows Settings (Settings > Privacy & Security > For Developers) ` +
            `or execute the commit within a POSIX environment (WSL2/Linux).`,
        };
      }
    }

    // 4. Resolve Quality Gates Configuration
    let config: QualityGatesConfig | null = null;
    try {
      config = loadQualityGatesConfig(this.targetDir, { validator: this.validator });
    } catch {
      // If quality gates config is not configured, governance schema checks are sufficient
      return {
        success: true,
        exitCode: 0,
        message: "Pre-commit governance verification passed (no quality-gates.json configured).",
        stagedFilesCount: stagedEntries.length,
      };
    }

    // Determine active stage and profile from state and manifest
    const statePath = path.join(this.targetDir, ".playbook", "state.json");
    const manifestPath = path.join(this.targetDir, ".playbook", "manifest.json");

    if (!fs.existsSync(statePath) || !fs.existsSync(manifestPath)) {
      return {
        success: true,
        exitCode: 0,
        message: "Pre-commit check passed (governance state files not found on disk).",
        stagedFilesCount: stagedEntries.length,
      };
    }

    let state: ProjectState;
    let manifest: ProjectManifest;
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        exitCode: 1,
        message: `[PRECOMMIT_STATE_ERROR] Failed to read project governance state: ${msg}`,
      };
    }

    const currentStage = state.current_stage;
    const stageGate = getStageQualityGate(config, currentStage);
    if (!stageGate || stageGate.checks.length === 0) {
      return {
        success: true,
        exitCode: 0,
        message: `Pre-commit check passed: no quality checks configured for active Stage ${currentStage}.`,
        stagedFilesCount: stagedEntries.length,
      };
    }

    const profile = manifest.playbook?.governance_profile || "standard";
    const activeChecks = filterChecksForProfile(stageGate.checks, profile);

    // Filter checks applicable to the staged file paths
    const stagedFilePaths = stagedEntries.map((e) => e.path);
    const applicableChecks: QualityGateCheck[] = [];

    for (const check of activeChecks) {
      const patterns = check.inputs && check.inputs.length > 0
        ? check.inputs
        : [...(check.text_patterns || []), ...(check.binary_patterns || [])];

      if (patterns.length === 0) {
        // Checks without explicit file patterns apply to stage deliverables
        applicableChecks.push(check);
      } else {
        const matches = stagedFilePaths.some((fp) => matchesAnyGlob(fp, patterns));
        if (matches) {
          applicableChecks.push(check);
        }
      }
    }

    if (applicableChecks.length === 0) {
      return {
        success: true,
        exitCode: 0,
        message: `Pre-commit check passed: staged files do not trigger any configured Stage ${currentStage} quality checks.`,
        stagedFilesCount: stagedEntries.length,
      };
    }

    // 5. Ephemeral Shadow Extraction & Isolated Validation
    const initialIndexTree = writeIndexTree(this.targetDir);
    const nonce = crypto.randomBytes(6).toString("hex");
    const shadowDir = path.join(this.targetDir, ".playbook", ".tmp", `staged-${nonce}`);

    // Register cleanup hook
    const cleanup = () => {
      try {
        if (fs.existsSync(shadowDir)) {
          // Unlink node_modules junction if created
          const linkedModules = path.join(shadowDir, "node_modules");
          if (fs.existsSync(linkedModules)) {
            try {
              const stat = fs.lstatSync(linkedModules);
              if (stat.isSymbolicLink()) {
                fs.unlinkSync(linkedModules);
              }
            } catch {
              // Ignore
            }
          }
          fs.rmSync(shadowDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore residual locked files in tmp
      }
    };

    try {
      // Extract staged index
      extractStagedIndexToDirectory(this.targetDir, shadowDir);

      // Ensure .playbook/ governance files exist in shadow directory
      const shadowPlaybook = path.join(shadowDir, ".playbook");
      fs.mkdirSync(shadowPlaybook, { recursive: true });

      const filesToCopy = ["manifest.json", "state.json", "quality-gates.json"];
      for (const f of filesToCopy) {
        const srcF = path.join(this.targetDir, ".playbook", f);
        const destF = path.join(shadowPlaybook, f);
        if (fs.existsSync(srcF) && !fs.existsSync(destF)) {
          fs.copyFileSync(srcF, destF);
        }
      }

      // Link node_modules if present in parent repo
      const parentNodeModules = path.join(this.targetDir, "node_modules");
      const shadowNodeModules = path.join(shadowDir, "node_modules");
      if (fs.existsSync(parentNodeModules) && !fs.existsSync(shadowNodeModules)) {
        try {
          if (process.platform === "win32") {
            fs.symlinkSync(parentNodeModules, shadowNodeModules, "junction");
          } else {
            fs.symlinkSync(parentNodeModules, shadowNodeModules, "dir");
          }
        } catch {
          // Ignore if symlink not permitted
        }
      }

      // Execute QualityGateRunner targeting the isolated staged shadow directory
      const runner = new QualityGateRunner(shadowDir);
      const report = await runner.run({
        stage: currentStage,
        profile,
        headless: false, // Local evaluation tier
      });

      // 6. Invariant Verification: Index stability check
      const postIndexTree = writeIndexTree(this.targetDir);
      if (postIndexTree !== initialIndexTree) {
        return {
          success: false,
          exitCode: 1,
          message:
            `[INDEX_MODIFIED_DURING_VALIDATION] Git index tree hash changed during pre-commit validation.\n` +
            `Before: ${initialIndexTree}\n` +
            `After:  ${postIndexTree}\n` +
            `Quality gate checks are strictly prohibited from mutating the Git index.`,
        };
      }

      if (report.overall_outcome !== "passed") {
        const failureDetails = report.checks
          .filter((c) => c.outcome === "failed")
          .map((c) => `  ✖ [${c.check_id}] ${c.name}: ${c.error_message || "Check failed"}`)
          .join("\n");

        return {
          success: false,
          exitCode: 1,
          message: `[PRECOMMIT_CHECK_FAILED] Staged changes failed Quality Gate checks for Stage ${currentStage}:\n${failureDetails}`,
          stagedFilesCount: stagedEntries.length,
          checksRunCount: applicableChecks.length,
        };
      }

      return {
        success: true,
        exitCode: 0,
        message: `Pre-commit quality gate checks passed successfully (${applicableChecks.length} checks evaluated).`,
        stagedFilesCount: stagedEntries.length,
        checksRunCount: applicableChecks.length,
      };
    } finally {
      cleanup();
    }
  }
}
