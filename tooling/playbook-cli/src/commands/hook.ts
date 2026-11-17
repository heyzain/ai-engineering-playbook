import { GitHookManager } from "../core/hooks/hook-manager.js";
import {
  type HookInstallOptions,
  type HookUninstallOptions,
  type HookRunOptions,
  type HookStatusReport,
  type HookInstallReport,
  type HookUninstallReport,
  HookError,
} from "../types/hooks.js";
import {
  formatHookStatusTerminal,
  formatHookInstallTerminal,
  formatHookUninstallTerminal,
} from "../formatters/hook-terminal.js";

export interface HookCommandBaseOptions {
  cwd?: string;
  hooksDir?: string;
  json?: boolean;
}

export function runHookStatus(
  options: HookCommandBaseOptions = {}
): { success: boolean; exitCode: number; data?: HookStatusReport; error?: string } {
  try {
    const manager = new GitHookManager({
      cwd: options.cwd,
      hooksDir: options.hooksDir,
    });
    const report = manager.status();

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHookStatusTerminal(report));
    }

    const exitCode = report.allHealthy ? 0 : 1;
    return { success: report.allHealthy, exitCode, data: report };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof HookError ? err.code : "HOOK_STATUS_FAILED";

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message }, null, 2));
    } else {
      console.error(`\n✖ Hook Status Error [${code}]: ${message}`);
    }
    return { success: false, exitCode: 1, error: code };
  }
}

export function runHookInstall(
  options: HookInstallOptions & HookCommandBaseOptions = {}
): { success: boolean; exitCode: number; data?: HookInstallReport; error?: string } {
  try {
    const manager = new GitHookManager({
      cwd: options.cwd,
      hooksDir: options.hooksDir,
    });
    const report = manager.install({
      cwd: options.cwd,
      hooksDir: options.hooksDir,
      dryRun: options.dryRun,
      force: options.force,
      allowInert: options.allowInert,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHookInstallTerminal(report));
    }

    return { success: report.allSuccess, exitCode: report.allSuccess ? 0 : 1, data: report };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof HookError ? err.code : "HOOK_INSTALL_FAILED";

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message }, null, 2));
    } else {
      console.error(`\n✖ Hook Installation Error [${code}]: ${message}`);
    }
    return { success: false, exitCode: 1, error: code };
  }
}

export function runHookUninstall(
  options: HookUninstallOptions & HookCommandBaseOptions = {}
): { success: boolean; exitCode: number; data?: HookUninstallReport; error?: string } {
  try {
    const manager = new GitHookManager({
      cwd: options.cwd,
      hooksDir: options.hooksDir,
    });
    const report = manager.uninstall({
      cwd: options.cwd,
      hooksDir: options.hooksDir,
      force: options.force,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHookUninstallTerminal(report));
    }

    return { success: report.allSuccess, exitCode: report.allSuccess ? 0 : 1, data: report };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof HookError ? err.code : "HOOK_UNINSTALL_FAILED";

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message }, null, 2));
    } else {
      console.error(`\n✖ Hook Uninstallation Error [${code}]: ${message}`);
    }
    return { success: false, exitCode: 1, error: code };
  }
}

export async function runHookRun(
  options: HookRunOptions
): Promise<{ success: boolean; exitCode: number; message?: string }> {
  const manager = new GitHookManager({ cwd: options.cwd });
  const result = await manager.run(options);

  if (!result.success && result.message) {
    console.error(`[playbook hook] ${result.message}`);
  }

  return result;
}
