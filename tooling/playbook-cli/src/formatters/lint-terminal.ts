import type { LintJsonReport, LintJsonFinding } from "./lint-json.js";

const CATEGORY_TITLES: Record<string, string> = {
  documentation: "Category A: Documentation & Reference Consistency",
  schema: "Category B: Project Configuration & Schema Validity",
  invariant: "Category C: Governance Invariants & Process Constraints",
  stack: "Category D: Technology Stack Governance",
  security: "Category E: Security & Workflow Governance",
  unknown: "Other Findings",
};

/**
 * Formats a canonical human-readable terminal report from the lint report.
 */
export function formatLintTerminalReport(report: LintJsonReport, targetDir: string): string {
  const lines: string[] = [];

  lines.push("════════════════════════════════════════════════════════════════");
  lines.push("         AI ENGINEERING PLAYBOOK — GOVERNANCE LINTER           ");
  lines.push("════════════════════════════════════════════════════════════════");
  lines.push(` Target:           ${targetDir}`);
  lines.push(` Execution Time:   ${report.execution.duration_ms} ms`);
  lines.push(` Rules Registered: ${report.summary.rules_total}`);
  lines.push(` Rules Evaluated:  ${report.summary.rules_evaluated} (${report.summary.rules_passed} passed, ${report.summary.rules_failed} failed)`);
  lines.push(` Total Findings:   ${report.summary.findings_total} (${report.summary.blocking_findings} blocking, ${report.summary.warning_findings} warning, ${report.summary.advisory_findings} advisory)`);
  lines.push("────────────────────────────────────────────────────────────────");

  // Report execution aborts or crashes if any
  if (report.execution_failures.length > 0) {
    lines.push("");
    lines.push("✖ EXECUTION FAILURES & TIMEOUTS:");
    for (const failure of report.execution_failures) {
      lines.push(`  - [${failure.ruleId}] ${failure.code || "FAILURE"}: ${failure.error}`);
    }
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push("");
    lines.push("✔ Clean Governance Lint: All evaluated rules passed with zero findings.");
    lines.push("────────────────────────────────────────────────────────────────");
    lines.push(" Verdict: PASSED");
    lines.push("════════════════════════════════════════════════════════════════");
    return lines.join("\n");
  }

  // Group findings by category
  const grouped = new Map<string, LintJsonFinding[]>();
  for (const finding of report.findings) {
    const cat = finding.category || "unknown";
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push(finding);
  }

  for (const [cat, catFindings] of grouped.entries()) {
    const title = CATEGORY_TITLES[cat] || `Category: ${cat}`;
    lines.push("");
    lines.push(`▶ ${title} (${catFindings.length} finding${catFindings.length === 1 ? "" : "s"})`);

    for (const f of catFindings) {
      const locStr = f.file_path
        ? f.line
          ? `${f.file_path}:${f.line}${f.column ? `:${f.column}` : ""}`
          : f.file_path
        : "repository-wide";

      const icon = f.blocks_operation ? "✖ [BLOCKING]" : f.enforcement === "warning" ? "⚠ [WARNING]" : "ℹ [ADVISORY]";
      lines.push(`  ${icon} [${f.rule_id}] ${f.diagnostic_code}`);
      lines.push(`    Severity:    ${f.severity} | Operational Enforcement: ${f.enforcement}`);
      lines.push(`    Location:    ${locStr}`);
      lines.push(`    Message:     ${f.message}`);
      if (f.expected) {
        lines.push(`    Expected:    ${f.expected}`);
      }
      if (f.actual) {
        lines.push(`    Actual:      ${f.actual}`);
      }
      if (f.remediation) {
        lines.push(`    Remediation: ${f.remediation}`);
      }
      lines.push("");
    }
  }

  lines.push("────────────────────────────────────────────────────────────────");
  if (report.status === "passed") {
    lines.push(" Verdict: PASSED (Non-blocking warnings only)");
  } else if (report.status === "incomplete") {
    lines.push(" Verdict: INCOMPLETE (One or more rules timed out or aborted)");
  } else {
    lines.push(` Verdict: FAILED (${report.summary.blocking_findings} blocking violation${report.summary.blocking_findings === 1 ? "" : "s"} detected)`);
  }
  lines.push("════════════════════════════════════════════════════════════════");

  return lines.join("\n");
}
