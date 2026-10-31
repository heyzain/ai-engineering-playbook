import {
  PLAYBOOK_VERSION,
  SCHEMA_VERSION,
  STATE_SCHEMA_URI,
  DEFAULT_PATHS,
  type ApprovalMode,
} from "../constants.js";
import type { ProjectState } from "../types/state.js";

export interface CreateStateOptions {
  projectId: string;
  milestoneId?: string;
  milestoneName?: string;
  playbookVersion?: string;
  approvalMode?: ApprovalMode;
  actor?: string;
  actorType?: "human" | "agent";
  reason?: string;
  now?: string;
}

export function createInitialState(options: CreateStateOptions): ProjectState {
  const timestamp = options.now || new Date().toISOString();
  const milestoneId = options.milestoneId || "M-1.0.0";
  const milestoneName = options.milestoneName || "Initial MVP Release";
  const approvalMode = options.approvalMode || "solo";

  return {
    $schema: STATE_SCHEMA_URI,
    schema_version: SCHEMA_VERSION,
    project_id: options.projectId,
    playbook_version: options.playbookVersion || PLAYBOOK_VERSION,
    milestone_id: milestoneId,
    milestone_name: milestoneName,
    lifecycle_status: "active",
    current_stage: 0,
    stage_status: "not_started",
    current_stage_detail: {
      stage: 0,
      stage_name: "Discovery & Problem Formulation",
      started_at: timestamp,
      deliverables: [
        {
          id: "PRD-CORE",
          name: "Problem Statement Document (PRD Core)",
          description: "Core problem formulation, user goals, non-goals, and measurable success metrics.",
          artifact_path: `${DEFAULT_PATHS.prdDir}/PRD-CORE.md`,
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ],
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "not_drafted",
        path: `${DEFAULT_PATHS.gatesDir}/GATE-0-EXIT-PACKAGE.md`,
        submitted_at: null,
      },
      human_approval: {
        status: "not_requested",
        approved_by: null,
        role: null,
        approval_mode: approvalMode,
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    },
    stage_history: [],
    archived_milestones: [],
    last_updated: {
      timestamp,
      updated_by: options.actor || "playbook-cli",
      actor_type: options.actorType || "human",
      reason: options.reason || "Project initialized at Stage 0 (Discovery & Problem Formulation)",
    },
  };
}
