import test, { describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  RuleRegistry,
  LinterEngine,
  DefaultRuleExecutionContext,
  ruleSchemaManifestValidity,
  ruleSchemaStateValidity,
  ruleSchemaGatesValidity,
  ruleCfgStackDeclaration,
  SCHEMA_RULES,
  DOCUMENTATION_RULES,
  type RuleFinding,
} from "../src/core/linters/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to create valid fixture files
function writeValidManifest(targetDir: string, overrides: Record<string, unknown> = {}): void {
  const playbookDir = path.join(targetDir, ".playbook");
  fs.mkdirSync(playbookDir, { recursive: true });

  const manifest = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    project_name: "Test Governance Project",
    active_milestone_id: "M-1.0.0",
    description: "Test description",
    playbook: {
      version: "1.0.0",
      governance_profile: "standard",
      approval_mode: "solo",
    },
    tech_stack: {
      ecosystem: "node",
      primary_language: "typescript",
      runtimes: ["node20"],
      frameworks: ["nextjs"],
      package_manager: "npm",
    },
    paths: {
      docs_root: "docs",
      prd_dir: "docs/prd",
      adr_dir: "docs/adr",
      rfc_dir: "docs/rfcs",
      gates_dir: "docs/gates",
      exceptions_dir: "docs/exceptions",
      state_file: ".playbook/state.json",
    },
    active_lifecycle_stage: 0,
    capabilities: ["automated_testing"],
    technology_stacks: ["nextjs"],
    ...overrides,
  };

  fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

function writeValidState(targetDir: string, overrides: Record<string, unknown> = {}): void {
  const playbookDir = path.join(targetDir, ".playbook");
  fs.mkdirSync(playbookDir, { recursive: true });

  const state = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    playbook_version: "1.0.0",
    milestone_id: "M-1.0.0",
    milestone_name: "M-1.0.0 Initial Release",
    lifecycle_status: "active",
    current_stage: 0,
    stage_status: "not_started",
    current_stage_detail: {
      stage: 0,
      stage_name: "Discovery & Problem Formulation",
      started_at: "2026-11-07T00:00:00.000Z",
      deliverables: [
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
      ],
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "not_drafted",
        path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        submitted_at: null,
      },
      human_approval: {
        status: "not_requested",
        approved_by: null,
        role: null,
        approval_mode: "solo",
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    },
    stage_history: [],
    archived_milestones: [],
    last_updated: {
      timestamp: "2026-11-07T00:00:00.000Z",
      updated_by: "playbook-cli",
      actor_type: "human",
      reason: "Test state initialization",
    },
    ...overrides,
  };

  fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
}

function writeValidQualityGates(targetDir: string, overrides: Record<string, unknown> = {}): void {
  const playbookDir = path.join(targetDir, ".playbook");
  fs.mkdirSync(playbookDir, { recursive: true });

  const gates = {
    $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    default_profile: "standard",
    global_settings: {
      default_timeout_ms: 30000,
      max_concurrency: 2,
      mask_secrets: true,
      log_retention_runs: 10,
      max_journaled_log_bytes: 1048576,
      env_allowlist: ["PATH", "NODE_ENV"],
    },
    gates: [
      {
        stage: 0,
        stage_name: "Discovery & Problem Formulation",
        checks: [
          {
            id: "prd-audit",
            name: "PRD Structural Audit",
            type: "static_analysis",
            deliverable_id: "PRD-CORE",
            command: "node",
            args: ["scripts/audit-prd.mjs"],
            inputs: ["docs/prd/PRD-CORE.md"],
            severity: "blocking",
          },
        ],
      },
    ],
    ...overrides,
  };

  fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(gates, null, 2), "utf-8");
}

describe("Task 008B.3: Category B Schema & Configuration Integrity Rules", () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-schema-test-"));
  });

  test.afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RULE-SCHEMA-MANIFEST-VALIDITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. RULE-SCHEMA-MANIFEST-VALIDITY", () => {
    test("passes cleanly on valid project manifest", async () => {
      writeValidManifest(tmpDir);
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags missing required property in manifest with MANIFEST_SCHEMA_VIOLATION", async () => {
      writeValidManifest(tmpDir);
      const manifestPath = path.join(tmpDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      delete manifest.playbook; // required property
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MANIFEST_SCHEMA_VIOLATION" && f.message.includes("playbook")));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags invalid property type with MANIFEST_SCHEMA_VIOLATION", async () => {
      writeValidManifest(tmpDir, { active_lifecycle_stage: "stage-zero" }); // must be integer
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MANIFEST_SCHEMA_VIOLATION" && f.message.includes("type")));
    });

    test("flags unsupported enum value with MANIFEST_SCHEMA_VIOLATION", async () => {
      writeValidManifest(tmpDir);
      const manifestPath = path.join(tmpDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.playbook.governance_profile = "invalid-profile"; // must be strict|standard|lightweight
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MANIFEST_SCHEMA_VIOLATION"));
    });

    test("flags prohibited additional property with MANIFEST_SCHEMA_VIOLATION", async () => {
      writeValidManifest(tmpDir, { unexpected_top_level_prop: true });
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MANIFEST_SCHEMA_VIOLATION" && f.message.includes("unexpected_top_level_prop")));
    });

    test("flags missing manifest file with MANIFEST_MISSING", async () => {
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "MANIFEST_MISSING");
      assert.strictEqual(findings[0].filePath, ".playbook/manifest.json");
    });

    test("flags malformed JSON with MANIFEST_PARSE_ERROR", async () => {
      const playbookDir = path.join(tmpDir, ".playbook");
      fs.mkdirSync(playbookDir, { recursive: true });
      fs.writeFileSync(path.join(playbookDir, "manifest.json"), "{ invalid json: true, ", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaManifestValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "MANIFEST_PARSE_ERROR");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. RULE-SCHEMA-STATE-VALIDITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. RULE-SCHEMA-STATE-VALIDITY", () => {
    test("passes cleanly on valid project state", async () => {
      writeValidState(tmpDir);
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaStateValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags invalid schema structure with STATE_SCHEMA_VIOLATION", async () => {
      writeValidState(tmpDir);
      const statePath = path.join(tmpDir, ".playbook", "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      delete state.milestone_id; // required property
      state.current_stage = 99; // maximum is 6
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaStateValidity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "STATE_SCHEMA_VIOLATION"));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags malformed JSON with STATE_PARSE_ERROR", async () => {
      const playbookDir = path.join(tmpDir, ".playbook");
      fs.mkdirSync(playbookDir, { recursive: true });
      fs.writeFileSync(path.join(playbookDir, "state.json"), '{"malformed": }', "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaStateValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "STATE_PARSE_ERROR");
    });

    test("flags missing state file with STATE_MISSING", async () => {
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaStateValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "STATE_MISSING");
    });

    test("preserves read-only behavior without state or WAL mutation", async () => {
      writeValidState(tmpDir);
      const statePath = path.join(tmpDir, ".playbook", "state.json");
      const beforeContent = fs.readFileSync(statePath, "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      await ruleSchemaStateValidity.evaluate(context);

      const afterContent = fs.readFileSync(statePath, "utf-8");
      assert.strictEqual(beforeContent, afterContent);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", ".lock")), false);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", "journal.json")), false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RULE-SCHEMA-GATES-VALIDITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. RULE-SCHEMA-GATES-VALIDITY", () => {
    test("passes cleanly on valid quality gates configuration", async () => {
      writeValidQualityGates(tmpDir);
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaGatesValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags invalid gate structure with GATES_SCHEMA_VIOLATION", async () => {
      writeValidQualityGates(tmpDir);
      const gatesPath = path.join(tmpDir, ".playbook", "quality-gates.json");
      const gates = JSON.parse(fs.readFileSync(gatesPath, "utf-8"));
      delete gates.global_settings; // required
      fs.writeFileSync(gatesPath, JSON.stringify(gates, null, 2), "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaGatesValidity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "GATES_SCHEMA_VIOLATION" && f.message.includes("global_settings")));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags malformed JSON with GATES_PARSE_ERROR", async () => {
      const playbookDir = path.join(tmpDir, ".playbook");
      fs.mkdirSync(playbookDir, { recursive: true });
      fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), "{ broken: json ]", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaGatesValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "GATES_PARSE_ERROR");
    });

    test("flags missing quality gates configuration with GATES_CONFIG_MISSING", async () => {
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleSchemaGatesValidity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "GATES_CONFIG_MISSING");
    });

    test("strictly read-only: does not execute quality gates or modify disk", async () => {
      writeValidQualityGates(tmpDir);
      const gatesPath = path.join(tmpDir, ".playbook", "quality-gates.json");
      const beforeContent = fs.readFileSync(gatesPath, "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      await ruleSchemaGatesValidity.evaluate(context);

      const afterContent = fs.readFileSync(gatesPath, "utf-8");
      assert.strictEqual(beforeContent, afterContent);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", "logs")), false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RULE-CFG-STACK-DECLARATION
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. RULE-CFG-STACK-DECLARATION", () => {
    test("passes cleanly on valid single-stack declaration (nextjs)", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["nextjs"] });
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly on valid multi-stack declaration (react-native, expo)", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["react-native", "expo"] });
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags unknown or malformed stack ID with UNKNOWN_STACK_ID", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["Invalid_CamelCase!"] });
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNKNOWN_STACK_ID"));
    });

    test("flags missing stack definition with STACK_DEFINITION_MISSING", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["nonexistent-stack-xyz"] });
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "STACK_DEFINITION_MISSING"));
    });

    test("flags missing stack dependency with STACK_DEPENDENCY_MISSING", async () => {
      // Create a local isolated stacks directory where stack-custom requires stack-missing
      const customStacksDir = path.join(tmpDir, "stacks");
      fs.mkdirSync(path.join(customStacksDir, "stack-custom"), { recursive: true });
      fs.writeFileSync(
        path.join(customStacksDir, "stack-custom", "stack.json"),
        JSON.stringify({
          name: "Custom Stack",
          version: "1.0.0",
          dependencies: ["stack-missing"],
        }),
        "utf-8"
      );

      writeValidManifest(tmpDir, { technology_stacks: ["stack-custom"] });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "STACK_DEPENDENCY_MISSING"));
    });

    test("flags circular dependency with CIRCULAR_STACK_DEPENDENCY", async () => {
      const customStacksDir = path.join(tmpDir, "stacks");
      fs.mkdirSync(path.join(customStacksDir, "stack-a"), { recursive: true });
      fs.mkdirSync(path.join(customStacksDir, "stack-b"), { recursive: true });

      fs.writeFileSync(
        path.join(customStacksDir, "stack-a", "stack.json"),
        JSON.stringify({ name: "Stack A", version: "1.0.0", dependencies: ["stack-b"] }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(customStacksDir, "stack-b", "stack.json"),
        JSON.stringify({ name: "Stack B", version: "1.0.0", dependencies: ["stack-a"] }),
        "utf-8"
      );

      writeValidManifest(tmpDir, { technology_stacks: ["stack-a"] });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "CIRCULAR_STACK_DEPENDENCY"));
    });

    test("flags conflicting stack configuration without packageOverrides with STACK_CONFIG_CONFLICT", async () => {
      const customStacksDir = path.join(tmpDir, "stacks");
      const stackADir = path.join(customStacksDir, "stack-alpha");
      const stackBDir = path.join(customStacksDir, "stack-beta");

      fs.mkdirSync(path.join(stackADir, "template"), { recursive: true });
      fs.mkdirSync(path.join(stackBDir, "template"), { recursive: true });

      fs.writeFileSync(
        path.join(stackADir, "stack.json"),
        JSON.stringify({ name: "Stack Alpha", version: "1.0.0", dependencies: [] }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(stackADir, "template", "package.json"),
        JSON.stringify({ dependencies: { "shared-lib": "1.0.0" } }),
        "utf-8"
      );

      fs.writeFileSync(
        path.join(stackBDir, "stack.json"),
        JSON.stringify({ name: "Stack Beta", version: "1.0.0", dependencies: [] }),
        "utf-8"
      );
      // Conflicting version of shared-lib without packageOverrides
      fs.writeFileSync(
        path.join(stackBDir, "template", "package.json"),
        JSON.stringify({ dependencies: { "shared-lib": "2.0.0" } }),
        "utf-8"
      );

      writeValidManifest(tmpDir, { technology_stacks: ["stack-alpha", "stack-beta"] });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "STACK_CONFIG_CONFLICT"));
    });

    test("flags Expo declared without React Native prerequisite with STACK_PREREQUISITE_INCONSISTENCY", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["expo"] }); // lacks 'react-native'
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleCfgStackDeclaration.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "STACK_PREREQUISITE_INCONSISTENCY"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Engine Integration & Regression Consistency
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Engine Integration & Regression Consistency", () => {
    test("runs all 4 Category B rules via LinterEngine producing clean passed status on valid project", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["react-native", "expo"] });
      writeValidState(tmpDir);
      writeValidQualityGates(tmpDir);

      const registry = new RuleRegistry();
      for (const rule of SCHEMA_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.summary.blocking, 0);
    });

    test("repeated execution produces identical canonical output (idempotence)", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["expo"] }); // will emit 1 finding for prerequisite
      writeValidState(tmpDir);
      writeValidQualityGates(tmpDir);

      const registry = new RuleRegistry();
      for (const rule of SCHEMA_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      const result1 = await engine.run({ projectDir: tmpDir });
      const result2 = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result1.status, result2.status);
      assert.strictEqual(result1.findings.length, result2.findings.length);
      assert.deepStrictEqual(result1.findings, result2.findings);
    });

    test("deduplicates identical findings and preserves stable diagnostic codes", async () => {
      writeValidManifest(tmpDir);
      // Empty tmpDir state/gates will emit missing findings
      const registry = new RuleRegistry();
      for (const rule of SCHEMA_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });
      assert.strictEqual(result.status, "failed");
      assert.ok(result.findings.length >= 2);

      // Verify each emitted finding is distinct in the deduplicated collection
      const keys = result.findings.map(
        (f) => `${f.ruleId}:${f.diagnosticCode}:${f.filePath}:${f.line}:${f.column}:${f.message}`
      );
      const uniqueKeys = new Set(keys);
      assert.strictEqual(keys.length, uniqueKeys.size, "Findings must be deduplicated");
    });

    test("executes Category A and Category B rules concurrently without mutual interference", async () => {
      writeValidManifest(tmpDir, { technology_stacks: ["nextjs"] });
      writeValidState(tmpDir);
      writeValidQualityGates(tmpDir);

      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Project Readme\n[Valid Link](README.md)");

      const registry = new RuleRegistry();
      for (const rule of [...DOCUMENTATION_RULES, ...SCHEMA_RULES]) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
    });

    test("strictly read-only: does not mutate state or WAL during linting", async () => {
      writeValidManifest(tmpDir);
      writeValidState(tmpDir);
      writeValidQualityGates(tmpDir);

      const manifestPath = path.join(tmpDir, ".playbook", "manifest.json");
      const statePath = path.join(tmpDir, ".playbook", "state.json");
      const gatesPath = path.join(tmpDir, ".playbook", "quality-gates.json");

      const mBefore = fs.readFileSync(manifestPath, "utf-8");
      const sBefore = fs.readFileSync(statePath, "utf-8");
      const gBefore = fs.readFileSync(gatesPath, "utf-8");

      const registry = new RuleRegistry();
      for (const rule of SCHEMA_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      await engine.run({ projectDir: tmpDir });

      assert.strictEqual(fs.readFileSync(manifestPath, "utf-8"), mBefore);
      assert.strictEqual(fs.readFileSync(statePath, "utf-8"), sBefore);
      assert.strictEqual(fs.readFileSync(gatesPath, "utf-8"), gBefore);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", "journal.json")), false);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", ".lock")), false);
    });
  });
});
