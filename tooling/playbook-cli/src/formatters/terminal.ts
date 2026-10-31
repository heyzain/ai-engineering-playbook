import type { InspectionReport, DiagnosticIssue } from "../core/diagnostics/types.js";

export function formatTerminalReport(report: InspectionReport): string {
  const lines: string[] = [];
  const divider = "─".repeat(60);

  // Header Banner
  lines.push("");
  lines.push("┌" + "─".repeat(58) + "┐");
  lines.push("│       AI Engineering Playbook — Project Inspection       │");
  lines.push("└" + "─".repeat(58) + "┘");
  lines.push("");

  // Target & Initialization State
  lines.push(` Target Directory: ${report.target_dir}`);
  lines.push(` Initialized:      ${report.initialized ? "YES" : "NO (Missing governance files)"}`);
  lines.push(` Manifest File:    ${report.manifest_present ? (report.manifest_valid ? "VALID" : "INVALID SCHEMA") : "MISSING"}`);
  lines.push(` State File:       ${report.state_present ? (report.state_valid ? "VALID" : "INVALID SCHEMA") : "MISSING"}`);
  lines.push("");

  if (!report.initialized) {
    lines.push(divider);
    lines.push(" [!] UNINITIALIZED GOVERNANCE STATE");
    lines.push(" This repository is not yet initialized under the AI Engineering Playbook.");
    lines.push(" To bootstrap standard directories, manifest, and Stage 0 baseline, run:");
    lines.push("");
    lines.push("    playbook init");
    lines.push(divider);
    lines.push("");
    return lines.join("\n");
  }

  // Project Identity Section
  if (report.project) {
    lines.push(divider);
    lines.push(" Project Identity & Standards");
    lines.push(divider);
    lines.push(`  ID / Name:        ${report.project.id} — ${report.project.name}`);
    lines.push(`  Tech Stack:       ${report.project.ecosystem} (${report.project.language})`);
    lines.push(`  Governance Profile: ${report.project.profile.toUpperCase()} profile`);
    lines.push(`  Approval Mode:    ${report.project.approval_mode.toUpperCase()} mode`);
    lines.push("");
  }

  // Milestone & Lifecycle Section
  if (report.milestone) {
    lines.push(divider);
    lines.push(" Milestone & Lifecycle Status");
    lines.push(divider);
    lines.push(`  Active Milestone: ${report.milestone.id} ("${report.milestone.name}")`);
    lines.push(`  Lifecycle Status: ${report.milestone.lifecycle_status.toUpperCase()}`);
    lines.push("");
  }

  // Active Stage & Progress Section
  if (report.stage) {
    lines.push(divider);
    lines.push(" Active Lifecycle Stage");
    lines.push(divider);
    lines.push(`  Current Stage:    Stage ${report.stage.number}: ${report.stage.name}`);
    lines.push(`  Stage Status:     ${report.stage.status.toUpperCase()}`);
    if (report.stage.started_at) {
      lines.push(`  Stage Started At: ${report.stage.started_at}`);
    }
    lines.push("");

    // Deliverables breakdown
    const ds = report.deliverables_summary;
    lines.push("  Deliverables Breakdown:");
    lines.push(`    Total Configured: ${ds.total}`);
    lines.push(`    - Verified:       ${ds.verified}`);
    lines.push(`    - Waived:         ${ds.waived}`);
    lines.push(`    - Completed:      ${ds.completed} (unverified)`);
    lines.push(`    - In Progress:    ${ds.in_progress}`);
    lines.push(`    - Not Started:    ${ds.not_started}`);
    lines.push(`    - Blocked:        ${ds.blocked}`);
    lines.push("");
  }

  // RFCs Summary
  const rs = report.rfcs_summary;
  if (rs.total > 0) {
    lines.push(divider);
    lines.push(" Clarification Requests (RFCs)");
    lines.push(divider);
    lines.push(`  Total RFCs:       ${rs.total}`);
    lines.push(`  - Blocking Open:  ${rs.blocking_unresolved}`);
    lines.push(`  - Pending Review: ${rs.pending_decision}`);
    lines.push(`  - Resolved:       ${rs.resolved}`);
    lines.push(`  - Rejected:       ${rs.rejected}`);
    lines.push("");
  }

  // Exceptions Summary
  const es = report.exceptions_summary;
  if (es.total > 0) {
    lines.push(divider);
    lines.push(" Governance Exceptions");
    lines.push(divider);
    lines.push(`  Total Exceptions: ${es.total}`);
    lines.push(`  - Active:         ${es.active}`);
    lines.push(`  - Expired:        ${es.expired}`);
    lines.push(`  - Revoked:        ${es.revoked}`);
    lines.push(`  - Remediated:     ${es.remediated}`);
    lines.push("");
  }

  // Approvals & Sign-off Section
  if (report.approval_summary) {
    lines.push(divider);
    lines.push(" Gate Review & Human Approval");
    lines.push(divider);
    lines.push(`  Approval Status:  ${report.approval_summary.status.toUpperCase()}`);
    if (report.approval_summary.approver) {
      lines.push(`  Reviewer:         ${report.approval_summary.approver} (${report.approval_summary.role || 'Unspecified Role'})`);
    }
    if (report.approval_summary.decision) {
      lines.push(`  Decision:         ${report.approval_summary.decision}`);
    }
    if (report.approval_summary.approved_at) {
      lines.push(`  Approved At:      ${report.approval_summary.approved_at}`);
    }
    lines.push("");
  }

  // Diagnostics Findings
  lines.push(divider);
  lines.push(` Diagnostic Findings (${report.diagnostics.length} issue${report.diagnostics.length === 1 ? "" : "s"})`);
  lines.push(divider);

  if (report.diagnostics.length === 0) {
    lines.push("  ✓ Zero governance issues or warnings detected.");
  } else {
    const errors = report.diagnostics.filter((d) => d.severity === "error");
    const warnings = report.diagnostics.filter((d) => d.severity === "warning");
    const infos = report.diagnostics.filter((d) => d.severity === "info");

    const renderIssue = (issue: DiagnosticIssue, prefix: string) => {
      lines.push(`  ${prefix} [${issue.code}] ${issue.message}`);
      if (issue.path) {
        lines.push(`     Target:      ${issue.path}`);
      }
      lines.push(`     Remediation: ${issue.remediation}`);
      lines.push("");
    };

    if (errors.length > 0) {
      lines.push(`  CRITICAL BLOCKERS (${errors.length}):`);
      for (const err of errors) {
        renderIssue(err, "✖");
      }
    }

    if (warnings.length > 0) {
      lines.push(`  WARNINGS (${warnings.length}):`);
      for (const warn of warnings) {
        renderIssue(warn, "▲");
      }
    }

    if (infos.length > 0) {
      lines.push(`  INFORMATIONAL (${infos.length}):`);
      for (const info of infos) {
        renderIssue(info, "ℹ");
      }
    }
  }

  // Preliminary Readiness Assessment
  lines.push(divider);
  lines.push(" Preliminary Readiness Assessment");
  lines.push(divider);

  let readinessBadge = "";
  switch (report.readiness.status) {
    case "blocked":
      readinessBadge = "[BLOCKED — HALT PROGRESSION]";
      break;
    case "needs_attention":
      readinessBadge = "[NEEDS ATTENTION — WORK IN PROGRESS]";
      break;
    case "ready_for_human_review":
      readinessBadge = "[READY FOR HUMAN REVIEW]";
      break;
    case "approved":
      readinessBadge = "[STAGE APPROVED — READY TO ADVANCE]";
      break;
    case "completed_terminal":
      readinessBadge = "[MILESTONE SEALED — COMPLETED TERMINAL]";
      break;
  }

  lines.push(`  Readiness: ${readinessBadge}`);
  lines.push(`  Summary:   ${report.readiness.summary}`);
  lines.push("");
  lines.push("  * Notice: This is a read-only diagnostic assessment, not a state transition.");
  lines.push("    Only an authorized human engineer may sign off on stage gate transitions.");
  lines.push(divider);
  lines.push("");

  return lines.join("\n");
}
