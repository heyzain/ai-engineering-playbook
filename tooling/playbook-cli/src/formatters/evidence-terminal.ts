import type { EvidenceVerificationReport, EvidenceItemResult } from "../core/evidence/types.js";
import type { DiagnosticIssue } from "../core/diagnostics/types.js";

export function formatEvidenceTerminalReport(report: EvidenceVerificationReport): string {
  const lines: string[] = [];
  const divider = "─".repeat(64);

  // Header Banner
  lines.push("");
  lines.push("┌" + "─".repeat(62) + "┐");
  lines.push("│       AI Engineering Playbook — Evidence Verification        │");
  lines.push("└" + "─".repeat(62) + "┘");
  lines.push("");

  lines.push(` Target Directory: ${report.target_dir}`);
  if (report.milestone_id) {
    lines.push(` Milestone:        ${report.milestone_id}`);
  }
  if (report.current_stage !== null) {
    lines.push(` Lifecycle Stage:  Stage ${report.current_stage}${report.stage_name ? ` (${report.stage_name})` : ""}`);
  }
  lines.push("");

  // Summary Breakdown
  const s = report.summary;
  lines.push(divider);
  lines.push(" Evidence Verification Summary");
  lines.push(divider);
  lines.push(`  Total Records Inspected:  ${s.total}`);
  lines.push(`  ✔ Integrity Passed:       ${s.integrity_passed} (File exists, matching SHA-256)`);
  lines.push(`  ℹ Existence Verified:     ${s.existence_verified} (File exists, no hash recorded)`);
  lines.push(`  ✖ Integrity Failed:       ${s.integrity_failed} (Hash mismatch against state.json)`);
  lines.push(`  ✖ Unreadable Files:       ${s.unreadable} (Permission denied, directory, or read error)`);
  lines.push(`  ✖ Missing Files:          ${s.missing} (Referenced file absent on disk)`);
  lines.push(`  ✖ Invalid References:     ${s.invalid_reference} (Traversal, unsafe, or malformed)`);
  lines.push(`  ▲ Unsupported URIs:       ${s.unsupported} (Remote URLs not fetched)`);
  lines.push("");

  // Detailed Evidence Item Records
  if (report.items.length > 0) {
    lines.push(divider);
    lines.push(" Detailed Evidence Records");
    lines.push(divider);

    for (const item of report.items) {
      const badge = getStatusBadge(item);
      lines.push(` ${badge} Deliverable: [${item.deliverable_id}] ${item.deliverable_name}`);
      lines.push(`    Discipline:      ${item.type}`);
      lines.push(`    Recorded Claim:  ${item.recorded_result.toUpperCase()}`);
      lines.push(`    Reference:       ${item.evidence_ref}`);
      if (item.resolved_path) {
        lines.push(`    Resolved Path:   ${item.resolved_path}`);
      }
      if (item.recorded_hash) {
        lines.push(`    Recorded Hash:   ${item.recorded_hash}`);
      }
      if (item.calculated_hash) {
        lines.push(`    Calculated Hash: ${item.calculated_hash}`);
      }
      lines.push(`    Evaluation:      ${item.details}`);
      lines.push("");
    }
  }

  // Diagnostic Findings
  if (report.diagnostics.length > 0) {
    lines.push(divider);
    lines.push(` Diagnostic Findings (${report.diagnostics.length})`);
    lines.push(divider);

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
      lines.push(`  CRITICAL FAILURES (${errors.length}):`);
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

  // Final Overall Assessment & Limitations
  lines.push(divider);
  lines.push(" Final Verification Verdict & Authority Boundaries");
  lines.push(divider);

  if (report.all_passed) {
    lines.push("  Verdict: [EVIDENCE VERIFICATION PASSED]");
    lines.push("  All referenced files exist and passing integrity hashes matched.");
  } else {
    lines.push("  Verdict: [EVIDENCE VERIFICATION FAILED — DEFECTS DETECTED]");
    lines.push("  One or more evidence files are missing, malformed, or have hash mismatches.");
  }
  lines.push("");
  lines.push("  Non-Negotiable Boundaries & Scientific Limitations:");
  for (const lim of report.limitations) {
    lines.push(`   * ${lim}`);
  }
  lines.push(divider);
  lines.push("");

  return lines.join("\n");
}

function getStatusBadge(item: EvidenceItemResult): string {
  switch (item.status) {
    case "integrity_passed":
      return "[PASS: INTEGRITY]";
    case "existence_verified":
      return "[PASS: EXISTENCE]";
    case "integrity_failed":
      return "[FAIL: INTEGRITY MISMATCH]";
    case "unreadable":
      return "[FAIL: UNREADABLE]";
    case "missing":
      return "[FAIL: FILE MISSING]";
    case "invalid_reference":
      return "[FAIL: INVALID PATH]";
    case "unsupported":
      return "[WARN: UNSUPPORTED URI]";
    case "not_checked":
      return "[INFO: NOT CHECKED]";
  }
}
