import path from "node:path";
import crypto from "node:crypto";
import { computeFileSha256 } from "./transaction/fs-utils.js";
import type { ProjectState } from "../types/state.js";

/**
 * Normalizes a relative path to use forward slashes and trims whitespace.
 */
function normalizeRelativePath(p: string): string {
  return p.trim().replace(/\\/g, "/");
}

/**
 * Serializes a JavaScript value using RFC 8785 JSON Canonicalization Scheme (JCS).
 * Keys are sorted lexicographically by UTF-16 code units; zero whitespace outside string literals.
 */
export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map((item) => canonicalJsonStringify(item === undefined ? null : item)).join(",") + "]";
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs: string[] = [];
  for (const key of sortedKeys) {
    const v = obj[key];
    if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
      pairs.push(JSON.stringify(key) + ":" + canonicalJsonStringify(v));
    }
  }
  return "{" + pairs.join(",") + "}";
}

/**
 * Computes the deterministic canonical projection payload for a given project state
 * and real-time filesystem evidence hashes.
 *
 * Implements canonical rules from Section 3.6 of approval-and-advancement-design.md:
 * 1. Normalizes `stage_status` to `"approved"` for both `pending_review` and `approved`.
 * 2. Excludes volatile timestamps, last_updated, stage_history, manifest properties, and human_approval.
 * 3. Incorporates real-time SHA-256 hashes of referenced local evidence files and exit package.
 * 4. Deterministically sorts deliverables, evidence, exceptions, and RFCs.
 */
export function computeCanonicalProjection(
  targetDir: string,
  state: ProjectState
): Record<string, unknown> {
  const currentStageDetail = state.current_stage_detail;
  if (!currentStageDetail) {
    throw new Error("Cannot compute fingerprint: state.current_stage_detail is missing.");
  }

  // stage_status normalization
  if (state.stage_status !== "pending_review" && state.stage_status !== "approved") {
    throw new Error(
      `Cannot compute approval fingerprint: stage_status "${state.stage_status}" is not reviewable or approved.`
    );
  }
  const normalizedStageStatus = "approved";

  // Deliverables projection (sorted by id ascending)
  const deliverables = (currentStageDetail.deliverables || [])
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((deliv) => {
      // Evidence projection (sorted by evidence_ref ascending, then requirement_id ascending)
      const evidence = (deliv.evidence || [])
        .slice()
        .sort((a, b) => {
          const cmp = a.evidence_ref.localeCompare(b.evidence_ref);
          if (cmp !== 0) return cmp;
          return (a.requirement_id || "").localeCompare(b.requirement_id || "");
        })
        .map((ev) => {
          const cleanRef = normalizeRelativePath(ev.evidence_ref);
          const absPath = path.resolve(targetDir, cleanRef);
          const realTimeHash = computeFileSha256(absPath);

          return {
            requirement_id: ev.requirement_id ?? null,
            type: ev.type,
            procedure: ev.procedure,
            result: ev.result,
            summary: ev.summary,
            exit_code: ev.exit_code ?? null,
            evidence_ref: cleanRef,
            evidence_hash: ev.evidence_hash ? ev.evidence_hash.toLowerCase() : null,
            file_sha256: realTimeHash ? realTimeHash.toLowerCase() : null,
          };
        });

      return {
        id: deliv.id,
        name: deliv.name,
        status: deliv.status,
        validation_status: deliv.validation_status,
        artifact_path: normalizeRelativePath(deliv.artifact_path),
        exception_ref: deliv.exception_ref ?? null,
        evidence,
      };
    });

  // Exceptions projection (sorted by exception_id ascending)
  const exceptions = (currentStageDetail.exceptions || [])
    .slice()
    .sort((a, b) => a.exception_id.localeCompare(b.exception_id))
    .map((exc) => ({
      exception_id: exc.exception_id,
      status: exc.status,
      waived_requirement: exc.waived_requirement,
      expiration_date: exc.expiration_date,
    }));

  // RFCs projection (sorted by rfc_id ascending)
  const rfcs = (currentStageDetail.rfcs || [])
    .slice()
    .sort((a, b) => a.rfc_id.localeCompare(b.rfc_id))
    .map((rfc) => ({
      rfc_id: rfc.rfc_id,
      status: rfc.status,
      is_blocking: Boolean(rfc.is_blocking),
    }));

  // Exit package projection
  const exitPackagePath = currentStageDetail.exit_package?.path
    ? normalizeRelativePath(currentStageDetail.exit_package.path)
    : "";
  const absExitPackagePath = exitPackagePath ? path.resolve(targetDir, exitPackagePath) : "";
  const exitPackageHash = absExitPackagePath ? computeFileSha256(absExitPackagePath) : null;

  return {
    project_id: state.project_id,
    milestone_id: state.milestone_id,
    current_stage: state.current_stage,
    stage_status: normalizedStageStatus,
    deliverables,
    exceptions,
    rfcs,
    exit_package: {
      path: exitPackagePath,
      file_sha256: exitPackageHash ? exitPackageHash.toLowerCase() : null,
    },
  };
}

/**
 * Computes the canonical SHA-256 approval fingerprint digest for a project state.
 * Returns `sha256:<hex>`.
 */
export function computeApprovalFingerprint(targetDir: string, state: ProjectState): string {
  const projection = computeCanonicalProjection(targetDir, state);
  const jcs = canonicalJsonStringify(projection);
  const hash = crypto.createHash("sha256").update(jcs, "utf-8").digest("hex");
  return `sha256:${hash.toLowerCase()}`;
}

/**
 * Data model for `.playbook/approval-fingerprint.json` sidecar artifact.
 */
export interface ApprovalFingerprintSidecar {
  $schema: string;
  schema_version: string;
  algorithm: "sha256";
  project_id: string;
  milestone_id: string;
  gate: number;
  stage_name: string;
  approved_at: string;
  approved_by: string;
  role: string;
  signature_reference: string;
  fingerprint: string;
  payload_digest_inputs: {
    deliverables_count: number;
    verified_deliverables: string[];
    evidence_files: Array<{ path: string; hash: string | null }>;
    exit_package_path: string;
    exit_package_hash: string | null;
  };
}

/**
 * Constructs the approval fingerprint sidecar object.
 */
export function buildApprovalFingerprintSidecar(
  targetDir: string,
  state: ProjectState,
  params: {
    approvedBy: string;
    role: string;
    signatureReference: string;
    approvedAt: string;
  }
): { sidecar: ApprovalFingerprintSidecar; fingerprint: string } {
  const fingerprint = computeApprovalFingerprint(targetDir, state);
  const currentStageDetail = state.current_stage_detail;

  const deliverables = currentStageDetail.deliverables || [];
  const verifiedDeliverables = deliverables
    .filter((d) => d.status === "verified")
    .map((d) => d.id)
    .sort();

  const evidenceFiles: Array<{ path: string; hash: string | null }> = [];
  for (const deliv of deliverables) {
    for (const ev of deliv.evidence || []) {
      const cleanRef = normalizeRelativePath(ev.evidence_ref);
      const absPath = path.resolve(targetDir, cleanRef);
      const h = computeFileSha256(absPath);
      evidenceFiles.push({ path: cleanRef, hash: h ? h.toLowerCase() : null });
    }
  }

  const exitPackagePath = currentStageDetail.exit_package?.path
    ? normalizeRelativePath(currentStageDetail.exit_package.path)
    : "";
  const absExitPackagePath = exitPackagePath ? path.resolve(targetDir, exitPackagePath) : "";
  const exitPackageHash = absExitPackagePath ? computeFileSha256(absExitPackagePath) : null;

  const sidecar: ApprovalFingerprintSidecar = {
    $schema: "https://ai-engineering-playbook.org/schemas/approval-fingerprint.schema.json",
    schema_version: "1.0.0",
    algorithm: "sha256",
    project_id: state.project_id,
    milestone_id: state.milestone_id,
    gate: state.current_stage,
    stage_name: currentStageDetail.stage_name,
    approved_at: params.approvedAt,
    approved_by: params.approvedBy,
    role: params.role,
    signature_reference: params.signatureReference,
    fingerprint,
    payload_digest_inputs: {
      deliverables_count: deliverables.length,
      verified_deliverables: verifiedDeliverables,
      evidence_files: evidenceFiles,
      exit_package_path: exitPackagePath,
      exit_package_hash: exitPackageHash ? exitPackageHash.toLowerCase() : null,
    },
  };

  return { sidecar, fingerprint };
}

/**
 * Verifies that the current authoritative inputs on disk match the recorded fingerprint.
 */
export function verifyFingerprintIntegrity(
  targetDir: string,
  state: ProjectState,
  recordedFingerprint: string
): { isValid: boolean; currentFingerprint: string; reason?: string } {
  let currentFingerprint = "";
  try {
    currentFingerprint = computeApprovalFingerprint(targetDir, state);
  } catch (err: unknown) {
    return {
      isValid: false,
      currentFingerprint: "",
      reason: `Failed to compute current fingerprint: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (currentFingerprint.toLowerCase() !== recordedFingerprint.toLowerCase()) {
    return {
      isValid: false,
      currentFingerprint,
      reason: `Fingerprint mismatch: recorded approval is ${recordedFingerprint}, but current state and disk digests compute to ${currentFingerprint}. Repository has drifted post-approval.`,
    };
  }

  return { isValid: true, currentFingerprint };
}
