import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createInitialManifest } from "../src/templates/manifest-template.js";
import { createInitialState } from "../src/templates/state-template.js";
import { SchemaValidator } from "../src/core/validator.js";

describe("Governance Consistency Invariants", () => {
  const validator = new SchemaValidator();

  test("initialization creates valid Stage 0 state conforming to canonical schema", () => {
    const manifest = createInitialManifest({
      projectId: "governance-app",
      projectName: "Governance App",
      ecosystem: "node",
      primaryLanguage: "typescript",
    });

    const state = createInitialState({
      projectId: "governance-app",
      approvalMode: "solo",
    });

    const manifestVal = validator.validateManifest(manifest);
    assert.equal(manifestVal.valid, true);

    const stateVal = validator.validateState(state);
    assert.equal(stateVal.valid, true);

    // Explicit Stage 0 checks
    assert.equal(state.current_stage, 0);
    assert.equal(state.stage_status, "not_started");
    assert.equal(state.current_stage_detail.stage, 0);
    assert.equal(state.current_stage_detail.stage_name, "Discovery & Problem Formulation");
  });

  test("initialization never creates automated approvals or verification claims", () => {
    const state = createInitialState({
      projectId: "sovereignty-test",
      approvalMode: "solo",
    });

    // Human sovereignty guard check
    assert.equal(state.current_stage_detail.human_approval.status, "not_requested");
    assert.equal(state.current_stage_detail.human_approval.approved_by, null);
    assert.equal(state.current_stage_detail.human_approval.decision, null);
    assert.equal(state.current_stage_detail.human_approval.signature_reference, null);
    assert.equal(state.current_stage_detail.human_approval.approved_at, null);

    // Deliverables are unvalidated and not started
    for (const deliv of state.current_stage_detail.deliverables) {
      assert.equal(deliv.status, "not_started");
      assert.equal(deliv.validation_status, "unvalidated");
      assert.equal(deliv.evidence.length, 0);
      assert.equal(deliv.exception_ref, null);
    }

    // Historical ledgers are pristine empty arrays
    assert.equal(state.stage_history.length, 0);
    assert.equal(state.archived_milestones.length, 0);
    assert.equal(state.current_stage_detail.rfcs.length, 0);
    assert.equal(state.current_stage_detail.adrs.length, 0);
    assert.equal(state.current_stage_detail.exceptions.length, 0);
  });

  test("initialization respects stage boundaries (stages 0 to 6)", () => {
    const manifest = createInitialManifest({
      projectId: "stage-boundary-test",
      projectName: "Stage Boundary Test",
    });
    assert.equal(manifest.active_lifecycle_stage, 0);
    assert.ok(manifest.active_lifecycle_stage >= 0 && manifest.active_lifecycle_stage <= 6);
  });
});
