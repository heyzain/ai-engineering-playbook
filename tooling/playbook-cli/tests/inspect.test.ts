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

  test("diagnoses missing manifest (.playbook/manifest.json missing)", () => {
    const state = createInitialState({ projectId: "test-app" });
    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "MANIFEST_MISSING"));
  });

  test("diagnoses missing state (.playbook/state.json missing)", () => {
    const manifest = createInitialManifest({ projectId: "test-app", projectName: "Test App" });
    fs.mkdirSync(path.join(tempDir, ".playbook"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".playbook", "manifest.json"), JSON.stringify(manifest, null, 2));

    const res = runInspect({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.report.readiness.status, "blocked");
    assert.ok(res.report.diagnostics.some((d) => d.code === "STATE_MISSING"));
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
