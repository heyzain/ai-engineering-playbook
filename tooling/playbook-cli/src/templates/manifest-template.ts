import {
  PLAYBOOK_VERSION,
  SCHEMA_VERSION,
  MANIFEST_SCHEMA_URI,
  DEFAULT_PATHS,
  type GovernanceProfile,
  type ApprovalMode,
  type Capability,
} from "../constants.js";
import type { ProjectManifest } from "../types/manifest.js";

export interface CreateManifestOptions {
  projectId: string;
  projectName: string;
  activeMilestoneId?: string;
  description?: string;
  playbookVersion?: string;
  repositoryUri?: string;
  governanceProfile?: GovernanceProfile;
  approvalMode?: ApprovalMode;
  ecosystem?: string;
  primaryLanguage?: string;
  runtimes?: string[];
  frameworks?: string[];
  packageManager?: string;
  capabilities?: Capability[];
  metadata?: Record<string, unknown>;
}

export function createInitialManifest(options: CreateManifestOptions): ProjectManifest {
  const milestoneId = options.activeMilestoneId || "M-1.0.0";
  const defaultCapabilities: Capability[] = [
    "automated_testing",
    "contract_testing",
    "static_type_checking",
    "ast_linting",
  ];

  return {
    $schema: MANIFEST_SCHEMA_URI,
    schema_version: SCHEMA_VERSION,
    project_id: options.projectId,
    project_name: options.projectName,
    active_milestone_id: milestoneId,
    description: options.description || `${options.projectName} - governed by the AI Engineering Playbook`,
    playbook: {
      version: options.playbookVersion || PLAYBOOK_VERSION,
      repository_uri: options.repositoryUri,
      governance_profile: options.governanceProfile || "standard",
      approval_mode: options.approvalMode || "solo",
    },
    tech_stack: {
      ecosystem: options.ecosystem || "agnostic",
      primary_language: options.primaryLanguage || "agnostic",
      runtimes: options.runtimes,
      frameworks: options.frameworks,
      package_manager: options.packageManager,
    },
    paths: {
      docs_root: DEFAULT_PATHS.docsRoot,
      prd_dir: DEFAULT_PATHS.prdDir,
      adr_dir: DEFAULT_PATHS.adrDir,
      rfc_dir: DEFAULT_PATHS.rfcDir,
      gates_dir: DEFAULT_PATHS.gatesDir,
      exceptions_dir: DEFAULT_PATHS.exceptionsDir,
      state_file: DEFAULT_PATHS.stateFile,
    },
    active_lifecycle_stage: 0,
    capabilities: options.capabilities || defaultCapabilities,
    metadata: options.metadata,
  };
}
