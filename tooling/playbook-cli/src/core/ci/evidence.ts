import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type PlaybookCiRunEvidence,
  type CiEvidenceReportOptions,
  type CiExecutionOutcome,
  type CiReportGenerationMethod,
  type CiEvidenceCompleteness,
  type CiGovernanceLintSummary,
} from "./types.js";
import { PLAYBOOK_VERSION, STAGE_NAMES } from "../../constants.js";
import type { CheckExecutionResult } from "../../types/quality-gates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CI_EVIDENCE_LIMITATIONS: readonly string[] = [
  "A matching SHA-256 hash confirms only byte-level artifact integrity; it does NOT establish runner authenticity or cryptographic non-repudiation.",
  "Evidence produced within a cloud runner execution environment is subject to provider retention policies (default 30 days on GitHub).",
  "Long-term governance immutability is rooted in Git-committed hashes and human approval fingerprints, not ephemeral cloud runner storage.",
  "Checked-out tree SHA verifies the state of the filesystem tree evaluated by quality gates; merge commits may differ from the PR branch tip.",
] as const;

function getGitRev(cwd: string, rev: string): string {
  try {
    return execSync(`git rev-parse ${rev}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

function getGitTreeSha(cwd: string): string {
  try {
    return execSync("git log -1 --format=%T HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

function getRunningPackageVersion(): string {
  try {
    // Traverse upwards from current file to find package.json
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (pkg.name === "@ai-engineering-playbook/cli" && pkg.version) {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fallback to constant
  }
  return PLAYBOOK_VERSION;
}

/**
 * Constructs the canonical machine-readable CI evidence report adhering to the Playbook CI evidence model.
 */
export function buildCiEvidenceReport(
  cwd: string,
  options: CiEvidenceReportOptions = {}
): PlaybookCiRunEvidence {
  const repository =
    options.repository || process.env.GITHUB_REPOSITORY || "unknown/local-repository";
  const workflowName =
    options.workflow || process.env.GITHUB_WORKFLOW || "Playbook Quality Gates & Verification";
  const runId = options.runId || process.env.GITHUB_RUN_ID || "local-run";
  const runAttempt =
    options.runAttempt || (process.env.GITHUB_RUN_ATTEMPT ? parseInt(process.env.GITHUB_RUN_ATTEMPT, 10) : 1);
  const triggerEvent = options.eventName || process.env.GITHUB_EVENT_NAME || "push";
  const prNumber =
    options.prNumber !== undefined
      ? options.prNumber
      : process.env.PR_NUMBER
      ? parseInt(process.env.PR_NUMBER, 10)
      : null;
  const headBranch = options.ref || process.env.HEAD_BRANCH || process.env.GITHUB_REF_NAME || null;
  const baseBranch = options.prBaseRef || process.env.BASE_BRANCH || null;
  const ref = options.ref || process.env.GITHUB_REF || null;

  // Explicit commit identity distinction
  const prHeadSha = options.prHeadSha || process.env.PR_HEAD_SHA || null;
  const prBaseSha = options.prBaseSha || process.env.PR_BASE_SHA || null;
  const checkedOutCommitSha = options.headSha || getGitRev(cwd, "HEAD");
  const checkedOutTreeSha = getGitTreeSha(cwd);

  // Check if checked-out commit is a merge commit (e.g. refs/pull/:id/merge)
  let isMergeCommit = false;
  try {
    const parentsOutput = execSync("git log -1 --format=%P HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parentCount = parentsOutput ? parentsOutput.split(/\s+/).length : 0;
    isMergeCommit = parentCount > 1;
  } catch {
    isMergeCommit = false;
  }

  // Commit identity & provenance verification
  let commitVerified = true;
  const diagnostics: string[] = [];

  // 1. Verify checked-out commit format and existence in local repository
  let checkedOutCommitExists = false;
  if (
    checkedOutCommitSha === "0000000000000000000000000000000000000000" ||
    !/^[a-fA-F0-9]{40,64}$/.test(checkedOutCommitSha)
  ) {
    commitVerified = false;
    diagnostics.push("Checked-out commit SHA could not be determined from git history.");
  } else {
    try {
      execSync(`git cat-file -e ${checkedOutCommitSha}`, { cwd, stdio: "ignore" });
      checkedOutCommitExists = true;
    } catch {
      commitVerified = false;
      checkedOutCommitExists = false;
      diagnostics.push(`Checked-out commit SHA '${checkedOutCommitSha}' does not exist in local git repository.`);
    }
  }

  // 2. Pull Request event provenance: verify PR head and base SHAs and reachability
  if (triggerEvent === "pull_request" || prNumber !== null) {
    if (!prHeadSha || !/^[a-fA-F0-9]{40,64}$/.test(prHeadSha)) {
      commitVerified = false;
      diagnostics.push("Pull request event is missing a valid PR head commit SHA (pr_head_sha).");
    } else {
      let prHeadExists = false;
      try {
        execSync(`git cat-file -e ${prHeadSha}`, { cwd, stdio: "ignore" });
        prHeadExists = true;
      } catch {
        commitVerified = false;
        prHeadExists = false;
        diagnostics.push(
          `PR head commit SHA '${prHeadSha}' was not found in local git history (possible force-push, shallow clone, or invalid ref).`
        );
      }

      // Check reachability: distinguish commit existence from reachability / event identity
      if (prHeadExists && checkedOutCommitExists) {
        if (checkedOutCommitSha.toLowerCase() !== prHeadSha.toLowerCase()) {
          try {
            execSync(`git merge-base --is-ancestor ${prHeadSha} ${checkedOutCommitSha}`, { cwd, stdio: "ignore" });
          } catch {
            commitVerified = false;
            diagnostics.push(
              `PR head commit SHA '${prHeadSha}' exists in repository but is NOT reachable from checked-out commit '${checkedOutCommitSha}'. Event identity mismatch.`
            );
          }
        }
      }
    }

    // Verify PR base SHA if provided
    if (prBaseSha && /^[a-fA-F0-9]{40,64}$/.test(prBaseSha)) {
      let prBaseExists = false;
      try {
        execSync(`git cat-file -e ${prBaseSha}`, { cwd, stdio: "ignore" });
        prBaseExists = true;
      } catch {
        commitVerified = false;
        prBaseExists = false;
        diagnostics.push(`PR base commit SHA '${prBaseSha}' was not found in local git history.`);
      }

      if (isMergeCommit && prBaseExists && checkedOutCommitExists) {
        try {
          execSync(`git merge-base --is-ancestor ${prBaseSha} ${checkedOutCommitSha}`, { cwd, stdio: "ignore" });
        } catch {
          commitVerified = false;
          diagnostics.push(
            `PR base commit SHA '${prBaseSha}' exists in repository but is NOT reachable from checked-out merge commit '${checkedOutCommitSha}'.`
          );
        }
      }
    }
  }

  // 3. Push event provenance: ensure checked-out commit matches GITHUB_SHA if present
  if (triggerEvent === "push") {
    const envSha = process.env.GITHUB_SHA;
    if (envSha && /^[a-fA-F0-9]{40,64}$/.test(envSha)) {
      if (checkedOutCommitSha.toLowerCase() !== envSha.toLowerCase()) {
        commitVerified = false;
        diagnostics.push(
          `Checked-out commit SHA '${checkedOutCommitSha}' does not match GITHUB_SHA '${envSha}' for push event.`
        );
      }
    }
  }

  const runUrl =
    runId !== "local-run"
      ? `https://github.com/${repository}/actions/runs/${runId}`
      : `file://${cwd}`;

  // Read raw report if present
  const rawReportFile = options.rawReportPath
    ? path.isAbsolute(options.rawReportPath)
      ? options.rawReportPath
      : path.resolve(cwd, options.rawReportPath)
    : path.resolve(cwd, "gate-raw-report.json");

  let rawReport: Record<string, unknown> | null = null;
  if (fs.existsSync(rawReportFile)) {
    try {
      rawReport = JSON.parse(fs.readFileSync(rawReportFile, "utf-8"));
    } catch {
      rawReport = null;
      diagnostics.push(`Failed to parse raw gate report at ${rawReportFile}: malformed JSON.`);
    }
  }

  // Read raw lint report if present
  const explicitLintReport = Boolean(options.lintReportPath);
  const rawLintFile = options.lintReportPath
    ? path.isAbsolute(options.lintReportPath)
      ? options.lintReportPath
      : path.resolve(cwd, options.lintReportPath)
    : path.resolve(cwd, "lint-raw-report.json");

  let governanceLinting: CiGovernanceLintSummary | undefined;
  if (fs.existsSync(rawLintFile)) {
    try {
      const stat = fs.statSync(rawLintFile);
      const relReportPath = path.relative(cwd, rawLintFile).replace(/\\/g, "/");

      if (stat.size === 0) {
        governanceLinting = {
          status: "incomplete",
          completed: false,
          rules_evaluated: 0,
          findings_total: 0,
          blocking_findings: 1,
          warning_findings: 0,
          advisory_findings: 0,
          report_path: relReportPath,
        };
        diagnostics.push(`Failed to parse raw lint report at ${rawLintFile}: file is empty (0 bytes).`);
      } else {
        const lintContent = fs.readFileSync(rawLintFile, "utf-8");
        if (lintContent.trim().length === 0) {
          governanceLinting = {
            status: "incomplete",
            completed: false,
            rules_evaluated: 0,
            findings_total: 0,
            blocking_findings: 1,
            warning_findings: 0,
            advisory_findings: 0,
            report_path: relReportPath,
          };
          diagnostics.push(`Failed to parse raw lint report at ${rawLintFile}: file contains only whitespace.`);
        } else {
          const parsedLint = JSON.parse(lintContent);
          const lintSha = crypto.createHash("sha256").update(lintContent).digest("hex");

          // Validate schema version strictly
          if (parsedLint.schema_version !== "1.0") {
            governanceLinting = {
              status: "incomplete",
              completed: false,
              rules_evaluated: 0,
              findings_total: 0,
              blocking_findings: 1,
              warning_findings: 0,
              advisory_findings: 0,
              report_path: relReportPath,
              report_sha256: `sha256:${lintSha}`,
            };
            diagnostics.push(
              `Invalid lint report schema_version '${parsedLint.schema_version}'. Expected '1.0'.`
            );
          } else {
            const sum = parsedLint.summary;
            const hasValidSummary =
              sum &&
              typeof sum === "object" &&
              typeof sum.rules_evaluated === "number" &&
              sum.rules_evaluated >= 0 &&
              typeof sum.findings_total === "number" &&
              sum.findings_total >= 0 &&
              typeof sum.blocking_findings === "number" &&
              sum.blocking_findings >= 0 &&
              typeof sum.warning_findings === "number" &&
              sum.warning_findings >= 0 &&
              typeof sum.advisory_findings === "number" &&
              sum.advisory_findings >= 0 &&
              (sum.rules_passed === undefined ||
                sum.rules_failed === undefined ||
                sum.rules_passed + sum.rules_failed === sum.rules_evaluated) &&
              sum.blocking_findings + sum.warning_findings + sum.advisory_findings === sum.findings_total;

            const executionFailures = Array.isArray(parsedLint.execution_failures)
              ? parsedLint.execution_failures
              : [];
            const hasExecutionFailures = executionFailures.length > 0;

            if (!hasValidSummary) {
              governanceLinting = {
                status: "incomplete",
                completed: false,
                rules_evaluated: Number(sum?.rules_evaluated) || 0,
                findings_total: Number(sum?.findings_total) || 0,
                blocking_findings: Math.max(1, Number(sum?.blocking_findings) || 0),
                warning_findings: Number(sum?.warning_findings) || 0,
                advisory_findings: Number(sum?.advisory_findings) || 0,
                report_path: relReportPath,
                report_sha256: `sha256:${lintSha}`,
              };
              diagnostics.push(`Lint report summary contains inconsistent, non-numeric, or missing counts.`);
            } else if (hasExecutionFailures) {
              governanceLinting = {
                status: "failed",
                completed: false,
                rules_evaluated: sum.rules_evaluated,
                findings_total: sum.findings_total,
                blocking_findings: Math.max(1, sum.blocking_findings),
                warning_findings: sum.warning_findings,
                advisory_findings: sum.advisory_findings,
                report_path: relReportPath,
                report_sha256: `sha256:${lintSha}`,
              };
              diagnostics.push(
                `Governance linter reported ${executionFailures.length} execution failure(s).`
              );
            } else {
              const isComplete = Boolean(parsedLint.complete);
              let lintStatus = parsedLint.status || "incomplete";
              if (!isComplete && lintStatus === "passed") {
                lintStatus = "incomplete";
              }

              governanceLinting = {
                status: lintStatus,
                completed: isComplete,
                rules_evaluated: sum.rules_evaluated,
                findings_total: sum.findings_total,
                blocking_findings: sum.blocking_findings,
                warning_findings: sum.warning_findings,
                advisory_findings: sum.advisory_findings,
                report_path: relReportPath,
                report_sha256: `sha256:${lintSha}`,
              };
            }
          }
        }
      }
    } catch {
      governanceLinting = {
        status: "incomplete",
        completed: false,
        rules_evaluated: 0,
        findings_total: 0,
        blocking_findings: 1,
        warning_findings: 0,
        advisory_findings: 0,
        report_path: path.relative(cwd, rawLintFile).replace(/\\/g, "/"),
      };
      diagnostics.push(`Failed to parse raw lint report at ${rawLintFile}: malformed JSON.`);
    }
  } else if (explicitLintReport) {
    governanceLinting = {
      status: "incomplete",
      completed: false,
      rules_evaluated: 0,
      findings_total: 0,
      blocking_findings: 1,
      warning_findings: 0,
      advisory_findings: 0,
      report_path: path.relative(cwd, rawLintFile).replace(/\\/g, "/"),
    };
    diagnostics.push(`Explicitly specified lint report was not found at ${rawLintFile}.`);
  }

  // Inspect state.json for stage context if raw report is missing
  let stageNumber = 0;
  let stageName: string = STAGE_NAMES[0];
  let profile = "standard";
  let workingTreeClean = true;
  let rawChecks: CheckExecutionResult[] = [];
  let summary = {
    total: 0,
    passed: 0,
    failed: 0,
    warning: 0,
    skipped: 0,
  };

  const stateFile = path.resolve(cwd, ".playbook/state.json");
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      stageNumber = Number.isInteger(state.active_lifecycle_stage) ? state.active_lifecycle_stage : 0;
      stageName = STAGE_NAMES[stageNumber] || `Stage ${stageNumber}`;
      profile = state.governance_profile || "standard";
    } catch {
      // Fallback to defaults
    }
  }

  if (rawReport) {
    if (typeof rawReport.stage === "number") stageNumber = rawReport.stage;
    if (typeof rawReport.stage_name === "string") stageName = rawReport.stage_name;
    if (typeof rawReport.profile === "string") profile = rawReport.profile;
    if (typeof rawReport.working_tree_clean === "boolean") workingTreeClean = rawReport.working_tree_clean;
    if (Array.isArray(rawReport.checks)) rawChecks = rawReport.checks as CheckExecutionResult[];
    if (rawReport.summary && typeof rawReport.summary === "object") {
      summary = {
        total: Number((rawReport.summary as Record<string, unknown>).total) || 0,
        passed: Number((rawReport.summary as Record<string, unknown>).passed) || 0,
        failed: Number((rawReport.summary as Record<string, unknown>).failed) || 0,
        warning: Number((rawReport.summary as Record<string, unknown>).warning) || 0,
        skipped: Number((rawReport.summary as Record<string, unknown>).skipped) || 0,
      };
    }
    if (Array.isArray(rawReport.diagnostics)) {
      for (const d of rawReport.diagnostics) {
        if (typeof d === "string") diagnostics.push(d);
        else if (d && typeof d === "object" && "message" in d) diagnostics.push(String(d.message));
      }
    }
  }

  // Execution and reporting method semantics
  const reportGenerationMethod: CiReportGenerationMethod =
    options.reportGenerationMethod || "playbook_cli";
  const gateExecutionStarted =
    options.gateExecutionStarted !== undefined
      ? options.gateExecutionStarted
      : rawReport !== null;
  const gateExecutionCompleted =
    options.gateExecutionCompleted !== undefined
      ? options.gateExecutionCompleted
      : rawReport !== null &&
        typeof rawReport.overall_outcome === "string" &&
        rawReport.overall_outcome.trim().length > 0;

  // Determine overall outcome
  const jobStatus = (options.jobStatus || process.env.JOB_STATUS || "").toLowerCase().trim();
  let overallOutcome: CiExecutionOutcome = "incomplete";

  if (jobStatus === "cancelled") {
    overallOutcome = "cancelled";
    diagnostics.push("Remote CI workflow run was cancelled before completion.");
  } else if (jobStatus === "skipped") {
    overallOutcome = "skipped";
    diagnostics.push("Remote CI workflow run was skipped.");
  } else if (rawReport && gateExecutionCompleted) {
    const rawOutcome = String(rawReport.overall_outcome || "").toLowerCase();
    if (rawOutcome === "passed" && summary.failed === 0) {
      overallOutcome = "passed";
    } else {
      overallOutcome = "failed";
    }
  } else if (jobStatus === "failure") {
    overallOutcome = "incomplete";
    diagnostics.push("Workflow failed prior to Quality Gate execution or gate report generation.");
  } else if (jobStatus === "success") {
    overallOutcome =
      summary.failed === 0 && rawReport !== null && gateExecutionCompleted ? "passed" : "failed";
  }

  // Downgrade to incomplete if commit provenance could not be verified
  if (!commitVerified && overallOutcome === "passed") {
    overallOutcome = "incomplete";
    diagnostics.push("Verdict downgraded to 'incomplete': target commit provenance could not be verified.");
  }

  // Downgrade to incomplete if gate execution did not complete
  if (!gateExecutionCompleted && overallOutcome === "passed") {
    overallOutcome = "incomplete";
    diagnostics.push("Verdict downgraded to 'incomplete': quality gate execution did not complete.");
  }

  // Downgrade to incomplete if emergency fallback was used
  if (reportGenerationMethod === "emergency_fallback" && overallOutcome === "passed") {
    overallOutcome = "incomplete";
    diagnostics.push("Verdict downgraded to 'incomplete': emergency fallback report cannot claim pass.");
  }

  // Adjust outcome and diagnostics based on governance linting
  if (governanceLinting) {
    if (governanceLinting.blocking_findings > 0 || governanceLinting.status === "failed") {
      if (overallOutcome === "passed") {
        overallOutcome = "failed";
      }
      diagnostics.push(
        `Governance linting failed with ${governanceLinting.blocking_findings} blocking finding(s).`
      );
    } else if (!governanceLinting.completed || governanceLinting.status === "incomplete") {
      if (overallOutcome === "passed") {
        overallOutcome = "incomplete";
      }
      diagnostics.push("Governance linting did not complete or timed out.");
    }
  } else if (jobStatus === "cancelled" || jobStatus === "skipped") {
    governanceLinting = {
      status: jobStatus === "cancelled" ? "incomplete" : "skipped",
      completed: false,
      rules_evaluated: 0,
      findings_total: 0,
      blocking_findings: 0,
      warning_findings: 0,
      advisory_findings: 0,
    };
  }

  // Determine evidence completeness
  let evidenceCompleteness: CiEvidenceCompleteness = options.evidenceCompleteness || "incomplete";
  if (!options.evidenceCompleteness) {
    if (!commitVerified) {
      evidenceCompleteness = "incomplete";
    } else if (
      gateExecutionCompleted &&
      summary.total > 0 &&
      overallOutcome !== "incomplete" &&
      reportGenerationMethod === "playbook_cli"
    ) {
      evidenceCompleteness = "complete";
    } else if (gateExecutionStarted) {
      evidenceCompleteness = "partial";
    } else {
      evidenceCompleteness = "incomplete";
    }
  }

  const startedAt = rawReport?.timestamp ? String(rawReport.timestamp) : new Date().toISOString();
  const completedAt = new Date().toISOString();
  const durationMs = 0;

  const artifactName = `playbook-ci-evidence-${runId}-${runAttempt}`;
  const artifacts: { name: string; path: string; sha256?: string; retention_days: number }[] = [
    {
      name: artifactName,
      path: "gate-report.json",
      retention_days: 30,
    },
  ];

  if (governanceLinting?.report_sha256) {
    artifacts.push({
      name: artifactName,
      path: "lint-raw-report.json",
      sha256: governanceLinting.report_sha256,
      retention_days: 30,
    });
  }

  const runningCliVersion = getRunningPackageVersion();

  return {
    $schema: "https://ai-engineering-playbook.org/schemas/ci-run-evidence.schema.json",
    schema_version: "1.0.0",
    report_generation_method: reportGenerationMethod,
    gate_execution_started: gateExecutionStarted,
    gate_execution_completed: gateExecutionCompleted,
    evidence_completeness: evidenceCompleteness,
    run_identity: {
      provider: "github_actions",
      repository,
      workflow_name: workflowName,
      run_id: String(runId),
      run_attempt: Number(runAttempt),
      run_url: runUrl,
      trigger_event: triggerEvent,
      ref,
      pull_request_number: prNumber,
      head_branch: headBranch,
      base_branch: baseBranch,
      pr_head_sha: prHeadSha,
      pr_base_sha: prBaseSha,
      checked_out_commit_sha: checkedOutCommitSha,
      checked_out_tree_sha: checkedOutTreeSha,
      head_commit_sha: prHeadSha || checkedOutCommitSha,
      head_tree_sha: checkedOutTreeSha,
      is_merge_commit: isMergeCommit,
      commit_verified: commitVerified,
    },
    runtime_environment: {
      os_platform: process.platform,
      os_release: process.version,
      node_version: process.version,
      cli_version: runningCliVersion,
      runner_arch: process.arch,
    },
    governance_evaluation: {
      stage: stageNumber,
      stage_name: stageName,
      profile,
      working_tree_clean: workingTreeClean,
      overall_outcome: overallOutcome,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
    },
    governance_linting: governanceLinting,
    summary,
    checks: rawChecks,
    artifacts,
    diagnostics,
    limitations: [...CI_EVIDENCE_LIMITATIONS],
  };
}

/**
 * Generates an emergency fallback CI evidence report when early pipeline failures prevent CLI execution.
 */
export function generateEmergencyFallbackReport(
  options: {
    repository?: string;
    workflow?: string;
    runId?: string;
    runAttempt?: number;
    eventName?: string;
    ref?: string;
    prNumber?: number | null;
    headSha?: string;
    prHeadSha?: string | null;
    prBaseSha?: string | null;
    prBaseRef?: string | null;
    checkedOutCommitSha?: string;
    checkedOutTreeSha?: string;
    reason?: string;
    cliVersion?: string;
    gateExecutionStarted?: boolean;
  } = {}
): PlaybookCiRunEvidence {
  const repository =
    options.repository || process.env.GITHUB_REPOSITORY || "unknown/unknown";
  const workflowName =
    options.workflow || process.env.GITHUB_WORKFLOW || "Playbook Quality Gates & Verification";
  const runId = String(options.runId || process.env.GITHUB_RUN_ID || "unknown");
  const runAttempt = Number(
    options.runAttempt || process.env.GITHUB_RUN_ATTEMPT || 1
  );
  const triggerEvent = options.eventName || process.env.GITHUB_EVENT_NAME || "push";
  const ref = options.ref || process.env.GITHUB_REF || null;
  const prNumber =
    options.prNumber !== undefined
      ? options.prNumber
      : process.env.PR_NUMBER
      ? parseInt(process.env.PR_NUMBER, 10)
      : null;
  const prHeadSha = options.prHeadSha || process.env.PR_HEAD_SHA || null;
  const prBaseSha = options.prBaseSha || process.env.PR_BASE_SHA || null;
  const checkedOutCommitSha =
    options.checkedOutCommitSha ||
    options.headSha ||
    process.env.GITHUB_SHA ||
    "0000000000000000000000000000000000000000";
  const checkedOutTreeSha =
    options.checkedOutTreeSha || "0000000000000000000000000000000000000000";
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  const now = new Date().toISOString();
  const reason =
    options.reason ||
    "Early CI pipeline failure: CLI was unavailable or failed before report generation.";

  return {
    $schema: "https://ai-engineering-playbook.org/schemas/ci-run-evidence.schema.json",
    schema_version: "1.0.0",
    report_generation_method: "emergency_fallback",
    gate_execution_started: options.gateExecutionStarted ?? false,
    gate_execution_completed: false,
    evidence_completeness: "incomplete",
    run_identity: {
      provider: "github_actions",
      repository,
      workflow_name: workflowName,
      run_id: runId,
      run_attempt: runAttempt,
      run_url: runUrl,
      trigger_event: triggerEvent,
      ref,
      pull_request_number: prNumber,
      head_branch: process.env.GITHUB_REF_NAME || null,
      base_branch: options.prBaseRef || process.env.PR_BASE_REF || null,
      pr_head_sha: prHeadSha,
      pr_base_sha: prBaseSha,
      checked_out_commit_sha: checkedOutCommitSha,
      checked_out_tree_sha: checkedOutTreeSha,
      head_commit_sha: prHeadSha || checkedOutCommitSha,
      head_tree_sha: checkedOutTreeSha,
      is_merge_commit: false,
      commit_verified: false,
    },
    runtime_environment: {
      os_platform: process.platform,
      os_release: process.version,
      node_version: process.version,
      cli_version: options.cliVersion || "unavailable",
      runner_arch: process.arch,
    },
    governance_evaluation: {
      stage: 0,
      stage_name: "Discovery",
      profile: "standard",
      working_tree_clean: false,
      overall_outcome: "incomplete",
      started_at: now,
      completed_at: now,
      duration_ms: 0,
    },
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      warning: 0,
      skipped: 0,
    },
    checks: [],
    artifacts: [
      {
        name: `playbook-ci-evidence-${runId}-${runAttempt}`,
        path: "gate-report.json",
        retention_days: 30,
      },
    ],
    diagnostics: [reason],
    limitations: [
      "Emergency fallback report generated due to early CI pipeline failure before CLI availability.",
      ...CI_EVIDENCE_LIMITATIONS,
    ],
  };
}

export interface CiEvidenceValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates a generated CI evidence report against strict governance, provenance, and anti-tampering rules.
 */
export function validateCiEvidenceReport(
  report: PlaybookCiRunEvidence,
  options?: {
    expectedHeadSha?: string;
    expectedRunId?: string;
    strict?: boolean;
    requireGovernanceLinting?: boolean;
  }
): CiEvidenceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (report.schema_version !== "1.0.0") {
    errors.push(`Invalid evidence schema_version '${report.schema_version}'. Expected '1.0.0'.`);
  }

  if (!report.run_identity) {
    errors.push("Missing required 'run_identity' object in evidence report.");
    return { valid: false, errors, warnings };
  }

  // Governance linting requirement check
  if (options?.requireGovernanceLinting && !report.governance_linting) {
    errors.push("Missing required 'governance_linting' summary in evidence report.");
  }

  // Structural validation of governance_linting if present
  if (report.governance_linting) {
    const gl = report.governance_linting;
    if (!["passed", "failed", "incomplete", "skipped"].includes(gl.status)) {
      errors.push(
        `Invalid governance_linting.status '${gl.status}'. Expected 'passed', 'failed', 'incomplete', or 'skipped'.`
      );
    }
    if (typeof gl.completed !== "boolean") {
      errors.push("Missing or non-boolean field 'governance_linting.completed'.");
    }
    if (typeof gl.rules_evaluated !== "number" || gl.rules_evaluated < 0) {
      errors.push("Invalid or negative 'governance_linting.rules_evaluated'.");
    }
    if (typeof gl.blocking_findings !== "number" || gl.blocking_findings < 0) {
      errors.push("Invalid or negative 'governance_linting.blocking_findings'.");
    }
    if (gl.report_sha256 && !/^sha256:[a-fA-F0-9]{64}$/.test(gl.report_sha256)) {
      errors.push(
        `Invalid 'governance_linting.report_sha256' format: '${gl.report_sha256}'. Expected 'sha256:<64 hex chars>'.`
      );
    }
  }

  const runId = report.run_identity;
  if (!runId.run_id || String(runId.run_id).trim() === "") {
    errors.push("Missing required field 'run_identity.run_id'.");
  }
  if (!runId.provider || runId.provider !== "github_actions") {
    errors.push(`Invalid provider '${runId.provider}'. Expected 'github_actions'.`);
  }
  if (!runId.checked_out_commit_sha || !/^[a-fA-F0-9]{40,64}$/.test(runId.checked_out_commit_sha)) {
    errors.push(`Invalid or missing 'run_identity.checked_out_commit_sha': '${runId.checked_out_commit_sha}'.`);
  }
  if (!runId.checked_out_tree_sha || !/^[a-fA-F0-9]{40,64}$/.test(runId.checked_out_tree_sha)) {
    errors.push(`Invalid or missing 'run_identity.checked_out_tree_sha': '${runId.checked_out_tree_sha}'.`);
  }

  // Stale run identity assertion
  if (options?.expectedRunId && String(runId.run_id) !== String(options.expectedRunId)) {
    errors.push(`Run ID mismatch: expected '${options.expectedRunId}', got '${runId.run_id}'.`);
  }

  // Stale commit SHA assertion
  if (options?.expectedHeadSha) {
    const expected = options.expectedHeadSha.toLowerCase();
    const checkedOut = (runId.checked_out_commit_sha || "").toLowerCase();
    const prHead = (runId.pr_head_sha || "").toLowerCase();

    if (checkedOut !== expected && prHead !== expected) {
      errors.push(
        `Commit SHA mismatch: expected '${options.expectedHeadSha}', found checked_out='${runId.checked_out_commit_sha}' and pr_head='${runId.pr_head_sha}'.`
      );
    }
  }

  // Report generation method & execution semantics check
  if (
    !report.report_generation_method ||
    !["playbook_cli", "emergency_fallback"].includes(report.report_generation_method)
  ) {
    errors.push(
      `Invalid or missing 'report_generation_method': '${report.report_generation_method}'. Expected 'playbook_cli' or 'emergency_fallback'.`
    );
  }
  if (typeof report.gate_execution_started !== "boolean") {
    errors.push("Missing or non-boolean field 'gate_execution_started'.");
  }
  if (typeof report.gate_execution_completed !== "boolean") {
    errors.push("Missing or non-boolean field 'gate_execution_completed'.");
  }
  if (
    !report.evidence_completeness ||
    !["complete", "partial", "incomplete"].includes(report.evidence_completeness)
  ) {
    errors.push(
      `Invalid or missing 'evidence_completeness': '${report.evidence_completeness}'. Expected 'complete', 'partial', or 'incomplete'.`
    );
  }

  // False PASS prevention assertions
  const gov = report.governance_evaluation;
  if (gov.overall_outcome === "passed") {
    if (report.report_generation_method === "emergency_fallback") {
      errors.push("FALSE_PASS_DETECTED: Emergency fallback report cannot claim overall_outcome 'passed'.");
    }
    if (report.gate_execution_completed === false) {
      errors.push("FALSE_PASS_DETECTED: overall_outcome is 'passed' but gate_execution_completed is false.");
    }
    if (report.evidence_completeness !== "complete") {
      errors.push(
        `FALSE_PASS_DETECTED: overall_outcome is 'passed' but evidence_completeness is '${report.evidence_completeness}'.`
      );
    }
    if (runId.commit_verified === false) {
      errors.push("FALSE_PASS_DETECTED: overall_outcome is 'passed' but commit_verified is false.");
    }
    if (
      runId.trigger_event === "pull_request" &&
      (!runId.pr_head_sha || !/^[a-fA-F0-9]{40,64}$/.test(runId.pr_head_sha))
    ) {
      errors.push("FALSE_PASS_DETECTED: overall_outcome is 'passed' but pull_request event is missing valid pr_head_sha.");
    }
    if (runId.checked_out_commit_sha === "0000000000000000000000000000000000000000") {
      errors.push("FALSE_PASS_DETECTED: overall_outcome is 'passed' but checked_out_commit_sha is invalid zero hash.");
    }
    if (report.summary.failed > 0) {
      errors.push(
        `FALSE_PASS_DETECTED: overall_outcome is 'passed' but summary reports ${report.summary.failed} failed checks.`
      );
    }
    if (gov.working_tree_clean === false) {
      errors.push(
        "FALSE_PASS_DETECTED: overall_outcome is 'passed' but working_tree_clean is false (violates Tier 3 Clean Tree policy)."
      );
    }
    if (report.summary.total === 0 && gov.stage > 0) {
      errors.push(
        `FALSE_PASS_DETECTED: overall_outcome is 'passed' but zero checks were evaluated for Stage ${gov.stage}.`
      );
    }
    if (report.governance_linting) {
      if (report.governance_linting.status === "failed" || report.governance_linting.blocking_findings > 0) {
        errors.push(
          `FALSE_PASS_DETECTED: overall_outcome is 'passed' but governance_linting failed with ${report.governance_linting.blocking_findings} blocking finding(s).`
        );
      }
      if (report.governance_linting.completed === false && report.governance_linting.status !== "skipped") {
        errors.push(
          "FALSE_PASS_DETECTED: overall_outcome is 'passed' but governance_linting did not complete."
        );
      }
      if (report.governance_linting.status === "incomplete") {
        errors.push(
          "FALSE_PASS_DETECTED: overall_outcome is 'passed' but governance_linting status is 'incomplete'."
        );
      }
    }
  }

  // Artifact integrity check
  if (!Array.isArray(report.artifacts) || report.artifacts.length === 0) {
    errors.push("Missing required 'artifacts' list in evidence report.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Formats a rich Markdown Step Summary for GitHub Actions step annotations.
 */
export function formatCiStepSummaryMarkdown(report: PlaybookCiRunEvidence): string {
  const lines: string[] = [];
  const evalInfo = report.governance_evaluation;
  const runId = report.run_identity;

  lines.push("## AI Engineering Playbook Quality Gates & Verification");
  lines.push("");

  let badge = "";
  if (evalInfo.overall_outcome === "passed") {
    badge = "> [!NOTE]\n> **Verdict**: :white_check_mark: **PASSED** — All quality gates satisfied.";
  } else if (evalInfo.overall_outcome === "failed") {
    badge = "> [!WARNING]\n> **Verdict**: :x: **FAILED** — One or more mandatory quality checks failed.";
  } else if (evalInfo.overall_outcome === "cancelled") {
    badge = "> [!CAUTION]\n> **Verdict**: :no_entry_sign: **CANCELLED** — Workflow execution was cancelled.";
  } else if (evalInfo.overall_outcome === "skipped") {
    badge = "> [!NOTE]\n> **Verdict**: :fast_forward: **SKIPPED** — Quality gate execution was skipped.";
  } else {
    badge = "> [!WARNING]\n> **Verdict**: :warning: **INCOMPLETE** — Workflow failed before gate execution completed.";
  }

  lines.push(badge);
  lines.push("");

  lines.push("### Execution Provenance & Identity");
  lines.push("| Field | Value |");
  lines.push("| :--- | :--- |");
  lines.push(`| **Provider** | \`${runId.provider}\` |`);
  lines.push(`| **Repository** | \`${runId.repository}\` |`);
  lines.push(`| **Workflow Run** | [Run #${runId.run_id} (Attempt ${runId.run_attempt})](${runId.run_url}) |`);
  lines.push(`| **Trigger Event** | \`${runId.trigger_event}\`${runId.pull_request_number ? ` (PR #${runId.pull_request_number})` : ""} |`);
  if (runId.pr_head_sha) {
    lines.push(`| **PR Head SHA** | \`${runId.pr_head_sha}\` |`);
  }
  if (runId.pr_base_sha) {
    lines.push(`| **PR Base SHA** | \`${runId.pr_base_sha}\` |`);
  }
  lines.push(`| **Checked-out Commit SHA** | \`${runId.checked_out_commit_sha}\`${runId.is_merge_commit ? " *(Merge Ref)*" : ""} |`);
  lines.push(`| **Checked-out Tree SHA** | \`${runId.checked_out_tree_sha}\` |`);
  lines.push(`| **Commit Verified** | ${runId.commit_verified ? ":white_check_mark: Yes" : ":x: Unverified"} |`);
  lines.push(`| **Report Generation Method** | \`${report.report_generation_method}\` |`);
  lines.push(
    `| **Gate Execution** | ${
      report.gate_execution_completed
        ? ":white_check_mark: Completed"
        : report.gate_execution_started
        ? ":warning: Incomplete"
        : ":x: Not Started"
    } |`
  );
  lines.push(`| **Evidence Completeness** | \`${report.evidence_completeness.toUpperCase()}\` |`);
  lines.push("");

  if (report.governance_linting) {
    const lint = report.governance_linting;
    lines.push("### Governance Static Analysis & Policy Linting");
    const lintBadge =
      lint.status === "passed"
        ? ":white_check_mark: PASSED"
        : lint.status === "failed"
        ? ":x: FAILED"
        : lint.status === "skipped"
        ? ":fast_forward: SKIPPED"
        : ":warning: INCOMPLETE";

    lines.push("| Status | Execution | Rules Evaluated | Total Findings | Blocking Findings | Warnings |");
    lines.push("| :---: | :---: | :---: | :---: | :---: | :---: |");
    lines.push(
      `| ${lintBadge} | ${lint.completed ? "Completed" : "Incomplete"} | ${lint.rules_evaluated} | ${lint.findings_total} | ${lint.blocking_findings} | ${lint.warning_findings} |`
    );
    if (lint.report_sha256) {
      lines.push("");
      lines.push(`*Lint Report Artifact SHA-256*: \`${lint.report_sha256}\``);
    }
    lines.push("");
  }

  lines.push(`### Evaluation Summary: Stage ${evalInfo.stage} (${evalInfo.stage_name})`);
  lines.push("| Total Checks | Passed | Failed | Warnings | Skipped |");
  lines.push("| :---: | :---: | :---: | :---: | :---: |");
  lines.push(
    `| ${report.summary.total} | ${report.summary.passed} | ${report.summary.failed} | ${report.summary.warning} | ${report.summary.skipped} |`
  );
  lines.push("");

  if (report.checks.length > 0) {
    lines.push("### Quality Check Details");
    lines.push("| Check ID | Name | Severity | Exit Code | Result | RIF Fingerprint |");
    lines.push("| :--- | :--- | :---: | :---: | :---: | :--- |");
    for (const chk of report.checks) {
      const outcomeIcon = chk.outcome === "passed" ? ":white_check_mark: PASS" : ":x: FAIL";
      const rifShort = chk.rif ? `\`${chk.rif.slice(0, 18)}...\`` : "*(none)*";
      lines.push(
        `| \`${chk.check_id}\` | ${chk.name} | \`${chk.severity}\` | \`${chk.exit_code}\` | ${outcomeIcon} | ${rifShort} |`
      );
    }
    lines.push("");
  }

  if (report.diagnostics.length > 0) {
    lines.push("### Diagnostics & Warnings");
    for (const d of report.diagnostics) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  lines.push("### Governance Limitations & Reality");
  for (const lim of report.limitations) {
    lines.push(`- *${lim}*`);
  }
  lines.push("");

  lines.push("---");
  lines.push(`*Generated by @ai-engineering-playbook/cli v${report.runtime_environment.cli_version} on ${evalInfo.completed_at}*`);

  return lines.join("\n");
}

/**
 * Generates and writes the CI evidence report to disk, appending step summaries to $GITHUB_STEP_SUMMARY.
 */
export function writeCiEvidenceReport(
  cwd: string,
  options: CiEvidenceReportOptions = {}
): { report: PlaybookCiRunEvidence; outputPath: string; summaryWritten: boolean } {
  const report = buildCiEvidenceReport(cwd, options);
  const outputPath = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(cwd, options.outputPath)
    : path.resolve(cwd, "gate-report.json");

  // Write report JSON
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const serialized = JSON.stringify(report, null, 2);
  fs.writeFileSync(outputPath, serialized, "utf-8");

  // Calculate and update artifact hash
  const sha = crypto.createHash("sha256").update(serialized).digest("hex");
  if (report.artifacts.length > 0) {
    report.artifacts[0].sha256 = `sha256:${sha}`;
  }

  let summaryWritten = false;
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile && options.writeSummary !== false) {
    try {
      const summaryMarkdown = formatCiStepSummaryMarkdown(report);
      fs.appendFileSync(summaryFile, `\n${summaryMarkdown}\n`, "utf-8");
      summaryWritten = true;
    } catch {
      summaryWritten = false;
    }
  }

  return { report, outputPath, summaryWritten };
}
