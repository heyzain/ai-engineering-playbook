import { SCHEMA_VERSION } from "../../constants.js";
import { SchemaValidator } from "../validator.js";
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
        remediation: "Run 'playbook init' in this directory to initialize project governance.",
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
        remediation: "Restore .playbook/manifest.json or re-run 'playbook init --force' to recreate configuration.",
      });
    }

    if (!raw.stateExists) {
      diagnostics.push({
        code: "STATE_MISSING",
        severity: "error",
        message: "Machine-readable state file (.playbook/state.json) is missing.",
        path: ".playbook/state.json",
        remediation: "Restore .playbook/state.json from version control or re-run 'playbook init --force'.",
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
          message: `Stage pointer mismatch: manifest active_lifecycle_stage is ${manifest.active_lifecycle_stage} but state current_stage is ${state.current_stage}.`,
          path: ".playbook/manifest.json",
          remediation: "Update manifest.active_lifecycle_stage to match active stage in state.json.",
        });
      }
    }

    // 5. Governance Evaluation on State Details
    if (state) {
      // 5.1 Lifecycle status
      if (state.lifecycle_status === "completed_terminal") {
        diagnostics.push({
          code: "LIFECYCLE_COMPLETED_TERMINAL",
          severity: "info",
          message: `Project milestone '${state.milestone_id}' has completed Stage 6 and is sealed in production.`,
          path: "/lifecycle_status",
          remediation: "Lifecycle is terminal. Reopening for new features requires formal REOPEN_LIFECYCLE.",
        });
      } else if (state.lifecycle_status === "paused") {
        diagnostics.push({
          code: "LIFECYCLE_PAUSED",
          severity: "warning",
          message: "Project lifecycle is paused.",
          path: "/lifecycle_status",
          remediation: "Resume active development before performing stage work.",
        });
      }

      // 5.2 Deliverables analysis
      const deliverables = state.current_stage_detail?.deliverables || [];
      deliverablesSummary.total = deliverables.length;

      if (deliverables.length === 0) {
        diagnostics.push({
          code: "DELIVERABLES_EMPTY",
          severity: "warning",
          message: `Current stage (${state.current_stage}) has zero deliverables defined.`,
          path: "/current_stage_detail/deliverables",
          remediation: "Define required deliverables for this stage in state.json.",
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
        const isPastDate = exc.expiration_date < today;
        if (exc.status === "expired" || isPastDate) {
          exceptionsSummary.expired++;
          diagnostics.push({
            code: "EXCEPTION_EXPIRED",
            severity: "error",
            message: `Exception '${exc.title}' (${exc.exception_id}) expired on ${exc.expiration_date}.`,
            path: exc.path,
            remediation: `Remediate the waived requirement (${exc.waived_requirement}) or obtain human renewal of exception.`,
          });
        } else if (exc.status === "revoked") {
          exceptionsSummary.revoked++;
          diagnostics.push({
            code: "EXCEPTION_REVOKED",
            severity: "error",
            message: `Exception '${exc.title}' (${exc.exception_id}) was revoked.`,
            path: exc.path,
            remediation: `Remediate waived requirement or obtain new authorized exception.`,
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
        } else if (exc.status === "remediated") {
          exceptionsSummary.remediated++;
        }
      }

      // 5.5 Stage Review & Approval Status
      if (state.stage_status === "approved") {
        diagnostics.push({
          code: "STAGE_APPROVED",
          severity: "info",
          message: `Stage ${state.current_stage} (${state.current_stage_detail?.stage_name}) is approved by human sign-off (${state.current_stage_detail?.human_approval?.approved_by || 'Human'}).`,
          path: "/stage_status",
          remediation: "Human engineer can proceed to advance the lifecycle stage.",
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
      return {
        status: "approved",
        summary: `Stage ${state.current_stage} (${state.current_stage_detail?.stage_name}) has received formal human approval. Ready to advance.`,
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
