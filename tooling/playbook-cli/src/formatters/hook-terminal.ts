import type {
  HookStatusReport,
  HookInstallReport,
  HookUninstallReport,
} from "../types/hooks.js";

export function formatHookStatusTerminal(report: HookStatusReport): string {
  const lines: string[] = [];
  lines.push(`================================================================`);
  lines.push(`  PLAYBOOK GIT HOOKS - STATUS REPORT`);
  lines.push(`  Repository Root: ${report.targetDir}`);
  lines.push(`  Hooks Directory: ${report.hooksDir}`);
  lines.push(`  Git Status:      ${report.isGitRepository ? "Git Repository Detected" : "NOT A GIT REPOSITORY"}`);
  lines.push(`================================================================\n`);

  for (const [hookName, hook] of Object.entries(report.hooks)) {
    const symbol =
      hook.wrapperIntegrity === "valid"
        ? "✔"
        : hook.wrapperIntegrity === "modified"
        ? "ℹ"
        : hook.wrapperIntegrity === "corrupt"
        ? "✖"
        : hook.wrapperIntegrity === "unmanaged"
        ? "⚠"
        : "○";

    lines.push(`${symbol} [${hookName.toUpperCase()}]`);
    lines.push(`    Path:               ${hook.effectivePath}`);
    lines.push(`    Wrapper Status:     ${hook.wrapperIntegrity.toUpperCase()}`);
    lines.push(`    Installed:          ${hook.installed ? "Yes (Playbook managed)" : "No"}`);
    lines.push(`    Engine Status:      ${hook.validationStatus === "inert_transitional" ? "INERT (Transitional - checks inactive)" : hook.validationStatus.toUpperCase()}`);
    lines.push(`    Original Backup:    ${hook.originalBackupPresent ? `Present (${hook.originalBackupPath})` : "None"}`);
    if (hook.originalBackupHash) {
      lines.push(`    Backup Hash:        ${hook.originalBackupHash}`);
    }
    lines.push(`    Backup Integrity:   ${hook.backupIntegrity.toUpperCase()}`);

    if (hook.recoveryRequired) {
      lines.push(`    ✖ RECOVERY NEEDED:  ${hook.recoveryReason || "Interrupted or conflicting state"}`);
    }

    if (hook.warnings.length > 0) {
      for (const w of hook.warnings) {
        lines.push(`    ⚠ Warning:          ${w}`);
      }
    }
    lines.push(``);
  }

  lines.push(`----------------------------------------------------------------`);
  lines.push(`Overall Health:    ${report.allHealthy ? "ALL HEALTHY" : "ATTENTION REQUIRED"}`);
  if (report.recoveryNeeded) {
    lines.push(`Recovery Status:   Run "playbook hook install --force" to resolve conflicting state.`);
  }
  lines.push(`================================================================`);

  return lines.join("\n");
}

export function formatHookInstallTerminal(report: HookInstallReport): string {
  const lines: string[] = [];
  lines.push(`================================================================`);
  lines.push(`  PLAYBOOK GIT HOOKS - INSTALLATION REPORT`);
  lines.push(`  Hooks Directory: ${report.hooksDir}`);
  if (report.dryRun) {
    lines.push(`  Mode:            DRY RUN (No filesystem modifications)`);
  }
  lines.push(`================================================================\n`);

  for (const [hookName, res] of Object.entries(report.results)) {
    const symbol = res.success ? "✔" : "✖";
    lines.push(`${symbol} [${hookName.toUpperCase()}] - Action: ${res.action.toUpperCase()}`);
    lines.push(`    Path:            ${res.effectivePath}`);
    if (res.originalBackupPath) {
      lines.push(`    Original Backup: ${res.originalBackupPath}`);
    }
    if (res.userBackupPath) {
      lines.push(`    User Archive:    ${res.userBackupPath}`);
    }
    if (res.warnings.length > 0) {
      for (const w of res.warnings) {
        lines.push(`    ⚠ Warning:       ${w}`);
      }
    }
    lines.push(``);
  }

  lines.push(`================================================================`);
  lines.push(
    report.allSuccess
      ? `✔ Successfully installed Playbook Git hook wrappers.`
      : `✖ Hook installation encountered errors.`
  );
  lines.push(`================================================================`);

  return lines.join("\n");
}

export function formatHookUninstallTerminal(report: HookUninstallReport): string {
  const lines: string[] = [];
  lines.push(`================================================================`);
  lines.push(`  PLAYBOOK GIT HOOKS - UNINSTALLATION REPORT`);
  lines.push(`  Hooks Directory: ${report.hooksDir}`);
  lines.push(`================================================================\n`);

  for (const [hookName, res] of Object.entries(report.results)) {
    const symbol = res.success ? "✔" : "✖";
    lines.push(`${symbol} [${hookName.toUpperCase()}] - Action: ${res.action.toUpperCase()}`);
    lines.push(`    Path:          ${res.effectivePath}`);
    if (res.restoredFrom) {
      lines.push(`    Restored From: ${res.restoredFrom}`);
    }
    if (res.warnings.length > 0) {
      for (const w of res.warnings) {
        lines.push(`    ⚠ Warning:     ${w}`);
      }
    }
    lines.push(``);
  }

  lines.push(`================================================================`);
  lines.push(
    report.allSuccess
      ? `✔ Successfully uninstalled Playbook Git hook wrappers.`
      : `✖ Hook uninstallation encountered errors.`
  );
  lines.push(`================================================================`);

  return lines.join("\n");
}
