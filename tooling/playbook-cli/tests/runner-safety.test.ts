import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { removeTempFixture } from "./fixtures/temp.js";
import { QualityGateRunner } from "../src/core/quality-gates/runner.js";

test("synchronous process-launch rejection persists failed proof without verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-runner-safety-"));
  const fixture = setupStageProject(root, { stage: 0, status: "in_progress" });
  const target = fixture.state.current_stage_detail.deliverables[0];
  target.status = "completed";
  target.validation_status = "unvalidated";
  target.evidence = [];
  fs.writeFileSync(fixture.statePath, JSON.stringify(fixture.state));
  fs.writeFileSync(path.join(root, ".playbook/quality-gates.json"), JSON.stringify({
    $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
    schema_version: "1.0.0", project_id: fixture.state.project_id, default_profile: "standard",
    global_settings: { default_timeout_ms: 30000, max_concurrency: 1, mask_secrets: true, log_retention_runs: 5, max_journaled_log_bytes: 1048576, env_allowlist: ["PATH"] },
    gates: [{ stage: 0, stage_name: "Discovery & Problem Formulation", checks: [{
      id: "launch", name: "Launch rejection", type: "automated_test", deliverable_id: target.id,
      command: "node", args: ["--version"], inputs: ["docs/prd/PRD-CORE.md"], severity: "blocking"
    }] }]
  }));
  const spawn = mock.method(childProcess, "spawn", (() => { throw new Error("SYNTHETIC_PROCESS_LAUNCH_DENIED"); }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    const report = await new QualityGateRunner(root).run({ stage: 0 });
    assert.equal(report.overall_outcome, "failed");
    assert.match(report.checks[0].error_message || "", /SYNTHETIC_PROCESS_LAUNCH_DENIED/);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.current_stage_detail.deliverables[0].status, "in_progress");
    const evidence = state.current_stage_detail.deliverables[0].evidence.at(-1);
    assert.equal(evidence.result, "failed");
    assert.ok(fs.existsSync(path.join(root, evidence.evidence_ref)));
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    removeTempFixture(root);
  }
});
