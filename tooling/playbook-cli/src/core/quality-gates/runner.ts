import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, execSync, execFileSync } from "node:child_process";
import { DEFAULT_PATHS, type GovernanceProfile } from "../../constants.js";
import { WriteAheadTransactionManager } from "../transaction/transaction-manager.js";
import { computeFileSha256, computeSha256 } from "../transaction/fs-utils.js";
import { toPosixPath, normalizeRelativePath } from "../../utils/paths.js";
import { SchemaValidator } from "../validator.js";
import { resolveExecutable } from "../process-execution.js";
import type { ProjectState, Deliverable, EvidenceRecord } from "../../types/state.js";
import type { ProjectManifest } from "../../types/manifest.js";
import type {
  QualityGatesConfig,
  QualityGateStage,
  QualityGateCheck,
  CheckExecutionResult,
  QualityGateRunReport,
  WorkingTreeTier,
} from "../../types/quality-gates.js";
import {
  loadQualityGatesConfig,
  getStageQualityGate,
  filterChecksForProfile,
  QualityGateConfigError,
} from "./config.js";
import { resolveCheckDag } from "./dag.js";
import { computeRif } from "./rif.js";
import {configurationFingerprint,toolFingerprint,parseToolVersionCommand} from "./evidence-binding.js";
import {resolveAuthoritativeVerification,resolveGovernanceProfile} from "../controller/resolver.js";
import {assertEffectiveWaiver} from "../controller/exception-lifecycle.js";
import {verifyExceptionAuthority} from "../controller/exception-service.js";
import { assertWorkingTreePolicy, type WorkingTreeStatus } from "./policy.js";
import { reapStagingFiles, type StagingMetadata } from "./reaper.js";

export class QualityGateExecutionError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, exitCode: number = 4, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "QualityGateExecutionError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/**
 * Standard environment variables permitted into child process environments.
 */
const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USER",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "TERM",
  "SYSTEMROOT",
  "SystemRoot",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
];

/**
 * Best-effort secret scrubber for stream sanitization.
 */
export function scrubSecrets(chunk: string, customPatterns?: string[]): string {
  let scrubbed = chunk
    .replace(/ghp_[a-zA-Z0-9]{36}/g, "ghp_***[REDACTED]")
    .replace(/github_pat_[a-zA-Z0-9_]{82}/g, "github_pat_***[REDACTED]")
    .replace(/sk-[a-zA-Z0-9]{32,}/g, "sk-***[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-.]{20,}/gi, "Bearer ***[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA***[REDACTED]");

  if (customPatterns) {
    for (const pat of customPatterns) {
      try {
        const regex = new RegExp(pat, "g");
        scrubbed = scrubbed.replace(regex, "***[REDACTED]");
      } catch {
        // Ignore invalid custom regex
      }
    }
  }

  return scrubbed;
}

/**
 * Applies middle-truncation to log output if it exceeds max_journaled_log_bytes.
 */
export function truncateLogIfNeeded(
  content: string,
  maxBytes: number = 2097152
): { content: string; truncated: boolean } {
  const buf = Buffer.from(content, "utf-8");
  if (buf.length <= maxBytes) {
    return { content, truncated: false };
  }

  const half = Math.floor(maxBytes / 2) - 256;
  const head = buf.subarray(0, half).toString("utf-8");
  const tail = buf.subarray(buf.length - half).toString("utf-8");
  const omitted = buf.length - (half * 2);

  const notice = `\n\n... [MIDDLE TRUNCATED: ${omitted} bytes omitted to preserve WAL journal durability] ...\n\n`;

  return {
    content: head + notice + tail,
    truncated: true,
  };
}

export interface RunQualityGatesOptions {
  cwd?: string;
  stage?: number;
  checkId?: string;
  headless?: boolean;
  failFast?: boolean;
  haltOnFailure?: boolean;
  profile?: GovernanceProfile;
}

export class QualityGateRunner {
  readonly targetDir: string;
  readonly playbookDir: string;
  readonly tmpDir: string;
  readonly logsDir: string;
  readonly validator: SchemaValidator;
  readonly txManager: WriteAheadTransactionManager;

  constructor(targetDir?: string) {
    this.targetDir = path.resolve(targetDir || process.cwd());
    this.playbookDir = path.join(this.targetDir, DEFAULT_PATHS.playbookDir);
    this.tmpDir = path.join(this.playbookDir, ".tmp");
    this.logsDir = path.join(this.playbookDir, "logs");
    this.validator = new SchemaValidator();
    this.txManager = new WriteAheadTransactionManager({ targetDir: this.targetDir });
  }

  /**
   * Executes quality gates for the active or specified stage.
   */
  async run(options?: RunQualityGatesOptions): Promise<QualityGateRunReport> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // 0. Cleanup orphaned staging files from prior interrupted runs
    await reapStagingFiles(this.targetDir);

    // 1. Phase 1: Policy Loading & Manifest Validation
    const manifestPath = path.join(this.playbookDir, "manifest.json");
    const statePath = path.join(this.playbookDir, "state.json");

    if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
      throw new QualityGateExecutionError(
        "PRECONDITION_FAILED",
        "Required governance state files (.playbook/manifest.json, .playbook/state.json) are missing.",
        3
      );
    }

    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const stateRaw = fs.readFileSync(statePath, "utf-8");

    const manifest = JSON.parse(manifestRaw) as ProjectManifest;
    const state = JSON.parse(stateRaw) as ProjectState;

    const manifestVal = this.validator.validateManifest(manifest);
    if (!manifestVal.valid) {
      throw new QualityGateExecutionError(
        "PRECONDITION_FAILED",
        `manifest.json failed schema validation:\n${manifestVal.formattedErrors}`,
        3
      );
    }

    const stateVal = this.validator.validateState(state);
    if (!stateVal.valid) {
      throw new QualityGateExecutionError(
        "PRECONDITION_FAILED",
        `state.json failed schema validation:\n${stateVal.formattedErrors}`,
        3
      );
    }

    // Determine target stage and profile
    const targetStageNum = options?.stage !== undefined ? options.stage : state.current_stage;
    const activeProfile: GovernanceProfile =
      options?.profile || resolveGovernanceProfile(this.targetDir, manifest);

    // 2. Phase 2: Preconditions & Working Tree Assertion
    const workingTreeTier: WorkingTreeTier = options?.headless ? "ci" : "local";
    let treeStatus: WorkingTreeStatus;
    try {
      treeStatus = assertWorkingTreePolicy(this.targetDir, workingTreeTier);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new QualityGateExecutionError("PRECONDITION_FAILED", msg, 3);
    }

    if (state.stage_status === "blocked") {
      throw new QualityGateExecutionError(
        "STAGE_BLOCKED",
        `Stage ${state.current_stage} is currently in 'blocked' state. Resolve active blocking RFCs before running quality gates.`,
        3
      );
    }

    // Load quality gates configuration
    let config: QualityGatesConfig;
    try {
      config = loadQualityGatesConfig(this.targetDir, { validator: this.validator });
    } catch (err: unknown) {
      if (err instanceof QualityGateConfigError) {
        throw new QualityGateExecutionError(err.code, err.message, 2, err.details);
      }
      throw err;
    }

    const stageGate = getStageQualityGate(config, targetStageNum);
    if (!stageGate || stageGate.checks.length === 0) {
      return {
        timestamp,
        stage: targetStageNum,
        stage_name: stageGate?.stage_name || `Stage ${targetStageNum}`,
        profile: activeProfile,
        working_tree_clean: treeStatus.isClean,
        overall_outcome: "passed",
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          warning: 0,
          skipped: 0,
          duration_ms: Date.now() - startTime,
        },
        checks: [],
        diagnostics: [],
      };
    }

    // Filter checks for active profile and target check ID if specified
    let applicableChecks = filterChecksForProfile(stageGate.checks, activeProfile);
    if (options?.checkId) {
      applicableChecks = applicableChecks.filter((c) => c.id === options.checkId);
      if (applicableChecks.length === 0) {
        throw new QualityGateExecutionError(
          "CHECK_NOT_FOUND",
          `Check '${options.checkId}' not found in stage ${targetStageNum} for profile '${activeProfile}'.`,
          2
        );
      }
    }

    // 3. Phase 3: DAG Resolution & Cycle Detection
    let dagResult;
    try {
      dagResult = resolveCheckDag(applicableChecks);
    } catch (err: unknown) {
      if (err instanceof QualityGateConfigError) {
        throw new QualityGateExecutionError(err.code, err.message, 2, err.details);
      }
      throw err;
    }

    // 4. Execution Loop (UNLOCKED Phase 4 + LOCKED Phase 5 per check or level)
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });

    const executedResults: CheckExecutionResult[] = [];
    let hasBlockingFailure = false;

    for (const check of dagResult.orderedChecks) {
      // Global abort if fail-fast was requested
      if (hasBlockingFailure && options?.failFast) {
        executedResults.push({
          check_id: check.id,
          name: check.name,
          type: check.type,
          deliverable_id: check.deliverable_id,
          severity: check.severity || "blocking",
          command: check.command,
          args: check.args,
          exit_code: null,
          outcome: "skipped",
          duration_ms: 0,
          rif: "",
          tool_version: "",
          canonical_log_path: "",
          canonical_log_sha256: "",
          truncated: false,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: "Skipped due to prior blocking failure (--fail-fast).",
        });
        continue;
      }

      // Dependency failure invariant: Skip check if any prerequisite dependency did not pass
      const failedDeps = (check.depends_on || []).filter((depId) => {
        const prior = executedResults.find((r) => r.check_id === depId);
        return !prior || prior.outcome !== "passed";
      });

      if (failedDeps.length > 0) {
        executedResults.push({
          check_id: check.id,
          name: check.name,
          type: check.type,
          deliverable_id: check.deliverable_id,
          severity: check.severity || "blocking",
          command: check.command,
          args: check.args,
          exit_code: null,
          outcome: "skipped",
          duration_ms: 0,
          rif: "",
          tool_version: "",
          canonical_log_path: "",
          canonical_log_sha256: "",
          truncated: false,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: `Skipped because upstream dependency failed: ${failedDeps.join(", ")}`,
        });
        continue;
      }

      // Execute single check
      const { checkResult, stagingLogPath, stagingMetaPath } = await this.executeCheckUnlocked(
        check,
        stageGate,
        config,
        treeStatus.isClean,
        treeStatus.headCommitSha
      );

      // Register evidence under WAL lock with explicit staging references
      await this.registerEvidenceLocked(
        checkResult,
        stageGate,
        treeStatus.isClean,
        stagingLogPath,
        stagingMetaPath
      );

      executedResults.push(checkResult);

      if (checkResult.outcome !== "passed" && checkResult.outcome !== "skipped" && (check.severity || "blocking") === "blocking") {
        hasBlockingFailure = true;
      }
    }

    // If halt-on-failure is requested and a blocking check failed, transition state to blocked
    if (hasBlockingFailure && options?.haltOnFailure) {
      await this.txManager.lockManager.withLock(
        async (lockHandle) => {
          const freshStateRaw = fs.readFileSync(statePath, "utf-8");
          const freshDiskHash = computeSha256(freshStateRaw);
          const freshState = JSON.parse(freshStateRaw) as ProjectState;
          freshState.stage_status = "blocked";
          freshState.last_updated = {
            timestamp: new Date().toISOString(),
            updated_by: "agent:quality-gate-engine",
            actor_type: "agent",
            reason: `Controller Halt triggered: Stage ${targetStageNum} transitioned to blocked due to quality gate failure (--halt-on-failure).`,
          };
          const fileOps = [
            {
              operation: "write" as const,
              targetPath: ".playbook/state.json",
              content: JSON.stringify(freshState, null, 2) + "\n",
              expectedPreviousSha256: freshDiskHash,
            },
          ];
          const prepJournal = await this.txManager.prepare(
            "TRIGGER_HALT",
            fileOps,
            lockHandle
          );
          await this.txManager.commit(prepJournal, lockHandle);
        },
        { timeoutMs: this.txManager.lockTimeoutMs }
      );
    }

    const totalDuration = Date.now() - startTime;
    const passedCount = executedResults.filter((r) => r.outcome === "passed").length;
    const failedCount = executedResults.filter((r) => r.outcome === "failed").length;
    const warningCount = executedResults.filter(
      (r) => r.outcome === "failed" && r.severity === "warning"
    ).length;
    const skippedCount = executedResults.filter((r) => r.outcome === "skipped").length;

    const overallOutcome = hasBlockingFailure
      ? options?.haltOnFailure
        ? "halted"
        : "failed"
      : "passed";

    return {
      timestamp,
      stage: targetStageNum,
      stage_name: stageGate.stage_name,
      profile: activeProfile,
      working_tree_clean: treeStatus.isClean,
      overall_outcome: overallOutcome,
      summary: {
        total: executedResults.length,
        passed: passedCount,
        failed: failedCount,
        warning: warningCount,
        skipped: skippedCount,
        duration_ms: totalDuration,
      },
      checks: executedResults,
      diagnostics: hasBlockingFailure
        ? [
            {
              code: "QUALITY_GATE_FAILED",
              severity: "error",
              message: `One or more blocking quality checks failed in Stage ${targetStageNum}. Deliverables reverted to in_progress.`,
            },
          ]
        : [],
    };
  }

  /**
   * Phase 4: Executes a single check completely unlocked.
   */
  private async executeCheckUnlocked(
    check: QualityGateCheck,
    stageGate: QualityGateStage,
    config: QualityGatesConfig,
    workingTreeClean: boolean,
    headCommitSha: string | null
  ): Promise<{
    checkResult: CheckExecutionResult;
    stagingLogPath: string;
    stagingMetaPath: string;
  }> {
    const startedAt = new Date().toISOString();
    const startTimeMs = Date.now();
    const runNonce = crypto.randomUUID();

    const configurationHash=configurationFingerprint(this.targetDir,JSON.parse(fs.readFileSync(path.join(this.targetDir,".playbook/manifest.json"),"utf8")));
    let executableFingerprint: string | undefined;
    let fingerprintError: string | undefined;
    try { executableFingerprint=toolFingerprint(this.targetDir,check); }
    catch (error) { fingerprintError=error instanceof Error?error.message:String(error); }
    // Determine tool version if configured
    let toolVersion = "v1.0.0";
    if (check.tool_version_command) {
      try {
        const parts = parseToolVersionCommand(check.tool_version_command);
        const bin = parts[0];
        const args = parts.slice(1);
        const resolved = resolveExecutable(bin, args, { cwd: this.targetDir, env: process.env as Record<string, string> });
        const out = spawnSyncToString(resolved.file, resolved.args, this.targetDir);
        toolVersion = out.trim() || toolVersion;
      } catch {
        throw new QualityGateExecutionError("TOOL_VERSION_UNAVAILABLE","Declared tool version could not be verified.");
      }
    }

    // Compute RIF
    const rifResult = computeRif({
      projectDir: this.targetDir,
      check,
      toolVersion,
      workingTreeClean,
      ambientEnv: process.env,
      sensitivePatterns: config.global_settings.sensitive_patterns,
    });

    // Setup staging paths
    const pidPlaceholder = process.pid;
    const stagingBaseName = `proc-${pidPlaceholder}-${runNonce}`;
    const stagingLogPath = path.join(this.tmpDir, `${stagingBaseName}.log`);
    const stagingMetaPath = path.join(this.tmpDir, `${stagingBaseName}.meta.json`);

    // Prepare child environment using allowlist
    const allowedEnvKeys = new Set([
      ...DEFAULT_ENV_ALLOWLIST,
      ...config.global_settings.env_allowlist,
    ]);
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && allowedEnvKeys.has(k)) {
        childEnv[k] = v;
      }
    }
    // Add explicitly configured check env variables
    if (check.env) {
      Object.assign(childEnv, check.env);
    }

    // Normalize PATH / Path on Windows so child processes can locate system and tool binaries
    if (childEnv.Path && !childEnv.PATH) {
      childEnv.PATH = childEnv.Path;
    } else if (childEnv.PATH && !childEnv.Path) {
      childEnv.Path = childEnv.PATH;
    }

    const workingDir = check.working_dir
      ? path.resolve(this.targetDir, check.working_dir)
      : this.targetDir;

    const timeoutMs =
      check.timeout_ms || config.global_settings.default_timeout_ms || 120000;

    // Run process and stream to staging log
    let exitCode: number | null = null;
    let timedOut = false;
    let executionError: string | undefined = fingerprintError;

    const stagingLogStream = fs.createWriteStream(stagingLogPath, { flags: "w", encoding: "utf-8" });

    const resolved = resolveExecutable(check.command, check.args, {
      cwd: workingDir,
      env: childEnv,
    });

    try {
      const child = spawn(resolved.file, resolved.args, {
        cwd: workingDir,
        env: childEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const childPid = child.pid || pidPlaceholder;

      // Atomic metadata creation
      const metadata: StagingMetadata = {
        schema_version: "1.0.0",
        pid: childPid,
        run_nonce: runNonce,
        hostname: os.hostname(),
        created_at: startedAt,
        started_at_ms: startTimeMs,
        command: check.command,
        args: check.args,
      };
      const metaTmp = `${stagingMetaPath}.tmp`;
      fs.writeFileSync(metaTmp, JSON.stringify(metadata, null, 2), "utf-8");
      fs.renameSync(metaTmp, stagingMetaPath);

      // Handle streaming
      child.stdout?.on("data", (data: Buffer) => {
        const str = data.toString("utf-8");
        const scrubbed = config.global_settings.mask_secrets
          ? scrubSecrets(str, config.global_settings.sensitive_patterns)
          : str;
        stagingLogStream.write(scrubbed);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const str = data.toString("utf-8");
        const scrubbed = config.global_settings.mask_secrets
          ? scrubSecrets(str, config.global_settings.sensitive_patterns)
          : str;
        stagingLogStream.write(scrubbed);
      });

      // Timeout handler with graceful escalation
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid);
      }, timeoutMs);

      exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          executionError = err.message;
          resolve(null);
        });
      });
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    } finally {
      await new Promise<void>((resolve) => {
        stagingLogStream.end(() => resolve());
      });
    }

    const durationMs = Date.now() - startTimeMs;
    const completedAt = new Date().toISOString();

    const isPassed = exitCode === 0 && !timedOut && !executionError;
    const outcome = isPassed ? "passed" : timedOut ? "timed_out" : "failed";

    // Read staging log content
    let rawLogContent = "";
    if (fs.existsSync(stagingLogPath)) {
      rawLogContent = fs.readFileSync(stagingLogPath, "utf-8");
    }

    // Assemble canonical log with metadata header and execution footer
    const safeTimestampSlug = startedAt.replace(/[:.]/g, "-");
    const canonicalLogRelative = `.playbook/logs/gate-stage-${stageGate.stage}-${check.id}-${safeTimestampSlug}.log`;
    const canonicalLogAbsolute = path.join(this.targetDir, canonicalLogRelative);

    const header = [
      "=== PLAYBOOK QUALITY-GATE EXECUTION LOG ===",
      `Check ID:        ${check.id}`,
      `Check Name:      ${check.name}`,
      `Check Type:      ${check.type}`,
      `Stage:           ${stageGate.stage} (${stageGate.stage_name})`,
      `Deliverable ID:  ${check.deliverable_id}`,
      `Requirement IDs: ${(check.requirement_ids || []).join(", ") || "none"}`,
      `Command:         ${check.command} ${check.args.join(" ")}`,
      `Working Dir:     ${toPosixPath(path.relative(this.targetDir, workingDir)) || "."}`,
      `Git Commit:      ${headCommitSha || "untracked"}`,
      `Working Tree:    ${workingTreeClean ? "clean" : "dirty"}`,
      `RIF:             ${rifResult.rif}`,
      `Tool Version:    ${toolVersion}`,
      `Secret Freshness:${rifResult.secret_freshness_unbounded ? ` bounded_with_warning (unversioned secrets: ${rifResult.unbounded_secret_keys?.join(", ")})` : " verified"}`,
      `Started At:      ${startedAt}`,
      "=================================================",
      "",
    ].join("\n");

    const footer = [
      "",
      "=================================================",
      "=== EXECUTION RESULT ===",
      `Exit Code:       ${exitCode !== null ? exitCode : "null"}`,
      `Outcome:         ${outcome.toUpperCase()}`,
      `Duration:        ${durationMs} ms`,
      `Completed At:    ${completedAt}`,
      "=================================================",
    ].join("\n");

    const fullLogContent = header + rawLogContent + footer;
    const { content: finalizedLogContent, truncated } = truncateLogIfNeeded(
      fullLogContent,
      config.global_settings.max_journaled_log_bytes || 2097152
    );

    const canonicalLogBytes = Buffer.from(finalizedLogContent, "utf-8");
    const canonicalLogSha256 = `sha256:${crypto.createHash("sha256").update(canonicalLogBytes).digest("hex")}`;

    // Temporarily save finalized log content into the staging log file for transaction registration
    fs.writeFileSync(stagingLogPath, finalizedLogContent, "utf-8");

    const checkResult: CheckExecutionResult = {
      config_hash: configurationHash,
      tool_fingerprint: executableFingerprint,
      check_id: check.id,
      name: check.name,
      type: check.type,
      deliverable_id: check.deliverable_id,
      severity: check.severity || "blocking",
      command: check.command,
      args: check.args,
      exit_code: exitCode,
      outcome,
      duration_ms: durationMs,
      rif: rifResult.rif,
      tool_version: toolVersion,
      canonical_log_path: canonicalLogRelative,
      canonical_log_sha256: canonicalLogSha256,
      truncated,
      started_at: startedAt,
      completed_at: completedAt,
      error_message: executionError || (timedOut ? `Timed out after ${timeoutMs}ms` : undefined),
      secret_freshness_unbounded: rifResult.secret_freshness_unbounded,
      unbounded_secret_keys: rifResult.unbounded_secret_keys,
    };

    return {
      checkResult,
      stagingLogPath,
      stagingMetaPath,
    };
  }

  /**
   * Phase 5: Registers evidence and canonical log under exclusive WAL transaction lock.
   */
  private async registerEvidenceLocked(
    result: CheckExecutionResult,
    stageGate: QualityGateStage,
    workingTreeClean: boolean,
    stagingLogPath?: string,
    stagingMetaPath?: string
  ): Promise<void> {
    let resolvedLogPath = stagingLogPath;
    let resolvedMetaPath = stagingMetaPath;

    if (!resolvedLogPath || !fs.existsSync(resolvedLogPath)) {
      // Conservative fallback if stagingLogPath is not directly provided
      const tmpEntries = fs.existsSync(this.tmpDir) ? fs.readdirSync(this.tmpDir) : [];
      const matchingLog = tmpEntries.find((f) => f.endsWith(".log"));
      resolvedLogPath = matchingLog ? path.join(this.tmpDir, matchingLog) : undefined;
      resolvedMetaPath = matchingLog
        ? path.join(this.tmpDir, matchingLog.replace(/\.log$/, ".meta.json"))
        : undefined;
    }

    let logContent = "";
    if (resolvedLogPath && fs.existsSync(resolvedLogPath)) {
      logContent = fs.readFileSync(resolvedLogPath, "utf-8");
    }

    const stateRelative = ".playbook/state.json";
    const stateAbsolute = path.join(this.targetDir, stateRelative);

    await this.txManager.lockManager.withLock(
      async (lockHandle) => {
        // Step 0: Recover any interrupted prior transaction before proceeding
        await this.txManager.recover(lockHandle);

        // Step 1: Re-read fresh state under lock
        const freshStateRaw = fs.readFileSync(stateAbsolute, "utf-8");
        const freshDiskHash = computeSha256(freshStateRaw);
        const freshState = JSON.parse(freshStateRaw) as ProjectState;

        // Concurrency Check
        if (
          freshState.current_stage !== stageGate.stage ||
          freshState.stage_status === "blocked"
        ) {
          throw new QualityGateExecutionError(
            "CHECK_RESULT_SUPERSEDED",
            `State concurrency conflict: Stage changed or transitioned to blocked during check execution.`,
            4
          );
        }

        // Update target deliverable
        const deliverables = freshState.current_stage_detail.deliverables || [];
        const deliverable = deliverables.find((d) => d.id === result.deliverable_id);

        if (!deliverable) {
          throw new QualityGateExecutionError(
            "DELIVERABLE_NOT_FOUND",
            `Deliverable '${result.deliverable_id}' not found in active stage state.`,
            4
          );
        }

        const isPassed = result.outcome === "passed";
        const manifest=JSON.parse(fs.readFileSync(path.join(this.targetDir,".playbook/manifest.json"),"utf8")) as ProjectManifest;
        const check=stageGate.checks.find(c=>c.id===result.check_id)!;
        if (result.config_hash!==configurationFingerprint(this.targetDir,manifest) ||
            (result.tool_fingerprint ? result.tool_fingerprint!==toolFingerprint(this.targetDir,check) : result.outcome==="passed")) {
          throw new QualityGateExecutionError("CHECK_RESULT_SUPERSEDED","Check configuration or tool changed while executing.");
        }
        const waived=deliverable.status==="waived";
        const exception=freshState.current_stage_detail.exceptions.find(e=>e.exception_id===deliverable.exception_ref);
        if (waived) {
          assertEffectiveWaiver(freshState,deliverable,e=>verifyExceptionAuthority(this.targetDir,freshState,manifest,e));
          if (!exception?.remediation_id || !exception.remediation_started_at || Date.parse(result.started_at)<=Date.parse(exception.remediation_started_at)) {
            throw new QualityGateExecutionError("REMEDIATION_NOT_STARTED","Start fresh remediation before running checks for a waived deliverable.");
          }
        } else if (isPassed) {
          deliverable.validation_status = "unvalidated";
          deliverable.status = "in_progress";
        } else if (result.severity === "blocking") {
          deliverable.validation_status = "failed";
          deliverable.status = "in_progress";
        }

        const evidenceRecord: EvidenceRecord = {
          requirement_id: null,
          type: result.type,
          procedure: `${result.command} ${result.args.join(" ")}`.trim(),
          result: isPassed ? "passed" : "failed",
          summary: `Quality check '${result.check_id}' ${result.outcome.toUpperCase()} (exit code ${result.exit_code !== null ? result.exit_code : "null"}, duration ${result.duration_ms}ms) [rif:${result.rif}]`,
          exit_code: result.exit_code,
          commit_sha: null,
          evidence_hash: result.canonical_log_sha256,
          evidence_ref: result.canonical_log_path,
          verified_at: result.completed_at,
          verified_by: "agent:quality-gate-engine",
          actor_type: "agent",
          rif: result.rif,
          working_tree_clean: workingTreeClean,
          inputs_hash: null,
          quality_gate: {
            gate_id: `gate-stage-${stageGate.stage}`,
            check_id: result.check_id,
            duration_ms: result.duration_ms,
            config_hash: result.config_hash,
            tool_fingerprint: result.tool_fingerprint,
            tool_version: result.tool_version,
          },
        };
        if (freshState.schema_version==="1.1.0") {
          freshState.transaction_sequence=(freshState.transaction_sequence || 0)+1;
          evidenceRecord.sequence=freshState.transaction_sequence;
          if (waived) evidenceRecord.remediation_ref=exception!.remediation_id;
          freshState.audit_trail ||= [];
          freshState.audit_trail.push({action:"EVIDENCE_RECORDED",sequence:freshState.transaction_sequence,timestamp:result.completed_at,actor:"agent:quality-gate-engine",actor_type:"agent",reason:`Quality check ${check.id} recorded`,deliverable_id:deliverable.id,prior_authorization_ref:exception?.authorization_ref || null});
        }

        // Append evidence record
        deliverable.evidence.push(evidenceRecord);

        // Update state metadata
        freshState.last_updated = {
          timestamp: result.completed_at,
          updated_by: "agent:quality-gate-engine",
          actor_type: "agent",
          reason: `Recorded quality-gate evidence for check '${result.check_id}' (${result.outcome.toUpperCase()}).`,
        };

        if (!this.validator.validateState(freshState).valid) throw new QualityGateExecutionError("STATE_SCHEMA_INVALID","Gate evidence update failed schema validation.");
        const serializedState = JSON.stringify(freshState, null, 2) + "\n";

        // Multi-file atomic operations:
        // files[0]: canonical log (createOnly: true)
        // files[1]: state.json (expectedPreviousSha256: freshDiskHash)
        const fileOperations = [
          {
            operation: "write" as const,
            targetPath: result.canonical_log_path,
            content: logContent,
            createOnly: true,
          },
          {
            operation: "write" as const,
            targetPath: stateRelative,
            content: serializedState,
            expectedPreviousSha256: freshDiskHash,
          },
        ];

        // Prepare and commit inside lock
        const prepJournal = await this.txManager.prepare(
          "RECORD_QUALITY_GATE_EVIDENCE",
          fileOperations,
          lockHandle
        );
        await this.txManager.commit(prepJournal, lockHandle);

        // The log must exist before aggregate promotion. A crash between these
        // transactions leaves a conservative in-progress target with intact proof.
        if (!waived) {
          const resolution=resolveAuthoritativeVerification(this.targetDir,freshState.current_stage,deliverable,manifest,deliverables);
          if (resolution.authoritativeResult==="passed") {
            const recordedRaw=fs.readFileSync(stateAbsolute,"utf8");
            deliverable.status="verified";deliverable.validation_status="passed";
            const promotion=await this.txManager.prepare("VERIFY_QUALITY_GATE_DELIVERABLE",[
              {operation:"write",targetPath:stateRelative,content:JSON.stringify(freshState,null,2)+"\n",expectedPreviousSha256:computeSha256(recordedRaw)},
            ],lockHandle);
            await this.txManager.commit(promotion,lockHandle);
          }
        }

        return true;
      },
      { timeoutMs: this.txManager.lockTimeoutMs }
    );

    // Unlink staging files
    try {
      if (resolvedLogPath && fs.existsSync(resolvedLogPath)) {
        fs.unlinkSync(resolvedLogPath);
      }
      if (resolvedMetaPath && fs.existsSync(resolvedMetaPath)) {
        fs.unlinkSync(resolvedMetaPath);
      }
    } catch {
      // Ignore staging unlink errors
    }
  }
}

/**
 * Helper to synchronously execute command and return string output.
 */
function spawnSyncToString(command: string, args: string[], cwd: string): string {
  try {
    const resolved = resolveExecutable(command, args, { cwd });
    return execFileSync(resolved.file, resolved.args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * Terminates process tree with graceful escalation across platforms.
 */
function terminateProcessTree(pid?: number): void {
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      // Stage 1: Graceful termination attempt without /F
      // For GUI processes or applications with window message loops, taskkill without /F sends WM_CLOSE.
      // Note: On Windows, process.kill(pid, "SIGTERM") must NOT be called here because it maps to
      // TerminateProcess(), which kills the root process immediately without running cleanup handlers
      // and severs the process tree, orphaning any grandchild processes.
      execSync(`taskkill /pid ${pid} /T`, { stdio: "ignore" });
    } catch {
      // Ignore if process already dead or console application requiring forced termination
    }

    // Stage 2: Escalate to forced tree termination (/T /F) after 1,000ms if process tree is still alive
    const escalationTimer = setTimeout(() => {
      try {
        process.kill(pid, 0); // probe if root process is still alive
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      } catch {
        // already exited
      }
    }, 1000);
    escalationTimer.unref();
  } else {
    try {
      // Stage 1: SIGTERM process group
      process.kill(-pid, "SIGTERM");
    } catch {
      // Ignore ESRCH if already dead
    }

    // Stage 2: Escalate to SIGKILL after 3,000ms
    const escalationTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Ignore ESRCH
      }
    }, 3000);
    escalationTimer.unref();
  }
}
