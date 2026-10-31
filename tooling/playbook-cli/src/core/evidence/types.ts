import type { DiagnosticIssue } from "../diagnostics/types.js";

/**
 * Verification outcome status for an individual evidence item.
 */
export type EvidenceVerificationStatus =
  | "not_checked"
  | "missing"
  | "invalid_reference"
  | "integrity_passed"
  | "integrity_failed"
  | "existence_verified"
  | "unreadable"
  | "unsupported";

/**
 * Detailed verification outcome for a single evidence item.
 */
export interface EvidenceItemResult {
  deliverable_id: string;
  deliverable_name: string;
  requirement_id: string | null;
  type: string;
  procedure: string;
  recorded_result: "passed" | "failed" | "inconclusive";
  evidence_ref: string;
  resolved_path: string | null;
  recorded_hash: string | null;
  calculated_hash: string | null;
  hash_matched: boolean | null;
  status: EvidenceVerificationStatus;
  details: string;
}

/**
 * Aggregated summary of evidence verification outcomes.
 */
export interface EvidenceVerificationSummary {
  total: number;
  integrity_passed: number;
  integrity_failed: number;
  existence_verified: number;
  unreadable: number;
  missing: number;
  invalid_reference: number;
  unsupported: number;
  not_checked: number;
}

/**
 * Complete machine-readable Evidence Verification Report.
 */
export interface EvidenceVerificationReport {
  schema_version: string;
  timestamp: string;
  target_dir: string;
  milestone_id: string | null;
  current_stage: number | null;
  stage_name: string | null;
  summary: EvidenceVerificationSummary;
  items: EvidenceItemResult[];
  diagnostics: DiagnosticIssue[];
  all_passed: boolean;
  limitations: string[];
}
