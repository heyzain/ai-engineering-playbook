import type {
  QualityGateRunReport,
  QualityGateVerifyReport,
  QualityGatesConfig,
} from "../types/quality-gates.js";

export function formatGateListTerminal(config: QualityGatesConfig, stageFilter?: number): string {
  const lines: string[] = [];
  lines.push(`================================================================`);
  lines.push(`  PLAYBOOK QUALITY GATES - CONFIGURATION CATALOG`);
  lines.push(`  Project ID: ${config.project_id} | Default Profile: ${config.default_profile}`);
  lines.push(`================================================================`);

  const gates =
    stageFilter !== undefined
      ? config.gates.filter((g) => g.stage === stageFilter)
      : config.gates;

  if (gates.length === 0) {
    lines.push(`No quality gates configured${stageFilter !== undefined ? ` for stage ${stageFilter}` : ""}.`);
    return lines.join("\n");
  }

  for (const gate of gates) {
    lines.push(`\n[Stage ${gate.stage}: ${gate.stage_name}] (${gate.checks.length} check${gate.checks.length === 1 ? "" : "s"})`);
    lines.push(`----------------------------------------------------------------`);
    for (const check of gate.checks) {
      const deps = check.depends_on && check.depends_on.length > 0 ? ` (depends on: ${check.depends_on.join(", ")})` : "";
      const sev = check.severity || "blocking";
      lines.push(`  • [${check.id}] ${check.name} [${check.type}] [${sev}]${deps}`);
      lines.push(`    Command: ${check.command} ${check.args.join(" ")}`);
      lines.push(`    Deliverable: ${check.deliverable_id}`);
    }
  }

  lines.push(`\n================================================================`);
  return lines.join("\n");
}

export function formatGateRunTerminal(report: QualityGateRunReport): string {
  const lines: string[] = [];
  lines.push(`================================================================`);
  lines.push(`  PLAYBOOK QUALITY GATES - EXECUTION REPORT`);
  lines.push(`  Stage ${report.stage}: ${report.stage_name} | Profile: ${report.profile}`);
  lines.push(`  Working Tree: ${report.working_tree_clean ? "clean" : "dirty"}`);
  lines.push(`================================================================\n`);

  for (const check of report.checks) {
    const symbol = check.outcome === "passed" ? "✔" : check.outcome === "skipped" ? "⚠" : "✖";
    lines.push(`${symbol} [${check.check_id}] ${check.name} (${check.outcome.toUpperCase()}, ${check.duration_ms}ms)`);
    lines.push(`    Command:     ${check.command} ${check.args.join(" ")}`);
    lines.push(`    Deliverable: ${check.deliverable_id} [${check.severity}]`);
    lines.push(`    RIF:         ${check.rif || "N/A"}`);
    if (check.canonical_log_path) {
      lines.push(`    Log:         ${check.canonical_log_path}`);
      lines.push(`    Hash:        ${check.canonical_log_sha256}`);
    }
    if (check.error_message) {
      lines.push(`    Error:       ${check.error_message}`);
    }
    lines.push("");
  }

  lines.push(`----------------------------------------------------------------`);
  lines.push(
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed (${report.summary.warning} warning), ${report.summary.skipped} skipped [Total: ${report.summary.total} in ${report.summary.duration_ms}ms]`
  );
  lines.push(
    `Overall Outcome: ${report.overall_outcome.toUpperCase()}`
  );
  lines.push(`================================================================`);

  return lines.join("\n");
}

export function formatGateVerifyTerminal(report: QualityGateVerifyReport): string {
  const lines: string[] = [];
  lines.push(`================================================================`);
  lines.push(`  PLAYBOOK QUALITY GATES - READ-ONLY VERIFICATION`);
  lines.push(`  Stage ${report.stage}: ${report.stage_name}`);
  lines.push(`================================================================\n`);

  for (const check of report.checks) {
    const symbol = check.is_fresh ? "✔" : "✖";
    const statusStr = check.is_fresh ? "FRESH & VERIFIED" : "STALE / UNVERIFIED";
    lines.push(`${symbol} [${check.check_id}] ${statusStr}`);
    lines.push(`    Deliverable: ${check.deliverable_id}`);
    lines.push(`    Current RIF: ${check.current_rif}`);
    lines.push(`    Stored RIF:  ${check.recorded_rif || "none"}`);
    lines.push(`    Log File:    ${check.log_exists ? "exists" : "missing"} (hash match: ${check.log_hash_matched})`);
    if (check.reason) {
      lines.push(`    Notice:      ${check.reason}`);
    }
    lines.push("");
  }

  lines.push(`----------------------------------------------------------------`);
  if (report.pending_recovery) {
    lines.push(`  NOTICE: Pending WAL journal detected (.playbook/tx-journal.json).`);
    lines.push(`          Read-only verification does not perform recovery.`);
    lines.push(`----------------------------------------------------------------`);
  }
  lines.push(`Status: ${report.all_fresh ? "ALL CHECKS FRESH" : "STALE OR INCOMPLETE EVIDENCE DETECTED"}`);
  lines.push(`================================================================`);

  return lines.join("\n");
}
