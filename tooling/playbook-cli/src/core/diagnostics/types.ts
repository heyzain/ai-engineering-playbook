import type { ProjectManifest } from "../../types/manifest.js";
import type { ProjectState } from "../../types/state.js";

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "PROJECT_UNINITIALIZED"
  | "MANIFEST_MISSING"
  | "STATE_MISSING"
  | "MANIFEST_MALFORMED"
  | "STATE_MALFORMED"
  | "MANIFEST_SCHEMA_INVALID"
  | "STATE_SCHEMA_INVALID"
  | "MILESTONE_MISMATCH"
  | "STAGE_MISMATCH"
  | "DELIVERABLES_EMPTY"
  | "DELIVERABLE_BLOCKED"
  | "DELIVERABLE_INCOMPLETE"
  | "DELIVERABLE_UNVERIFIED"
  | "DELIVERABLE_WAIVED"
  | "RFC_BLOCKING_UNRESOLVED"
  | "RFC_NON_BLOCKING_PENDING"
  | "EXCEPTION_EXPIRED"
  | "EXCEPTION_REVOKED"
  | "EXCEPTION_ACTIVE"
  | "STAGE_PENDING_REVIEW"
  | "STAGE_APPROVED"
  | "LIFECYCLE_COMPLETED_TERMINAL"
  | "LIFECYCLE_PAUSED";

export interface DiagnosticIssue {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  path: string | null;
  remediation: string;
}

export type ReadinessStatus =
  | "blocked"
  | "needs_attention"
  | "ready_for_human_review"
  | "approved"
  | "completed_terminal";

export interface DeliverablesSummary {
  total: number;
  not_started: number;
  in_progress: number;
  completed: number;
  verified: number;
  waived: number;
  blocked: number;
}

export interface RfcsSummary {
  total: number;
  pending_decision: number;
  blocking_unresolved: number;
  resolved: number;
  rejected: number;
}

export interface ExceptionsSummary {
  total: number;
  active: number;
  expired: number;
  revoked: number;
  remediated: number;
}

export interface ApprovalSummary {
  status: string;
  approver: string | null;
  role: string | null;
  decision: string | null;
  approved_at: string | null;
  mode: string | null;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  summary: string;
  blockers: string[];
  warnings: string[];
}

export interface InspectionReport {
  schema_version: string;
  timestamp: string;
  target_dir: string;
  initialized: boolean;
  manifest_present: boolean;
  state_present: boolean;
  manifest_valid: boolean;
  state_valid: boolean;
  project: {
    id: string;
    name: string;
    ecosystem: string;
    language: string;
    profile: string;
    approval_mode: string;
  } | null;
  milestone: {
    id: string;
    name: string;
    lifecycle_status: string;
  } | null;
  stage: {
    number: number;
    name: string;
    status: string;
    started_at: string | null;
  } | null;
  deliverables_summary: DeliverablesSummary;
  rfcs_summary: RfcsSummary;
  exceptions_summary: ExceptionsSummary;
  approval_summary: ApprovalSummary | null;
  readiness: ReadinessReport;
  diagnostics: DiagnosticIssue[];
}

export interface InspectionRawData {
  targetDir: string;
  manifestPath: string;
  statePath: string;
  manifestExists: boolean;
  stateExists: boolean;
  manifestRaw: string | null;
  stateRaw: string | null;
  manifestParsed: ProjectManifest | null;
  stateParsed: ProjectState | null;
  manifestParseError: string | null;
  stateParseError: string | null;
}
