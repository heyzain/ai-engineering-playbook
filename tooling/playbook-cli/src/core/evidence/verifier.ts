import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCHEMA_VERSION, DEFAULT_PATHS } from "../../constants.js";
import { toPosixPath, normalizeRelativePath } from "../../utils/paths.js";
import type { ProjectState } from "../../types/state.js";
import type { DiagnosticIssue } from "../diagnostics/types.js";
import type {
  EvidenceItemResult,
  EvidenceVerificationReport,
  EvidenceVerificationStatus,
  EvidenceVerificationSummary,
} from "./types.js";

export const CANONICAL_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export const EVIDENCE_LIMITATIONS = [
  "A matching SHA-256 hash verifies integrity against the recorded hash in state.json, but does NOT prove the authenticity of the verification actor or test runner.",
  "A matching SHA-256 hash does NOT establish the engineering correctness, validity, or semantic completeness of the evidence contents.",
  "State and evidence files stored within the same mutable repository do NOT establish an independent trust boundary; an actor with write access to evidence files typically has write access to state.json.",
  "Existence verification confirms only that a referenced file exists on disk; it does NOT establish that requirements were satisfied.",
  "External URLs and network references are unsupported and are not fetched to preserve hermetic, offline-first execution.",
];

export class EvidenceVerifier {
  /**
   * Verifies all evidence records in a project's state.json against the filesystem.
   * Strictly read-only: never modifies state or evidence files on disk.
   */
  public verify(projectDir: string, stateInput?: ProjectState): EvidenceVerificationReport {
    const resolvedProjectDir = path.resolve(projectDir);
    const realProjectDir = fs.existsSync(resolvedProjectDir)
      ? fs.realpathSync(resolvedProjectDir)
      : resolvedProjectDir;

    const timestamp = new Date().toISOString();

    let state: ProjectState | null = stateInput || null;
    const diagnostics: DiagnosticIssue[] = [];

    if (!state) {
      const statePath = path.join(resolvedProjectDir, DEFAULT_PATHS.stateFile);
      if (!fs.existsSync(statePath)) {
        diagnostics.push({
          code: "STATE_MISSING",
          severity: "error",
          message: "Cannot verify evidence: .playbook/state.json is missing.",
          path: ".playbook/state.json",
          remediation: "Restore .playbook/state.json from version control.",
        });

        return this.buildReport({
          timestamp,
          targetDir: resolvedProjectDir,
          milestoneId: null,
          currentStage: null,
          stageName: null,
          summary: this.emptySummary(),
          items: [],
          diagnostics,
        });
      }

      try {
        const rawState = fs.readFileSync(statePath, "utf-8");
        state = JSON.parse(rawState) as ProjectState;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        diagnostics.push({
          code: "STATE_MALFORMED",
          severity: "error",
          message: `Cannot verify evidence: Syntax error in .playbook/state.json: ${errMsg}`,
          path: ".playbook/state.json",
          remediation: "Fix JSON syntax errors in .playbook/state.json.",
        });

        return this.buildReport({
          timestamp,
          targetDir: resolvedProjectDir,
          milestoneId: null,
          currentStage: null,
          stageName: null,
          summary: this.emptySummary(),
          items: [],
          diagnostics,
        });
      }
    }

    const items: EvidenceItemResult[] = [];
    const summary: EvidenceVerificationSummary = this.emptySummary();

    const currentStage = state.current_stage ?? null;
    const stageName = state.current_stage_detail?.stage_name ?? null;
    const milestoneId = state.milestone_id ?? null;

    const deliverables = state.current_stage_detail?.deliverables || [];

    for (const deliv of deliverables) {
      const evidenceList = deliv.evidence || [];
      for (const ev of evidenceList) {
        summary.total++;
        const itemResult = this.verifyEvidenceItem(resolvedProjectDir, realProjectDir, deliv.id, deliv.name, ev);
        items.push(itemResult);

        // Update aggregated summary count
        summary[itemResult.status]++;

        // Produce diagnostic issue for non-passing statuses
        if (itemResult.status === "missing") {
          diagnostics.push({
            code: "EVIDENCE_FILE_MISSING",
            severity: "error",
            message: `Evidence file for deliverable '${deliv.name}' (${deliv.id}) is missing: ${itemResult.evidence_ref}.`,
            path: itemResult.evidence_ref,
            remediation: `Generate the required evidence artifact at ${itemResult.evidence_ref} by re-running verification.`,
          });
        } else if (itemResult.status === "unreadable") {
          diagnostics.push({
            code: "EVIDENCE_UNREADABLE",
            severity: "error",
            message: `Evidence file for deliverable '${deliv.name}' (${deliv.id}) could not be read: ${itemResult.details}.`,
            path: itemResult.evidence_ref,
            remediation: "Ensure the evidence path is a readable file with appropriate filesystem permissions, not a directory.",
          });
        } else if (itemResult.status === "integrity_failed") {
          if (itemResult.details.includes("Malformed evidence_hash")) {
            diagnostics.push({
              code: "EVIDENCE_HASH_MALFORMED",
              severity: "error",
              message: `Evidence hash format invalid for deliverable '${deliv.name}' (${deliv.id}): ${itemResult.details}.`,
              path: itemResult.evidence_ref,
              remediation: "Correct evidence_hash in state.json to match canonical pattern 'sha256:<64 hex characters>'.",
            });
          } else {
            diagnostics.push({
              code: "EVIDENCE_HASH_MISMATCH",
              severity: "error",
              message: `Evidence integrity check failed for deliverable '${deliv.name}' (${deliv.id}): ${itemResult.details}.`,
              path: itemResult.evidence_ref,
              remediation: `Re-run the verification procedure ('${itemResult.procedure}') and record the updated evidence hash.`,
            });
          }
        } else if (itemResult.status === "invalid_reference") {
          diagnostics.push({
            code: "EVIDENCE_PATH_INVALID",
            severity: "error",
            message: `Unsafe or malformed evidence reference in deliverable '${deliv.name}' (${deliv.id}): ${itemResult.details}.`,
            path: itemResult.evidence_ref,
            remediation: "Ensure evidence_ref is a safe, relative path within the project root directory.",
          });
        } else if (itemResult.status === "unsupported") {
          diagnostics.push({
            code: "EVIDENCE_UNSUPPORTED",
            severity: "warning",
            message: `Unsupported evidence reference format in deliverable '${deliv.name}' (${deliv.id}): ${itemResult.details}.`,
            path: itemResult.evidence_ref,
            remediation: "Replace remote or unsupported reference with a local evidence file under .playbook/logs/ or docs/.",
          });
        } else if (itemResult.status === "existence_verified") {
          diagnostics.push({
            code: "EVIDENCE_NO_HASH",
            severity: "info",
            message: `Evidence file exists for deliverable '${deliv.name}' (${deliv.id}) but has no recorded SHA-256 integrity hash.`,
            path: itemResult.evidence_ref,
            remediation: "Record an evidence_hash (sha256:<hex>) in state.json to enable cryptographic integrity verification.",
          });
        }
      }
    }

    return this.buildReport({
      timestamp,
      targetDir: resolvedProjectDir,
      milestoneId,
      currentStage,
      stageName,
      summary,
      items,
      diagnostics,
    });
  }

  private verifyEvidenceItem(
    projectDir: string,
    realProjectDir: string,
    delivId: string,
    delivName: string,
    ev: {
      requirement_id?: string | null;
      type: string;
      procedure: string;
      result: string;
      summary: string;
      evidence_ref: string;
      evidence_hash?: string | null;
    }
  ): EvidenceItemResult {
    const rawRef = ev.evidence_ref ?? "";
    const trimmedRef = rawRef.trim();
    const recordedResult = (ev.result as "passed" | "failed" | "inconclusive") || "inconclusive";
    const rawRecordedHash = ev.evidence_hash !== undefined && ev.evidence_hash !== null ? String(ev.evidence_hash).trim() : null;

    const baseResult: Omit<EvidenceItemResult, "status" | "details" | "resolved_path" | "calculated_hash" | "hash_matched"> = {
      deliverable_id: delivId,
      deliverable_name: delivName,
      requirement_id: ev.requirement_id ?? null,
      type: ev.type,
      procedure: ev.procedure,
      recorded_result: recordedResult,
      evidence_ref: rawRef,
      recorded_hash: rawRecordedHash,
    };

    // 1. Check for empty or malformed reference
    if (!trimmedRef) {
      return {
        ...baseResult,
        status: "invalid_reference",
        resolved_path: null,
        calculated_hash: null,
        hash_matched: null,
        details: "Evidence reference path is empty.",
      };
    }

    if (trimmedRef.includes("\0")) {
      return {
        ...baseResult,
        status: "invalid_reference",
        resolved_path: null,
        calculated_hash: null,
        hash_matched: null,
        details: "Evidence reference contains illegal null bytes.",
      };
    }

    // 2. Check for unsupported remote URIs (e.g. http://, https://)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedRef)) {
      if (trimmedRef.startsWith("http://") || trimmedRef.startsWith("https://")) {
        return {
          ...baseResult,
          status: "unsupported",
          resolved_path: null,
          calculated_hash: null,
          hash_matched: null,
          details: "Remote HTTP/HTTPS evidence references are not fetched to ensure hermetic execution.",
        };
      }
      return {
        ...baseResult,
        status: "unsupported",
        resolved_path: null,
        calculated_hash: null,
        hash_matched: null,
        details: `URI scheme in '${trimmedRef}' is unsupported for local evidence verification.`,
      };
    }

    // 3. Reject Absolute, Drive-Relative, or UNC Paths
    // Evidence references in project state MUST be relative paths
    if (
      path.isAbsolute(trimmedRef) ||
      /^[a-zA-Z]:/i.test(trimmedRef) ||
      /^[/\\]/.test(trimmedRef) ||
      trimmedRef.startsWith("\\\\")
    ) {
      return {
        ...baseResult,
        status: "invalid_reference",
        resolved_path: null,
        calculated_hash: null,
        hash_matched: null,
        details: `Evidence reference must be a relative path within project root; absolute, drive-relative, or UNC paths are disallowed: '${trimmedRef}'.`,
      };
    }

    // 4. Security Boundary & Path Traversal Prevention
    const targetPath = path.resolve(projectDir, trimmedRef);

    // Boundary check: targetPath must resolve inside projectDir
    const relFromRoot = path.relative(projectDir, targetPath);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      return {
        ...baseResult,
        status: "invalid_reference",
        resolved_path: null,
        calculated_hash: null,
        hash_matched: null,
        details: `Path traversal detected: '${trimmedRef}' resolves outside project boundary.`,
      };
    }

    // Symlink and Junction escape check against canonical real project directory
    try {
      if (fs.existsSync(targetPath)) {
        const realTarget = fs.realpathSync(targetPath);
        const realRel = path.relative(realProjectDir, realTarget);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
          return {
            ...baseResult,
            status: "invalid_reference",
            resolved_path: null,
            calculated_hash: null,
            hash_matched: null,
            details: `Symlink traversal detected: '${trimmedRef}' resolves outside project boundary to '${toPosixPath(realTarget)}'.`,
          };
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        status: "unreadable",
        resolved_path: toPosixPath(relFromRoot),
        calculated_hash: null,
        hash_matched: false,
        details: `Filesystem resolution error: ${errMsg}`,
      };
    }

    const posixRelPath = normalizeRelativePath(relFromRoot);

    // 5. File Existence Check
    if (!fs.existsSync(targetPath)) {
      return {
        ...baseResult,
        status: "missing",
        resolved_path: posixRelPath,
        calculated_hash: null,
        hash_matched: null,
        details: `Evidence file does not exist on disk at '${posixRelPath}'.`,
      };
    }

    // 6. Read File and Validate Target Type
    let buffer: Buffer;
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        return {
          ...baseResult,
          status: "unreadable",
          resolved_path: posixRelPath,
          calculated_hash: null,
          hash_matched: false,
          details: `Target at '${posixRelPath}' is a directory, not a verifiable file.`,
        };
      }
      buffer = fs.readFileSync(targetPath);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        status: "unreadable",
        resolved_path: posixRelPath,
        calculated_hash: null,
        hash_matched: false,
        details: `Unable to read evidence file: ${errMsg}`,
      };
    }

    const hexDigest = crypto.createHash("sha256").update(buffer).digest("hex");
    const calculatedHash = `sha256:${hexDigest}`.toLowerCase();

    // 7. Check for Missing Hash
    if (rawRecordedHash === null) {
      return {
        ...baseResult,
        status: "existence_verified",
        resolved_path: posixRelPath,
        calculated_hash: calculatedHash,
        hash_matched: null,
        details: "File exists on disk, but no evidence_hash was recorded in state.json for integrity comparison.",
      };
    }

    // 8. Strict Validation of Recorded Hash Format
    if (!CANONICAL_HASH_PATTERN.test(rawRecordedHash)) {
      return {
        ...baseResult,
        status: "integrity_failed",
        resolved_path: posixRelPath,
        calculated_hash: calculatedHash,
        hash_matched: false,
        details: `Malformed evidence_hash '${rawRecordedHash}'. Must match canonical format 'sha256:[a-f0-9]{64}'.`,
      };
    }

    const normalizedRecordedHash = rawRecordedHash.toLowerCase();
    const matches = calculatedHash === normalizedRecordedHash;

    if (matches) {
      return {
        ...baseResult,
        status: "integrity_passed",
        resolved_path: posixRelPath,
        calculated_hash: calculatedHash,
        hash_matched: true,
        details: "File exists and calculated SHA-256 matches recorded hash.",
      };
    }

    return {
      ...baseResult,
      status: "integrity_failed",
      resolved_path: posixRelPath,
      calculated_hash: calculatedHash,
      hash_matched: false,
      details: `SHA-256 hash mismatch: expected '${normalizedRecordedHash}', calculated '${calculatedHash}'.`,
    };
  }

  private emptySummary(): EvidenceVerificationSummary {
    return {
      total: 0,
      integrity_passed: 0,
      integrity_failed: 0,
      existence_verified: 0,
      unreadable: 0,
      missing: 0,
      invalid_reference: 0,
      unsupported: 0,
      not_checked: 0,
    };
  }

  private buildReport(opts: {
    timestamp: string;
    targetDir: string;
    milestoneId: string | null;
    currentStage: number | null;
    stageName: string | null;
    summary: EvidenceVerificationSummary;
    items: EvidenceItemResult[];
    diagnostics: DiagnosticIssue[];
  }): EvidenceVerificationReport {
    const { summary } = opts;
    const hasFailures =
      summary.missing > 0 ||
      summary.invalid_reference > 0 ||
      summary.integrity_failed > 0 ||
      summary.unreadable > 0;

    return {
      schema_version: SCHEMA_VERSION,
      timestamp: opts.timestamp,
      target_dir: opts.targetDir,
      milestone_id: opts.milestoneId,
      current_stage: opts.currentStage,
      stage_name: opts.stageName,
      summary: opts.summary,
      items: opts.items,
      diagnostics: opts.diagnostics,
      all_passed: !hasFailures,
      limitations: EVIDENCE_LIMITATIONS,
    };
  }
}
