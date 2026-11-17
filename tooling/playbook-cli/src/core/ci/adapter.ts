import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  type CiProviderType,
  type CiWorkflowOptions,
  type CiWorkflowValidationResult,
  type CiStatusResult,
  type CiInitResult,
  type CiStatusType,
  type CiAdapter,
  SUPPORTED_CI_PROVIDERS,
  CI_REQUIRED_CHECK_NAME,
  DEFAULT_GITHUB_WORKFLOW_PATH,
  CI_WORKFLOW_MARKERS,
  CiError,
} from "./types.js";
import { GitHubActionsAdapter } from "./adapters/github.js";
import { PLAYBOOK_VERSION } from "../../constants.js";

export type { CiAdapter };

/**
 * Factory returning the adapter for the requested CI provider.
 */
export function getCiAdapter(provider: string = "github"): CiAdapter {
  const normalized = provider.toLowerCase().trim() as CiProviderType;
  if (normalized === "github") {
    return new GitHubActionsAdapter();
  }

  throw new CiError(
    "UNSUPPORTED_PROVIDER",
    `CI provider '${provider}' is not supported. Currently supported providers: ${SUPPORTED_CI_PROVIDERS.join(", ")}`,
    { provider, supported: SUPPORTED_CI_PROVIDERS }
  );
}

/**
 * Resolves the absolute workflow file path for the target provider.
 */
export function resolveWorkflowPath(
  cwd: string,
  provider: CiProviderType = "github",
  customPath?: string
): string {
  if (customPath) {
    return path.isAbsolute(customPath) ? customPath : path.resolve(cwd, customPath);
  }
  const adapter = getCiAdapter(provider);
  return path.resolve(cwd, adapter.defaultWorkflowPath);
}

/**
 * Scans for backup files associated with the target workflow path.
 */
export function findWorkflowBackups(workflowPath: string): string[] {
  const dir = path.dirname(workflowPath);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const baseName = path.basename(workflowPath);
  const prefix = `${baseName}.user-backup.`;

  try {
    const entries = fs.readdirSync(dir);
    return entries
      .filter((file) => file.startsWith(prefix))
      .map((file) => path.join(dir, file))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Cleans up abandoned staging files belonging to dead processes.
 */
export function cleanupAbandonedStaging(dir: string, baseName: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const prefix = `${baseName}.playbook-tmp.`;

  try {
    const entries = fs.readdirSync(dir);
    for (const file of entries) {
      if (!file.startsWith(prefix)) continue;

      const fullPath = path.join(dir, file);
      const parts = file.split(".");
      // format: <baseName>.playbook-tmp.<pid>.<timestamp>
      const pidStr = parts[parts.length - 2];
      const pid = parseInt(pidStr, 10);

      if (Number.isInteger(pid) && pid > 0) {
        let isAlive = true;
        try {
          process.kill(pid, 0);
        } catch {
          isAlive = false;
        }

        if (!isAlive) {
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // Ignore error removing stale staging file
          }
        }
      }
    }
  } catch {
    // Ignore scan errors
  }
}

/**
 * Inspects the current workflow installation and validation state on disk.
 */
export function inspectCiStatus(
  cwd: string,
  options?: { provider?: CiProviderType; filePath?: string }
): CiStatusResult {
  const provider = options?.provider ?? "github";
  const adapter = getCiAdapter(provider);
  const targetPath = resolveWorkflowPath(cwd, provider, options?.filePath);
  const backupFiles = findWorkflowBackups(targetPath);
  const diagnostics: string[] = [];

  diagnostics.push(`Required Status Check in GitHub Rulesets: "${CI_REQUIRED_CHECK_NAME}"`);

  if (!fs.existsSync(targetPath)) {
    return {
      installed: false,
      provider: adapter.provider,
      filePath: targetPath,
      status: "missing",
      isPlaybookManaged: false,
      requiredCheckName: adapter.requiredCheckName,
      errors: [`Workflow file not found at ${targetPath}.`],
      warnings: [],
      backupFiles,
      diagnostics,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(targetPath, "utf-8");
  } catch (err) {
    return {
      installed: true,
      provider: adapter.provider,
      filePath: targetPath,
      status: "invalid",
      isPlaybookManaged: false,
      requiredCheckName: adapter.requiredCheckName,
      errors: [`Failed to read workflow file: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      backupFiles,
      diagnostics,
    };
  }

  const validation = adapter.validateWorkflow(content, targetPath);
  let status: CiStatusType = "valid";

  if (!validation.isPlaybookManaged) {
    status = "unmanaged";
  } else if (!validation.valid) {
    status = "invalid";
  } else {
    // Determine whether content matches canonical template
    const timestampMatch = content.match(/#\s*Generated At:\s*([^\s\r\n]+)/);
    const existingTimestamp = timestampMatch ? timestampMatch[1] : undefined;
    const canonical = adapter.generateWorkflow({
      provider: adapter.provider,
      timestamp: existingTimestamp,
    });

    const normalizedExisting = content.replace(/\r\n/g, "\n").trim();
    const normalizedCanonical = canonical.replace(/\r\n/g, "\n").trim();

    if (normalizedExisting !== normalizedCanonical) {
      status = "modified";
    } else if (validation.version && validation.version !== PLAYBOOK_VERSION) {
      status = "outdated";
    }
  }

  return {
    installed: true,
    provider: adapter.provider,
    filePath: targetPath,
    status,
    isPlaybookManaged: validation.isPlaybookManaged,
    version: validation.version,
    requiredCheckName: adapter.requiredCheckName,
    errors: validation.errors,
    warnings: validation.warnings,
    backupFiles,
    validationResult: validation,
    diagnostics,
  };
}

/**
 * Initializes or updates the CI workflow file using crash-safe staging and atomic backups.
 */
export function initCiWorkflow(cwd: string, options: CiWorkflowOptions): CiInitResult {
  const provider = options.provider ?? "github";
  const adapter = getCiAdapter(provider);
  const targetPath = resolveWorkflowPath(cwd, provider, options.outputPath);
  const targetDir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const warnings: string[] = [];

  const generatedContent = adapter.generateWorkflow(options);

  if (options.dryRun) {
    return {
      success: true,
      provider: adapter.provider,
      filePath: targetPath,
      action: "dry_run",
      backupCreated: false,
      message: `[dry-run] Playbook CI workflow would be generated at ${targetPath}`,
      warnings: [`Workflow output preview:\n${generatedContent}`],
    };
  }

  // Ensure target directory exists
  fs.mkdirSync(targetDir, { recursive: true });
  cleanupAbandonedStaging(targetDir, baseName);

  if (!fs.existsSync(targetPath)) {
    // Fresh installation
    const stagingPath = path.join(targetDir, `${baseName}.playbook-tmp.${process.pid}.${Date.now()}`);
    try {
      fs.writeFileSync(stagingPath, generatedContent, { encoding: "utf-8", mode: 0o644 });
      fs.renameSync(stagingPath, targetPath);
    } catch (err) {
      try {
        fs.unlinkSync(stagingPath);
      } catch {}
      throw new CiError(
        "FILESYSTEM_ERROR",
        `Failed to write workflow file to ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
        { targetPath }
      );
    }

    return {
      success: true,
      provider: adapter.provider,
      filePath: targetPath,
      action: "created",
      backupCreated: false,
      message: `Successfully created Playbook CI workflow at ${targetPath}`,
      warnings,
    };
  }

  // File exists: inspect for idempotency or modification
  const existingContent = fs.readFileSync(targetPath, "utf-8");
  const timestampMatch = existingContent.match(/#\s*Generated At:\s*([^\s\r\n]+)/);
  const existingTimestamp = timestampMatch ? timestampMatch[1] : undefined;

  const candidate = adapter.generateWorkflow({
    ...options,
    timestamp: existingTimestamp,
  });

  const normalizedExisting = existingContent.replace(/\r\n/g, "\n").trim();
  const normalizedCandidate = candidate.replace(/\r\n/g, "\n").trim();

  if (normalizedExisting === normalizedCandidate) {
    // Completely unchanged and up to date
    return {
      success: true,
      provider: adapter.provider,
      filePath: targetPath,
      action: "already_up_to_date",
      backupCreated: false,
      message: `Playbook CI workflow at ${targetPath} is already installed and up to date.`,
      warnings,
    };
  }

  // Existing file differs from canonical template
  if (!options.force) {
    throw new CiError(
      "WORKFLOW_MODIFIED",
      `Workflow file at '${targetPath}' already exists and differs from the managed template.\n` +
        `Pass --force to safely create a timestamped backup and overwrite.`,
      { filePath: targetPath }
    );
  }

  // Force overwrite requested: create collision-safe backup and verify integrity
  const now = Date.now();
  let backupPath = `${targetPath}.user-backup.${now}`;
  let counter = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = `${targetPath}.user-backup.${now}.${counter++}`;
  }

  const stagingBackupPath = `${backupPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(stagingBackupPath, existingContent, { encoding: "utf-8", mode: 0o644 });
    fs.renameSync(stagingBackupPath, backupPath);
  } catch (err) {
    try {
      fs.unlinkSync(stagingBackupPath);
    } catch {}
    throw new CiError(
      "BACKUP_INTEGRITY_FAILED",
      `Failed to create user backup file at ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
      { targetPath, backupPath }
    );
  }

  // Verify backup integrity
  const origHash = crypto.createHash("sha256").update(existingContent).digest("hex");
  const backupContent = fs.readFileSync(backupPath, "utf-8");
  const backupHash = crypto.createHash("sha256").update(backupContent).digest("hex");

  if (origHash !== backupHash) {
    // Hash mismatch: abort overwrite to prevent data loss
    throw new CiError(
      "BACKUP_INTEGRITY_FAILED",
      `Integrity verification failed for backup '${backupPath}': SHA-256 hash does not match original file. Overwrite aborted.`,
      { targetPath, backupPath }
    );
  }

  // Execute staged overwrite
  const stagingPath = path.join(targetDir, `${baseName}.playbook-tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(stagingPath, generatedContent, { encoding: "utf-8", mode: 0o644 });
    fs.renameSync(stagingPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(stagingPath);
    } catch {}
    throw new CiError(
      "FILESYSTEM_ERROR",
      `Failed to overwrite workflow file at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      { targetPath, backupPath }
    );
  }

  return {
    success: true,
    provider: adapter.provider,
    filePath: targetPath,
    action: "overwritten",
    backupCreated: true,
    backupPath,
    message: `Successfully updated Playbook CI workflow at ${targetPath}.\nOriginal workflow archived to ${backupPath}`,
    warnings,
  };
}

/**
 * Validates a workflow file on disk or provided as a string.
 */
export function validateCiWorkflow(
  cwd: string,
  options?: { provider?: CiProviderType; filePath?: string; content?: string }
): CiWorkflowValidationResult {
  const provider = options?.provider ?? "github";
  const adapter = getCiAdapter(provider);
  const targetPath = resolveWorkflowPath(cwd, provider, options?.filePath);

  let content: string;
  if (options?.content !== undefined) {
    content = options.content;
  } else {
    if (!fs.existsSync(targetPath)) {
      throw new CiError("WORKFLOW_NOT_FOUND", `Workflow file not found at ${targetPath}`, {
        filePath: targetPath,
      });
    }
    try {
      content = fs.readFileSync(targetPath, "utf-8");
    } catch (err) {
      throw new CiError(
        "FILESYSTEM_ERROR",
        `Failed to read workflow file at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
        { filePath: targetPath }
      );
    }
  }

  return adapter.validateWorkflow(content, targetPath);
}
