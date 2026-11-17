import type { GovernanceProfile } from "../constants.js";

export type CheckType =
  | "automated_test"
  | "build_typecheck"
  | "static_analysis"
  | "schema_validation"
  | "security_audit"
  | "manual_functional"
  | "visual_review"
  | "accessibility_audit"
  | "architecture_review";

export type CheckSeverity = "blocking" | "warning" | "advisory";

export interface CheckRetryConfig {
  count: number;
  delay_ms: number;
}

export interface QualityGateCheck {
  id: string;
  name: string;
  type: CheckType;
  deliverable_id: string;
  requirement_ids?: string[];
  inputs?: string[];
  exclude?: string[];
  text_patterns?: string[];
  binary_patterns?: string[];
  lockfiles?: string[];
  tool_version_command?: string;
  command: string;
  args: string[];
  working_dir?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  severity?: CheckSeverity;
  depends_on?: string[];
  retry?: CheckRetryConfig;
  profiles?: GovernanceProfile[];
}

export interface QualityGateStage {
  stage: number;
  stage_name: string;
  checks: QualityGateCheck[];
}

export interface GlobalQualityGateSettings {
  default_timeout_ms: number;
  max_concurrency: number;
  mask_secrets: boolean;
  log_retention_runs: number;
  max_journaled_log_bytes: number;
  env_allowlist: string[];
  sensitive_patterns?: string[];
}

export interface QualityGatesConfig {
  $schema: string;
  schema_version: string;
  project_id: string;
  default_profile: GovernanceProfile;
  global_settings: GlobalQualityGateSettings;
  gates: QualityGateStage[];
}

export type WorkingTreeTier = "local" | "handover" | "ci";

export type CheckOutcome = "passed" | "failed" | "skipped" | "timed_out" | "error";

export interface CheckExecutionResult {
  check_id: string;
  name: string;
  type: CheckType;
  deliverable_id: string;
  severity: CheckSeverity;
  command: string;
  args: string[];
  exit_code: number | null;
  outcome: CheckOutcome;
  duration_ms: number;
  rif: string;
  tool_version: string;
  canonical_log_path: string;
  canonical_log_sha256: string;
  truncated: boolean;
  started_at: string;
  completed_at: string;
  error_message?: string;
  secret_freshness_unbounded?: boolean;
  unbounded_secret_keys?: string[];
}

export interface QualityGateRunSummary {
  total: number;
  passed: number;
  failed: number;
  warning: number;
  skipped: number;
  duration_ms: number;
}

export interface QualityGateRunReport {
  timestamp: string;
  stage: number;
  stage_name: string;
  profile: GovernanceProfile;
  working_tree_clean: boolean;
  overall_outcome: "passed" | "failed" | "halted";
  summary: QualityGateRunSummary;
  checks: CheckExecutionResult[];
  diagnostics: Array<{
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
  }>;
}

export interface QualityGateVerifyReport {
  timestamp: string;
  stage: number;
  stage_name: string;
  all_fresh: boolean;
  checks: Array<{
    check_id: string;
    deliverable_id: string;
    is_fresh: boolean;
    current_rif: string;
    recorded_rif: string | null;
    evidence_status: string;
    log_exists: boolean;
    log_hash_matched: boolean;
    reason?: string;
  }>;
  pending_recovery?: boolean;
  diagnostics?: Array<{
    code: string;
    severity: "warning" | "error" | "info";
    message: string;
  }>;
}
