import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runInspect } from "../src/commands/inspect.js";
import { createInitialManifest } from "../src/templates/manifest-template.js";
import { createInitialState } from "../src/templates/state-template.js";
import { ProjectScaffolder } from "../src/core/scaffold.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");
const examplesDir = path.resolve(__dirname, "../../../../schemas/examples");

describe("Governance State Inspection & Diagnostics (playbook inspect)", () => {
  let tempDir: string;
  const scaffolder = new ProjectScaffolder();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-inspect-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("diagnoses uninitialized project with remediation guidance", () => {
    const res = runInspect({ cwd: tempDir, json: true, silent: true });

    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.report.initialized, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "PROJECT_UNINITIALIZED"));
    assert.match(res.output, /playbook init/);
  });

  test("diagnoses missing manifest (.playbook/manifest.json missing) with safe non-destructive remediation", () => {
    const state = createInitialState({ projectId: "test-app" });
    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    const d = res.report.diagnostics.find((issue) => issue.code === "MANIFEST_MISSING");
    assert.ok(d);
    assert.doesNotMatch(d.remediation, /--force/);
    assert.match(d.remediation, /version control/);
  });

  test("diagnoses missing state (.playbook/state.json missing) with safe non-destructive remediation", () => {
    const manifest = createInitialManifest({ projectId: "test-app", projectName: "Test App" });
    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    const d = res.report.diagnostics.find((issue) => issue.code === "STATE_MISSING");
    assert.ok(d);
    assert.doesNotMatch(d.remediation, /--force/);
    assert.match(d.remediation, /version control/);
  });

  test("diagnoses malformed JSON syntax in governance files", () => {
    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), "{ invalid json syntax ");
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), "{ another bad syntax");

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "MANIFEST_MALFORMED"));
    assert.ok(res.report.diagnostics.some((d) => d.code === "STATE_MALFORMED"));
  });

  test("diagnoses schema-invalid manifest and state", () => {
    const invalidManifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "invalid-manifest.json"), "utf-8"));
    const invalidState = JSON.parse(
      fs.readFileSync(path.join(examplesDir, "invalid-state-agent-self-approval.json"), "utf-8")
    );

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(invalidManifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(invalidState, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "MANIFEST_SCHEMA_INVALID"));
    assert.ok(res.report.diagnostics.some((d) => d.code === "STATE_SCHEMA_INVALID"));
  });

  test("diagnoses valid Stage 0 initialized project (needs_attention)", () => {
    const manifest = createInitialManifest({
      projectId: "fresh-app",
      projectName: "Fresh Application",
      ecosystem: "node",
      primaryLanguage: "typescript",
    });
    const state = createInitialState({ projectId: "fresh-app" });

    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.initialized, true);
    assert.equal(res.report.manifest_valid, true);
    assert.equal(res.report.state_valid, true);
    assert.equal(res.report.readiness.status, "needs_attention");
    assert.equal(res.report.stage?.number, 0);
    assert.equal(res.report.deliverables_summary.not_started, 1);
  });

  test("diagnoses active milestone mismatch between manifest and state", () => {
    const manifest = createInitialManifest({
      projectId: "mismatch-app",
      projectName: "Mismatch App",
      activeMilestoneId: "M-1.0.0",
    });
    const state = createInitialState({
      projectId: "mismatch-app",
      milestoneId: "M-2.0.0", // Mismatch
    });

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "MILESTONE_MISMATCH"));
  });

  test("diagnoses blocking RFC and sets readiness to blocked", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "invalid-state-unresolved-rfc.json"), "utf-8"));

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "RFC_BLOCKING_UNRESOLVED"));
    assert.equal(res.report.rfcs_summary.blocking_unresolved, 1);
  });

  test("diagnoses expired exception and sets readiness to blocked", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "invalid-state-expired-exception.json"), "utf-8"));

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "EXCEPTION_EXPIRED"));
    assert.equal(res.report.exceptions_summary.expired, 1);
  });

  test("diagnoses verified deliverables pending human review (ready_for_human_review)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage1-verified.json"), "utf-8"));

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.report.readiness.status, "ready_for_human_review");
    assert.equal(res.report.deliverables_summary.verified, 2);
    assert.ok(res.report.diagnostics.some((d) => d.code === "STAGE_PENDING_REVIEW"));
  });

  test("diagnoses approved stage with active waiver (approved)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 2;

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.report.readiness.status, "approved");
    assert.equal(res.report.stage?.status, "approved");
    assert.equal(res.report.deliverables_summary.waived, 1);
    assert.ok(res.report.diagnostics.some((d) => d.code === "STAGE_APPROVED"));
    assert.ok(res.report.diagnostics.some((d) => d.code === "DELIVERABLE_WAIVED"));
  });

  test("diagnoses completed terminal lifecycle", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 6;
    state.current_stage = 6;
    state.current_stage_detail.stage = 6;
    state.current_stage_detail.stage_name = "Deployment & Operational Monitoring";
    state.lifecycle_status = "completed_terminal";

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.report.readiness.status, "completed_terminal");
    assert.ok(res.report.diagnostics.some((d) => d.code === "LIFECYCLE_COMPLETED_TERMINAL"));
  });

  test("evaluates exception expiration boundary deterministically in UTC (inclusive calendar day)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 2;
    state.current_stage_detail.exceptions = [
      {
        exception_id: "EXC-20261031-001",
        title: "Temporary waiver for staging smoke test",
        path: "governance/exceptions/EXC-20261031-001.md",
        waived_requirement: "REQ-SMOKE-01",
        authorized_by: "Lead Architect",
        authorized_at: "2026-10-15T00:00:00Z",
        expiration_date: "2026-10-31",
        status: "active"
      }
    ];

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    // Instant 1: End of day on expiration date (23:59:59.000Z) -> Active (inclusive)
    const resActive = runInspect({
      cwd: tempDir,
      json: true,
      silent: true,
      now: new Date("2026-10-31T23:59:59.000Z")
    });
    assert.equal(resActive.report.exceptions_summary.active, 1);
    assert.equal(resActive.report.exceptions_summary.expired, 0);
    assert.ok(resActive.report.diagnostics.some((d) => d.code === "EXCEPTION_ACTIVE"));
    assert.ok(!resActive.report.diagnostics.some((d) => d.code === "EXCEPTION_EXPIRED"));

    // Instant 2: Beginning of next day (00:00:01.000Z) -> Expired
    const resExpired = runInspect({
      cwd: tempDir,
      json: true,
      silent: true,
      now: new Date("2026-11-01T00:00:01.000Z")
    });
    assert.equal(resExpired.report.exceptions_summary.expired, 1);
    assert.ok(resExpired.report.diagnostics.some((d) => d.code === "EXCEPTION_EXPIRED"));
    assert.equal(resExpired.report.readiness.status, "blocked");
  });

  test("does not treat remediated exception with past expiration date as expired", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 2;
    state.current_stage_detail.exceptions = [
      {
        exception_id: "EXC-20260101-001",
        title: "Historical remediated waiver",
        path: "governance/exceptions/EXC-20260101-001.md",
        waived_requirement: "REQ-LEGACY-01",
        authorized_by: "Security Lead",
        authorized_at: "2026-01-01T00:00:00Z",
        expiration_date: "2026-01-15",
        status: "remediated"
      }
    ];

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({
      cwd: tempDir,
      json: true,
      silent: true,
      now: new Date("2026-10-31T12:00:00Z")
    });
    assert.equal(res.report.exceptions_summary.remediated, 1);
    assert.equal(res.report.exceptions_summary.expired, 0);
    assert.ok(!res.report.diagnostics.some((d) => d.code === "EXCEPTION_EXPIRED"));
  });

  test("enforces gate criteria invariant: pending_review with incomplete deliverables raises GATE_CRITERIA_UNMET and blocks readiness", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage1-verified.json"), "utf-8"));
    state.current_stage_detail.deliverables.push({
      id: "DELIV-103",
      name: "Unfinished Security Model",
      description: "Incomplete security model spec.",
      artifact_path: "docs/prd/security.md",
      status: "in_progress",
      validation_status: "unvalidated",
      exception_ref: null,
      evidence: []
    });

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "GATE_CRITERIA_UNMET"));
  });

  test("enforces terminal lifecycle consistency: completed_terminal requires Stage 6 approval", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    state.lifecycle_status = "completed_terminal";

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "LIFECYCLE_STATE_INCONSISTENT"));
  });

  test("readiness assessment: blockers strictly take precedence over approved stage status", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 2;
    state.current_stage_detail.exceptions.push({
      exception_id: "EXC-20260901-099",
      title: "Expired temporary waiver",
      path: "governance/exceptions/EXC-20260901-099.md",
      waived_requirement: "REQ-STAGING-01",
      authorized_by: "Architect",
      authorized_at: "2026-09-01T00:00:00Z",
      expiration_date: "2026-09-30",
      status: "expired"
    });

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.notEqual(res.report.readiness.status, "approved");
    assert.ok(res.report.diagnostics.some((d) => d.code === "EXCEPTION_EXPIRED"));
  });

  test("readiness assessment: Stage 6 approved specifies CLOSE_LIFECYCLE rather than advance", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 6;
    state.current_stage = 6;
    state.current_stage_detail.stage = 6;
    state.current_stage_detail.stage_name = "Deployment & Operational Monitoring";
    state.stage_status = "approved";
    state.lifecycle_status = "active";

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.report.readiness.status, "approved");
    assert.match(res.report.readiness.summary, /CLOSE_LIFECYCLE/);
    assert.doesNotMatch(res.report.readiness.summary, /ADVANCE_STAGE/);
  });

  test("source-of-truth consistency: state.current_stage is authoritative when manifest drifts", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-manifest.json"), "utf-8"));
    const state = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf-8"));
    manifest.active_lifecycle_stage = 1;
    state.current_stage = 2;

    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.report.stage?.number, 2);
    assert.ok(res.report.diagnostics.some((d) => d.code === "STAGE_MISMATCH"));
    const mismatch = res.report.diagnostics.find((d) => d.code === "STAGE_MISMATCH");
    assert.equal(mismatch?.severity, "warning");
    assert.match(mismatch?.message || "", /authoritative source of truth/);
  });

  test("CLI executable: formats human-readable and machine-readable JSON output correctly", async () => {
    const manifest = createInitialManifest({
      projectId: "e2e-inspect-app",
      projectName: "E2E Inspect App",
    });
    const state = createInitialState({ projectId: "e2e-inspect-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    // 1. Human-readable terminal output
    const { stdout: textOut } = await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir]);
    assert.match(textOut, /AI Engineering Playbook — Project Inspection/);
    assert.match(textOut, /Project Identity & Standards/);
    assert.match(textOut, /E2E Inspect App/);
    assert.match(textOut, /Deliverables Breakdown:/);
    assert.match(textOut, /Preliminary Readiness Assessment/);
    assert.match(textOut, /NEEDS ATTENTION/);

    // 2. Machine-readable JSON output
    const { stdout: jsonOut } = await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir, "--json"]);
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.schema_version, "1.0.0");
    assert.equal(parsed.initialized, true);
    assert.equal(parsed.project.id, "e2e-inspect-app");
    assert.equal(parsed.readiness.status, "needs_attention");
    assert.ok(Array.isArray(parsed.diagnostics));
  });

  test("strictly enforces read-only behaviour (zero filesystem modifications)", async () => {
    const manifest = createInitialManifest({
      projectId: "readonly-app",
      projectName: "Readonly App",
    });
    const state = createInitialState({ projectId: "readonly-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
    const statePath = path.join(tempDir, ".playbook", "state.json");

    const manifestMtimeBefore = fs.statSync(manifestPath).mtimeMs;
    const stateMtimeBefore = fs.statSync(statePath).mtimeMs;
    const filesBefore = fs.readdirSync(path.join(tempDir, ".playbook"));

    // Run inspection multiple times
    runInspect({ cwd: tempDir, json: false });
    runInspect({ cwd: tempDir, json: true });
    await execFileAsync("node", [cliBinPath, "inspect", "--cwd", tempDir]);

    const manifestMtimeAfter = fs.statSync(manifestPath).mtimeMs;
    const stateMtimeAfter = fs.statSync(statePath).mtimeMs;
    const filesAfter = fs.readdirSync(path.join(tempDir, ".playbook"));

    // Assert zero file mutations or file additions
    assert.equal(manifestMtimeAfter, manifestMtimeBefore);
    assert.equal(stateMtimeAfter, stateMtimeBefore);
    assert.deepEqual(filesAfter, filesBefore);
  });
});
