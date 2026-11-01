import path from "node:path";
import { TerminalPrompter, type PromptInterface } from "../utils/prompt.js";
import { checkPivotEligibility, executeStagePivot } from "../core/pivot.js";
import { TransactionError } from "../core/transaction/index.js";
import { LockError } from "../core/lock/types.js";
import { STAGE_NAMES } from "../constants.js";

export interface PivotCommandOptions {
  cwd?: string;
  stage?: number;
  authorizedBy?: string;
  role?: string;
  reason?: string;
  confirmationPhrase?: string;
  isTTY?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
  prompter?: PromptInterface;
}

export interface PivotCommandResult {
  success: boolean;
  exitCode: number;
  message: string;
  pivotId?: string;
  milestoneId?: string;
  txId?: string;
  error?: string;
}

export async function runPivot(options: PivotCommandOptions = {}): Promise<PivotCommandResult> {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const isTTY =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  // Mandatory interactive terminal session check (C5)
  if (options.nonInteractive || !isTTY) {
    const msg =
      "Error: [TTY_REQUIRED] Stage pivot requires an interactive terminal session.\nAutomated, scripted, or piped execution is strictly prohibited.";
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            success: false,
            error: "TTY_REQUIRED",
            message: msg,
          },
          null,
          2
        )
      );
    } else {
      console.error(msg);
    }
    return {
      success: false,
      exitCode: 1,
      message: msg,
      error: "TTY_REQUIRED",
    };
  }

  const prompter = options.prompter || new TerminalPrompter();

  try {
    // 1. Stage verification
    let targetStage: number;
    if (options.stage !== undefined) {
      targetStage = Number(options.stage);
    } else {
      const selected = await prompter.ask("Target Stage to Pivot (must be 0)", "0");
      targetStage = Number(selected.trim());
    }

    if (isNaN(targetStage) || targetStage !== 0) {
      throw new TransactionError(
        "PIVOT_TARGET_UNSUPPORTED",
        `Unsupported pivot target stage "${options.stage}". Only pivot to Stage 0 is supported.`
      );
    }

    // 2. Preflight eligibility check & capture pre-prompt baseline
    const baseline = checkPivotEligibility(targetDir, targetStage);

    // 3. Human authorizer identification
    let authorizedBy = options.authorizedBy?.trim();
    if (!authorizedBy) {
      authorizedBy = (
        await prompter.ask("Authorizing Human Reviewer (claimed full name)")
      ).trim();
    }

    if (!authorizedBy) {
      throw new TransactionError(
        "AGENT_APPROVAL_PROHIBITED",
        "Authorizing human reviewer name is required."
      );
    }

    // 4. Authorizer professional role
    let role = options.role?.trim();
    if (!role) {
      role = (
        await prompter.ask("Authorizer Professional Role (e.g. Lead Architect)")
      ).trim();
    }

    if (!role) {
      throw new TransactionError(
        "PIVOT_ABORTED",
        "Authorizer professional role is required."
      );
    }

    // 5. Pivot Justification Reason (C6)
    let reason = options.reason?.trim();
    if (!reason) {
      reason = (
        await prompter.ask("Pivot Justification (why PRD-CORE is outdated)")
      ).trim();
    }

    if (!reason) {
      throw new TransactionError(
        "PIVOT_REASON_REQUIRED",
        "Stage pivot requires an explicit, non-empty justification string."
      );
    }

    // 6. Exact Confirmation Phrase Verification
    const expectedPhrase = `CONFIRM PIVOT TO STAGE 0 ${baseline.milestoneId}`;
    let confirmationPhrase = options.confirmationPhrase;
    if (confirmationPhrase === undefined) {
      if (!options.json) {
        console.log(
          `\nConfirm Stage Pivot to Stage 0:\n` +
            `This will archive current Stage 1 work, archive the outdated PRD-CORE.md,\n` +
            `and return the active milestone ${baseline.milestoneId} to Stage 0 for foundational problem reformulation.\n`
        );
      }
      confirmationPhrase = await prompter.ask(
        `Type exact phrase '${expectedPhrase}' to confirm`
      );
    }

    if (confirmationPhrase !== expectedPhrase) {
      throw new TransactionError(
        "PIVOT_ABORTED",
        `Confirmation phrase mismatch. Expected exactly "${expectedPhrase}", received "${confirmationPhrase}".`
      );
    }

    // 7. Execute Pivot under WAL transaction
    const res = await executeStagePivot(targetDir, {
      targetStage: 0,
      authorizedBy,
      role,
      reason,
      confirmationPhrase,
      baseline,
    });

    const successMessage =
      `Stage pivot to Stage 0 completed successfully.\n` +
      `  Pivot Event ID:   ${res.pivotId}\n` +
      `  Active Milestone: ${res.milestoneId}\n` +
      `  Transition:       Stage 1 (Requirements) -> Stage 0 (${STAGE_NAMES[0]})\n` +
      `  State Snapshot:   ${res.snapshotRef}\n` +
      `  Audit Document:   ${res.auditRef}\n` +
      `  Archived PRD:     ${res.archivedPrdRef}\n` +
      `  Transaction ID:   ${res.txId}`;

    if (!options.json) {
      console.log(`\n✔ ${successMessage}\n`);
    } else {
      console.log(
        JSON.stringify(
          {
            success: true,
            pivot_id: res.pivotId,
            milestone_id: res.milestoneId,
            from_stage: 1,
            to_stage: 0,
            snapshot_ref: res.snapshotRef,
            audit_ref: res.auditRef,
            archived_prd_ref: res.archivedPrdRef,
            source_prd_hash: res.sourcePrdHash,
            tx_id: res.txId,
            message: successMessage,
          },
          null,
          2
        )
      );
    }

    return {
      success: true,
      exitCode: 0,
      message: successMessage,
      pivotId: res.pivotId,
      milestoneId: res.milestoneId,
      txId: res.txId,
    };
  } catch (err: unknown) {
    const code =
      err instanceof TransactionError
        ? err.code
        : err instanceof LockError
        ? err.code
        : "PIVOT_ABORTED";
    const msg = err instanceof Error ? err.message : String(err);

    if (!options.json) {
      console.error(`\n✖ Error: [${code}] ${msg}\n`);
    } else {
      console.error(
        JSON.stringify(
          {
            success: false,
            error: code,
            message: msg,
          },
          null,
          2
        )
      );
    }

    return {
      success: false,
      exitCode: 1,
      message: msg,
      error: code,
    };
  }
}
