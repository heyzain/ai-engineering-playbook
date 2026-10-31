import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EvidenceVerifier } from "../src/core/evidence/verifier.js";
import { runVerifyEvidence } from "../src/commands/verify-evidence.js";
import { createInitialManifest } from "../src/templates/manifest-template.js";
import { createInitialState } from "../src/templates/state-template.js";
import { ProjectScaffolder } from "../src/core/scaffold.js";
import type { ProjectState } from "../src/types/state.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");

function createSha256(content: string | Buffer): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `sha256:${hash}`;
}

describe("Evidence Verification Engine (playbook verify-evidence)", () => {
  let tempDir: string;
  const scaffolder = new ProjectScaffolder();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-evidence-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("verifies existing evidence file without a hash (existence_verified)", () => {
    const manifest = createInitialManifest({ projectId: "evidence-app", projectName: "Evidence App" });
    const state = createInitialState({ projectId: "evidence-app" });

    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const logRelPath = ".playbook/logs/manual-checklist.log";
    const logAbsPath = path.join(tempDir, logRelPath);
    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    fs.writeFileSync(logAbsPath, "Manual architectural review completed by lead engineer.\n");

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-001",
        type: "architecture_review",
        procedure: "Manual inspection against Constitution",
        result: "passed",
        summary: "Verified all constitutional invariants.",
        exit_code: null,
        commit_sha: "7b3f9a1",
        evidence_hash: null,
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "human:lead",
        actor_type: "human",
      },
    ];

    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runVerifyEvidence({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.summary.total, 1);
    assert.equal(res.report.summary.existence_verified, 1);
    assert.equal(res.report.summary.integrity_passed, 0);
    assert.equal(res.report.items[0].status, "existence_verified");
    assert.equal(res.report.items[0].hash_matched, null);
    assert.ok(res.report.items[0].calculated_hash?.startsWith("sha256:"));
    assert.ok(res.report.diagnostics.some((d) => d.code === "EVIDENCE_NO_HASH"));
  });

  test("verifies existing evidence file with matching SHA-256 hash (integrity_passed)", () => {
    const manifest = createInitialManifest({ projectId: "evidence-app", projectName: "Evidence App" });
    const state = createInitialState({ projectId: "evidence-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const logRelPath = ".playbook/logs/unit-tests.log";
    const logAbsPath = path.join(tempDir, logRelPath);
    const content = "PASS: 48 tests passed, 0 failures, 100% assertions green.\n";
    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    fs.writeFileSync(logAbsPath, content);

    const calculatedHash = createSha256(content);

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-002",
        type: "automated_test",
        procedure: "npm test",
        result: "passed",
        summary: "All unit tests pass.",
        exit_code: 0,
        commit_sha: "7b3f9a1",
        evidence_hash: calculatedHash,
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:05:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runVerifyEvidence({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.summary.integrity_passed, 1);
    assert.equal(res.report.items[0].status, "integrity_passed");
    assert.equal(res.report.items[0].hash_matched, true);
    assert.equal(res.report.items[0].recorded_hash, calculatedHash);
  });

  test("diagnoses existing evidence file with mismatched SHA-256 hash (integrity_failed)", () => {
    const manifest = createInitialManifest({ projectId: "evidence-app", projectName: "Evidence App" });
    const state = createInitialState({ projectId: "evidence-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const logRelPath = ".playbook/logs/linter.log";
    const logAbsPath = path.join(tempDir, logRelPath);
    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    fs.writeFileSync(logAbsPath, "Actual current linter output.\n");

    const forgedHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-003",
        type: "static_analysis",
        procedure: "eslint .",
        result: "passed",
        summary: "Zero lint errors.",
        exit_code: 0,
        commit_sha: "7b3f9a1",
        evidence_hash: forgedHash,
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:10:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runVerifyEvidence({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.report.summary.integrity_failed, 1);
    assert.equal(res.report.items[0].status, "integrity_failed");
    assert.equal(res.report.items[0].hash_matched, false);
    assert.ok(res.report.diagnostics.some((d) => d.code === "EVIDENCE_HASH_MISMATCH"));
  });

  test("diagnoses missing evidence file (missing)", () => {
    const manifest = createInitialManifest({ projectId: "evidence-app", projectName: "Evidence App" });
    const state = createInitialState({ projectId: "evidence-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-004",
        type: "automated_test",
        procedure: "npm run test:e2e",
        result: "passed",
        summary: "E2E suites passed.",
        exit_code: 0,
        commit_sha: "7b3f9a1",
        evidence_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        evidence_ref: ".playbook/logs/missing-e2e.log",
        verified_at: "2026-10-31T10:15:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const res = runVerifyEvidence({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.report.summary.missing, 1);
    assert.equal(res.report.items[0].status, "missing");
    assert.ok(res.report.diagnostics.some((d) => d.code === "EVIDENCE_FILE_MISSING"));
  });

  test("diagnoses invalid or malformed evidence reference", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "test",
        exit_code: 0,
        evidence_ref: "",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "test",
        exit_code: 0,
        evidence_ref: "logs/\0nullbyte.log",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.invalid_reference, 2);
    assert.equal(report.all_passed, false);
    assert.equal(report.items[0].status, "invalid_reference");
    assert.equal(report.items[1].status, "invalid_reference");
  });

  test("diagnoses and blocks path traversal attempt escaping project root", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });
    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "security_audit",
        procedure: "audit",
        result: "passed",
        summary: "traversal test",
        exit_code: 0,
        evidence_ref: "../../secret-credentials.json",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.invalid_reference, 1);
    assert.equal(report.all_passed, false);
    assert.equal(report.items[0].status, "invalid_reference");
    assert.match(report.items[0].details, /Path traversal detected/);
    assert.ok(report.diagnostics.some((d) => d.code === "EVIDENCE_PATH_INVALID"));
  });

  test("diagnoses and blocks symlink escape attempt pointing outside project boundary", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-outside-dir-"));
    const outsideFile = path.join(outsideDir, "outside-secret.log");
    fs.writeFileSync(outsideFile, "Sensitive host file\n");

    const symlinkRelPath = ".playbook/logs/symlink-escape.log";
    const symlinkAbsPath = path.join(tempDir, symlinkRelPath);
    fs.mkdirSync(path.dirname(symlinkAbsPath), { recursive: true });

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, symlinkAbsPath);
      symlinkCreated = true;
    } catch {
      // Symlinks may require elevated privileges on certain Windows configurations
    }

    if (symlinkCreated) {
      const verifier = new EvidenceVerifier();
      const state = createInitialState({ projectId: "evidence-app" });
      state.current_stage_detail.deliverables[0].evidence = [
        {
          requirement_id: null,
          type: "static_analysis",
          procedure: "check",
          result: "passed",
          summary: "symlink test",
          exit_code: 0,
          evidence_ref: symlinkRelPath,
          verified_at: "2026-10-31T10:00:00Z",
          verified_by: "agent:controller",
          actor_type: "agent",
        },
      ];

      const report = verifier.verify(tempDir, state);
      assert.equal(report.summary.invalid_reference, 1);
      assert.equal(report.all_passed, false);
      assert.equal(report.items[0].status, "invalid_reference");
      assert.match(report.items[0].details, /Symlink traversal detected/);
    }

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test("safely handles unreadable file or directory target error", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    // Target path is a directory, not a verifiable file
    const dirTargetRel = ".playbook/logs/directory-target.log";
    fs.mkdirSync(path.join(tempDir, dirTargetRel), { recursive: true });

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "directory test",
        exit_code: 0,
        evidence_ref: dirTargetRel,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.unreadable, 1);
    assert.equal(report.all_passed, false);
    assert.equal(report.items[0].status, "unreadable");
    assert.match(report.items[0].details, /directory, not a verifiable file/);
    assert.ok(report.diagnostics.some((d) => d.code === "EVIDENCE_UNREADABLE"));
  });

  test("correctly evaluates multiple evidence records with mixed outcomes", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    // Item 1: integrity_passed
    const log1 = ".playbook/logs/test1.log";
    const content1 = "Pass 1\n";
    fs.mkdirSync(path.join(tempDir, ".playbook", "logs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, log1), content1);

    // Item 2: existence_verified
    const log2 = ".playbook/logs/test2.log";
    fs.writeFileSync(path.join(tempDir, log2), "Pass 2\n");

    // Item 3: integrity_failed
    const log3 = ".playbook/logs/test3.log";
    fs.writeFileSync(path.join(tempDir, log3), "Pass 3\n");

    // Item 4: missing
    const log4 = ".playbook/logs/test4-missing.log";

    // Item 5: unreadable (directory target)
    const log5 = ".playbook/logs/test5-dir.log";
    fs.mkdirSync(path.join(tempDir, log5), { recursive: true });

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-01",
        type: "automated_test",
        procedure: "p1",
        result: "passed",
        summary: "s1",
        exit_code: 0,
        evidence_hash: createSha256(content1),
        evidence_ref: log1,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: "REQ-02",
        type: "manual_functional",
        procedure: "p2",
        result: "passed",
        summary: "s2",
        exit_code: null,
        evidence_hash: null,
        evidence_ref: log2,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "human:tester",
        actor_type: "human",
      },
      {
        requirement_id: "REQ-03",
        type: "static_analysis",
        procedure: "p3",
        result: "passed",
        summary: "s3",
        exit_code: 0,
        evidence_hash: "sha256:badhash0000000000000000000000000000000000000000000000000000000000",
        evidence_ref: log3,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: "REQ-04",
        type: "security_audit",
        procedure: "p4",
        result: "passed",
        summary: "s4",
        exit_code: 0,
        evidence_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        evidence_ref: log4,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: "REQ-05",
        type: "automated_test",
        procedure: "p5",
        result: "passed",
        summary: "s5",
        exit_code: 0,
        evidence_ref: log5,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.total, 5);
    assert.equal(report.summary.integrity_passed, 1);
    assert.equal(report.summary.existence_verified, 1);
    assert.equal(report.summary.integrity_failed, 1);
    assert.equal(report.summary.missing, 1);
    assert.equal(report.summary.unreadable, 1);
    assert.equal(report.all_passed, false);
  });

  test("evidence recorded as 'passed' whose file is missing is strictly flagged as missing defect", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-999",
        type: "automated_test",
        procedure: "npm test",
        result: "passed", // Claimed passed in state
        summary: "Recorded as passed in state",
        exit_code: 0,
        evidence_ref: ".playbook/logs/deleted-evidence.log",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.all_passed, false);
    assert.equal(report.items[0].recorded_result, "passed");
    assert.equal(report.items[0].status, "missing");
    assert.ok(report.diagnostics.some((d) => d.code === "EVIDENCE_FILE_MISSING"));
  });

  test("diagnoses unsupported remote URI reference without accessing network", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "remote",
        result: "passed",
        summary: "remote url test",
        exit_code: 0,
        evidence_ref: "https://jenkins.example.com/job/42/console.log",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.unsupported, 1);
    assert.equal(report.items[0].status, "unsupported");
    assert.match(report.items[0].details, /Remote HTTP\/HTTPS evidence references are not fetched/);
    assert.ok(report.diagnostics.some((d) => d.code === "EVIDENCE_UNSUPPORTED"));
  });

  test("strictly enforces read-only behavior (zero modifications to disk or state)", () => {
    const manifest = createInitialManifest({ projectId: "readonly-evidence", projectName: "Readonly Evidence" });
    const state = createInitialState({ projectId: "readonly-evidence" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const logRelPath = ".playbook/logs/test.log";
    const logAbsPath = path.join(tempDir, logRelPath);
    const content = "Test log\n";
    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    fs.writeFileSync(logAbsPath, content);

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "test",
        exit_code: 0,
        evidence_hash: createSha256(content),
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const statePath = path.join(tempDir, ".playbook", "state.json");
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const stateMtimeBefore = fs.statSync(statePath).mtimeMs;
    const logMtimeBefore = fs.statSync(logAbsPath).mtimeMs;
    const filesBefore = fs.readdirSync(path.join(tempDir, ".playbook", "logs"));

    runVerifyEvidence({ cwd: tempDir, json: false });
    runVerifyEvidence({ cwd: tempDir, json: true });

    const stateMtimeAfter = fs.statSync(statePath).mtimeMs;
    const logMtimeAfter = fs.statSync(logAbsPath).mtimeMs;
    const filesAfter = fs.readdirSync(path.join(tempDir, ".playbook", "logs"));

    assert.equal(stateMtimeAfter, stateMtimeBefore);
    assert.equal(logMtimeAfter, logMtimeBefore);
    assert.deepEqual(filesAfter, filesBefore);
  });

  test("CLI executable: formats human-readable and machine-readable output for verify-evidence", async () => {
    const manifest = createInitialManifest({ projectId: "cli-evidence-app", projectName: "CLI Evidence App" });
    const state = createInitialState({ projectId: "cli-evidence-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const logRelPath = ".playbook/logs/cli-test.log";
    const logAbsPath = path.join(tempDir, logRelPath);
    const content = "CLI test output\n";
    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    fs.writeFileSync(logAbsPath, content);

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-CLI-01",
        type: "automated_test",
        procedure: "npm test",
        result: "passed",
        summary: "CLI test pass",
        exit_code: 0,
        evidence_hash: createSha256(content),
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    // 1. Human-readable terminal output
    const { stdout: textOut } = await execFileAsync("node", [cliBinPath, "verify-evidence", "--cwd", tempDir]);
    assert.match(textOut, /AI Engineering Playbook — Evidence Verification/);
    assert.match(textOut, /Evidence Verification Summary/);
    assert.match(textOut, /Integrity Passed:/);
    assert.match(textOut, /PASS: INTEGRITY/);
    assert.match(textOut, /EVIDENCE VERIFICATION PASSED/);
    assert.match(textOut, /Non-Negotiable Boundaries & Scientific Limitations:/);

    // 2. Machine-readable JSON output
    const { stdout: jsonOut } = await execFileAsync("node", [cliBinPath, "verify-evidence", "--cwd", tempDir, "--json"]);
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.schema_version, "1.0.0");
    assert.equal(parsed.all_passed, true);
    assert.equal(parsed.summary.integrity_passed, 1);
    assert.equal(parsed.items[0].status, "integrity_passed");
    assert.ok(Array.isArray(parsed.limitations));
  });

  test("diagnoses and rejects malformed evidence_hash format (EVIDENCE_HASH_MALFORMED)", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    const logRelPath = ".playbook/logs/hash-malformed.log";
    fs.mkdirSync(path.join(tempDir, ".playbook", "logs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, logRelPath), "Test content\n");

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "test",
        exit_code: 0,
        evidence_hash: "sha256:not_valid_hex_string",
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "test",
        exit_code: 0,
        evidence_hash: "",
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.integrity_failed, 2);
    assert.equal(report.all_passed, false);
    assert.ok(report.diagnostics.some((d) => d.code === "EVIDENCE_HASH_MALFORMED"));
  });

  test("strictly compares SHA-256 hashes case-insensitively with canonical schema pattern", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    const logRelPath = ".playbook/logs/case-test.log";
    const content = "Case sensitivity test\n";
    fs.mkdirSync(path.join(tempDir, ".playbook", "logs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, logRelPath), content);

    const lowercaseHash = createSha256(content);
    const uppercaseHash = lowercaseHash.toUpperCase();

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "test",
        exit_code: 0,
        evidence_hash: uppercaseHash,
        evidence_ref: logRelPath,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.integrity_passed, 1);
    assert.equal(report.all_passed, true);
    assert.equal(report.items[0].hash_matched, true);
  });

  test("rejects absolute, drive-relative, and UNC path references as invalid_reference", () => {
    const verifier = new EvidenceVerifier();
    const state = createInitialState({ projectId: "evidence-app" });

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "absolute posix path",
        exit_code: 0,
        evidence_ref: "/etc/shadow",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "absolute windows drive path",
        exit_code: 0,
        evidence_ref: "C:\\Windows\\System32\\cmd.exe",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "UNC network share path",
        exit_code: 0,
        evidence_ref: "\\\\storage-server\\logs\\build.log",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "drive-relative path",
        exit_code: 0,
        evidence_ref: "C:relative.log",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];

    const report = verifier.verify(tempDir, state);
    assert.equal(report.summary.invalid_reference, 4);
    assert.equal(report.all_passed, false);
    for (const item of report.items) {
      assert.equal(item.status, "invalid_reference");
      assert.match(item.details, /relative path within project root/);
    }
  });

  test("enforces read-only behavior on failure paths: zero filesystem or state mutations", () => {
    const manifest = createInitialManifest({ projectId: "readonly-fail-app", projectName: "Readonly Fail App" });
    const state = createInitialState({ projectId: "readonly-fail-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const statePath = path.join(tempDir, ".playbook", "state.json");
    const manifestPath = path.join(tempDir, ".playbook", "manifest.json");

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: null,
        type: "automated_test",
        procedure: "test",
        result: "passed",
        summary: "missing file",
        exit_code: 0,
        evidence_ref: ".playbook/logs/missing.log",
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const stateMtimeBefore = fs.statSync(statePath).mtimeMs;
    const manifestMtimeBefore = fs.statSync(manifestPath).mtimeMs;
    const filesBefore = fs.readdirSync(path.join(tempDir, ".playbook"));

    const res = runVerifyEvidence({ cwd: tempDir, json: true, silent: true });
    assert.equal(res.success, false);
    assert.equal(res.exitCode, 1);

    const stateMtimeAfter = fs.statSync(statePath).mtimeMs;
    const manifestMtimeAfter = fs.statSync(manifestPath).mtimeMs;
    const filesAfter = fs.readdirSync(path.join(tempDir, ".playbook"));

    assert.equal(stateMtimeAfter, stateMtimeBefore);
    assert.equal(manifestMtimeAfter, manifestMtimeBefore);
    assert.deepEqual(filesAfter, filesBefore);
  });

  test("verifies consistency between human-readable terminal report and machine-readable JSON output", () => {
    const manifest = createInitialManifest({ projectId: "consistency-app", projectName: "Consistency App" });
    const state = createInitialState({ projectId: "consistency-app" });
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    const log1 = ".playbook/logs/pass.log";
    const content1 = "Pass\n";
    fs.mkdirSync(path.join(tempDir, ".playbook", "logs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, log1), content1);

    state.current_stage_detail.deliverables[0].evidence = [
      {
        requirement_id: "REQ-C1",
        type: "automated_test",
        procedure: "p1",
        result: "passed",
        summary: "pass",
        exit_code: 0,
        evidence_hash: createSha256(content1),
        evidence_ref: log1,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
      {
        requirement_id: "REQ-C2",
        type: "automated_test",
        procedure: "p2",
        result: "passed",
        summary: "fail",
        exit_code: 0,
        evidence_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        evidence_ref: log1,
        verified_at: "2026-10-31T10:00:00Z",
        verified_by: "agent:controller",
        actor_type: "agent",
      },
    ];
    fs.writeFileSync(path.join(tempDir, ".playbook", "state.json"), JSON.stringify(state, null, 2));

    const jsonRes = runVerifyEvidence({ cwd: tempDir, json: true, silent: true });
    const termRes = runVerifyEvidence({ cwd: tempDir, json: false, silent: true });

    assert.equal(jsonRes.exitCode, termRes.exitCode);
    assert.equal(jsonRes.success, termRes.success);
    assert.match(termRes.output, /Total Records Inspected:\s+2/);
    assert.match(termRes.output, /Integrity Passed:\s+1/);
    assert.match(termRes.output, /Integrity Failed:\s+1/);
    assert.equal(jsonRes.report.summary.total, 2);
    assert.equal(jsonRes.report.summary.integrity_passed, 1);
    assert.equal(jsonRes.report.summary.integrity_failed, 1);
  });
});
