import path from "node:path";
import { SchemaValidator } from "../core/validator.js";
import {
  loadQualityGatesConfig,
  QualityGateConfigError,
} from "../core/quality-gates/config.js";
import {
  QualityGateRunner,
  QualityGateExecutionError,
} from "../core/quality-gates/runner.js";
import { QualityGateVerifier } from "../core/quality-gates/verifier.js";
import {
  checkRecoveryEligibility,
  recoverBlockedStage,
} from "../core/quality-gates/recovery.js";
import { TerminalPrompter, type PromptInterface } from "../utils/prompt.js";
import { TransactionError } from "../core/transaction/types.js";
import type { WriteAheadTransactionManager } from "../core/transaction/transaction-manager.js";
import {
  formatGateListTerminal,
  formatGateRunTerminal,
  formatGateVerifyTerminal,
} from "../formatters/gate-terminal.js";
import type { GovernanceProfile } from "../constants.js";

export interface GateRecoverCommandOptions {
  cwd?: string;
  stage?: number;
  operator?: string;
  role?: string;
  reason?: string;
  confirmationPhrase?: string;
  isTTY?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
  prompter?: PromptInterface;
  txManager?: WriteAheadTransactionManager;
}

export async function runGateRecover(
  options: GateRecoverCommandOptions = {}
): Promise<{ success: boolean; exitCode: number; data?: unknown; error?: string }> {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const isTTY =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  // Mandatory interactive terminal session check
  if (options.nonInteractive || !isTTY) {
    const msg =
      "Error: [TTY_REQUIRED] Controlled stage recovery requires an interactive terminal session.\nAutomated, scripted, or piped recovery invocations are strictly prohibited.";
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: "TTY_REQUIRED", message: msg }, null, 2));
    } else {
      console.error(msg);
    }
    return { success: false, exitCode: 1, error: "TTY_REQUIRED" };
  }

  const prompter = options.prompter || new TerminalPrompter();

  try {
    // 1. Eligibility Check
    const eligibility = checkRecoveryEligibility(targetDir, options.stage);
    if (!eligibility.eligible || !eligibility.state) {
      const msg = `Recovery Precondition Failed: ${eligibility.reason || "Stage is not eligible for recovery."}`;
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: "STAGE_NOT_BLOCKED", message: msg }, null, 2));
      } else {
        console.error(`\n✖ ${msg}`);
      }
      return { success: false, exitCode: 1, error: "STAGE_NOT_BLOCKED" };
    }

    const currentStage = eligibility.currentStage!;
    const stageName = eligibility.stageName!;

    // 2. Operator Identification
    let operator = options.operator?.trim();
    if (options.operator === undefined) {
      operator = (
        await prompter.ask("Authorizing Human Engineer (claimed full name)")
      ).trim();
    }

    if (!operator) {
      throw new TransactionError(
        "RECOVERY_BLOCKED",
        "Authorizing human engineer name is required."
      );
    }

    // 3. Professional Engineering Role
    let role = options.role?.trim();
    if (options.role === undefined) {
      role = (
        await prompter.ask("Professional Engineering Role (e.g. Lead Systems Engineer)")
      ).trim();
    }

    if (!role) {
      throw new TransactionError(
        "RECOVERY_BLOCKED",
        "Authorizing engineer professional role is required."
      );
    }

    // 4. Recovery Rationale / Remediation Summary
    let reason = options.reason?.trim();
    if (options.reason === undefined) {
      reason = (
        await prompter.ask("Recovery Rationale / Root Cause Remediation Summary")
      ).trim();
    }

    if (!reason || reason.length < 10) {
      throw new TransactionError(
        "RECOVERY_REASON_REQUIRED",
        "A substantive recovery reason (minimum 10 characters) explaining root cause remediation is required."
      );
    }

    // 5. Interactive Review & Confirmation Phrase
    const expectedPhrase = `CONFIRM RECOVER STAGE ${currentStage}`;

    if (!options.json) {
      console.log("\n" + "=".repeat(68));
      console.log(" AI ENGINEERING PLAYBOOK — CONTROLLED OPERATOR-ATTESTED RECOVERY");
      console.log("=".repeat(68));
      console.log(` Target Directory:      ${targetDir}`);
      console.log(` Blocked Stage:         Stage ${currentStage} (${stageName})`);
      console.log(` Current Status:        BLOCKED`);
      console.log("-".repeat(68));
      console.log(` Attested Operator:     ${operator}`);
      console.log(` Attested Role:         ${role}`);
      console.log(` Identity Confidence:   Operator-attested via interactive TTY (Non-cryptographic)`);
      console.log(` Remediation Reason:    ${reason}`);
      if (eligibility.failedDeliverables.length > 0) {
        console.log(` Impacted Deliverables: ${eligibility.failedDeliverables.map((d) => d.id).join(", ")}`);
      }
      console.log("-".repeat(68));
      console.log(" Notice: This recovery transition unblocks Stage " + currentStage + " to 'in_progress'.");
      console.log("         It does NOT approve the stage or verify deliverables.");
      console.log("         All quality checks must be executed again to earn passing evidence.");
      console.log("         Attestation does not provide cryptographic identity verification.");
      console.log("=".repeat(68));
    }

    let confirmationPhrase = options.confirmationPhrase;
    if (confirmationPhrase === undefined) {
      confirmationPhrase = await prompter.ask(`Type "${expectedPhrase}" to authorize recovery`);
    }

    if (confirmationPhrase.trim() !== expectedPhrase) {
      const msg = `Recovery aborted: confirmation phrase did not match "${expectedPhrase}". Zero state modifications made.`;
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: "RECOVERY_ABORTED", message: msg }, null, 2));
      } else {
        console.error(`\n✖ ${msg}\n`);
      }
      return { success: false, exitCode: 1, error: "RECOVERY_ABORTED" };
    }

    // 6. Execute Transactional Recovery
    const result = await recoverBlockedStage(targetDir, {
      stage: currentStage,
      operatorName: operator,
      role,
      reason,
      confirmationPhrase,
      txManager: options.txManager,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✔ Successfully recovered Stage ${currentStage} (${stageName})!`);
      console.log(`  State transition committed: 'blocked' -> 'in_progress'`);
      console.log(`  Audit log created: ${result.auditLogPath}`);
      console.log(`  Transaction ID:    ${result.txId}`);
      console.log(`  Next steps:        Run 'playbook gate run' to re-evaluate quality checks.\n`);
    }

    return { success: true, exitCode: 0, data: result };
  } catch (err: unknown) {
    const code = err instanceof TransactionError ? err.code : "RECOVERY_FAILED";
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message: msg }, null, 2));
    } else {
      console.error(`\n✖ Recovery Error [${code}]: ${msg}\n`);
    }
    return { success: false, exitCode: 1, error: code };
  } finally {
    prompter.close();
  }
}

export function runGateList(options: {
  cwd?: string;
  stage?: number;
  all?: boolean;
  json?: boolean;
}): { exitCode: number; data?: unknown } {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const validator = new SchemaValidator();

  try {
    const config = loadQualityGatesConfig(targetDir, { validator });

    if (options.json) {
      console.log(JSON.stringify(config, null, 2));
    } else {
      console.log(formatGateListTerminal(config, options.all ? undefined : options.stage));
    }

    return { exitCode: 0, data: config };
  } catch (err: unknown) {
    if (err instanceof QualityGateConfigError) {
      if (options.json) {
        console.error(JSON.stringify({ error: err.code, message: err.message, details: err.details }, null, 2));
      } else {
        console.error(`Error: ${err.message}`);
      }
      return { exitCode: 2 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return { exitCode: 2 };
  }
}

export async function runGateRun(options: {
  cwd?: string;
  stage?: number;
  checkId?: string;
  headless?: boolean;
  failFast?: boolean;
  haltOnFailure?: boolean;
  json?: boolean;
  profile?: GovernanceProfile;
}): Promise<{ exitCode: number; data?: unknown }> {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const runner = new QualityGateRunner(targetDir);

  try {
    const report = await runner.run({
      stage: options.stage,
      checkId: options.checkId,
      headless: options.headless,
      failFast: options.failFast,
      haltOnFailure: options.haltOnFailure,
      profile: options.profile,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatGateRunTerminal(report));
    }

    const exitCode = report.overall_outcome === "passed" ? 0 : 1;
    return { exitCode, data: report };
  } catch (err: unknown) {
    if (err instanceof QualityGateExecutionError) {
      if (options.json) {
        console.error(JSON.stringify({ error: err.code, message: err.message, details: err.details }, null, 2));
      } else {
        console.error(`\n[Execution Error] ${err.message}`);
      }
      return { exitCode: err.exitCode };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nUnexpected Error: ${msg}`);
    return { exitCode: 4 };
  }
}

export function runGateVerify(options: {
  cwd?: string;
  stage?: number;
  json?: boolean;
}): { exitCode: number; data?: unknown } {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const verifier = new QualityGateVerifier(targetDir);

  try {
    const report = verifier.verify(options.stage);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatGateVerifyTerminal(report));
    }

    const exitCode = report.all_fresh ? 0 : 1;
    return { exitCode, data: report };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.error(JSON.stringify({ error: "VERIFICATION_ERROR", message: msg }, null, 2));
    } else {
      console.error(`Verification Error: ${msg}`);
    }
    return { exitCode: 1 };
  }
}
