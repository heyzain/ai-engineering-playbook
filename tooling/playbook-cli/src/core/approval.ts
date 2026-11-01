import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_PATHS, type ApprovalMode, type StageNumber } from "../constants.js";
import { SchemaValidator } from "./validator.js";
import { getStageBaselineDeliverables } from "./stage-defaults.js";
import { evaluatePrdApplicability } from "./prd-applicability.js";
import {
  WriteAheadTransactionManager,
  TransactionError,
  validateCanonicalPath,
  computeFileSha256,
  safeUnlink,
} from "./transaction/index.js";
import { buildApprovalFingerprintSidecar } from "./fingerprint.js";
import type { ProjectState, Deliverable } from "../types/state.js";
import type { ProjectManifest } from "../types/manifest.js";
import type { DiagnosticIssue } from "./diagnostics/types.js";

const FORBIDDEN_SUBSTRINGS = [
  "agent",
  "bot",
  "controller",
  "playbook",
  "orchestrator",
  "copilot",
  "chatgpt",
  "gemini",
  "antigravity",
  "cursor",
];

/**
 * Checks whether an actor name contains forbidden agent keywords or patterns.
 */
export function isForbiddenAgentName(name: string): boolean {
  if (!name || typeof name !== "string" || name.trim().length === 0) return true;
  const lower = name.toLowerCase();
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  if (/\b(ai|llm|gpt|claude)\b/i.test(lower)) {
    return true;
  }
  return false;
}

export interface ExitPackageValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates the markdown structural completeness of a Stage Gate Exit Package
 * against canonical template requirements (sections, headings, placeholder absence).
 */
export function validateExitPackageStructure(
  content: string,
  gate: number
): ExitPackageValidationResult {
  const errors: string[] = [];

  // Minimum size check (must be at least 200 bytes)
  if (Buffer.byteLength(content, "utf-8") < 200) {
    errors.push(`Exit package is too short (${Buffer.byteLength(content, "utf-8")} bytes; minimum 200 bytes required).`);
  }

  // 1. Top-level Title (# Stage Gate Exit Package or # Stage Gate [0-6] Exit Package)
  if (!/^#\s+.*(?:Stage\s+Gate.*Exit\s+Package|Exit\s+Package)/im.test(content)) {
    errors.push("Missing top-level header: '# Stage Gate Exit Package' (or equivalent).");
  }

  // 2. Identification or Summary section
  if (
    !/^##\s+(?:\d+\.\s+)?(?:Package\s+&\s+Stage\s+Identification|Stage\s+Objectives|Executive\s+Summary)/im.test(
      content
    )
  ) {
    errors.push("Missing required section: '## 1. Package & Stage Identification' (or 'Executive Summary').");
  }

  // 3. Deliverables Manifest section
  if (
    !/^##\s+(?:\d+\.\s+)?(?:Deliverables\s+Manifest|Stage\s+Deliverables|Deliverables(?:\s+and\s+Traceability|\s+Manifest\s+&\s+Status)?)/im.test(
      content
    )
  ) {
    errors.push("Missing required section: '## 2. Deliverables Manifest & Status' (or 'Deliverables').");
  }

  // 4. Validation Evidence section
  if (
    !/^##\s+(?:\d+\.\s+)?(?:Verifiable\s+Validation\s+Evidence|Validation\s+Evidence|Evidence)/im.test(
      content
    )
  ) {
    errors.push("Missing required section: '## 3. Verifiable Validation Evidence' (or 'Evidence').");
  }

  // 5. Traceability Matrix or Sign-off section
  if (
    !/^##\s+(?:\d+\.\s+)?(?:Traceability(?:\s+Matrix)?|Human\s+Gate\s+Sign-Off|Sign-Off|Residual\s+Risk)/im.test(
      content
    )
  ) {
    errors.push("Missing required section: '## 4. Traceability & Sign-Off Record' (or 'Sign-Off').");
  }

  // 6. Check for unresolved template placeholders
  // Matches <!-- TODO ..., [TODO..., [INSERT..., [PLACEHOLDER...
  const placeholderRegex = /(?:<!--\s*TODO\b|\[TODO\b|\[INSERT\s+|\[PLACEHOLDER\b|<!--\s*REPLACE\b)/i;
  if (placeholderRegex.test(content)) {
    errors.push("Exit package contains unresolved template placeholders (e.g. 'TODO', 'INSERT', 'PLACEHOLDER').");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface GateEligibilityResult {
  eligible: boolean;
  diagnostics: DiagnosticIssue[];
  state?: ProjectState;
  manifest?: ProjectManifest;
}

/**
 * Evaluates 100% of the gate approval eligibility preconditions per Section 3.1.
 */
export function checkGateEligibility(
  targetDir: string,
  requestedGate: number,
  options?: { now?: Date; validator?: SchemaValidator }
): GateEligibilityResult {
  const diagnostics: DiagnosticIssue[] = [];
  const now = options?.now || new Date();
  const today = now.toISOString().slice(0, 10);
  const validator = options?.validator || new SchemaValidator();

  const manifestPath = path.resolve(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
    diagnostics.push({
      code: "PROJECT_UNINITIALIZED",
      severity: "error",
      message: "Manifest or state file is missing from .playbook/.",
      path: !fs.existsSync(manifestPath) ? DEFAULT_PATHS.manifestFile : DEFAULT_PATHS.stateFile,
      remediation: "Ensure the project is initialized under the AI Engineering Playbook.",
    });
    return { eligible: false, diagnostics };
  }

  let rawManifest: unknown;
  let rawState: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err: unknown) {
    diagnostics.push({
      code: "MANIFEST_MALFORMED",
      severity: "error",
      message: `Manifest JSON syntax error: ${err instanceof Error ? err.message : String(err)}`,
      path: DEFAULT_PATHS.manifestFile,
      remediation: "Fix JSON syntax errors in .playbook/manifest.json.",
    });
    return { eligible: false, diagnostics };
  }

  try {
    rawState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (err: unknown) {
    diagnostics.push({
      code: "STATE_MALFORMED",
      severity: "error",
      message: `State JSON syntax error: ${err instanceof Error ? err.message : String(err)}`,
      path: DEFAULT_PATHS.stateFile,
      remediation: "Fix JSON syntax errors in .playbook/state.json.",
    });
    return { eligible: false, diagnostics };
  }

  const manifestVal = validator.validateManifest(rawManifest);
  if (!manifestVal.valid) {
    diagnostics.push({
      code: "MANIFEST_SCHEMA_INVALID",
      severity: "error",
      message: `Manifest schema violation: ${manifestVal.errors.map((e) => e.message).join("; ")}`,
      path: DEFAULT_PATHS.manifestFile,
      remediation: "Fix manifest schema errors.",
    });
  }

  const stateVal = validator.validateState(rawState);
  if (!stateVal.valid) {
    diagnostics.push({
      code: "STATE_SCHEMA_INVALID",
      severity: "error",
      message: `State schema violation: ${stateVal.errors.map((e) => e.message).join("; ")}`,
      path: DEFAULT_PATHS.stateFile,
      remediation: "Fix state schema errors.",
    });
  }

  if (diagnostics.length > 0) {
    return { eligible: false, diagnostics };
  }

  const manifest = rawManifest as ProjectManifest;
  const state = rawState as ProjectState;

  // Consistency checks
  if (manifest.project_id !== state.project_id) {
    diagnostics.push({
      code: "PROJECT_ID_MISMATCH",
      severity: "error",
      message: `Project ID mismatch: manifest has "${manifest.project_id}", state has "${state.project_id}".`,
      path: DEFAULT_PATHS.manifestFile,
      remediation: "Align project IDs across manifest and state.",
    });
  }

  if (manifest.active_milestone_id !== state.milestone_id) {
    diagnostics.push({
      code: "MILESTONE_MISMATCH",
      severity: "error",
      message: `Milestone mismatch: manifest has "${manifest.active_milestone_id}", state has "${state.milestone_id}".`,
      path: DEFAULT_PATHS.manifestFile,
      remediation: "Synchronize active milestone ID between manifest and state.",
    });
  }

  if (manifest.active_lifecycle_stage !== state.current_stage) {
    diagnostics.push({
      code: "MANIFEST_STAGE_DRIFT",
      severity: "error",
      message: `Manifest stage drift: manifest has active_lifecycle_stage ${manifest.active_lifecycle_stage}, but authoritative state is at stage ${state.current_stage}.`,
      path: DEFAULT_PATHS.manifestFile,
      remediation: "Synchronize manifest active_lifecycle_stage with state.current_stage.",
    });
  }

  if (requestedGate !== state.current_stage) {
    diagnostics.push({
      code: "GATE_MISMATCH",
      severity: "error",
      message: `Requested approval for Gate ${requestedGate}, but current authoritative lifecycle stage is ${state.current_stage}.`,
      path: DEFAULT_PATHS.stateFile,
      remediation: `Run approval for active Gate ${state.current_stage}.`,
    });
  }

  if (state.stage_status === "approved") {
    diagnostics.push({
      code: "STAGE_ALREADY_APPROVED",
      severity: "error",
      message: `Stage ${state.current_stage} has already been approved. Run 'playbook advance' to proceed.`,
      path: DEFAULT_PATHS.stateFile,
      remediation: "Run 'playbook advance' to advance to the next lifecycle stage.",
    });
  }

  // Inherited Prerequisite Check: In Stage 1 maintenance, docs/prd/PRD-CORE.md must exist on disk
  if (state.lifecycle_status === "reopened_maintenance" && requestedGate === 1) {
    const prdCorePath = path.resolve(targetDir, "docs/prd/PRD-CORE.md");
    if (!fs.existsSync(prdCorePath)) {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message:
          "Inherited foundational Problem Statement 'docs/prd/PRD-CORE.md' is missing from disk. Maintenance requirements cannot proceed without a valid problem baseline. Reopen at Stage 0 to re-establish PRD Core.",
        path: "docs/prd/PRD-CORE.md",
        remediation: "Restore docs/prd/PRD-CORE.md or execute 'playbook reopen --stage 0'.",
      });
    }

    // Explicit Applicability Assessment Check
    const assessment = evaluatePrdApplicability(targetDir, state.milestone_id, state.current_stage_detail);
    if (assessment.status === "missing") {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: `Inherited PRD applicability assessment is missing for milestone '${state.milestone_id}'. In reopened maintenance mode, Gate 1 requires an explicit assessment confirming whether 'docs/prd/PRD-CORE.md' remains applicable.`,
        path: "docs/prd/REQUIREMENTS-SPEC.md",
        remediation: `Record an applicability assessment in docs/prd/REQUIREMENTS-SPEC.md or docs/prd/PRD-CORE-ASSESSMENT.md bound to milestone '${state.milestone_id}' declaring 'Applicability: APPLICABLE' with supporting justification.`,
      });
    } else if (assessment.status === "milestone_missing") {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: `Inherited PRD applicability assessment at '${assessment.path}' is missing active milestone binding (must declare 'Milestone: ${state.milestone_id}').`,
        path: assessment.path || "docs/prd/REQUIREMENTS-SPEC.md",
        remediation: `Update assessment in '${assessment.path}' with 'Milestone: ${state.milestone_id}'.`,
      });
    } else if (assessment.status === "milestone_mismatch") {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: `Inherited PRD applicability assessment at '${assessment.path}' is bound to milestone '${assessment.milestoneId}', which does not match active milestone '${state.milestone_id}'. Historical assessments cannot authorize a new maintenance milestone.`,
        path: assessment.path || "docs/prd/REQUIREMENTS-SPEC.md",
        remediation: `Author a fresh assessment bound to active milestone '${state.milestone_id}'.`,
      });
    } else if (assessment.status === "outdated") {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: `Inherited foundational Problem Statement in 'docs/prd/PRD-CORE.md' is marked OUTDATED for milestone '${state.milestone_id}'${assessment.reason ? `: ${assessment.reason}` : ""}. Stage 1 progression is BLOCKED. A fundamental domain pivot requires problem reformulation.`,
        path: assessment.path || "docs/prd/PRD-CORE.md",
        remediation: "Reopen lifecycle at Stage 0 to reformulate the core problem statement.",
      });
    } else if (assessment.status === "ambiguous") {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: `Inherited PRD applicability assessment at '${assessment.path}' lacks an explicit determination (must declare 'Applicability: APPLICABLE' or 'Applicability: OUTDATED').`,
        path: assessment.path || "docs/prd/REQUIREMENTS-SPEC.md",
        remediation: "Update the assessment document with an explicit 'Applicability: APPLICABLE' or 'Applicability: OUTDATED' determination.",
      });
    }
  }

  // Gate 0 Negative Byte-Match Guardrail: In Stage 0, docs/prd/PRD-CORE.md must not match any archived outdated PRD hash for this milestone
  if (requestedGate === 0) {
    const prdCorePath = path.resolve(targetDir, "docs/prd/PRD-CORE.md");
    if (fs.existsSync(prdCorePath)) {
      const activePrdHash = computeFileSha256(prdCorePath);
      if (activePrdHash) {
        const outdatedHashes = new Set<string>();
        for (const p of state.pivots || []) {
          if (p.milestone_id === state.milestone_id && p.source_prd_sha256) {
            outdatedHashes.add(p.source_prd_sha256.toLowerCase());
          }
        }

        const docsPivotsDir = path.resolve(targetDir, DEFAULT_PATHS.docsPivotsDir);
        if (fs.existsSync(docsPivotsDir)) {
          try {
            const files = fs.readdirSync(docsPivotsDir);
            const escapedMilestone = state.milestone_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const pvtRegex = new RegExp(`^PVT-${escapedMilestone}-[0-9]{3,}\\.md$`);
            for (const f of files) {
              if (pvtRegex.test(f)) {
                try {
                  const pvtContent = fs.readFileSync(path.join(docsPivotsDir, f), "utf-8");
                  const m = pvtContent.match(/\*\*Source PRD Hash\*\*:\s*`?(sha256:[a-f0-9]{64})`?/i);
                  if (m) {
                    outdatedHashes.add(m[1].toLowerCase());
                  }
                } catch {
                  // Ignore read errors
                }
              }
            }
          } catch {
            // Ignore dir read errors
          }
        }

        if (outdatedHashes.has(activePrdHash.toLowerCase())) {
          diagnostics.push({
            code: "PRD_CONTENT_UNALTERED",
            severity: "error",
            message: `Active 'docs/prd/PRD-CORE.md' has identical raw-byte SHA-256 hash (${activePrdHash}) to an outdated Problem Statement archived during a prior stage pivot for milestone '${state.milestone_id}'. Stage 0 requires authoring a fresh problem statement; reusing the outdated document is prohibited.`,
            path: "docs/prd/PRD-CORE.md",
            remediation: "Draft a fresh problem statement addressing the new problem domain.",
          });
        }
      }
    }
  }

  // 1. Mandatory Baseline Deliverables Enforcement
  if (requestedGate >= 0 && requestedGate <= 6) {
    const baselineDeliverables = getStageBaselineDeliverables(requestedGate as StageNumber);
    const declaredDeliverables = state.current_stage_detail?.deliverables || [];
    const declaredMap = new Map<string, Deliverable>();
    for (const d of declaredDeliverables) {
      declaredMap.set(d.id, d);
    }

    for (const baseDeliv of baselineDeliverables) {
      if (!declaredMap.has(baseDeliv.id)) {
        diagnostics.push({
          code: "GATE_REQUIRED_DELIVERABLE_MISSING",
          severity: "error",
          message: `Missing mandatory baseline deliverable "${baseDeliv.id}" (${baseDeliv.name}) for Stage ${requestedGate}.`,
          path: DEFAULT_PATHS.stateFile,
          remediation: `Declare mandatory deliverable "${baseDeliv.id}" in current_stage_detail.deliverables and verify it.`,
        });
      }
    }
  }

  // Deliverables completeness & verification
  const deliverables = state.current_stage_detail?.deliverables || [];
  if (deliverables.length === 0) {
    diagnostics.push({
      code: "GATE_CRITERIA_UNMET",
      severity: "error",
      message: `Stage ${state.current_stage} defines zero deliverables.`,
      path: DEFAULT_PATHS.stateFile,
      remediation: "Add mandatory deliverables for this stage.",
    });
  }

  for (const deliv of deliverables) {
    if (deliv.status !== "verified" && deliv.status !== "waived") {
      diagnostics.push({
        code: "GATE_CRITERIA_UNMET",
        severity: "error",
        message: `Deliverable "${deliv.id}" is in status "${deliv.status}". All deliverables must be "verified" or "waived" before gate approval.`,
        path: DEFAULT_PATHS.stateFile,
        remediation: `Verify deliverable "${deliv.id}" or obtain an authorized exception waiver.`,
      });
    }

    if (deliv.status === "verified") {
      if (deliv.validation_status !== "passed" || !Array.isArray(deliv.evidence) || deliv.evidence.length === 0) {
        diagnostics.push({
          code: "DELIVERABLE_UNVERIFIED",
          severity: "error",
          message: `Verified deliverable "${deliv.id}" lacks passed validation status or supporting evidence.`,
          path: DEFAULT_PATHS.stateFile,
          remediation: `Attach passing verification evidence to deliverable "${deliv.id}".`,
        });
      }

      // Check evidence items
      for (const ev of deliv.evidence || []) {
        if (ev.result !== "passed") {
          diagnostics.push({
            code: "EVIDENCE_RESULT_FAILED",
            severity: "error",
            message: `Evidence record for deliverable "${deliv.id}" recorded non-passing result "${ev.result}".`,
            path: DEFAULT_PATHS.stateFile,
            remediation: "Ensure all supporting evidence records report 'passed'.",
          });
        }

        // Automated disciplines require evidence_hash
        const isAutomated = [
          "automated_test",
          "build_typecheck",
          "static_analysis",
          "schema_validation",
          "security_audit",
        ].includes(ev.type);

        if (isAutomated && (!ev.evidence_hash || !/^sha256:[a-f0-9]{64}$/i.test(ev.evidence_hash))) {
          diagnostics.push({
            code: "EVIDENCE_HASH_MISMATCH",
            severity: "error",
            message: `Automated evidence for deliverable "${deliv.id}" requires a valid sha256 evidence_hash.`,
            path: DEFAULT_PATHS.stateFile,
            remediation: "Provide a valid SHA-256 evidence hash for automated disciplines.",
          });
        }

        // Verify evidence file presence on disk
        try {
          const { absolutePath: absEvidence } = validateCanonicalPath(targetDir, ev.evidence_ref);
          if (!fs.existsSync(absEvidence)) {
            diagnostics.push({
              code: "EVIDENCE_FILE_MISSING",
              severity: "error",
              message: `Evidence file for deliverable "${deliv.id}" does not exist on disk: "${ev.evidence_ref}".`,
              path: ev.evidence_ref,
              remediation: `Ensure evidence file exists at "${ev.evidence_ref}".`,
            });
          } else if (ev.evidence_hash) {
            const calculatedHash = computeFileSha256(absEvidence);
            if (calculatedHash?.toLowerCase() !== ev.evidence_hash.toLowerCase()) {
              diagnostics.push({
                code: "EVIDENCE_HASH_MISMATCH",
                severity: "error",
                message: `Evidence file "${ev.evidence_ref}" hash mismatch (expected ${ev.evidence_hash}, calculated ${calculatedHash}).`,
                path: ev.evidence_ref,
                remediation: "Update recorded evidence_hash or re-generate evidence artifact.",
              });
            }
          }
        } catch (err: unknown) {
          diagnostics.push({
            code: "TARGET_PATH_INVALID",
            severity: "error",
            message: `Evidence path is invalid or escapes project root: "${ev.evidence_ref}". Reason: ${
              err instanceof Error ? err.message : String(err)
            }`,
            path: ev.evidence_ref,
            remediation: "Ensure evidence path is strictly relative and contained within project root.",
          });
        }
      }
    }

    if (deliv.status === "waived") {
      if (!deliv.exception_ref || typeof deliv.exception_ref !== "string") {
        diagnostics.push({
          code: "GATE_CRITERIA_UNMET",
          severity: "error",
          message: `Waived deliverable "${deliv.id}" is missing a valid exception_ref.`,
          path: DEFAULT_PATHS.stateFile,
          remediation: "Attach an authorized exception record reference to waived deliverables.",
        });
      } else {
        const exc = (state.current_stage_detail?.exceptions || []).find(
          (e) => e.exception_id === deliv.exception_ref
        );
        if (!exc || exc.status !== "active") {
          diagnostics.push({
            code: "EXCEPTION_EXPIRED",
            severity: "error",
            message: `Waived deliverable "${deliv.id}" references inactive or missing exception "${deliv.exception_ref}".`,
            path: DEFAULT_PATHS.stateFile,
            remediation: "Ensure referenced exception is active and authorized.",
          });
        }
      }
    }
  }

  // RFC checks: no unresolved blocking RFCs
  for (const rfc of state.current_stage_detail?.rfcs || []) {
    if (rfc.is_blocking && rfc.status === "pending_decision") {
      diagnostics.push({
        code: "RFC_BLOCKING_UNRESOLVED",
        severity: "error",
        message: `Unresolved blocking RFC exists: "${rfc.rfc_id}" (${rfc.title}).`,
        path: rfc.path,
        remediation: `Resolve blocking RFC "${rfc.rfc_id}" before requesting gate approval.`,
      });
    }
  }

  // Exception expiration check
  for (const exc of state.current_stage_detail?.exceptions || []) {
    if (exc.status === "expired" || exc.status === "revoked") {
      diagnostics.push({
        code: "EXCEPTION_EXPIRED",
        severity: "error",
        message: `Exception "${exc.exception_id}" is ${exc.status}.`,
        path: exc.path,
        remediation: `Renew exception "${exc.exception_id}" or satisfy the requirement.`,
      });
    } else if (exc.status === "active" && exc.expiration_date < today) {
      diagnostics.push({
        code: "EXCEPTION_EXPIRED",
        severity: "error",
        message: `Active exception "${exc.exception_id}" expired on ${exc.expiration_date} (current UTC date: ${today}).`,
        path: exc.path,
        remediation: `Renew expired exception "${exc.exception_id}".`,
      });
    }
  }

  // Exit package verification
  const exitPackage = state.current_stage_detail?.exit_package;
  if (!exitPackage || !exitPackage.path || exitPackage.path.trim().length === 0) {
    diagnostics.push({
      code: "EXIT_PACKAGE_INCOMPLETE",
      severity: "error",
      message: "Stage exit package path is missing in state.json.",
      path: DEFAULT_PATHS.stateFile,
      remediation: "Specify stage exit package path.",
    });
  } else {
    try {
      const { absolutePath: absExitPkg } = validateCanonicalPath(targetDir, exitPackage.path);
      if (!fs.existsSync(absExitPkg)) {
        diagnostics.push({
          code: "EXIT_PACKAGE_INCOMPLETE",
          severity: "error",
          message: `Stage Gate Exit Package artifact does not exist on disk: "${exitPackage.path}".`,
          path: exitPackage.path,
          remediation: `Author and compile Stage Exit Package at "${exitPackage.path}".`,
        });
      } else {
        let content = "";
        try {
          content = fs.readFileSync(absExitPkg, "utf-8");
        } catch (err: unknown) {
          diagnostics.push({
            code: "EXIT_PACKAGE_INCOMPLETE",
            severity: "error",
            message: `Failed to read Stage Gate Exit Package at "${exitPackage.path}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            path: exitPackage.path,
            remediation: "Ensure the exit package file exists and has read permissions.",
          });
        }

        if (content) {
          const structResult = validateExitPackageStructure(content, requestedGate);
          if (!structResult.valid) {
            for (const err of structResult.errors) {
              diagnostics.push({
                code: "EXIT_PACKAGE_INCOMPLETE",
                severity: "error",
                message: `Stage Gate Exit Package at "${exitPackage.path}" validation failed: ${err}`,
                path: exitPackage.path,
                remediation: "Complete all required template sections and resolve placeholders in the exit package.",
              });
            }
          }
        }
      }
    } catch (err: unknown) {
      diagnostics.push({
        code: "TARGET_PATH_INVALID",
        severity: "error",
        message: `Exit package path is invalid: "${exitPackage.path}".`,
        path: exitPackage.path,
        remediation: "Ensure exit package path is contained within project root.",
      });
    }
  }

  const eligible = diagnostics.length === 0;
  return { eligible, diagnostics, state, manifest };
}

export interface ApproveGateOptions {
  gate: number;
  reviewerName: string;
  role: string;
  approvalMode?: ApprovalMode;
  signatureReference?: string;
  conditions?: string;
  confirmationPhrase: string;
  isTTY?: boolean;
  now?: Date;
  lockTimeoutMs?: number;
  txManager?: WriteAheadTransactionManager;
}

export interface ApproveGateResult {
  success: boolean;
  txId?: string;
  fingerprint?: string;
  error?: string;
  diagnostic?: DiagnosticIssue;
}

/**
 * Executes the human gate approval workflow under a unified WAL transaction.
 */
export async function approveGate(
  targetDir: string,
  options: ApproveGateOptions
): Promise<ApproveGateResult> {
  const isInteractive =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  // Safeguard 1: Interactive TTY enforcement
  if (!isInteractive) {
    throw new TransactionError(
      "TTY_REQUIRED",
      "Gate approval requires an interactive terminal session. Automated, scripted, or piped approval invocations are strictly prohibited."
    );
  }

  // Safeguard 2: Agent self-approval prohibition
  if (isForbiddenAgentName(options.reviewerName)) {
    throw new TransactionError(
      "AGENT_APPROVAL_PROHIBITED",
      `Reviewer identity "${options.reviewerName}" matches an AI agent or automated process identifier. AI agents are strictly forbidden from approving quality gates.`
    );
  }

  // Safeguard 3: Exact confirmation phrase guard
  const expectedPhrase = `CONFIRM APPROVAL GATE ${options.gate}`;
  if (options.confirmationPhrase !== expectedPhrase) {
    return {
      success: false,
      error: `Confirmation phrase mismatch. Expected exactly "${expectedPhrase}", got "${options.confirmationPhrase}". Gate approval aborted.`,
    };
  }

  // Eligibility evaluation
  const eligibility = checkGateEligibility(targetDir, options.gate, { now: options.now });
  if (!eligibility.eligible || !eligibility.state || !eligibility.manifest) {
    const firstDiag = eligibility.diagnostics[0];
    throw new TransactionError(
      (firstDiag?.code as any) || "GATE_CRITERIA_UNMET",
      firstDiag?.message || "Gate approval eligibility criteria not met.",
      { diagnostics: eligibility.diagnostics }
    );
  }

  const state = eligibility.state;
  const now = options.now || new Date();
  const isoTimestamp = now.toISOString();

  const approvalMode: ApprovalMode =
    options.approvalMode || state.current_stage_detail?.human_approval?.approval_mode || "solo";
  const signatureRef =
    options.signatureReference || `Interactive CLI Session ${crypto.randomUUID()}`;

  // State mutations for approval
  const newState: ProjectState = JSON.parse(JSON.stringify(state));
  newState.stage_status = "approved";
  newState.current_stage_detail.exit_package.status = "submitted_for_review";
  newState.current_stage_detail.human_approval = {
    status: "approved",
    approved_by: options.reviewerName.trim(),
    role: options.role.trim(),
    approval_mode: approvalMode,
    decision: "GATE_APPROVED",
    signature_reference: signatureRef,
    approved_at: isoTimestamp,
    conditions: options.conditions ? options.conditions.trim() : null,
  };
  newState.last_updated = {
    timestamp: isoTimestamp,
    updated_by: `human:${options.reviewerName.trim()}`,
    actor_type: "human",
    reason: `Human gate approval granted for Stage ${options.gate} (${newState.current_stage_detail.stage_name}).`,
  };

  // Build approval fingerprint sidecar
  const { sidecar, fingerprint } = buildApprovalFingerprintSidecar(targetDir, newState, {
    approvedBy: options.reviewerName.trim(),
    role: options.role.trim(),
    signatureReference: signatureRef,
    approvedAt: isoTimestamp,
  });

  const txManager =
    options.txManager ||
    new WriteAheadTransactionManager({
      targetDir,
      lockTimeoutMs: options.lockTimeoutMs,
    });

  const statePayload = JSON.stringify(newState, null, 2) + "\n";
  const sidecarPayload = JSON.stringify(sidecar, null, 2) + "\n";

  const txResult = await txManager.executeTransaction("APPROVE_GATE", [
    { targetPath: DEFAULT_PATHS.stateFile, content: statePayload },
    { targetPath: DEFAULT_PATHS.approvalFingerprintFile, content: sidecarPayload },
  ]);

  return {
    success: true,
    txId: txResult.txId,
    fingerprint,
  };
}

export interface RejectGateOptions {
  gate: number;
  reviewerName: string;
  role: string;
  approvalMode?: ApprovalMode;
  signatureReference?: string;
  conditions: string;
  isTTY?: boolean;
  now?: Date;
  lockTimeoutMs?: number;
  txManager?: WriteAheadTransactionManager;
}

export interface RejectGateResult {
  success: boolean;
  txId?: string;
  error?: string;
}

/**
 * Executes gate rejection under a unified WAL transaction.
 */
export async function rejectGate(
  targetDir: string,
  options: RejectGateOptions
): Promise<RejectGateResult> {
  const isInteractive =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (!isInteractive) {
    throw new TransactionError(
      "TTY_REQUIRED",
      "Gate rejection requires an interactive terminal session."
    );
  }

  if (isForbiddenAgentName(options.reviewerName)) {
    throw new TransactionError(
      "AGENT_APPROVAL_PROHIBITED",
      "AI agents are strictly forbidden from recording gate decisions."
    );
  }

  if (!options.conditions || options.conditions.trim().length === 0) {
    throw new TransactionError(
      "GATE_CRITERIA_UNMET",
      "Gate rejection requires explicit, mandatory rework conditions."
    );
  }

  const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);
  if (!fs.existsSync(statePath)) {
    throw new TransactionError("PROJECT_UNINITIALIZED", "State file not found.");
  }

  const rawState = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ProjectState;
  if (rawState.current_stage !== options.gate) {
    throw new TransactionError(
      "GATE_MISMATCH",
      `Requested rejection for Gate ${options.gate}, but current stage is ${rawState.current_stage}.`
    );
  }

  const now = options.now || new Date();
  const isoTimestamp = now.toISOString();

  const approvalMode: ApprovalMode =
    options.approvalMode || rawState.current_stage_detail?.human_approval?.approval_mode || "solo";
  const signatureRef =
    options.signatureReference || `Interactive CLI Session ${crypto.randomUUID()}`;

  const newState: ProjectState = JSON.parse(JSON.stringify(rawState));
  newState.stage_status = "in_progress";
  newState.current_stage_detail.exit_package.status = "drafted";
  newState.current_stage_detail.human_approval = {
    status: "rejected",
    approved_by: options.reviewerName.trim(),
    role: options.role.trim(),
    approval_mode: approvalMode,
    decision: "REJECTED",
    signature_reference: signatureRef,
    approved_at: isoTimestamp,
    conditions: options.conditions.trim(),
  };
  newState.last_updated = {
    timestamp: isoTimestamp,
    updated_by: `human:${options.reviewerName.trim()}`,
    actor_type: "human",
    reason: `Human gate review rejected Gate ${options.gate}. Rework required: ${options.conditions.trim()}`,
  };

  const txManager =
    options.txManager ||
    new WriteAheadTransactionManager({
      targetDir,
      lockTimeoutMs: options.lockTimeoutMs,
    });

  const statePayload = JSON.stringify(newState, null, 2) + "\n";

  // When rejecting, remove sidecar if present
  const sidecarPath = path.resolve(targetDir, DEFAULT_PATHS.approvalFingerprintFile);

  const txResult = await txManager.withTransaction("REJECT_GATE", [
    { targetPath: DEFAULT_PATHS.stateFile, content: statePayload },
  ], async () => {
    safeUnlink(sidecarPath);
  });

  return {
    success: true,
    txId: txResult.txId,
  };
}
