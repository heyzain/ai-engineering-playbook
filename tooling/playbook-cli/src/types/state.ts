import type { StageNumber, StageName, ApprovalMode } from "../constants.js";

export type LifecycleStatus = "active" | "completed_terminal" | "reopened_maintenance" | "paused";
export type StageStatus = "not_started" | "in_progress" | "blocked" | "pending_review" | "approved";
export type DeliverableStatus = "not_started" | "in_progress" | "completed" | "verified" | "waived" | "blocked";
export type ValidationStatus = "unvalidated" | "passed" | "failed" | "waived";

export interface EvidenceRecord {
  requirement_id: string | null;
  type:
    | "automated_test"
    | "build_typecheck"
    | "static_analysis"
    | "schema_validation"
    | "security_audit"
    | "manual_functional"
    | "visual_review"
    | "accessibility_audit"
    | "architecture_review"
    | string;
  procedure: string;
  result: "passed" | "failed" | "inconclusive";
  summary: string;
  exit_code: number | null;
  commit_sha?: string | null;
  evidence_hash?: string | null;
  evidence_ref: string;
  verified_at: string;
  verified_by: string;
  actor_type: "agent" | "human";
}

export interface Deliverable {
  id: string;
  name: string;
  description?: string;
  artifact_path: string;
  status: DeliverableStatus;
  validation_status: ValidationStatus;
  exception_ref: string | null;
  evidence: EvidenceRecord[];
}

export interface RFCRecord {
  rfc_id: string;
  title: string;
  path: string;
  status: "pending_decision" | "resolved" | "rejected";
  is_blocking: boolean;
  resolved_at?: string | null;
  decision_summary?: string | null;
}

export interface ADRRecord {
  adr_id: string;
  title: string;
  path: string;
  status: "proposed" | "accepted" | "superseded" | "rejected";
  approved_at?: string | null;
}

export interface ExceptionRecord {
  exception_id: string;
  title: string;
  path: string;
  waived_requirement: string;
  authorized_by: string;
  authorized_at: string;
  expiration_date: string;
  status: "active" | "remediated" | "expired" | "revoked";
}

export interface ExitPackage {
  status: "not_drafted" | "drafted" | "submitted_for_review";
  path: string;
  submitted_at?: string | null;
}

export interface HumanApproval {
  status: "not_requested" | "pending_review" | "approved" | "rejected";
  approved_by: string | null;
  role: string | null;
  approval_mode: ApprovalMode | null;
  decision: "GATE_APPROVED" | "REJECTED" | null;
  signature_reference: string | null;
  approved_at: string | null;
  conditions: string | null;
}

export interface CurrentStageDetail {
  stage: StageNumber;
  stage_name: StageName;
  started_at: string;
  deliverables: Deliverable[];
  rfcs: RFCRecord[];
  adrs: ADRRecord[];
  exceptions: ExceptionRecord[];
  exit_package: ExitPackage;
  human_approval: HumanApproval;
}

export interface StageHistoryEntry {
  stage: StageNumber;
  stage_name: string;
  status: "approved" | "waived";
  started_at: string;
  completed_at: string;
  approved_at: string;
  exit_package_ref: string;
  human_approval: {
    approved_by: string;
    role: string;
    approval_mode: ApprovalMode;
    signature_reference: string;
  };
}

export interface ArchivedMilestone {
  milestone_id: string;
  milestone_name: string;
  completed_at: string;
  final_stage: StageNumber;
  stage_history: unknown[];
  exit_package_ref: string;
  state_snapshot_ref?: string;
}

export interface StateLastUpdated {
  timestamp: string;
  updated_by: string;
  actor_type: "human" | "agent";
  reason: string;
}

export interface ProjectState {
  $schema: string;
  schema_version: string;
  project_id: string;
  playbook_version: string;
  milestone_id: string;
  milestone_name: string;
  lifecycle_status: LifecycleStatus;
  current_stage: StageNumber;
  stage_status: StageStatus;
  current_stage_detail: CurrentStageDetail;
  stage_history: StageHistoryEntry[];
  archived_milestones: ArchivedMilestone[];
  last_updated: StateLastUpdated;
}
