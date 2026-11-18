import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaValidator } from "../src/core/validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveExamplesDir(): string {
  const candidates = [
    path.resolve(__dirname, "../../../schemas/examples"),
    path.resolve(__dirname, "../../../../schemas/examples"),
    path.resolve(process.cwd(), "schemas/examples"),
    path.resolve(process.cwd(), "../../schemas/examples"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "valid-manifest.json"))) {
      return candidate;
    }
  }
  throw new Error(`Could not locate schemas/examples directory. Checked:\n${candidates.join("\n")}`);
}

function resolveRootSchemasDir(): string {
  const candidates = [
    path.resolve(__dirname, "../../../schemas"),
    path.resolve(__dirname, "../../../../schemas"),
    path.resolve(process.cwd(), "schemas"),
    path.resolve(process.cwd(), "../../schemas"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "project-manifest.schema.json"))) {
      return candidate;
    }
  }
  throw new Error(`Could not locate root schemas directory. Checked:\n${candidates.join("\n")}`);
}

const examplesDir = resolveExamplesDir();
const rootSchemasDir = resolveRootSchemasDir();

describe("SchemaValidator Core", () => {
  const validator = new SchemaValidator();

  test("initializes successfully and exposes schemas", () => {
    const manifestSchema = validator.getManifestSchema();
    const stateSchema = validator.getStateSchema();

    assert.ok(manifestSchema);
    assert.equal(manifestSchema["$id"], "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json");
    assert.ok(stateSchema);
    assert.equal(stateSchema["$id"], "https://ai-engineering-playbook.org/schemas/project-state.schema.json");
  });

  test("bundled schemas match canonical root schemas byte-for-byte", () => {
    const rootManifest = fs.readFileSync(path.join(rootSchemasDir, "project-manifest.schema.json"), "utf-8");
    const rootState = fs.readFileSync(path.join(rootSchemasDir, "project-state.schema.json"), "utf-8");

    const bundledManifest = JSON.stringify(validator.getManifestSchema(), null, 2);
    const bundledState = JSON.stringify(validator.getStateSchema(), null, 2);

    assert.deepEqual(JSON.parse(bundledManifest), JSON.parse(rootManifest));
    assert.deepEqual(JSON.parse(bundledState), JSON.parse(rootState));
  });

  test("validates canonical valid-manifest.json fixture successfully", () => {
    const fixturePath = path.join(examplesDir, "valid-manifest.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateManifest(data);
    assert.equal(result.valid, true, `Expected valid manifest, got: ${result.formattedErrors}`);
    assert.equal(result.errors.length, 0);
  });

  test("validates canonical valid-state-stage1-verified.json fixture successfully", () => {
    const fixturePath = path.join(examplesDir, "valid-state-stage1-verified.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateState(data);
    assert.equal(result.valid, true, `Expected valid state, got: ${result.formattedErrors}`);
    assert.equal(result.errors.length, 0);
  });

  test("validates canonical valid-state-stage2-approved.json fixture successfully", () => {
    const fixturePath = path.join(examplesDir, "valid-state-stage2-approved.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateState(data);
    assert.equal(result.valid, true, `Expected valid state, got: ${result.formattedErrors}`);
    assert.equal(result.errors.length, 0);
  });

  test("correctly rejects canonical invalid-manifest.json fixture", () => {
    const fixturePath = path.join(examplesDir, "invalid-manifest.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateManifest(data);
    assert.equal(result.valid, false, "Expected invalid manifest to fail");
    assert.ok(result.errors.length >= 4, "Expected multiple validation errors");

    const formatted = result.formattedErrors;
    assert.match(formatted, /Schema validation failed/);
  });

  test("correctly rejects canonical invalid-state-agent-self-approval.json fixture", () => {
    const fixturePath = path.join(examplesDir, "invalid-state-agent-self-approval.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateState(data);
    assert.equal(result.valid, false, "Expected agent self-approval to fail validation");
    assert.ok(result.errors.length > 0, "Expected validation errors for agent self-approval");
    assert.ok(
      result.errors.some((e) => e.instancePath.includes("actor_type") || e.keyword === "const" || e.keyword === "if"),
      "Expected actor_type human sovereignty failure"
    );
  });

  test("correctly rejects canonical invalid-state-unverified-advance.json fixture", () => {
    const fixturePath = path.join(examplesDir, "invalid-state-unverified-advance.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateState(data);
    assert.equal(result.valid, false, "Expected unverified advancement to fail validation");
    assert.ok(result.errors.length > 0, "Expected validation errors for unverified advancement");
    assert.ok(
      result.errors.some(
        (e) =>
          e.instancePath.includes("validation_status") ||
          e.instancePath.includes("evidence") ||
          e.keyword === "minItems" ||
          e.keyword === "const"
      ),
      "Expected deliverable verification evidence failure"
    );
  });

  test("correctly rejects canonical invalid-state-unresolved-rfc.json fixture", () => {
    const fixturePath = path.join(examplesDir, "invalid-state-unresolved-rfc.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateState(data);
    assert.equal(result.valid, false, "Expected unresolved blocking RFC to fail validation");
    assert.ok(result.errors.length > 0, "Expected validation errors for blocking RFC");
    assert.ok(
      result.errors.some((e) => e.instancePath.includes("rfcs") || e.keyword === "not"),
      "Expected blocking RFC failure"
    );
  });

  test("correctly rejects canonical invalid-state-expired-exception.json fixture", () => {
    const fixturePath = path.join(examplesDir, "invalid-state-expired-exception.json");
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    const result = validator.validateState(data);
    assert.equal(result.valid, false, "Expected expired exception to fail validation");
    assert.ok(result.errors.length > 0, "Expected validation errors for expired exception");
    assert.ok(
      result.errors.some((e) => e.instancePath.includes("exceptions") || e.keyword === "not"),
      "Expected expired exception failure"
    );
  });

  test("rejects manifest with missing required fields", () => {
    const invalidManifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      // missing project_id, project_name, etc.
    };

    const result = validator.validateManifest(invalidManifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.keyword === "required"));
  });

  test("retired exception history is valid until a waived target still relies on it", () => {
    const data = JSON.parse(fs.readFileSync(path.join(examplesDir, "valid-state-stage2-approved.json"), "utf8"));
    data.current_stage_detail.exceptions = [{ exception_id: "EXC-20261118-001", title: "Historical synthetic waiver", path: "docs/exceptions/EXC-20261118-001.md", waived_requirement: data.current_stage_detail.deliverables[0].id, authorized_by: "Example Engineer", authorized_at: "2026-11-17T00:00:00Z", expiration_date: "2026-11-17", status: "revoked" }];
    for (const status of ["revoked", "expired"]) {
      data.current_stage_detail.exceptions[0].status = status;
      const target = data.current_stage_detail.deliverables[0];
      target.status = "verified"; target.validation_status = "passed"; target.exception_ref = null;
      assert.equal(validator.validateState(data).valid, true);
      target.status = "waived"; target.validation_status = "waived"; target.exception_ref = "EXC-20261118-001";
      const invalid = validator.validateState(data);
      assert.equal(invalid.valid, false);
      assert.ok(invalid.errors.some(e => e.keyword === "exception_ref"));
    }
  });

  test("rejects state with out-of-range stage number (> 6)", () => {
    const validFixturePath = path.join(examplesDir, "valid-state-stage1-verified.json");
    const data = JSON.parse(fs.readFileSync(validFixturePath, "utf-8"));

    data.current_stage = 7; // Illegal: max is 6
    data.current_stage_detail.stage = 7;

    const result = validator.validateState(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.keyword === "maximum" && e.instancePath === "/current_stage"));
  });

  test("rejects state with malformed milestone_id pattern", () => {
    const validFixturePath = path.join(examplesDir, "valid-state-stage1-verified.json");
    const data = JSON.parse(fs.readFileSync(validFixturePath, "utf-8"));

    data.milestone_id = "INVALID_MILESTONE_FORMAT"; // Must match ^M-[a-zA-Z0-9.-]+$

    const result = validator.validateState(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.instancePath === "/milestone_id" && e.keyword === "pattern"));
  });

  test("rejects deliverable with invalid status enum", () => {
    const validFixturePath = path.join(examplesDir, "valid-state-stage1-verified.json");
    const data = JSON.parse(fs.readFileSync(validFixturePath, "utf-8"));

    data.current_stage_detail.deliverables[0].status = "in_review"; // Not in enum

    const result = validator.validateState(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.keyword === "enum"));
  });
});
