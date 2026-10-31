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
  | "GATE_CRITERIA_UNMET"
  | "LIFECYCLE_COMPLETED_TERMINAL"
  | "LIFECYCLE_STATE_INCONSISTENT"
  | "LIFECYCLE_PAUSED"
  | "EVIDENCE_FILE_MISSING"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_HASH_MALFORMED"
  | "EVIDENCE_UNREADABLE"
  | "EVIDENCE_PATH_INVALID"
  | "EVIDENCE_UNSUPPORTED"
  | "EVIDENCE_NO_HASH"
  | "LOCK_ACQUISITION_FAILED"
  | "LOCK_HELD_BY_ACTIVE_PROCESS"
  | "LOCK_METADATA_UNREADABLE"
  | "RECLAIM_MARKER_UNVERIFIABLE"
  | "RECLAMATION_IN_PROGRESS"
  | "LOCK_LOST_DURING_TRANSACTION"
  | "CROSS_HOST_LOCK_UNVERIFIABLE"
  | "UNSUPPORTED_FILESYSTEM"
  | "LOCK_TIMEOUT"
  | "TRANSACTION_JOURNAL_CORRUPT"
  | "CRITICAL_RECOVERY_FAILURE"
  | "TRANSACTION_FAILED"
  | "GATE_MISMATCH"
  | "STAGE_ALREADY_APPROVED"
  | "TTY_REQUIRED"
  | "AGENT_APPROVAL_PROHIBITED"
  | "APPROVAL_FINGERPRINT_MISSING"
  | "APPROVAL_FINGERPRINT_MALFORMED"
  | "APPROVAL_STALE"
  | "ADVANCEMENT_BLOCKED"
  | "SNAPSHOT_CONFLICT"
  | "EXIT_PACKAGE_INCOMPLETE"
  | "EVIDENCE_RESULT_FAILED"
  | "TARGET_PATH_INVALID"
  | "PROJECT_ID_MISMATCH"
  | "GATE_REQUIRED_DELIVERABLE_MISSING"
  | "MANIFEST_STAGE_DRIFT";

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
