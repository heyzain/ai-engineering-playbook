import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectScaffolder, OverwriteProtectionError } from "../src/core/scaffold.js";
import { createInitialManifest } from "../src/templates/manifest-template.js";
import { createInitialState } from "../src/templates/state-template.js";
import { SchemaValidator } from "../src/core/validator.js";

describe("ProjectScaffolder and Template Generation", () => {
  let tempDir: string;
  const validator = new SchemaValidator();
  const scaffolder = new ProjectScaffolder(validator);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-cli-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("scaffolds a fresh downstream project successfully", () => {
    const manifest = createInitialManifest({
      projectId: "test-app",
      projectName: "Test Application",
      ecosystem: "node",
      primaryLanguage: "typescript",
    });

    const state = createInitialState({
      projectId: "test-app",
      approvalMode: "solo",
    });

    const result = scaffolder.scaffold({
      targetDir: tempDir,
      manifest,
      state,
    });

    assert.equal(result.overwritten, false);
    assert.ok(fs.existsSync(result.manifestPath));
    assert.ok(fs.existsSync(result.statePath));

    // Verify folder layout per downstream-storage-convention.md
    assert.ok(fs.existsSync(path.join(tempDir, ".playbook")));
    assert.ok(fs.existsSync(path.join(tempDir, ".playbook/logs")));
    assert.ok(fs.existsSync(path.join(tempDir, "docs/prd")));
    assert.ok(fs.existsSync(path.join(tempDir, "docs/adr")));
    assert.ok(fs.existsSync(path.join(tempDir, "docs/rfcs")));
    assert.ok(fs.existsSync(path.join(tempDir, "docs/gates")));
    assert.ok(fs.existsSync(path.join(tempDir, "docs/exceptions")));

    // Read back written files and validate against schema
    const writtenManifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
    const writtenState = JSON.parse(fs.readFileSync(result.statePath, "utf-8"));

    const manifestVal = validator.validateManifest(writtenManifest);
    assert.equal(manifestVal.valid, true, `Generated manifest invalid: ${manifestVal.formattedErrors}`);

    const stateVal = validator.validateState(writtenState);
    assert.equal(stateVal.valid, true, `Generated state invalid: ${stateVal.formattedErrors}`);

    // Verify Stage 0 baseline
    assert.equal(writtenState.current_stage, 0);
    assert.equal(writtenState.stage_status, "not_started");
    assert.equal(writtenState.current_stage_detail.stage_name, "Discovery & Problem Formulation");
    assert.equal(writtenState.current_stage_detail.deliverables.length, 1);
    assert.equal(writtenState.current_stage_detail.deliverables[0].id, "PRD-CORE");
    assert.equal(writtenState.current_stage_detail.deliverables[0].status, "not_started");
    assert.equal(writtenState.current_stage_detail.human_approval.status, "not_requested");
  });

  test("refuses to overwrite existing governance files without force flag", () => {
    const manifest = createInitialManifest({
      projectId: "first-init",
      projectName: "First Init",
    });
    const state = createInitialState({ projectId: "first-init" });

    // Initial scaffold
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    // Attempt second scaffold without force
    const secondManifest = createInitialManifest({
      projectId: "second-init",
      projectName: "Second Init",
    });
    const secondState = createInitialState({ projectId: "second-init" });

    assert.throws(
      () => {
        scaffolder.scaffold({
          targetDir: tempDir,
          manifest: secondManifest,
          state: secondState,
          force: false,
        });
      },
      (err: Error) => {
        assert.ok(err instanceof OverwriteProtectionError);
        assert.match(err.message, /already exists/);
        return true;
      }
    );

    // Verify original content was NOT modified
    const originalManifest = JSON.parse(
      fs.readFileSync(path.join(tempDir, ".playbook/manifest.json"), "utf-8")
    );
    assert.equal(originalManifest.project_id, "first-init");
  });

  test("allows overwrite when force flag is true", () => {
    const manifest = createInitialManifest({
      projectId: "first-init",
      projectName: "First Init",
    });
    const state = createInitialState({ projectId: "first-init" });

    // Initial scaffold
    scaffolder.scaffold({ targetDir: tempDir, manifest, state });

    // Overwrite with force
    const secondManifest = createInitialManifest({
      projectId: "second-init",
      projectName: "Second Init",
    });
    const secondState = createInitialState({ projectId: "second-init" });

    const result = scaffolder.scaffold({
      targetDir: tempDir,
      manifest: secondManifest,
      state: secondState,
      force: true,
    });

    assert.equal(result.overwritten, true);

    const overwrittenManifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
    assert.equal(overwrittenManifest.project_id, "second-init");
  });

  test("fails fast before touching disk if manifest fails schema validation", () => {
    // Malformed manifest (invalid project_id format with uppercase & spaces)
    const malformedManifest = createInitialManifest({
      projectId: "INVALID PROJECT NAME WITH SPACES",
      projectName: "Invalid Project",
    });
    const state = createInitialState({ projectId: "invalid-project" });

    assert.throws(
      () => {
        scaffolder.scaffold({
          targetDir: tempDir,
          manifest: malformedManifest,
          state,
        });
      },
      (err: Error) => {
        assert.match(err.message, /Manifest schema validation failed/);
        return true;
      }
    );

    // Verify .playbook directory was NOT created
    assert.equal(fs.existsSync(path.join(tempDir, ".playbook")), false);
  });
});
