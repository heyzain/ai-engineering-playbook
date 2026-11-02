import fs from "node:fs";
import path from "node:path";
import { TerminalPrompter, type PromptInterface } from "../utils/prompt.js";
import { reopenLifecycle } from "../core/reopen.js";
import { isForbiddenAgentName } from "../core/approval.js";
import { TransactionError } from "../core/transaction/index.js";
import { DEFAULT_PATHS, STAGE_NAMES, MILESTONE_REGEX } from "../constants.js";
import type { ProjectState } from "../types/state.js";

export interface ReopenCommandOptions {
  cwd?: string;
  milestone?: string;
  name?: string;
  stage?: number;
  reason?: string;
  authorizedBy?: string;
  role?: string;
  confirmationPhrase?: string;
  isTTY?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
  prompter?: PromptInterface;
}

export interface ReopenCommandResult {
  success: boolean;
  exitCode: number;
  message: string;
  previousMilestoneId?: string;
  newMilestoneId?: string;
  stage?: number;
  txId?: string;
  error?: string;
}

export async function runReopen(options: ReopenCommandOptions = {}): Promise<ReopenCommandResult> {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const isTTY =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  // Mandatory interactive terminal session check
  if (options.nonInteractive || !isTTY) {
    const msg =
      "Error: [TTY_REQUIRED] Lifecycle reopening requires an interactive terminal session.\nAutomated, scripted, or piped reopening invocations are strictly prohibited.";
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
    const statePath = path.resolve(targetDir, DEFAULT_PATHS.stateFile);
    if (!fs.existsSync(statePath)) {
      throw new TransactionError(
        "PROJECT_UNINITIALIZED",
        "Cannot reopen: project state file (.playbook/state.json) is missing."
      );
    }

    let state: ProjectState;
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    } catch (err: unknown) {
      throw new TransactionError(
        "REOPEN_BLOCKED",
        `Cannot reopen: state file JSON syntax error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Pre-flight lifecycle status checks for actionable diagnostics
    if (state.lifecycle_status === "active") {
      throw new TransactionError(
        "LIFECYCLE_NOT_TERMINAL",
        "Cannot reopen: project lifecycle is currently active. Only projects in 'completed_terminal' status can be reopened."
      );
    }

    if (state.lifecycle_status === "paused") {
      throw new TransactionError(
        "LIFECYCLE_NOT_TERMINAL",
        "Cannot reopen: project lifecycle is currently paused. Resume active development before performing stage work."
      );
    }

    if (state.lifecycle_status === "reopened_maintenance") {
      throw new TransactionError(
        "LIFECYCLE_ALREADY_REOPENED",
        `Cannot reopen: lifecycle is already in 'reopened_maintenance' mode for milestone "${state.milestone_id}".`
      );
    }

    if (state.lifecycle_status !== "completed_terminal") {
      throw new TransactionError(
        "LIFECYCLE_NOT_TERMINAL",
        `Cannot reopen: lifecycle status "${state.lifecycle_status}" is not eligible. Reopening requires 'completed_terminal' status.`
      );
    }

    // 1. Milestone ID collection & validation
    let milestoneId = options.milestone?.trim();
    if (!milestoneId) {
      milestoneId = (await prompter.ask("New Milestone ID (e.g. M-1.1.0)")).trim();
    }

    if (!milestoneId || !MILESTONE_REGEX.test(milestoneId)) {
      throw new TransactionError(
        "INVALID_MILESTONE_ID",
        `Milestone identifier "${milestoneId}" is invalid. Must match pattern ^M-[a-zA-Z0-9.-]+$ (e.g. 'M-1.1.0').`
      );
    }

    if (milestoneId === state.milestone_id) {
      throw new TransactionError(
        "MILESTONE_ID_COLLISION",
        `Milestone ID "${milestoneId}" collides with current milestone ID. Reopening requires a new, distinct milestone identifier.`
      );
    }

    if (
      Array.isArray(state.archived_milestones) &&
      state.archived_milestones.some((m) => m.milestone_id === milestoneId)
    ) {
      throw new TransactionError(
        "MILESTONE_ID_COLLISION",
        `Milestone ID "${milestoneId}" already exists in archived milestones history.`
      );
    }

    const targetSnapshotRel = path.posix.join(".playbook", "milestones", `state-${milestoneId}.json`);
    const targetSnapshotAbs = path.resolve(targetDir, targetSnapshotRel);
    if (fs.existsSync(targetSnapshotAbs)) {
      throw new TransactionError(
        "MILESTONE_ID_COLLISION",
        `Snapshot file for milestone "${milestoneId}" already exists at "${targetSnapshotRel}". Specify a unique milestone identifier.`
      );
    }

    // 2. Milestone Name
    let milestoneName = options.name?.trim();
    if (!milestoneName) {
      milestoneName = (
        await prompter.ask("Milestone Title / Name", `Maintenance Milestone ${milestoneId}`)
      ).trim();
    }

    // 3. Entry Stage Selection (0 or 1)
    let targetStage: 0 | 1;
    if (options.stage !== undefined) {
      if (options.stage !== 0 && options.stage !== 1) {
        throw new TransactionError(
          "INVALID_REOPEN_STAGE",
          `Invalid target stage "${options.stage}". Reopening permits only Stage 1 (default) or Stage 0 (major pivot).`
        );
      }
      targetStage = options.stage as 0 | 1;
    } else {
      const selected = await prompter.select(
        "Entry Stage for Maintenance",
        [
          "1 (Stage 1: Requirements & Specification - Recommended)",
          "0 (Stage 0: Discovery & Problem Formulation - Fundamental Pivot)",
        ] as const,
        "1 (Stage 1: Requirements & Specification - Recommended)"
      );
      targetStage = selected.startsWith("0") ? 0 : 1;
    }

    // 4. Human Authorizer Identification
    let authorizedBy = options.authorizedBy?.trim();
    if (!authorizedBy) {
      authorizedBy = (
        await prompter.ask("Authorizing Human Engineer (claimed full name)")
      ).trim();
    }

    if (!authorizedBy) {
      throw new TransactionError(
        "REOPEN_BLOCKED",
        "Authorizing human engineer name is required."
      );
    }

    if (isForbiddenAgentName(authorizedBy)) {
      throw new TransactionError(
        "AGENT_REOPEN_PROHIBITED",
        `Authorizer identity "${authorizedBy}" matches an automated AI agent pattern. AI agents are strictly forbidden from reopening project lifecycles.`
      );
    }

    // 5. Professional Engineering Role (No invented default!)
    let role = options.role?.trim();
    if (!role) {
      role = (
        await prompter.ask("Professional Engineering Role (e.g. Principal Systems Architect)")
      ).trim();
    }

    if (!role) {
      throw new TransactionError(
        "REOPEN_BLOCKED",
        "Authorizer professional role is required."
      );
    }

    // 6. Business Justification / Rationale
    let reason = options.reason?.trim();
    if (!reason) {
      reason = (
        await prompter.ask("Reopening Rationale / Business Justification")
      ).trim();
    }

    if (!reason) {
      throw new TransactionError(
        "REOPEN_BLOCKED",
        "Reopening rationale / business justification is required."
      );
    }

    // 7. Interactive Review & Confirmation Phrase
    const expectedPhrase = `CONFIRM REOPEN MILESTONE ${milestoneId}`;

    if (!options.json) {
      console.log("\n" + "=".repeat(68));
      console.log(" AI ENGINEERING PLAYBOOK — LIFECYCLE REOPENING (REOPEN_LIFECYCLE)");
      console.log("=".repeat(68));
      console.log(` Target Directory:      ${targetDir}`);
      console.log(` Project ID:            ${state.project_id}`);
      console.log(` Current Status:        ${state.lifecycle_status.toUpperCase()}`);
      console.log(` Sealed Milestone:      ${state.milestone_id} ("${state.milestone_name}")`);
      console.log("-".repeat(68));
      console.log(` Authorizing Engineer:  ${authorizedBy}`);
      console.log(` Professional Role:     ${role}`);
      console.log(` New Milestone ID:      ${milestoneId}`);
      console.log(` Milestone Title:       ${milestoneName}`);
      console.log(` Entry Stage:           Stage ${targetStage}: ${STAGE_NAMES[targetStage]}`);
      console.log(` Reopening Rationale:   ${reason}`);
      console.log("-".repeat(68));
      console.log(` Notice: Preceding milestone ${state.milestone_id} will be permanently archived.`);
      console.log(` Active stage history will be re-initialized for ${milestoneId}.`);
      console.log(` Authoritative historical state remains in .playbook/milestones/state-${state.milestone_id}.json.`);
      console.log("=".repeat(68) + "\n");
    }

    let confirmationPhrase = options.confirmationPhrase?.trim();
    if (!confirmationPhrase) {
      console.log(`To confirm authorization, type exact phrase: "${expectedPhrase}"`);
      confirmationPhrase = (await prompter.ask("Confirmation phrase")).trim();
    }

    if (confirmationPhrase !== expectedPhrase) {
      const mismatchMsg = `Entered confirmation phrase did not match "${expectedPhrase}". Reopening aborted with zero mutations.`;
      if (!options.json) {
        console.error(`\n✖ [CONFIRMATION_PHRASE_MISMATCH] ${mismatchMsg}\n`);
      } else {
        console.error(
          JSON.stringify(
            {
              success: false,
              error: "CONFIRMATION_PHRASE_MISMATCH",
              message: mismatchMsg,
            },
            null,
            2
          )
        );
      }
      return {
        success: false,
        exitCode: 1,
        message: mismatchMsg,
        error: "CONFIRMATION_PHRASE_MISMATCH",
      };
    }

    // 8. Execute core reopening under WAL transaction
    const res = await reopenLifecycle(targetDir, {
      milestoneId,
      milestoneName,
      targetStage,
      reason,
      authorizedBy,
      role,
      isTTY: true,
    });

    const successMessage =
      `Lifecycle successfully reopened into maintenance mode.\n` +
      `  Status:           reopened_maintenance\n` +
      `  Active Milestone: ${res.newMilestoneId} ("${milestoneName}")\n` +
      `  Active Stage:     Stage ${res.newStage}: ${STAGE_NAMES[res.newStage]} (not_started)\n` +
      `  Archived History: ${res.archivedMilestonesCount} milestone(s) (${res.previousMilestoneId} preserved)\n` +
      `  Transaction ID:   ${res.txId}`;

    if (!options.json) {
      console.log(`\n✔ ${successMessage}\n`);
    } else {
      console.log(
        JSON.stringify(
          {
            success: true,
            status: "reopened_maintenance",
            previous_milestone_id: res.previousMilestoneId,
            new_milestone_id: res.newMilestoneId,
            milestone_name: milestoneName,
            stage: res.newStage,
            stage_name: STAGE_NAMES[res.newStage],
            archived_milestones_count: res.archivedMilestonesCount,
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
      previousMilestoneId: res.previousMilestoneId,
      newMilestoneId: res.newMilestoneId,
      stage: res.newStage,
      txId: res.txId,
    };
  } catch (err: unknown) {
    const code = err instanceof TransactionError ? err.code : "REOPEN_BLOCKED";
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
