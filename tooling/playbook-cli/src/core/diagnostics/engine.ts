import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION } from "../../constants.js";
import { SchemaValidator } from "../validator.js";
import { evaluatePrdApplicability } from "../prd-applicability.js";
import type {
  InspectionRawData,
  InspectionReport,
  DiagnosticIssue,
  ReadinessStatus,
  DeliverablesSummary,
  RfcsSummary,
  ExceptionsSummary,
  ApprovalSummary,
} from "./types.js";

export class DiagnosticsEngine {
  private validator: SchemaValidator;

  constructor(validator?: SchemaValidator) {
    this.validator = validator || new SchemaValidator();
  }

  public evaluate(raw: InspectionRawData, now: Date = new Date()): InspectionReport {
    const diagnostics: DiagnosticIssue[] = [];
    const timestamp = now.toISOString();
    const today = timestamp.slice(0, 10); // YYYY-MM-DD

    const deliverablesSummary: DeliverablesSummary = {
      total: 0,
      not_started: 0,
      in_progress: 0,
      completed: 0,
      verified: 0,
      waived: 0,
      blocked: 0,
    };

    const rfcsSummary: RfcsSummary = {
      total: 0,
      pending_decision: 0,
      blocking_unresolved: 0,
      resolved: 0,
      rejected: 0,
    };

    const exceptionsSummary: ExceptionsSummary = {
      total: 0,
      active: 0,
      expired: 0,
      revoked: 0,
      remediated: 0,
    };

    // 1. Setup & Presence Evaluation
    if (!raw.manifestExists && !raw.stateExists) {
      diagnostics.push({
        code: "PROJECT_UNINITIALIZED",
        severity: "error",
        message: "Project is not initialized under the AI Engineering Playbook. No .playbook/manifest.json or .playbook/state.json found.",
        path: null,
        remediation: "Run 'playbook init' in this directory to initialize project governance for a new repository, or restore .playbook/ from version control if previously initialized.",
      });

      return this.buildReport({
        timestamp,
        raw,
        initialized: false,
        manifestValid: false,
        stateValid: false,
        deliverablesSummary,
        rfcsSummary,
        exceptionsSummary,
        diagnostics,
        readinessStatus: "blocked",
        readinessSummary: "Project is not initialized under the AI Engineering Playbook.",
      });
    }

    if (!raw.manifestExists) {
      diagnostics.push({
        code: "MANIFEST_MISSING",
        severity: "error",
        message: "Governance manifest (.playbook/manifest.json) is missing.",
        path: ".playbook/manifest.json",
        remediation: "Restore .playbook/manifest.json from version control (e.g. 'git checkout .playbook/manifest.json') or from backup. Re-initialize only if configuring a fresh project.",
      });
    }

    if (!raw.stateExists) {
      diagnostics.push({
        code: "STATE_MISSING",
        severity: "error",
        message: "Machine-readable state file (.playbook/state.json) is missing.",
        path: ".playbook/state.json",
        remediation: "Restore .playbook/state.json from version control (e.g. 'git checkout .playbook/state.json') or from backup. Do not execute destructive re-initialization which would overwrite project history.",
      });
    }

    // 2. Syntax & Parsing Evaluation
    if (raw.manifestParseError) {
      diagnostics.push({
        code: "MANIFEST_MALFORMED",
        severity: "error",
        message: `Syntax error in .playbook/manifest.json: ${raw.manifestParseError}`,
        path: ".playbook/manifest.json",
        remediation: "Fix JSON syntax errors in .playbook/manifest.json.",
      });
    }

    if (raw.stateParseError) {
      diagnostics.push({
        code: "STATE_MALFORMED",
        severity: "error",
        message: `Syntax error in .playbook/state.json: ${raw.stateParseError}`,
        path: ".playbook/state.json",
        remediation: "Fix JSON syntax errors in .playbook/state.json.",
      });
    }

    // 3. Schema Conformance Evaluation
    let manifestValid = false;
    if (raw.manifestParsed) {
      const manifestVal = this.validator.validateManifest(raw.manifestParsed);
      manifestValid = manifestVal.valid;
      if (!manifestValid) {
        diagnostics.push({
          code: "MANIFEST_SCHEMA_INVALID",
          severity: "error",
          message: `Manifest schema validation failed (${manifestVal.errors.length} errors):\n${manifestVal.formattedErrors}`,
          path: ".playbook/manifest.json",
          remediation: "Correct the invalid fields in .playbook/manifest.json according to schemas/project-manifest.schema.json.",
        });
      }
    }

    let stateValid = false;
    if (raw.stateParsed) {
      const stateVal = this.validator.validateState(raw.stateParsed);
      stateValid = stateVal.valid;
      if (!stateValid) {
        diagnostics.push({
          code: "STATE_SCHEMA_INVALID",
          severity: "error",
          message: `State schema validation failed (${stateVal.errors.length} errors):\n${stateVal.formattedErrors}`,
          path: ".playbook/state.json",
          remediation: "Correct the invalid state fields in .playbook/state.json according to schemas/project-state.schema.json.",
        });
      }
    }

    // 4. Milestone & Consistency Invariants
    const manifest = raw.manifestParsed;
    const state = raw.stateParsed;

    if (manifest && state) {
      if (manifest.active_milestone_id !== state.milestone_id) {
        diagnostics.push({
          code: "MILESTONE_MISMATCH",
          severity: "error",
          message: `Active milestone mismatch: manifest specifies '${manifest.active_milestone_id}' but state specifies '${state.milestone_id}'.`,
          path: ".playbook/manifest.json",
          remediation: "Synchronize active_milestone_id in manifest.json with milestone_id in state.json.",
        });
      }

      if (manifest.active_lifecycle_stage !== state.current_stage) {
        diagnostics.push({
          code: "STAGE_MISMATCH",
          severity: "warning",
          message: `Stage pointer mismatch: manifest active_lifecycle_stage is ${manifest.active_lifecycle_stage} but state current_stage is ${state.current_stage}. state.json is the authoritative source of truth for lifecycle execution.`,
          path: ".playbook/manifest.json",
          remediation: "Update manifest.active_lifecycle_stage to match active stage in state.json.",
        });
      }
    }

    // 5. Governance Evaluation on State Details
    if (state) {
      // 5.1 Lifecycle status
      if (state.lifecycle_status === "completed_terminal") {
        if (state.current_stage !== 6 || state.stage_status !== "approved") {
          diagnostics.push({
            code: "LIFECYCLE_STATE_INCONSISTENT",
            severity: "error",
            message: `Lifecycle status is 'completed_terminal' but current stage is Stage ${state.current_stage} ('${state.stage_status}'). Stage 6 approval is required to seal the milestone.`,
            path: "/lifecycle_status",
            remediation: "Correct lifecycle_status or complete Stage 6 gate approval before marking lifecycle terminal.",
          });
        } else {
          diagnostics.push({
            code: "LIFECYCLE_COMPLETED_TERMINAL",
            severity: "info",
            message: `Project milestone '${state.milestone_id}' has completed Stage 6 and is sealed in production.`,
            path: "/lifecycle_status",
            remediation: "Lifecycle is terminal. Reopening for new features requires formal REOPEN_LIFECYCLE.",
          });
        }
      } else if (state.lifecycle_status === "paused") {
        diagnostics.push({
          code: "LIFECYCLE_PAUSED",
          severity: "warning",
          message: "Project lifecycle is paused.",
          path: "/lifecycle_status",
          remediation: "Resume active development before performing stage work.",
        });
      } else if (state.lifecycle_status === "reopened_maintenance") {
        diagnostics.push({
          code: "LIFECYCLE_REOPENED_MAINTENANCE",
          severity: "info",
          message: `Project lifecycle is in maintenance mode for milestone '${state.milestone_id}' (archived milestones: ${state.archived_milestones?.length || 0}).`,
          path: "/lifecycle_status",
          remediation: "Execute maintenance deliverables and advance through stage gates.",
        });

        if (state.current_stage === 1) {
          const prdCorePath = path.resolve(raw.targetDir, "docs/prd/PRD-CORE.md");
          const prdCoreExists = fs.existsSync(prdCorePath);

          if (!prdCoreExists) {
            diagnostics.push({
              code: "PRD_CORE_MISSING",
              severity: "error",
              message: "Inherited foundational Problem Statement 'docs/prd/PRD-CORE.md' is missing from disk.",
              path: "docs/prd/PRD-CORE.md",
              remediation: "Restore PRD-CORE.md or reopen lifecycle at Stage 0 to re-establish the problem baseline.",
            });
          }

          const assessment = evaluatePrdApplicability(raw.targetDir, state.milestone_id, state.current_stage_detail);
          if (assessment.status === "outdated") {
            diagnostics.push({
              code: "PRD_ASSESSMENT_OUTDATED",
              severity: "error",
              message: `Inherited foundational Problem Statement in 'docs/prd/PRD-CORE.md' was assessed as OUTDATED${assessment.reason ? `: ${assessment.reason}` : ""}. Stage 1 progression is BLOCKED. A fundamental domain pivot requires re-opening at Stage 0.`,
              path: assessment.path || "docs/prd/PRD-CORE.md",
              remediation: "Reopen lifecycle at Stage 0 ('playbook reopen --stage 0') to reformulate the core problem statement.",
            });
          } else if (assessment.status === "applicable") {
            diagnostics.push({
              code: "INHERITED_PREREQUISITE_ASSESSMENT",
              severity: "info",
              message: `Inherited foundational Problem Statement 'docs/prd/PRD-CORE.md' assessed as APPLICABLE for milestone '${state.milestone_id}'. Assessment artifact: ${assessment.path}.`,
              path: assessment.path,
              remediation: "Review applicability assessment during Gate 1 human approval.",
            });
          } else if (prdCoreExists) {
            diagnostics.push({
              code: "INHERITED_PREREQUISITE_ASSESSMENT",
              severity: "info",
              message: "Stage 1 maintenance milestone requires assessment of inherited 'docs/prd/PRD-CORE.md' applicability before Gate 1 approval.",
              path: "docs/prd/PRD-CORE.md",
              remediation: "Confirm continued validity in REQ-SPEC or reopen at Stage 0 if problem formulation has changed.",
            });
          }
        }
      }

      // 5.2 Deliverables analysis
      const deliverables = state.current_stage_detail?.deliverables || [];
      deliverablesSummary.total = deliverables.length;
      const isGateReviewOrApproved = state.stage_status === "pending_review" || state.stage_status === "approved";

      if (deliverables.length === 0) {
        diagnostics.push({
          code: "DELIVERABLES_EMPTY",
          severity: isGateReviewOrApproved ? "error" : "warning",
          message: `Current stage (${state.current_stage}) has zero deliverables defined${isGateReviewOrApproved ? ` while in '${state.stage_status}' status` : ""}.`,
          path: "/current_stage_detail/deliverables",
          remediation: isGateReviewOrApproved
            ? "Define and verify required stage deliverables before submitting for review or advancing."
            : "Define required deliverables for this stage in state.json.",
        });
      }

      for (const deliv of deliverables) {
        switch (deliv.status) {
          case "not_started":
            deliverablesSummary.not_started++;
            diagnostics.push({
              code: "DELIVERABLE_INCOMPLETE",
              severity: "warning",
              message: `Deliverable '${deliv.name}' (${deliv.id}) has not been started.`,
              path: deliv.artifact_path,
              remediation: `Author the artifact at ${deliv.artifact_path}.`,
            });
            break;
          case "in_progress":
            deliverablesSummary.in_progress++;
            diagnostics.push({
              code: "DELIVERABLE_INCOMPLETE",
              severity: "warning",
              message: `Deliverable '${deliv.name}' (${deliv.id}) is actively in progress.`,
              path: deliv.artifact_path,
              remediation: `Complete authoring at ${deliv.artifact_path}.`,
            });
            break;
          case "completed":
            deliverablesSummary.completed++;
            diagnostics.push({
              code: "DELIVERABLE_UNVERIFIED",
              severity: "warning",
              message: `Deliverable '${deliv.name}' (${deliv.id}) is completed but not yet verified with passing evidence.`,
              path: deliv.artifact_path,
              remediation: `Execute automated verification checks or manual inspection and record passing evidence.`,
            });
            break;
          case "verified":
            deliverablesSummary.verified++;
            break;
          case "waived":
            deliverablesSummary.waived++;
            diagnostics.push({
              code: "DELIVERABLE_WAIVED",
              severity: "info",
              message: `Deliverable '${deliv.name}' (${deliv.id}) is waived under exception ${deliv.exception_ref || 'unknown'}.`,
              path: deliv.artifact_path,
              remediation: "Ensure compensating controls and residual risks in exception record are actively maintained.",
            });
            break;
          case "blocked":
            deliverablesSummary.blocked++;
            diagnostics.push({
              code: "DELIVERABLE_BLOCKED",
              severity: "error",
              message: `Deliverable '${deliv.name}' (${deliv.id}) is blocked.`,
              path: deliv.artifact_path,
              remediation: "Resolve upstream blockers or missing dependencies preventing deliverable completion.",
            });
            break;
        }
      }

      // Gate Criteria Invariant: A stage in pending_review or approved MUST have all deliverables verified or waived
      const unfinishedCount = deliverablesSummary.not_started + deliverablesSummary.in_progress + deliverablesSummary.completed;
      if (isGateReviewOrApproved && unfinishedCount > 0) {
        diagnostics.push({
          code: "GATE_CRITERIA_UNMET",
          severity: "error",
          message: `Stage ${state.current_stage} is in '${state.stage_status}' status but has ${unfinishedCount} unfinished or unverified deliverable(s). All deliverables must be verified or waived prior to review or approval.`,
          path: "/current_stage_detail/deliverables",
          remediation: "Complete and verify all stage deliverables or obtain authorized waivers before submitting for review or advancing.",
        });
      }

      // 5.3 RFCs analysis
      const rfcs = state.current_stage_detail?.rfcs || [];
      rfcsSummary.total = rfcs.length;

      for (const rfc of rfcs) {
        if (rfc.status === "pending_decision") {
          rfcsSummary.pending_decision++;
          if (rfc.is_blocking) {
            rfcsSummary.blocking_unresolved++;
            diagnostics.push({
              code: "RFC_BLOCKING_UNRESOLVED",
              severity: "error",
              message: `Blocking Clarification Request '${rfc.title}' (${rfc.rfc_id}) is unresolved.`,
              path: rfc.path,
              remediation: `Human engineer must review ${rfc.path} and record formal decision before gate can proceed.`,
            });
          } else {
            diagnostics.push({
              code: "RFC_NON_BLOCKING_PENDING",
              severity: "info",
              message: `Non-blocking RFC '${rfc.title}' (${rfc.rfc_id}) is pending decision.`,
              path: rfc.path,
              remediation: "Address clarification before final stage completion.",
            });
          }
        } else if (rfc.status === "resolved") {
          rfcsSummary.resolved++;
        } else if (rfc.status === "rejected") {
          rfcsSummary.rejected++;
        }
      }

      // 5.4 Exceptions analysis
      const exceptions = state.current_stage_detail?.exceptions || [];
      exceptionsSummary.total = exceptions.length;

      for (const exc of exceptions) {
        // Exception date evaluation is UTC-deterministic and inclusive of the entire expiration day
        const expirationEndOfDayUtc = Date.parse(`${exc.expiration_date}T23:59:59.999Z`);
        const isPastDate = !Number.isNaN(expirationEndOfDayUtc) && now.getTime() > expirationEndOfDayUtc;

        if (exc.status === "remediated") {
          // Remediated exceptions are retired and no longer block progression even if past expiration date
          exceptionsSummary.remediated++;
        } else if (exc.status === "revoked") {
          exceptionsSummary.revoked++;
          diagnostics.push({
            code: "EXCEPTION_REVOKED",
            severity: "error",
            message: `Exception '${exc.title}' (${exc.exception_id}) was revoked.`,
            path: exc.path,
            remediation: `Remediate waived requirement or obtain new authorized exception.`,
          });
        } else if (exc.status === "expired" || (exc.status === "active" && isPastDate)) {
          exceptionsSummary.expired++;
          diagnostics.push({
            code: "EXCEPTION_EXPIRED",
            severity: "error",
            message: `Exception '${exc.title}' (${exc.exception_id}) expired on ${exc.expiration_date}.`,
            path: exc.path,
            remediation: `Remediate the waived requirement (${exc.waived_requirement}) or obtain human renewal of exception.`,
          });
        } else if (exc.status === "active") {
          exceptionsSummary.active++;
          diagnostics.push({
            code: "EXCEPTION_ACTIVE",
            severity: "info",
            message: `Active exception '${exc.title}' (${exc.exception_id}) authorized by ${exc.authorized_by} (TTL: ${exc.expiration_date}).`,
            path: exc.path,
            remediation: "Ensure waived deliverable is remediated before expiration date.",
          });
        }
      }

      // 5.5 Stage Review & Approval Status
      if (state.stage_status === "approved") {
        const isStage6 = state.current_stage === 6;
        diagnostics.push({
          code: "STAGE_APPROVED",
          severity: "info",
          message: `Stage ${state.current_stage} (${state.current_stage_detail?.stage_name}) is approved by human sign-off (${state.current_stage_detail?.human_approval?.approved_by || 'Human'}).`,
          path: "/stage_status",
          remediation: isStage6
            ? "Human engineer can proceed to seal milestone in production (CLOSE_LIFECYCLE)."
            : `Human engineer can proceed to advance the lifecycle stage (ADVANCE_STAGE to Stage ${state.current_stage + 1}).`,
        });
      } else if (state.stage_status === "pending_review") {
        diagnostics.push({
          code: "STAGE_PENDING_REVIEW",
          severity: "info",
          message: `Stage ${state.current_stage} Exit Package is submitted for human review; awaiting human sign-off.`,
          path: state.current_stage_detail?.exit_package?.path || "/exit_package",
          remediation: "Human engineer must review exit package and execute approval.",
        });
      }
    }

    // 6. Readiness Assessment Computation
    const { status, summary } = this.computeReadiness(state, diagnostics, deliverablesSummary);

    return this.buildReport({
      timestamp,
      raw,
      initialized: true,
      manifestValid,
      stateValid,
      deliverablesSummary,
      rfcsSummary,
      exceptionsSummary,
      diagnostics,
      readinessStatus: status,
      readinessSummary: summary,
    });
  }

  private computeReadiness(
    state: InspectionRawData["stateParsed"],
    diagnostics: DiagnosticIssue[],
    deliverablesSummary: DeliverablesSummary
  ): { status: ReadinessStatus; summary: string } {
    const errorIssues = diagnostics.filter((d) => d.severity === "error");

    // 1. Any error severity issue blocks progression
    if (errorIssues.length > 0) {
      return {
        status: "blocked",
        summary: `Stage progression is blocked by ${errorIssues.length} critical governance issue(s): ${errorIssues.map((e) => e.code).join(", ")}.`,
      };
    }

    if (!state) {
      return {
        status: "blocked",
        summary: "State file is missing or invalid.",
      };
    }

    // 2. Terminal lifecycle
    if (state.lifecycle_status === "completed_terminal") {
      return {
        status: "completed_terminal",
        summary: `Milestone '${state.milestone_id}' is terminal and completed in production.`,
      };
    }

    // 3. Approved stage
    if (state.stage_status === "approved") {
      const isStage6 = state.current_stage === 6;
      return {
        status: "approved",
        summary: isStage6
          ? `Stage 6 (${state.current_stage_detail?.stage_name}) has received formal human approval. Ready to seal milestone in production (CLOSE_LIFECYCLE).`
          : `Stage ${state.current_stage} (${state.current_stage_detail?.stage_name}) has received formal human approval. Ready to advance to Stage ${state.current_stage + 1} (ADVANCE_STAGE).`,
      };
    }

    // 4. Pending Review
    if (state.stage_status === "pending_review") {
      return {
        status: "ready_for_human_review",
        summary: `Stage ${state.current_stage} Exit Package is submitted. Awaiting human judgment and sign-off.`,
      };
    }

    // 5. In Progress work analysis
    const totalDeliverables = deliverablesSummary.total;
    const verifiedOrWaived = deliverablesSummary.verified + deliverablesSummary.waived;

    if (totalDeliverables > 0 && verifiedOrWaived === totalDeliverables) {
      const exitPackageStatus = state.current_stage_detail?.exit_package?.status;
      if (exitPackageStatus === "submitted_for_review") {
        return {
          status: "ready_for_human_review",
          summary: `All ${totalDeliverables} stage deliverables verified/waived. Exit Package submitted for human review.`,
        };
      }
      return {
        status: "needs_attention",
        summary: `All ${totalDeliverables} deliverables verified/waived. Ready to compile and submit Stage Exit Package.`,
      };
    }

    const unfinished = deliverablesSummary.not_started + deliverablesSummary.in_progress + deliverablesSummary.completed;
    return {
      status: "needs_attention",
      summary: `Stage ${state.current_stage} has ${unfinished} unfinished/unverified deliverable(s). Active engineering underway.`,
    };
  }

  private buildReport(opts: {
    timestamp: string;
    raw: InspectionRawData;
    initialized: boolean;
    manifestValid: boolean;
    stateValid: boolean;
    deliverablesSummary: DeliverablesSummary;
    rfcsSummary: RfcsSummary;
    exceptionsSummary: ExceptionsSummary;
    diagnostics: DiagnosticIssue[];
    readinessStatus: ReadinessStatus;
    readinessSummary: string;
  }): InspectionReport {
    const { raw, timestamp, initialized, manifestValid, stateValid, diagnostics, readinessStatus, readinessSummary } = opts;
    const manifest = raw.manifestParsed;
    const state = raw.stateParsed;

    const blockers = diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    const warnings = diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);

    let approvalSummary: ApprovalSummary | null = null;
    if (state?.current_stage_detail?.human_approval) {
      const ha = state.current_stage_detail.human_approval;
      approvalSummary = {
        status: ha.status,
        approver: ha.approved_by,
        role: ha.role,
        decision: ha.decision,
        approved_at: ha.approved_at,
        mode: ha.approval_mode,
      };
    }

    return {
      schema_version: SCHEMA_VERSION,
      timestamp,
      target_dir: raw.targetDir,
      initialized,
      manifest_present: raw.manifestExists,
      state_present: raw.stateExists,
      manifest_valid: manifestValid,
      state_valid: stateValid,
      project: manifest
        ? {
            id: manifest.project_id,
            name: manifest.project_name,
            ecosystem: manifest.tech_stack?.ecosystem || "agnostic",
            language: manifest.tech_stack?.primary_language || "agnostic",
            profile: manifest.playbook?.governance_profile || "standard",
            approval_mode: manifest.playbook?.approval_mode || "solo",
          }
        : null,
      milestone: state
        ? {
            id: state.milestone_id,
            name: state.milestone_name,
            lifecycle_status: state.lifecycle_status,
          }
        : null,
      stage: state
        ? {
            number: state.current_stage,
            name: state.current_stage_detail?.stage_name || `Stage ${state.current_stage}`,
            status: state.stage_status,
            started_at: state.current_stage_detail?.started_at || null,
          }
        : null,
      deliverables_summary: opts.deliverablesSummary,
      rfcs_summary: opts.rfcsSummary,
      exceptions_summary: opts.exceptionsSummary,
      approval_summary: approvalSummary,
      readiness: {
        status: readinessStatus,
        summary: readinessSummary,
        blockers,
        warnings,
      },
      diagnostics,
    };
  }
}
