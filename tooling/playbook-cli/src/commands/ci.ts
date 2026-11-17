import {
  type CiProviderType,
  type CiInitResult,
  type CiWorkflowValidationResult,
  type CiStatusResult,
  CiError,
} from "../core/ci/types.js";
import {
  initCiWorkflow,
  validateCiWorkflow,
  inspectCiStatus,
} from "../core/ci/adapter.js";
import {
  writeCiEvidenceReport,
  formatCiStepSummaryMarkdown,
} from "../core/ci/evidence.js";
import {
  formatCiStatusTerminal,
  formatCiValidationTerminal,
  formatCiInitTerminal,
} from "../formatters/ci-terminal.js";

export interface CiCommandBaseOptions {
  cwd?: string;
  provider?: string;
  json?: boolean;
}

export interface CiInitCommandOptions extends CiCommandBaseOptions {
  output?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface CiValidateCommandOptions extends CiCommandBaseOptions {
  file?: string;
}

export interface CiStatusCommandOptions extends CiCommandBaseOptions {
  file?: string;
}

export function runCiInit(
  options: CiInitCommandOptions = {}
): { success: boolean; exitCode: number; data?: CiInitResult; error?: string } {
  try {
    const cwd = options.cwd ?? process.cwd();
    const provider = (options.provider ?? "github") as CiProviderType;

    const result = initCiWorkflow(cwd, {
      provider,
      cwd,
      outputPath: options.output,
      force: options.force,
      dryRun: options.dryRun,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatCiInitTerminal(result));
    }

    return { success: true, exitCode: 0, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CiError ? err.code : "CI_INIT_FAILED";

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message }, null, 2));
    } else {
      console.error(`\n✖ CI Init Error [${code}]: ${message}`);
    }

    return { success: false, exitCode: 1, error: code };
  }
}

export function runCiValidate(
  options: CiValidateCommandOptions = {}
): { success: boolean; exitCode: number; data?: CiWorkflowValidationResult; error?: string } {
  try {
    const cwd = options.cwd ?? process.cwd();
    const provider = (options.provider ?? "github") as CiProviderType;

    const result = validateCiWorkflow(cwd, {
      provider,
      filePath: options.file,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatCiValidationTerminal(result));
    }

    const exitCode = result.valid ? 0 : 1;
    return { success: result.valid, exitCode, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CiError ? err.code : "CI_VALIDATE_FAILED";

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message }, null, 2));
    } else {
      console.error(`\n✖ CI Validation Error [${code}]: ${message}`);
    }

    return { success: false, exitCode: 2, error: code };
  }
}

export function runCiStatus(
  options: CiStatusCommandOptions = {}
): { success: boolean; exitCode: number; data?: CiStatusResult; error?: string } {
  try {
    const cwd = options.cwd ?? process.cwd();
    const provider = (options.provider ?? "github") as CiProviderType;

    const result = inspectCiStatus(cwd, {
      provider,
      filePath: options.file,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatCiStatusTerminal(result));
    }

    const exitCode = result.status === "valid" ? 0 : 1;
    return { success: result.status === "valid", exitCode, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CiError ? err.code : "CI_STATUS_FAILED";

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message }, null, 2));
    } else {
      console.error(`\n✖ CI Status Error [${code}]: ${message}`);
    }

    return { success: false, exitCode: 2, error: code };
  }
}

export interface CiReportCommandOptions extends CiCommandBaseOptions {
  output?: string;
  raw?: string;
  summary?: boolean;
  jobStatus?: string;
}

export function runCiReport(
  options: CiReportCommandOptions = {}
): { success: boolean; exitCode: number; data?: unknown; error?: string } {
  try {
    const cwd = options.cwd ?? process.cwd();

    const { report, outputPath, summaryWritten } = writeCiEvidenceReport(cwd, {
      cwd,
      outputPath: options.output,
      rawReportPath: options.raw,
      writeSummary: options.summary !== false,
      jobStatus: options.jobStatus,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n✔ Playbook CI Evidence Report written to ${outputPath}`);
      console.log(`  Verdict: ${report.governance_evaluation.overall_outcome.toUpperCase()}`);
      if (summaryWritten) {
        console.log(`  Step summary appended to $GITHUB_STEP_SUMMARY`);
      }
    }

    const isPassed = report.governance_evaluation.overall_outcome === "passed";
    return { success: isPassed, exitCode: isPassed ? 0 : 1, data: report };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n✖ CI Report Error: ${message}`);
    return { success: false, exitCode: 1, error: message };
  }
}
