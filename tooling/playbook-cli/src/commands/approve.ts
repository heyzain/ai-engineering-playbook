import fs from "node:fs";
import path from "node:path";
import { TerminalPrompter, type PromptInterface } from "../utils/prompt.js";
import { checkGateEligibility, approveGate, rejectGate, isForbiddenAgentName } from "../core/approval.js";
import { TransactionError } from "../core/transaction/index.js";
import type { ApprovalMode } from "../constants.js";

export interface ApproveCommandOptions {
  cwd?: string;
  gate?: number;
  reviewer?: string;
  role?: string;
  mode?: ApprovalMode;
  signature?: string;
  conditions?: string;
  reject?: boolean;
  confirmationPhrase?: string;
  isTTY?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
  prompter?: PromptInterface;
}

export interface ApproveCommandResult {
  success: boolean;
  exitCode: number;
  message: string;
  gate?: number;
  decision?: "GATE_APPROVED" | "REJECTED";
  fingerprint?: string;
  txId?: string;
  error?: string;
}

export async function runApprove(options: ApproveCommandOptions = {}): Promise<ApproveCommandResult> {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const isTTY =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (options.nonInteractive || !isTTY) {
    const msg =
      "Error: [TTY_REQUIRED] Gate approval requires an interactive terminal session.\nAutomated, scripted, or piped approval invocations are strictly prohibited.";
    if (!options.json) {
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
    // 1. Read state to determine current gate if not passed
    let gate = options.gate;
    if (gate === undefined) {
      const statePath = path.join(targetDir, ".playbook", "state.json");
      if (!fsExists(statePath)) {
        throw new TransactionError(
          "PROJECT_UNINITIALIZED",
          "Cannot approve gate: project is not initialized (.playbook/state.json missing)."
        );
      }
      const raw = JSON.parse(fsRead(statePath));
      gate = raw.current_stage;
    }

    if (typeof gate !== "number" || isNaN(gate) || gate < 0 || gate > 6) {
      throw new TransactionError(
        "GATE_MISMATCH",
        `Invalid gate number "${gate}". Gate must be an integer between 0 and 6.`
      );
    }

    // 2. Check Eligibility
    const eligibility = checkGateEligibility(targetDir, gate);
    if (!eligibility.eligible || !eligibility.state) {
      const issues = eligibility.diagnostics;
      let errorReport = `\nGate ${gate} Eligibility Checks Failed (${issues.length} blocking issues):\n`;
      for (const iss of issues) {
        errorReport += `  ✖ [${iss.code}] ${iss.message}\n    Remediation: ${iss.remediation}\n`;
      }
      if (!options.json) {
        console.error(errorReport);
      }
      return {
        success: false,
        exitCode: 1,
        message: errorReport,
        error: issues[0]?.code || "GATE_CRITERIA_UNMET",
      };
    }

    const state = eligibility.state;
    const stageDetail = state.current_stage_detail;

    // Read exit package content before presentation; fail closed if unreadable
    const exitPkgAbs = path.resolve(targetDir, stageDetail.exit_package.path);
    let exitPkgContent = "";
    try {
      exitPkgContent = fs.readFileSync(exitPkgAbs, "utf-8");
    } catch (err: unknown) {
      throw new TransactionError(
        "EXIT_PACKAGE_INCOMPLETE",
        `Cannot read Stage Exit Package at "${stageDetail.exit_package.path}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Display rich review context before requesting confirmation
    if (!options.json) {
      console.log("\n" + "=".repeat(68));
      console.log(` AI ENGINEERING PLAYBOOK — GATE ${gate} FORMAL HUMAN APPROVAL REVIEW`);
      console.log("=".repeat(68));
      console.log(` Project ID:       ${state.project_id}`);
      console.log(` Milestone ID:     ${state.milestone_id} (${state.milestone_name || "N/A"})`);
      console.log(` Active Stage:     Stage ${gate} (${stageDetail.stage_name})`);
      console.log(` Exit Package:     ${stageDetail.exit_package.path} (${Buffer.byteLength(exitPkgContent, "utf-8")} bytes)`);
      console.log("-".repeat(68));
      console.log(" MANDATORY DELIVERABLES & VERIFICATION STATUS:");
      for (const deliv of stageDetail.deliverables) {
        const symbol = deliv.status === "verified" ? "✔" : deliv.status === "waived" ? "⚠" : "✖";
        console.log(`  ${symbol} [${deliv.status.toUpperCase()}] ${deliv.id}: ${deliv.name}`);
        console.log(`    Artifact Path:  ${deliv.artifact_path}`);
        console.log(`    Validation:     ${deliv.validation_status}`);
        if (deliv.status === "waived") {
          console.log(`    Waiver Ref:     Exception ${deliv.exception_ref}`);
        } else if (deliv.evidence && deliv.evidence.length > 0) {
          for (const ev of deliv.evidence) {
            console.log(`    Evidence:       [${ev.type}] result=${ev.result} -> ${ev.evidence_ref}`);
            if (ev.evidence_hash) {
              console.log(`                    hash=${ev.evidence_hash}`);
            }
          }
        }
      }
      console.log("-".repeat(68));
      console.log(" EXCEPTIONS & WAIVERS:");
      if (!stageDetail.exceptions || stageDetail.exceptions.length === 0) {
        console.log("  None (0 active exceptions)");
      } else {
        for (const exc of stageDetail.exceptions) {
          console.log(`  • ${exc.exception_id}: ${exc.title} (status: ${exc.status}, expires: ${exc.expiration_date})`);
          console.log(`    Waived:         ${exc.waived_requirement} (authorized by: ${exc.authorized_by})`);
        }
      }
      console.log("-".repeat(68));
      console.log(" CLARIFICATION RFCS:");
      if (!stageDetail.rfcs || stageDetail.rfcs.length === 0) {
        console.log("  None (0 RFCs)");
      } else {
        for (const rfc of stageDetail.rfcs) {
          const blockingTag = rfc.is_blocking ? "[BLOCKING]" : "[non-blocking]";
          console.log(`  • ${rfc.rfc_id}: ${rfc.title} ${blockingTag} (status: ${rfc.status})`);
        }
      }
      console.log("-".repeat(68));
      if (state.lifecycle_status === "reopened_maintenance" && gate === 1) {
        console.log(" INHERITED PREREQUISITE ASSESSMENT (Stage 0 Problem Formulation):");
        const prdCorePath = path.resolve(targetDir, "docs/prd/PRD-CORE.md");
        const prdCoreExists = fs.existsSync(prdCorePath);
        console.log(`  Foundational Artifact: docs/prd/PRD-CORE.md (exists: ${prdCoreExists ? "YES" : "NO"})`);
        console.log("  Applicability Notice:  The human reviewer must verify that the original");
        console.log(`                         problem statement remains valid for milestone ${state.milestone_id}.`);
        console.log("                         If the problem formulation is invalid or obsolete,");
        console.log("                         Gate 1 approval MUST BE REJECTED and the project");
        console.log("                         reopened at Stage 0 (playbook reopen --stage 0).");
        console.log("-".repeat(68));
      }
      console.log(" STAGE GATE EXIT PACKAGE CONTENT:");
      const exitLines = exitPkgContent.split(/\r?\n/);
      const displayLines = exitLines.slice(0, 30);
      console.log(displayLines.map((line) => "  | " + line).join("\n"));
      if (exitLines.length > 30) {
        console.log(`  | ... [${exitLines.length - 30} more lines in ${stageDetail.exit_package.path}]`);
      }
      console.log("=".repeat(68) + "\n");
    }

    // 3. Collect Reviewer Details
    let reviewerName = options.reviewer;
    if (!reviewerName) {
      reviewerName = await prompter.ask("Reviewer Full Name (claimed human identity)");
    }
    if (!reviewerName || isForbiddenAgentName(reviewerName)) {
      throw new TransactionError(
        "AGENT_APPROVAL_PROHIBITED",
        `Reviewer identity "${reviewerName}" is invalid or matches an automated agent identifier. AI agents are strictly forbidden from approving quality gates.`
      );
    }

    let role = options.role;
    if (!role) {
      role = await prompter.ask("Professional Engineering Role", "Lead Systems Architect");
    }

    let approvalMode: ApprovalMode = options.mode || "solo";
    if (!options.mode) {
      approvalMode = await prompter.select(
        "Approval Mode",
        ["solo", "team"] as const,
        stageDetail.human_approval?.approval_mode || "solo"
      );
    }

    const sigRef =
      options.signature ||
      (await prompter.ask("Signature / Review Reference", `Interactive CLI Session ${options.gate}`));

    // 4. Handle Rejection vs Approval
    const isReject = Boolean(options.reject);
    if (isReject) {
      let conditions = options.conditions;
      if (!conditions) {
        conditions = await prompter.ask("Mandatory Rework Conditions / Reason for Rejection");
      }
      if (!conditions || conditions.trim().length === 0) {
        throw new TransactionError(
          "GATE_CRITERIA_UNMET",
          "Gate rejection requires explicit rework instructions."
        );
      }

      const res = await rejectGate(targetDir, {
        gate,
        reviewerName,
        role,
        approvalMode,
        signatureReference: sigRef,
        conditions,
        isTTY: true,
      });

      const message = `Gate ${gate} was REJECTED by ${reviewerName} (${role}). Rework conditions recorded.`;
      if (!options.json) {
        console.log(`\n✖ ${message}\n`);
      }
      return {
        success: true,
        exitCode: 0,
        message,
        gate,
        decision: "REJECTED",
        txId: res.txId,
      };
    }

    // Approval Path: collect conditions & confirmation phrase
    const conditions = options.conditions !== undefined ? options.conditions : await prompter.ask("Approval Conditions (optional, press Enter to skip)", "");

    const expectedPhrase = `CONFIRM APPROVAL GATE ${gate}`;
    let confirmationPhrase = options.confirmationPhrase;
    if (!confirmationPhrase) {
      console.log(`\nTo confirm approval, type exact phrase: "${expectedPhrase}"`);
      confirmationPhrase = await prompter.ask("Confirmation phrase");
    }

    if (confirmationPhrase !== expectedPhrase) {
      const abortMsg = `Confirmation phrase mismatch. Expected "${expectedPhrase}", got "${confirmationPhrase}". Gate approval aborted.`;
      if (!options.json) {
        console.error(`\n✖ ${abortMsg}\n`);
      }
      return {
        success: false,
        exitCode: 1,
        message: abortMsg,
        error: "CONFIRMATION_MISMATCH",
      };
    }

    const approvalRes = await approveGate(targetDir, {
      gate,
      reviewerName,
      role,
      approvalMode,
      signatureReference: sigRef,
      conditions,
      confirmationPhrase,
      isTTY: true,
    });

    const successMsg = `Gate ${gate} (${stageDetail.stage_name}) APPROVED by ${reviewerName} (${role}).`;
    if (!options.json) {
      console.log(`\n✔ ${successMsg}`);
      console.log(`  Approval Fingerprint: ${approvalRes.fingerprint}`);
      console.log(`  Transaction ID:       ${approvalRes.txId}`);
      console.log(`\nStage status is now "approved". Run 'playbook advance' to proceed to the next stage.\n`);
    }

    return {
      success: true,
      exitCode: 0,
      message: successMsg,
      gate,
      decision: "GATE_APPROVED",
      fingerprint: approvalRes.fingerprint,
      txId: approvalRes.txId,
    };
  } catch (err: unknown) {
    prompter.close();
    const errMsg = err instanceof Error ? err.message : String(err);
    const code = err instanceof TransactionError ? err.code : "APPROVAL_FAILED";
    if (!options.json) {
      console.error(`\nError: [${code}] ${errMsg}\n`);
    }
    return {
      success: false,
      exitCode: 1,
      message: errMsg,
      error: code,
    };
  } finally {
    prompter.close();
  }
}

function fsExists(p: string): boolean {
  try {
    const fs = require("node:fs");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function fsRead(p: string): string {
  const fs = require("node:fs");
  return fs.readFileSync(p, "utf-8");
}
