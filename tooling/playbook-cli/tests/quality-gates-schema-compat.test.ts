import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SchemaValidator } from "../src/core/validator.js";
import { DEFAULT_PATHS } from "../src/constants.js";

describe("Quality Gates Schema Compatibility & Migration Boundaries", () => {
  const validator = new SchemaValidator();

  test("validates valid quality-gates.json against quality-gates.schema.json", () => {
    const validConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "test-project",
      default_profile: "standard",
      global_settings: {
        default_timeout_ms: 60000,
        max_concurrency: 2,
        mask_secrets: true,
        log_retention_runs: 5,
        max_journaled_log_bytes: 1048576,
        env_allowlist: ["NODE_ENV", "PATH"],
      },
      gates: [
        {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          checks: [
            {
              id: "prd-linter",
              name: "PRD Markdown Linter",
              type: "static_analysis",
              deliverable_id: "PRD-CORE",
              command: "node",
              args: ["--version"],
              inputs: ["docs/prd/**/*.md"],
              text_patterns: ["docs/**/*.md"],
            },
          ],
        },
      ],
    };

    const res = validator.validateQualityGates(validConfig);
    assert.equal(res.valid, true, `Validation failed: ${res.formattedErrors}`);
  });

  test("rejects quality-gates.json with undeclared root properties (additionalProperties: false)", () => {
    const invalidConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "test-project",
      default_profile: "standard",
      unexpected_custom_field: "disallowed",
      global_settings: {
        default_timeout_ms: 60000,
        max_concurrency: 2,
        mask_secrets: true,
        log_retention_runs: 5,
        max_journaled_log_bytes: 1048576,
        env_allowlist: ["NODE_ENV"],
      },
      gates: [],
    };

    const res = validator.validateQualityGates(invalidConfig);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.keyword === "additionalProperties"));
  });

  test("backward compatibility: existing v1.0.0 state validates cleanly against v1.1.0 schema", () => {
    // Standard v1.0.0 evidence record (zero new optional fields)
    const v100Evidence = {
      requirement_id: null,
      type: "automated_test",
      procedure: "npm test",
      result: "passed",
      summary: "All unit tests passed",
      exit_code: 0,
      evidence_hash: "sha256:4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92",
      evidence_ref: ".playbook/logs/test.log",
      verified_at: "2026-11-02T12:00:00.000Z",
      verified_by: "agent:quality-gate-engine",
      actor_type: "agent",
    };

    const mockState = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
      schema_version: "1.0.0",
      project_id: "test-project",
      playbook_version: "1.0.0",
      milestone_id: "M-1.0.0",
      milestone_name: "Initial Release",
      lifecycle_status: "active",
      current_stage: 0,
      stage_status: "in_progress",
      current_stage_detail: {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        started_at: "2026-11-02T12:00:00.000Z",
        deliverables: [
          {
            id: "PRD-CORE",
            name: "Problem Statement Document (PRD Core)",
            artifact_path: "docs/prd/PRD-CORE.md",
            status: "verified",
            validation_status: "passed",
            exception_ref: null,
            evidence: [v100Evidence],
          },
        ],
        rfcs: [],
        adrs: [],
        exceptions: [],
        exit_package: {
          status: "not_drafted",
          path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        },
        human_approval: {
          status: "not_requested",
          approved_by: null,
          role: null,
          approval_mode: null,
          decision: null,
          signature_reference: null,
          approved_at: null,
          conditions: null,
        },
      },
      stage_history: [],
      archived_milestones: [],
      last_updated: {
        timestamp: "2026-11-02T12:00:00.000Z",
        updated_by: "agent:quality-gate-engine",
        actor_type: "agent",
        reason: "Initial baseline",
      },
    };

    const res = validator.validateState(mockState);
    assert.equal(res.valid, true, `v1.0.0 state validation failed: ${res.formattedErrors}`);
  });

  test("v1.1.0 state evolution: validates state containing optional rif, working_tree_clean, and quality_gate fields", () => {
    const v110Evidence = {
      requirement_id: null,
      type: "automated_test",
      procedure: "npm test",
      result: "passed",
      summary: "All unit tests passed",
      exit_code: 0,
      evidence_hash: "sha256:4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92",
      evidence_ref: ".playbook/logs/test.log",
      verified_at: "2026-11-02T12:00:00.000Z",
      verified_by: "agent:quality-gate-engine",
      actor_type: "agent",
      rif: "sha256:4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92",
      working_tree_clean: true,
      inputs_hash: "sha256:66663af9c7aa341431a8ee2ff27b72abd06c9218f517bb6fef948e4803c19e03",
      quality_gate: {
        gate_id: "gate-stage-0",
        check_id: "prd-linter",
        duration_ms: 125,
      },
    };

    const mockState = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
      schema_version: "1.1.0",
      transaction_sequence: 0,
      audit_trail: [],
      project_id: "test-project",
      playbook_version: "1.0.0",
      milestone_id: "M-1.0.0",
      milestone_name: "Initial Release",
      lifecycle_status: "active",
      current_stage: 0,
      stage_status: "in_progress",
      current_stage_detail: {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        started_at: "2026-11-02T12:00:00.000Z",
        deliverables: [
          {
            id: "PRD-CORE",
            name: "Problem Statement Document (PRD Core)",
            artifact_path: "docs/prd/PRD-CORE.md",
            status: "verified",
            validation_status: "passed",
            exception_ref: null,
            evidence: [v110Evidence],
          },
        ],
        rfcs: [],
        adrs: [],
        exceptions: [],
        exit_package: {
          status: "not_drafted",
          path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        },
        human_approval: {
          status: "not_requested",
          approved_by: null,
          role: null,
          approval_mode: null,
          decision: null,
          signature_reference: null,
          approved_at: null,
          conditions: null,
        },
      },
      stage_history: [],
      archived_milestones: [],
      last_updated: {
        timestamp: "2026-11-02T12:00:00.000Z",
        updated_by: "agent:quality-gate-engine",
        actor_type: "agent",
        reason: "Recorded v1.1.0 evidence",
      },
    };

    const res = validator.validateState(mockState);
    assert.equal(res.valid, true, `v1.1.0 state validation failed: ${res.formattedErrors}`);
  });

  test("rejects state with undeclared fields in evidence[] (additionalProperties: false)", () => {
    const invalidEvidence = {
      requirement_id: null,
      type: "automated_test",
      procedure: "npm test",
      result: "passed",
      summary: "All unit tests passed",
      exit_code: 0,
      evidence_ref: ".playbook/logs/test.log",
      verified_at: "2026-11-02T12:00:00.000Z",
      verified_by: "agent:quality-gate-engine",
      actor_type: "agent",
      unsupported_arbitrary_field: "should_fail",
    };

    const mockState = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
      schema_version: "1.1.0",
      transaction_sequence: 0,
      audit_trail: [],
      project_id: "test-project",
      playbook_version: "1.0.0",
      milestone_id: "M-1.0.0",
      milestone_name: "Initial Release",
      lifecycle_status: "active",
      current_stage: 0,
      stage_status: "in_progress",
      current_stage_detail: {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        started_at: "2026-11-02T12:00:00.000Z",
        deliverables: [
          {
            id: "PRD-CORE",
            name: "Problem Statement Document (PRD Core)",
            artifact_path: "docs/prd/PRD-CORE.md",
            status: "in_progress",
            validation_status: "unvalidated",
            exception_ref: null,
            evidence: [invalidEvidence],
          },
        ],
        rfcs: [],
        adrs: [],
        exceptions: [],
        exit_package: {
          status: "not_drafted",
          path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        },
        human_approval: {
          status: "not_requested",
          approved_by: null,
          role: null,
          approval_mode: null,
          decision: null,
          signature_reference: null,
          approved_at: null,
          conditions: null,
        },
      },
      stage_history: [],
      archived_milestones: [],
      last_updated: {
        timestamp: "2026-11-02T12:00:00.000Z",
        updated_by: "agent:quality-gate-engine",
        actor_type: "agent",
        reason: "Test",
      },
    };

    const res = validator.validateState(mockState);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.keyword === "additionalProperties"));
  });
});
