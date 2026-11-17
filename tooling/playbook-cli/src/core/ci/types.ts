/**
 * Core types, interfaces, constants, and error definitions for remote CI integration.
 * Part of Task 006C.3.1 (Remote CI Pipeline Architecture & GitHub Actions Adapter Design).
 */

import type { CheckExecutionResult } from "../../types/quality-gates.js";

export type CiProviderType = "github" | "gitlab" | "azure_devops";

export const SUPPORTED_CI_PROVIDERS: readonly CiProviderType[] = ["github"] as const;

export const CI_WORKFLOW_MARKERS = {
  start: "# >>> AI ENGINEERING PLAYBOOK CI (MANAGED WORKFLOW - DO NOT EDIT) >>>",
  end: "# <<< AI ENGINEERING PLAYBOOK CI (MANAGED WORKFLOW - DO NOT EDIT) <<<",
} as const;

export const CI_REQUIRED_CHECK_NAME = "Playbook / Quality Gates";
export const DEFAULT_GITHUB_WORKFLOW_PATH = ".github/workflows/quality-gate.yml";
export const CI_BACKUP_SUFFIX = ".user-backup";

export type CiExecutionOutcome = "passed" | "failed" | "incomplete" | "cancelled" | "skipped";

export type CiReportGenerationMethod = "playbook_cli" | "emergency_fallback";

export type CiEvidenceCompleteness = "complete" | "partial" | "incomplete";

export interface CiRunIdentity {
  provider: string;
  repository: string;
  workflow_name: string;
  run_id: string;
  run_attempt: number;
  run_url: string;
  trigger_event: string;
  ref: string | null;
  pull_request_number: number | null;
  head_branch: string | null;
  base_branch: string | null;
  pr_head_sha: string | null;
  pr_base_sha: string | null;
  checked_out_commit_sha: string;
  checked_out_tree_sha: string;
  head_commit_sha: string;
  head_tree_sha: string;
  is_merge_commit: boolean;
  commit_verified: boolean;
}

export interface CiRuntimeEnvironment {
  os_platform: string;
  os_release?: string;
  node_version: string;
  cli_version: string;
  runner_arch: string;
}

export interface CiGovernanceEvaluation {
  stage: number;
  stage_name: string;
  profile: string;
  working_tree_clean: boolean;
  overall_outcome: CiExecutionOutcome;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

export interface CiArtifactReference {
  name: string;
  path: string;
  sha256?: string;
  retention_days: number;
}

export interface CiGovernanceLintSummary {
  status: "passed" | "failed" | "incomplete" | "skipped";
  completed: boolean;
  rules_evaluated: number;
  findings_total: number;
  blocking_findings: number;
  warning_findings: number;
  advisory_findings: number;
  report_path?: string;
  report_sha256?: string;
}

export interface PlaybookCiRunEvidence {
  $schema: string;
  schema_version: string;
  report_generation_method: CiReportGenerationMethod;
  gate_execution_started: boolean;
  gate_execution_completed: boolean;
  evidence_completeness: CiEvidenceCompleteness;
  run_identity: CiRunIdentity;
  runtime_environment: CiRuntimeEnvironment;
  governance_evaluation: CiGovernanceEvaluation;
  governance_linting?: CiGovernanceLintSummary;
  summary: {
    total: number;
    passed: number;
    failed: number;
    warning: number;
    skipped: number;
  };
  checks: CheckExecutionResult[];
  artifacts: CiArtifactReference[];
  diagnostics: string[];
  limitations: string[];
}

export interface CiEvidenceReportOptions {
  cwd?: string;
  outputPath?: string;
  rawReportPath?: string;
  lintReportPath?: string;
  writeSummary?: boolean;
  jobStatus?: string;
  repository?: string;
  workflow?: string;
  runId?: string;
  runAttempt?: number;
  eventName?: string;
  headSha?: string;
  ref?: string;
  prNumber?: number;
  prHeadSha?: string;
  prBaseRef?: string;
  prBaseSha?: string;
  gateExecutionStarted?: boolean;
  gateExecutionCompleted?: boolean;
  reportGenerationMethod?: CiReportGenerationMethod;
  evidenceCompleteness?: CiEvidenceCompleteness;
}

export interface CiAdapter {
  readonly provider: CiProviderType;
  readonly defaultWorkflowPath: string;
  readonly requiredCheckName: string;
  generateWorkflow(options: CiWorkflowOptions): string;
  validateWorkflow(content: string, filePath: string): CiWorkflowValidationResult;
  getRequiredCheckNames(): string[];
}

export interface CiWorkflowOptions {
  provider: CiProviderType;
  cwd?: string;
  outputPath?: string;
  force?: boolean;
  dryRun?: boolean;
  stage?: number;
  profile?: "strict" | "standard" | "relaxed";
  timestamp?: string;
}

export interface CiWorkflowValidationResult {
  valid: boolean;
  provider: CiProviderType;
  filePath: string;
  errors: string[];
  warnings: string[];
  isPlaybookManaged: boolean;
  version?: string;
  requiredCheckName?: string;
  permissionsValid?: boolean;
  triggersValid?: boolean;
  pinnedActionsValid?: boolean;
}

export type CiStatusType = "valid" | "modified" | "outdated" | "invalid" | "unmanaged" | "missing";

export interface CiStatusResult {
  installed: boolean;
  provider: CiProviderType;
  filePath: string;
  status: CiStatusType;
  isPlaybookManaged: boolean;
  version?: string;
  requiredCheckName: string;
  errors: string[];
  warnings: string[];
  backupFiles: string[];
  validationResult?: CiWorkflowValidationResult;
  diagnostics: string[];
}

export interface CiInitResult {
  success: boolean;
  provider: CiProviderType;
  filePath: string;
  action: "created" | "already_up_to_date" | "overwritten" | "dry_run";
  backupCreated: boolean;
  backupPath?: string;
  message: string;
  warnings: string[];
}

export type CiErrorCode =
  | "UNSUPPORTED_PROVIDER"
  | "WORKFLOW_ALREADY_EXISTS"
  | "WORKFLOW_MODIFIED"
  | "WORKFLOW_CORRUPT"
  | "WORKFLOW_NOT_FOUND"
  | "INVALID_WORKFLOW"
  | "BACKUP_INTEGRITY_FAILED"
  | "STAGING_FAILED"
  | "FILESYSTEM_ERROR";

export class CiError extends Error {
  readonly code: CiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CiError";
    this.code = code;
    this.details = details;
  }
}
