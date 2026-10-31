import type { StageNumber } from "../constants.js";
import type { Deliverable } from "../types/state.js";

/**
 * Returns canonical baseline deliverables for a given lifecycle stage.
 */
export function getStageBaselineDeliverables(stage: StageNumber): Deliverable[] {
  switch (stage) {
    case 0:
      return [
        {
          id: "PRD-CORE",
          name: "Problem Statement Document (PRD Core)",
          description: "Core problem formulation, user goals, non-goals, and measurable success metrics.",
          artifact_path: "docs/prd/PRD-CORE.md",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    case 1:
      return [
        {
          id: "REQ-SPEC",
          name: "Requirements & Specification Document",
          description: "System requirements specification, functional user stories, non-functional criteria, and acceptance definitions.",
          artifact_path: "docs/prd/REQUIREMENTS-SPEC.md",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    case 2:
      return [
        {
          id: "ARCH-SPEC",
          name: "System Architecture Specification",
          description: "Technical structure, component decomposition, data models, contracts, and architectural decisions.",
          artifact_path: "docs/adr/ARCHITECTURE-SPEC.md",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    case 3:
      return [
        {
          id: "CODE-IMPL",
          name: "Production Source Code Implementation",
          description: "Clean, modular production source code satisfying architectural design and specifications.",
          artifact_path: "src/",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    case 4:
      return [
        {
          id: "INT-TESTS",
          name: "Integration & System Verification Suite",
          description: "Automated integration test suite verifying inter-module contracts and subsystem interactions.",
          artifact_path: "tests/integration/",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    case 5:
      return [
        {
          id: "SEC-AUDIT",
          name: "Security, Hardening & Release Package",
          description: "Comprehensive code review audit, vulnerability scan, release notes, and deployment runbook.",
          artifact_path: "docs/audits/RELEASE-HARDENING.md",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    case 6:
      return [
        {
          id: "DEPLOY-LOG",
          name: "Deployment Execution & Monitoring Log",
          description: "Deployment execution steps, post-deployment smoke test results, and operational telemetry baseline.",
          artifact_path: "docs/ops/DEPLOYMENT-LOG.md",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ];
    default:
      throw new Error(`Invalid stage number ${stage}: stage must be between 0 and 6.`);
  }
}
