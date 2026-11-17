import {
  type CiStatusResult,
  type CiWorkflowValidationResult,
  type CiInitResult,
} from "../core/ci/types.js";

export function formatCiStatusTerminal(status: CiStatusResult): string {
  const lines: string[] = [];

  lines.push("┌────────────────────────────────────────────────────────────────────────┐");
  lines.push("│ Playbook Remote CI Workflow Status                                     │");
  lines.push("└────────────────────────────────────────────────────────────────────────┘");
  lines.push("");

  const statusBadge =
    status.status === "valid"
      ? "✔ VALID"
      : status.status === "missing"
      ? "✖ NOT INSTALLED"
      : status.status === "modified"
      ? "⚠ USER MODIFIED"
      : status.status === "outdated"
      ? "⚠ OUTDATED"
      : status.status === "unmanaged"
      ? "⚠ UNMANAGED"
      : "✖ INVALID";

  lines.push(`Provider:                ${status.provider}`);
  lines.push(`Workflow File:           ${status.filePath}`);
  lines.push(`Installation Status:     ${statusBadge}`);
  lines.push(`Playbook Managed:        ${status.isPlaybookManaged ? "Yes" : "No"}`);
  if (status.version) {
    lines.push(`Workflow Template Ver:   ${status.version}`);
  }
  lines.push(`Required Status Check:   "${status.requiredCheckName}"`);
  lines.push("");

  if (status.backupFiles.length > 0) {
    lines.push("Preserved User Backups:");
    for (const b of status.backupFiles) {
      lines.push(`  • ${b}`);
    }
    lines.push("");
  }

  if (status.errors.length > 0) {
    lines.push("Validation Errors:");
    for (const err of status.errors) {
      lines.push(`  ✖ ${err}`);
    }
    lines.push("");
  }

  if (status.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warn of status.warnings) {
      lines.push(`  ⚠ ${warn}`);
    }
    lines.push("");
  }

  lines.push("Administrative Guidance:");
  lines.push(`  1. In GitHub repo settings, configure Branch Protection / Rulesets for main/master.`);
  lines.push(`  2. Mark "${status.requiredCheckName}" as a required status check before merging.`);
  lines.push(`  3. Enable "Require branches to be up to date before merging".`);

  return lines.join("\n");
}

export function formatCiValidationTerminal(res: CiWorkflowValidationResult): string {
  const lines: string[] = [];

  lines.push("┌────────────────────────────────────────────────────────────────────────┐");
  lines.push("│ Playbook Remote CI Workflow Validation                                │");
  lines.push("└────────────────────────────────────────────────────────────────────────┘");
  lines.push("");
  lines.push(`Provider:        ${res.provider}`);
  lines.push(`Target File:     ${res.filePath}`);
  lines.push(`Overall Status:  ${res.valid ? "✔ PASS" : "✖ FAIL"}`);
  lines.push(`Managed:         ${res.isPlaybookManaged ? "Yes" : "No"}`);
  if (res.version) {
    lines.push(`Template Ver:    ${res.version}`);
  }
  lines.push(`Required Check:  "${res.requiredCheckName || "Playbook / Quality Gates"}"`);
  lines.push("");

  if (res.errors.length > 0) {
    lines.push(`Errors (${res.errors.length}):`);
    for (const err of res.errors) {
      lines.push(`  ✖ ${err}`);
    }
    lines.push("");
  }

  if (res.warnings.length > 0) {
    lines.push(`Warnings (${res.warnings.length}):`);
    for (const warn of res.warnings) {
      lines.push(`  ⚠ ${warn}`);
    }
    lines.push("");
  }

  if (res.valid) {
    lines.push("✔ Workflow conforms strictly to Playbook security and execution standards.");
  } else {
    lines.push("✖ Workflow fails Playbook validation. Resolve the errors above or run with --force to reinitialize.");
  }

  return lines.join("\n");
}

export function formatCiInitTerminal(res: CiInitResult): string {
  const lines: string[] = [];

  lines.push("┌────────────────────────────────────────────────────────────────────────┐");
  lines.push("│ Playbook Remote CI Workflow Initialization                             │");
  lines.push("└────────────────────────────────────────────────────────────────────────┘");
  lines.push("");
  lines.push(`Provider:        ${res.provider}`);
  lines.push(`Workflow File:   ${res.filePath}`);
  lines.push(`Action Taken:    ${res.action}`);
  lines.push(`Status:          ${res.success ? "✔ SUCCESS" : "✖ FAILED"}`);
  lines.push("");
  lines.push(res.message);

  if (res.backupCreated && res.backupPath) {
    lines.push("");
    lines.push(`Backup Archive:  ${res.backupPath}`);
  }

  if (res.warnings.length > 0) {
    lines.push("");
    for (const warn of res.warnings) {
      lines.push(warn);
    }
  }

  return lines.join("\n");
}
