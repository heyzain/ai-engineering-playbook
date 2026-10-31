export const PLAYBOOK_VERSION = "1.0.0";
export const SCHEMA_VERSION = "1.0.0";

export const MANIFEST_SCHEMA_URI = "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json";
export const STATE_SCHEMA_URI = "https://ai-engineering-playbook.org/schemas/project-state.schema.json";

export const DEFAULT_PATHS = {
  playbookDir: ".playbook",
  logsDir: ".playbook/logs",
  docsRoot: "docs",
  prdDir: "docs/prd",
  adrDir: "docs/adr",
  rfcDir: "docs/rfcs",
  gatesDir: "docs/gates",
  exceptionsDir: "docs/exceptions",
  manifestFile: ".playbook/manifest.json",
  stateFile: ".playbook/state.json",
} as const;

export const STAGE_NAMES = [
  "Discovery & Problem Formulation",
  "Requirements & Specification",
  "Architecture & System Design",
  "Implementation & Unit Verification",
  "Integration & System Verification",
  "Review, Hardening & Release Readiness",
  "Deployment & Operational Monitoring",
] as const;

export type StageNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type StageName = typeof STAGE_NAMES[number];

export const VALID_GOVERNANCE_PROFILES = ["strict", "standard", "lightweight"] as const;
export type GovernanceProfile = typeof VALID_GOVERNANCE_PROFILES[number];

export const VALID_APPROVAL_MODES = ["solo", "team"] as const;
export type ApprovalMode = typeof VALID_APPROVAL_MODES[number];

export const VALID_CAPABILITIES = [
  "automated_testing",
  "contract_testing",
  "static_type_checking",
  "ast_linting",
  "security_dependency_scanning",
  "threat_modeling",
  "canary_deployments",
  "performance_benchmarks",
  "telemetry_health_checks",
] as const;
export type Capability = typeof VALID_CAPABILITIES[number];
