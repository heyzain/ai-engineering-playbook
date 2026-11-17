import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_PATHS, STAGE_NAMES, type StageNumber } from "../../constants.js";
import { WriteAheadTransactionManager } from "../transaction/transaction-manager.js";
import { computeSha256 } from "../transaction/fs-utils.js";
import { TransactionError } from "../transaction/types.js";
import { isForbiddenAgentName } from "../approval.js";
import type { ProjectState } from "../../types/state.js";

export interface RecoverStageOptions {
  stage?: number;
  operatorName: string;
  role: string;
  reason: string;
  confirmationPhrase?: string;
  now?: Date;
  txManager?: WriteAheadTransactionManager;
}

export interface RecoveryCheckResult {
  eligible: boolean;
  state?: ProjectState;
  currentStage?: number;
  stageName?: string;
  failedDeliverables: Array<{ id: string; name: string; validationStatus: string }>;
  reason?: string;
}

export interface RecoverStageResult {
  success: boolean;
  stage: number;
  stageName: string;
  operatorName: string;
  role: string;
  reason: string;
  txId: string;
  auditLogPath: string;
  timestamp: string;
}

/**
 * Checks whether the project is in a blocked state eligible for controlled human recovery.
 */
export function checkRecoveryEligibility(
  targetDir: string,
  stageOverride?: number
): RecoveryCheckResult {
  const resolvedDir = path.resolve(targetDir);
  const statePath = path.join(resolvedDir, DEFAULT_PATHS.stateFile);

  if (!fs.existsSync(statePath)) {
    return {
      eligible: false,
      failedDeliverables: [],
      reason: "Project state file (.playbook/state.json) is missing.",
    };
  }

  let state: ProjectState;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ProjectState;
  } catch (err: unknown) {
    return {
      eligible: false,
      failedDeliverables: [],
      reason: `Cannot parse .playbook/state.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const currentStage = state.current_stage;
  const stageName = state.current_stage_detail?.stage_name || STAGE_NAMES[currentStage as StageNumber] || `Stage ${currentStage}`;

  if (stageOverride !== undefined && stageOverride !== currentStage) {
    return {
      eligible: false,
      state,
      currentStage,
      stageName,
      failedDeliverables: [],
      reason: `Specified stage ${stageOverride} does not match active lifecycle stage ${currentStage}.`,
    };
  }

  if (state.stage_status !== "blocked") {
    return {
      eligible: false,
      state,
      currentStage,
      stageName,
      failedDeliverables: [],
      reason: `Stage ${currentStage} is currently in '${state.stage_status}' status, not 'blocked'. Only blocked stages can be recovered.`,
    };
  }

  const deliverables = state.current_stage_detail?.deliverables || [];
  const failedDeliverables = deliverables
    .filter((d) => d.validation_status === "failed" || d.status === "in_progress")
    .map((d) => ({ id: d.id, name: d.name, validationStatus: d.validation_status }));

  return {
    eligible: true,
    state,
    currentStage,
    stageName,
    failedDeliverables,
  };
}

/**
 * Executes controlled operator-attested recovery of a blocked stage under an exclusive WAL transaction.
 * Strictly transitions stage_status from 'blocked' to 'in_progress'.
 * Zero stage approval or deliverable verification side-effects.
 *
 * TRUST BOUNDARY & OPERATOR IDENTITY MODEL:
 * - TTY enforcement establishes that an interactive terminal is present, not authenticated human identity.
 * - `isForbiddenAgentName()` rejects recognized automated identity labels, but cannot prove the physical identity of the caller.
 * - A caller with terminal access could potentially declare another operator's identity.
 * - This operation represents operator-attested recovery, not cryptographic authentication or guaranteed prevention of agent impersonation.
 */
export async function recoverBlockedStage(
  targetDir: string,
  options: RecoverStageOptions
): Promise<RecoverStageResult> {
  const resolvedDir = path.resolve(targetDir);
  const statePath = path.join(resolvedDir, DEFAULT_PATHS.stateFile);

  if (!fs.existsSync(statePath)) {
    throw new TransactionError(
      "PROJECT_UNINITIALIZED",
      "Cannot recover: project is not initialized (.playbook/state.json missing)."
    );
  }

  // Operator identification & validation
  const operatorName = options.operatorName?.trim();
  if (!operatorName) {
    throw new TransactionError(
      "RECOVERY_BLOCKED",
      "Authorizing operator name is required for controlled recovery."
    );
  }

  if (isForbiddenAgentName(operatorName)) {
    throw new TransactionError(
      "AGENT_RECOVERY_FORBIDDEN",
      `Operator identity "${operatorName}" matches an automated AI agent pattern. Automated agents are strictly forbidden from recovering blocked stages.`
    );
  }

  const role = options.role?.trim();
  if (!role) {
    throw new TransactionError(
      "RECOVERY_BLOCKED",
      "Authorizing operator professional engineering role is required."
    );
  }

  const reason = options.reason?.trim();
  if (!reason || reason.length < 10) {
    throw new TransactionError(
      "RECOVERY_REASON_REQUIRED",
      "A substantive recovery reason (minimum 10 characters) explaining root cause remediation is required."
    );
  }

  const txManager =
    options.txManager ||
    new WriteAheadTransactionManager({
      targetDir: resolvedDir,
    });

  const now = options.now || new Date();
  const isoTimestamp = now.toISOString();

  let finalTxId = "";
  let auditLogRelative = "";
  let finalStage = 0;
  let finalStageName = "";

  await txManager.lockManager.withLock(
    async (lockHandle) => {
      // Step 0: Crash Recovery of any interrupted prior transaction
      await txManager.recover(lockHandle);

      // Step 1: Read fresh state under exclusive lock
      const rawState = fs.readFileSync(statePath, "utf-8");
      const freshDiskHash = computeSha256(rawState);
      const freshState = JSON.parse(rawState) as ProjectState;

      finalStage = freshState.current_stage;
      finalStageName =
        freshState.current_stage_detail?.stage_name ||
        STAGE_NAMES[finalStage as StageNumber] ||
        `Stage ${finalStage}`;

      if (options.stage !== undefined && options.stage !== finalStage) {
        throw new TransactionError(
          "GATE_MISMATCH",
          `Requested recovery for Stage ${options.stage}, but current active stage is Stage ${finalStage}.`
        );
      }

      if (freshState.stage_status !== "blocked") {
        throw new TransactionError(
          "STAGE_NOT_BLOCKED",
          `Stage ${finalStage} is in '${freshState.stage_status}' status, not 'blocked'. Recovery is only permitted for blocked stages.`
        );
      }

      // Transition stage_status: 'blocked' -> 'in_progress' ONLY
      freshState.stage_status = "in_progress";
      freshState.last_updated = {
        timestamp: isoTimestamp,
        updated_by: `human:${operatorName}`,
        actor_type: "human",
        reason: `Operator-attested recovery: ${reason}`,
      };

      // Assemble append-only recovery audit log
      const safeTs = isoTimestamp.replace(/[:.]/g, "-");
      auditLogRelative = `.playbook/logs/recovery-stage-${finalStage}-${safeTs}.log`;
      const auditLogAbsolute = path.join(resolvedDir, auditLogRelative);

      const logsDir = path.join(resolvedDir, DEFAULT_PATHS.logsDir);
      fs.mkdirSync(logsDir, { recursive: true });

      const logHeader = [
        "=== PLAYBOOK CONTROLLED OPERATOR-ATTESTED RECOVERY AUDIT LOG ===",
        `Stage:                ${finalStage} (${finalStageName})`,
        `Lifecycle Status:     ${freshState.lifecycle_status}`,
        `Timestamp:            ${isoTimestamp}`,
        `Attested Operator:    ${operatorName}`,
        `Attested Role:        ${role}`,
        "Identity Confidence:  Operator-attested via interactive TTY session (Non-cryptographic; does not verify physical identity or prevent impersonation)",
        `Previous Status:      blocked`,
        `New Status:           in_progress`,
        `Recovery Rationale:   ${reason}`,
        "----------------------------------------------------",
        "Governance Invariants Enforced:",
        "1. This operation transitions stage_status from 'blocked' to 'in_progress' ONLY.",
        "2. Zero deliverables are marked verified as a result of this recovery.",
        "3. Prior failing gate execution evidence remains fully intact and auditable.",
        "4. Required stage quality checks MUST be executed again to earn passing evidence.",
        "5. Formal human gate approval remains mandatory prior to stage advancement.",
        "6. Operator attestation does not provide cryptographic non-repudiation.",
        "====================================================",
        "",
      ].join("\n");

      const serializedState = JSON.stringify(freshState, null, 2) + "\n";

      const fileOperations = [
        {
          operation: "write" as const,
          targetPath: auditLogRelative,
          content: logHeader,
          createOnly: true,
        },
        {
          operation: "write" as const,
          targetPath: DEFAULT_PATHS.stateFile,
          content: serializedState,
          expectedPreviousSha256: freshDiskHash,
        },
      ];

      const journal = await txManager.prepare(
        "RECOVER_BLOCKED_STAGE",
        fileOperations,
        lockHandle
      );

      await txManager.commit(journal, lockHandle);
      finalTxId = journal.tx_id;
    },
    { timeoutMs: txManager.lockTimeoutMs }
  );

  return {
    success: true,
    stage: finalStage,
    stageName: finalStageName,
    operatorName,
    role,
    reason,
    txId: finalTxId,
    auditLogPath: auditLogRelative,
    timestamp: isoTimestamp,
  };
}
