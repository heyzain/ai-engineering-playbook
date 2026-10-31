import type { GovernanceProfile, ApprovalMode, Capability } from "../constants.js";

export interface ProjectManifest {
  $schema: string;
  schema_version: string;
  project_id: string;
  project_name: string;
  active_milestone_id: string;
  description?: string;
  playbook: {
    version: string;
    repository_uri?: string;
    governance_profile: GovernanceProfile;
    approval_mode: ApprovalMode;
  };
  tech_stack: {
    ecosystem: string;
    primary_language: string;
    runtimes?: string[];
    frameworks?: string[];
    package_manager?: string;
  };
  paths: {
    docs_root: string;
    prd_dir: string;
    adr_dir: string;
    rfc_dir: string;
    gates_dir: string;
    exceptions_dir: string;
    state_file: string;
  };
  active_lifecycle_stage: number;
  capabilities: Capability[];
  metadata?: Record<string, unknown>;
}
