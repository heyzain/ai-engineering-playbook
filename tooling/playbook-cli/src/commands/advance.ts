import path from "node:path";
import { advanceStage, type AdvanceStageResult } from "../core/advancement.js";
import { TransactionError } from "../core/transaction/index.js";
import { STAGE_NAMES } from "../constants.js";

export interface AdvanceCommandOptions {
  cwd?: string;
  json?: boolean;
  now?: Date;
}

export interface AdvanceCommandResult {
  success: boolean;
  exitCode: number;
  message: string;
  previousStage?: number;
  newStage?: number;
  isTerminalClosed?: boolean;
  milestoneSnapshotPath?: string;
  txId?: string;
  error?: string;
}

export async function runAdvance(options: AdvanceCommandOptions = {}): Promise<AdvanceCommandResult> {
  const targetDir = path.resolve(options.cwd || process.cwd());

  try {
    const res: AdvanceStageResult = await advanceStage(targetDir, { now: options.now });

    let message: string;
    if (res.isTerminalClosed) {
      message =
        `Milestone sealed. Lifecycle closed at Stage 6 (${STAGE_NAMES[6]}).\n` +
        `Milestone snapshot created: ${res.milestoneSnapshotPath}\n` +
        `Lifecycle status is now "completed_terminal". Stage 7 was not created.`;
    } else {
      message =
        `Successfully advanced lifecycle from Stage ${res.previousStage} (${STAGE_NAMES[res.previousStage]}) ` +
        `to Stage ${res.newStage} (${STAGE_NAMES[res.newStage]}).\n` +
        `Manifest active_lifecycle_stage synchronized to ${res.newStage}. Baseline deliverables initialized.`;
    }

    if (!options.json) {
      console.log("\n" + "=".repeat(64));
      console.log(" AI ENGINEERING PLAYBOOK — LIFECYCLE ADVANCEMENT");
      console.log("=".repeat(64));
      console.log(`\n✔ ${message}`);
      console.log(`  Transaction ID: ${res.txId}\n`);
    } else {
      console.log(
        JSON.stringify(
          {
            success: true,
            previous_stage: res.previousStage,
            new_stage: res.newStage,
            is_terminal_closed: res.isTerminalClosed,
            milestone_snapshot_path: res.milestoneSnapshotPath || null,
            tx_id: res.txId,
            message,
          },
          null,
          2
        )
      );
    }

    return {
      success: true,
      exitCode: 0,
      message,
      previousStage: res.previousStage,
      newStage: res.newStage,
      isTerminalClosed: res.isTerminalClosed,
      milestoneSnapshotPath: res.milestoneSnapshotPath,
      txId: res.txId,
    };
  } catch (err: unknown) {
    const code = err instanceof TransactionError ? err.code : "ADVANCEMENT_FAILED";
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
