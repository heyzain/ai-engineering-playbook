/**
 * Type definitions and error structures for Git lifecycle hook management.
 */

export type HookType = "pre-commit" | "pre-push";

export const TARGET_HOOKS: readonly HookType[] = ["pre-commit", "pre-push"] as const;

export const HOOK_MARKERS = {
  start: "# >>> AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT) >>>",
  end: "# <<< AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT) <<<",
  legacyStart: "# >>> AI ENGINEERING PLAYBOOK HOOK (MANAGED BLOCK - DO NOT EDIT) >>>",
  legacyEnd: "# <<< AI ENGINEERING PLAYBOOK HOOK (MANAGED BLOCK - DO NOT EDIT) <<<",
} as const;

export const ORIGINAL_HOOK_SUFFIX = ".playbook-orig";
export const USER_BACKUP_SUFFIX = ".user-backup";

export type HookWrapperIntegrity =
  | "valid"
  | "modified"
  | "corrupt"
  | "unmanaged"
  | "missing";

export type HookBackupIntegrity =
  | "verified"
  | "missing"
  | "conflict"
  | "not_applicable";

export type HookValidationStatus = "active" | "inert_transitional" | "inactive";

export interface SingleHookStatus {
  hookName: HookType;
  effectivePath: string;
  installed: boolean;
  wrapperIntegrity: HookWrapperIntegrity;
  originalBackupPresent: boolean;
  originalBackupPath: string | null;
  originalBackupHash: string | null;
  backupIntegrity: HookBackupIntegrity;
  validationStatus: HookValidationStatus;
  isInert: boolean;
  recoveryRequired: boolean;
  recoveryReason: string | null;
  warnings: string[];
}

export interface HookStatusReport {
  targetDir: string;
  hooksDir: string;
  isGitRepository: boolean;
  hooks: Record<HookType, SingleHookStatus>;
  allHealthy: boolean;
  recoveryNeeded: boolean;
}

export interface HookInstallOptions {
  cwd?: string;
  hooksDir?: string;
  dryRun?: boolean;
  force?: boolean;
  allowInert?: boolean;
}

export interface SingleHookInstallResult {
  hookName: HookType;
  action: "created" | "wrapped" | "updated" | "skipped_up_to_date" | "recovered_and_updated" | "dry_run";
  effectivePath: string;
  originalBackupPath: string | null;
  userBackupPath: string | null;
  success: boolean;
  warnings: string[];
}

export interface HookInstallReport {
  targetDir: string;
  hooksDir: string;
  dryRun: boolean;
  results: Record<HookType, SingleHookInstallResult>;
  allSuccess: boolean;
}

export interface HookUninstallOptions {
  cwd?: string;
  hooksDir?: string;
  force?: boolean;
}

export interface SingleHookUninstallResult {
  hookName: HookType;
  action: "restored_original" | "unlinked_wrapper" | "excised_managed_block" | "skipped_not_installed";
  effectivePath: string;
  restoredFrom: string | null;
  success: boolean;
  warnings: string[];
}

export interface HookUninstallReport {
  targetDir: string;
  hooksDir: string;
  results: Record<HookType, SingleHookUninstallResult>;
  allSuccess: boolean;
}

export interface HookRunOptions {
  cwd?: string;
  hookType: string;
  args?: string[];
  stdin?: string;
  allowInert?: boolean;
}

export interface HookRunResult {
  success: boolean;
  exitCode: number;
  message?: string;
}

export class HookError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "HookError";
    this.code = code;
    this.details = details;
  }
}
