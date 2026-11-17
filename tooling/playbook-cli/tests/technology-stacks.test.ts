import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SchemaValidator } from "../src/core/validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { StackManager, StackError } from "../src/core/stacks/stack-manager.js";
import { runStackList, runStackApply, runStackCompose } from "../src/commands/stack.js";
import { runInit } from "../src/commands/init.js";
import { computeRif } from "../src/core/quality-gates/rif.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { QualityGatesConfig } from "../src/types/quality-gates.js";
import type { ProjectManifest } from "../src/types/manifest.js";

describe("Modular Technology Stacks & Next.js Reference Stack (Task 007B)", () => {
  let tmpDir: string;
  let repoStacksDir: string;
  let validator: SchemaValidator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-stack-test-"));
    validator = new SchemaValidator();
    // Resolve repo stacks directory by walking up
    let curr = path.resolve(__dirname);
    repoStacksDir = "";
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(curr, "stacks");
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "nextjs"))) {
        repoStacksDir = candidate;
        break;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
    if (!repoStacksDir) {
      repoStacksDir = path.resolve(process.cwd(), "stacks");
    }
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  function createValidBaseManifest(projectDir: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest {
    const manifest: ProjectManifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      project_id: "test-stack-app",
      project_name: "Test Stack App",
      active_milestone_id: "M-1.0.0",
      playbook: {
        version: "1.0.0",
        governance_profile: "standard",
        approval_mode: "solo",
      },
      tech_stack: {
        ecosystem: "node",
        primary_language: "typescript",
      },
      paths: {
        docs_root: "docs",
        prd_dir: "docs/prd",
        adr_dir: "docs/adr",
        rfc_dir: "docs/rfcs",
        gates_dir: "docs/gates",
        exceptions_dir: "governance/exceptions",
        state_file: ".playbook/state.json",
      },
      active_lifecycle_stage: 0,
      capabilities: ["automated_testing", "static_type_checking"],
      ...overrides,
    };

    const playbookDir = path.join(projectDir, DEFAULT_PATHS.playbookDir);
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    return manifest;
  }

  function createValidQualityGatesConfig(projectDir: string): QualityGatesConfig {
    const config: QualityGatesConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "test-stack-app",
      default_profile: "standard",
      global_settings: {
        default_timeout_ms: 30000,
        max_concurrency: 2,
        mask_secrets: true,
        log_retention_runs: 5,
        max_journaled_log_bytes: 1048576,
        env_allowlist: ["NODE_ENV", "PATH"],
      },
      gates: [
        {
          stage: 4,
          stage_name: "Implementation & Local Verification",
          checks: [
            {
              id: "core-schema-check",
              name: "Schema Conformance Check",
              type: "schema_validation",
              deliverable_id: "CODE-IMPL",
              command: "node",
              args: ["-e", "process.exit(0);"],
            },
          ],
        },
      ],
    };

    const playbookDir = path.join(projectDir, DEFAULT_PATHS.playbookDir);
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(config, null, 2), "utf-8");
    return config;
  }

  // ───────────────────────────────────────────────────────────
  // 1. Manifest Schema Evolution & Backward Compatibility
  // ───────────────────────────────────────────────────────────
  describe("Phase 3: Manifest Schema Evolution", () => {
    test("existing manifest without technology_stacks remains 100% valid (backward compatible)", () => {
      const manifest = createValidBaseManifest(tmpDir);
      assert.strictEqual(manifest.technology_stacks, undefined);
      const res = validator.validateManifest(manifest);
      assert.strictEqual(res.valid, true, `Validation failed: ${res.errors.map((e) => e.message).join(", ")}`);
    });

    test("manifest with empty technology_stacks array validates successfully", () => {
      const manifest = createValidBaseManifest(tmpDir, { technology_stacks: [] });
      const res = validator.validateManifest(manifest);
      assert.strictEqual(res.valid, true);
    });

    test("manifest with valid technology_stacks array ['nextjs'] validates successfully", () => {
      const manifest = createValidBaseManifest(tmpDir, { technology_stacks: ["nextjs"] });
      const res = validator.validateManifest(manifest);
      assert.strictEqual(res.valid, true);
    });

    test("manifest rejects invalid stack identifiers (uppercase, spaces, special symbols)", () => {
      const invalidIds = ["NextJS", "next js", "next_js", "next@15", "NEXT", ""];
      for (const invalid of invalidIds) {
        const manifest = createValidBaseManifest(tmpDir, { technology_stacks: [invalid] });
        const res = validator.validateManifest(manifest);
        assert.strictEqual(res.valid, false, `Expected '${invalid}' to fail manifest validation`);
      }
    });

    test("manifest rejects duplicate technology stack identifiers (uniqueItems)", () => {
      const manifest = createValidBaseManifest(tmpDir, { technology_stacks: ["nextjs", "nextjs"] });
      const res = validator.validateManifest(manifest);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.message.includes("duplicate") || e.message.includes("unique")));
    });
  });

  // ───────────────────────────────────────────────────────────
  // 2. Stack Discovery, Metadata & Identifier Validation
  // ───────────────────────────────────────────────────────────
  describe("Phase 1: Stack Definition & Discovery", () => {
    test("StackManager discovers nextjs stack with correct metadata", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const stacks = manager.listStacks();

      assert.ok(stacks.length >= 1);
      const nextjs = stacks.find((s) => s.id === "nextjs");
      assert.ok(nextjs, "nextjs stack must be discovered");
      assert.strictEqual(nextjs.name, "Nextjs");
      assert.strictEqual(nextjs.hasTemplate, true);
      assert.strictEqual(nextjs.hasQualityGates, true);
      assert.strictEqual(nextjs.hasRifPatterns, true);
      assert.ok(nextjs.frameworkTarget.includes("Next.js") || nextjs.frameworkTarget.includes("15"));
    });

    test("validateStackId accepts valid known stack 'nextjs'", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      assert.strictEqual(manager.validateStackId("nextjs"), "nextjs");
    });

    test("validateStackId throws INVALID_STACK_ID on malformed names", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      assert.throws(
        () => manager.validateStackId("Next.JS"),
        (err: unknown) => err instanceof StackError && err.code === "INVALID_STACK_ID"
      );
      assert.throws(
        () => manager.validateStackId("next js"),
        (err: unknown) => err instanceof StackError && err.code === "INVALID_STACK_ID"
      );
    });

    test("validateStackId throws STACK_NOT_FOUND on unconfigured stack", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      assert.throws(
        () => manager.validateStackId("unknown-stack-xyz"),
        (err: unknown) => err instanceof StackError && err.code === "STACK_NOT_FOUND"
      );
    });

    test("loads quality-gates.partial.json and conforms to partial schema", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const partial = manager.loadStackQualityGates("nextjs");

      assert.strictEqual(partial.stack, "nextjs");
      assert.ok(Array.isArray(partial.gates));
      assert.ok(partial.gates.length >= 2, "Must define Stage 4 and Stage 5 gates");

      const stage4 = partial.gates.find((g) => g.stage === 4);
      assert.ok(stage4);
      const checkIds = stage4.checks.map((c) => c.id);
      assert.ok(checkIds.includes("nextjs-typecheck"));
      assert.ok(checkIds.includes("nextjs-lint"));
      assert.ok(checkIds.includes("nextjs-build"));
      assert.ok(checkIds.includes("nextjs-secret-audit"));

      const stage5 = partial.gates.find((g) => g.stage === 5);
      assert.ok(stage5);
      assert.ok(stage5.checks.some((c) => c.id === "nextjs-test"));
    });

    test("loads rif-patterns.json with text, binary, and exclusion globs", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const rif = manager.loadStackRifPatterns("nextjs");

      assert.strictEqual(rif.stack, "nextjs");
      assert.ok(Array.isArray(rif.exclude_patterns));
      assert.ok(rif.exclude_patterns.includes(".next/**"));
      assert.ok(rif.exclude_patterns.includes("out/**"));
      assert.ok(Array.isArray(rif.text_patterns));
      assert.ok(Array.isArray(rif.binary_patterns));
    });
  });

  // ───────────────────────────────────────────────────────────
  // 3. Offline Starter Template Completeness & Invariants
  // ───────────────────────────────────────────────────────────
  describe("Phase 2: Offline Starter Template Completeness", () => {
    test("template contains all approved files adhering to Leaves-Only rule", () => {
      const templateDir = path.join(repoStacksDir, "nextjs", "template");
      assert.ok(fs.existsSync(templateDir));

      const requiredFiles = [
        "package.json.template",
        "tsconfig.json",
        "eslint.config.mjs",
        "next.config.mjs",
        "src/app/layout.tsx",
        "src/app/page.tsx",
        "src/app/loading.tsx",
        "src/app/error.tsx",
        "src/app/not-found.tsx",
        "src/components/counter.tsx",
        "src/lib/env.ts",
        "scripts/audit-secrets.mjs",
      ];

      for (const rel of requiredFiles) {
        const full = path.join(templateDir, rel);
        assert.ok(fs.existsSync(full), `Template file missing: ${rel}`);
      }

      // Verify layout.tsx is Server Component (does NOT have "use client")
      const layoutContent = fs.readFileSync(path.join(templateDir, "src/app/layout.tsx"), "utf-8");
      assert.ok(!layoutContent.includes('"use client"'), "layout.tsx MUST NOT be marked with 'use client'");

      // Verify page.tsx is Server Component (does NOT have "use client")
      const pageContent = fs.readFileSync(path.join(templateDir, "src/app/page.tsx"), "utf-8");
      assert.ok(!pageContent.includes('"use client"'), "page.tsx MUST NOT be marked with 'use client'");

      // Verify error.tsx is Client Component (MUST have "use client")
      const errorContent = fs.readFileSync(path.join(templateDir, "src/app/error.tsx"), "utf-8");
      assert.ok(errorContent.includes('"use client"'), "error.tsx MUST be marked with 'use client'");

      // Verify counter.tsx has "use client" as an interactive leaf
      const counterContent = fs.readFileSync(path.join(templateDir, "src/components/counter.tsx"), "utf-8");
      assert.ok(counterContent.includes('"use client"'), "counter.tsx MUST be marked with 'use client'");
    });

    test("package.json.template has valid syntax, scripts, and FlatCompat dependencies", () => {
      const pkgPath = path.join(repoStacksDir, "nextjs", "template", "package.json.template");
      const content = fs.readFileSync(pkgPath, "utf-8");
      const substituted = content.replace("{{PROJECT_ID}}", "my-test-app");
      const parsed = JSON.parse(substituted);

      assert.strictEqual(parsed.name, "my-test-app");
      assert.ok(parsed.scripts.dev);
      assert.ok(parsed.scripts.build);
      assert.ok(parsed.scripts.lint);
      assert.ok(parsed.scripts.typecheck);
      assert.ok(parsed.scripts["audit:secrets"]);
      assert.ok(parsed.dependencies.next);
      assert.ok(parsed.dependencies.react);
      assert.ok(parsed.devDependencies["@eslint/eslintrc"], "Must declare @eslint/eslintrc for FlatCompat");
    });
  });

  // ───────────────────────────────────────────────────────────
  // 4. Scaffolding, Collisions, Traversal & Symlink Protection
  // ───────────────────────────────────────────────────────────
  describe("Phase 4: Scaffolding Safeguards & Protections", () => {
    test("scaffolds stack into clean directory and updates manifest", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });

      const res = manager.scaffoldStack({
        stackName: "nextjs",
        targetDir: tmpDir,
        projectId: "test-next-app",
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.manifestUpdated, true);
      assert.ok(res.createdFiles.includes("package.json"));
      assert.ok(res.createdFiles.includes("src/app/layout.tsx"));

      // Verify package.json variable replacement
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
      assert.strictEqual(pkg.name, "test-next-app");

      // Verify manifest.json was updated with technology_stacks
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tmpDir, DEFAULT_PATHS.playbookDir, "manifest.json"), "utf-8")
      );
      assert.deepStrictEqual(manifest.technology_stacks, ["nextjs"]);
    });

    test("collision detection blocks overwrite without force: true", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });

      // Create pre-existing package.json
      fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"existing"}', "utf-8");

      assert.throws(
        () =>
          manager.scaffoldStack({
            stackName: "nextjs",
            targetDir: tmpDir,
            force: false,
          }),
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.strictEqual(err.code, "COLLISION_DETECTED");
          const details = err.details as { conflictingFiles: string[] };
          assert.ok(details.conflictingFiles.includes("package.json"));
          return true;
        }
      );

      // Verify existing file was preserved
      const content = fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8");
      assert.strictEqual(content, '{"name":"existing"}');
    });

    test("scaffolds successfully with force: true overwriting collisions", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });

      fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"existing"}', "utf-8");

      const res = manager.scaffoldStack({
        stackName: "nextjs",
        targetDir: tmpDir,
        force: true,
      });

      assert.strictEqual(res.success, true);
      assert.ok(res.overwrittenFiles.includes("package.json"));
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
      assert.notStrictEqual(pkg.name, "existing");
    });

    test("repeated scaffolding with force produces deterministic byte-identical outputs", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });

      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir, force: true, projectId: "det-app" });
      const hash1 = crypto.createHash("sha256").update(fs.readFileSync(path.join(tmpDir, "src/app/page.tsx"))).digest("hex");

      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir, force: true, projectId: "det-app" });
      const hash2 = crypto.createHash("sha256").update(fs.readFileSync(path.join(tmpDir, "src/app/page.tsx"))).digest("hex");

      assert.strictEqual(hash1, hash2, "Repeated execution must produce deterministic identical bytes");
    });

    test("scaffolding does NOT modify project state, stage status, or stage approval", () => {
      createValidBaseManifest(tmpDir);
      const statePath = path.join(tmpDir, DEFAULT_PATHS.playbookDir, "state.json");
      const initialState = {
        $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
        schema_version: "1.1.0",
        project_id: "test-stack-app",
        playbook_version: "1.0.0",
        milestone_id: "M-1.0.0",
        milestone_name: "Initial Release",
        lifecycle_status: "active",
        current_stage: 0,
        stage_status: "in_progress",
        current_stage_detail: {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          started_at: "2026-11-04T12:00:00.000Z",
          deliverables: [],
          rfcs: [],
          adrs: [],
          exceptions: [],
          exit_package: { status: "not_drafted", path: "docs/gates/GATE-0-EXIT-PACKAGE.md" },
          human_approval: { status: "not_requested" },
        },
        stage_history: [],
        archived_milestones: [],
        last_updated: { timestamp: "2026-11-04T12:00:00.000Z", updated_by: "human:lead", actor_type: "human", reason: "Init" },
      };
      fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2), "utf-8");

      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir });

      const afterState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      assert.deepStrictEqual(afterState, initialState, "Governance state must remain completely untouched during stack scaffolding");
    });
  });

  // ───────────────────────────────────────────────────────────
  // 5. Quality Gate Composition & Collision Detection
  // ───────────────────────────────────────────────────────────
  describe("Phase 4: Quality Gate Composition", () => {
    test("composes Next.js partial gates into existing quality-gates.json", () => {
      createValidBaseManifest(tmpDir, { technology_stacks: ["nextjs"] });
      createValidQualityGatesConfig(tmpDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const res = manager.composeQualityGates({ targetDir: tmpDir });

      assert.strictEqual(res.success, true);
      assert.ok(res.addedChecks.length >= 5);

      const qgPath = path.join(tmpDir, DEFAULT_PATHS.playbookDir, "quality-gates.json");
      const updatedConfig = JSON.parse(fs.readFileSync(qgPath, "utf-8")) as QualityGatesConfig;

      // Verify composed config satisfies schema
      const val = validator.validateQualityGates(updatedConfig);
      assert.strictEqual(val.valid, true, `Composed gates failed schema: ${val.errors.map((e) => e.message).join(", ")}`);

      // Verify Stage 4 contains both original and Next.js checks
      const stage4 = updatedConfig.gates.find((g) => g.stage === 4);
      assert.ok(stage4);
      const ids4 = stage4.checks.map((c) => c.id);
      assert.ok(ids4.includes("core-schema-check"));
      assert.ok(ids4.includes("nextjs-typecheck"));
      assert.ok(ids4.includes("nextjs-lint"));
      assert.ok(ids4.includes("nextjs-build"));
      assert.ok(ids4.includes("nextjs-secret-audit"));

      // Verify Stage 5 was created and contains nextjs-test
      const stage5 = updatedConfig.gates.find((g) => g.stage === 5);
      assert.ok(stage5);
      assert.ok(stage5.checks.map((c) => c.id).includes("nextjs-test"));
    });

    test("repeated composition is deterministic and idempotent", () => {
      createValidBaseManifest(tmpDir, { technology_stacks: ["nextjs"] });
      createValidQualityGatesConfig(tmpDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const res1 = manager.composeQualityGates({ targetDir: tmpDir });
      const qgPath = path.join(tmpDir, DEFAULT_PATHS.playbookDir, "quality-gates.json");
      const content1 = fs.readFileSync(qgPath, "utf-8");

      const res2 = manager.composeQualityGates({ targetDir: tmpDir });
      const content2 = fs.readFileSync(qgPath, "utf-8");

      assert.strictEqual(content1, content2, "Repeated composition must be strictly idempotent");
      assert.strictEqual(res2.addedChecks.length, 0, "No new checks added on repeated composition");
    });

    test("gate collision detection rejects conflicting check definition with identical ID", () => {
      createValidBaseManifest(tmpDir, { technology_stacks: ["nextjs"] });
      const qgConfig = createValidQualityGatesConfig(tmpDir);

      // Inject a conflicting check with the same id but conflicting command
      qgConfig.gates[0].checks.push({
        id: "nextjs-typecheck",
        name: "Conflicting Custom Check",
        type: "build_typecheck",
        deliverable_id: "CODE-IMPL",
        command: "custom-compiler",
        args: ["--strict"],
      });
      fs.writeFileSync(
        path.join(tmpDir, DEFAULT_PATHS.playbookDir, "quality-gates.json"),
        JSON.stringify(qgConfig, null, 2),
        "utf-8"
      );

      const manager = new StackManager({ stacksDir: repoStacksDir });
      assert.throws(
        () => manager.composeQualityGates({ targetDir: tmpDir }),
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.strictEqual(err.code, "GATE_COLLISION_DETECTED");
          return true;
        }
      );
    });
  });

  // ───────────────────────────────────────────────────────────
  // 6. RIF Integration with Stack Exclusions
  // ───────────────────────────────────────────────────────────
  describe("Phase 4: RIF Integration with Stack Patterns", () => {
    test("computeRif respects stack exclusions from project manifest", () => {
      createValidBaseManifest(tmpDir, { technology_stacks: ["nextjs"] });

      // Create source files and .next build artifacts
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src/index.ts"), "export const a = 1;\n", "utf-8");

      fs.mkdirSync(path.join(tmpDir, ".next"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".next/build-output.js"), "compiled;\n", "utf-8");

      const check = {
        id: "test-check",
        name: "Test Check",
        type: "build_typecheck" as const,
        deliverable_id: "CODE-IMPL",
        command: "node",
        args: ["-v"],
        inputs: ["**/*"],
      };

      const rifRes = computeRif({
        projectDir: tmpDir,
        check,
      });

      const manifestFiles = rifRes.file_manifest.map((f) => f.path);
      assert.ok(manifestFiles.includes("src/index.ts"), "Source files must be included in RIF");
      assert.ok(!manifestFiles.some((p) => p.startsWith(".next")), ".next/ build artifacts must be excluded by RIF");
    });
  });

  // ───────────────────────────────────────────────────────────
  // 7. CLI Command Invocations
  // ───────────────────────────────────────────────────────────
  describe("Phase 4: CLI Command Invocations", () => {
    test("runStackList returns list of stacks", () => {
      const res = runStackList({ stacksDir: repoStacksDir, json: true });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.some((s) => s.id === "nextjs"));
    });

    test("runStackApply applies template and composes gates", () => {
      createValidBaseManifest(tmpDir);
      createValidQualityGatesConfig(tmpDir);

      const res = runStackApply("nextjs", {
        cwd: tmpDir,
        stacksDir: repoStacksDir,
        json: true,
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert.ok(fs.existsSync(path.join(tmpDir, "src/app/layout.tsx")));
    });

    test("runInit with --stack initializes governance and scaffolds stack in single step", async () => {
      const targetDir = path.join(tmpDir, "init-stack-app");
      fs.mkdirSync(targetDir, { recursive: true });

      const res = await runInit({
        cwd: targetDir,
        projectId: "init-stack-app",
        name: "Init Stack App",
        stack: "nextjs",
        nonInteractive: true,
      });

      assert.strictEqual(res.success, true);
      assert.ok(fs.existsSync(path.join(targetDir, ".playbook/manifest.json")));
      assert.ok(fs.existsSync(path.join(targetDir, "src/app/page.tsx")));

      const manifest = JSON.parse(
        fs.readFileSync(path.join(targetDir, ".playbook/manifest.json"), "utf-8")
      ) as ProjectManifest;
      assert.deepStrictEqual(manifest.technology_stacks, ["nextjs"]);
      assert.strictEqual(manifest.tech_stack.ecosystem, "node");
      assert.strictEqual(manifest.tech_stack.primary_language, "typescript");
    });
  });

  // ───────────────────────────────────────────────────────────
  // 8. Secret Defense Protocol (SEC-NEXT-01) Verification
  // ───────────────────────────────────────────────────────────
  describe("Phase 1 & 2: Secret Defense Protocol (SEC-NEXT-01)", () => {
    test("audit-secrets.mjs passes cleanly on pristine template scaffold", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir });

      const scriptPath = path.join(tmpDir, "scripts/audit-secrets.mjs");
      assert.ok(fs.existsSync(scriptPath));

      const run = spawnSync(process.execPath, [scriptPath], {
        cwd: tmpDir,
        encoding: "utf-8",
      });
      assert.strictEqual(run.status, 0, `Expected clean audit, stderr: ${run.stderr}\nstdout: ${run.stdout}`);
      assert.ok(run.stdout.includes("AUDIT PASSED"));
    });

    test("audit-secrets.mjs rejects sensitive NEXT_PUBLIC_* variable in .env", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir });

      // Inject prohibited public secret
      fs.writeFileSync(path.join(tmpDir, ".env.local"), "NEXT_PUBLIC_STRIPE_SECRET_KEY=sk_test_12345\n", "utf-8");

      const scriptPath = path.join(tmpDir, "scripts/audit-secrets.mjs");
      const run = spawnSync(process.execPath, [scriptPath], {
        cwd: tmpDir,
        encoding: "utf-8",
      });
      assert.strictEqual(run.status, 1);
      assert.ok(run.stderr.includes("[SEC-NEXT-01]"));
      assert.ok(run.stderr.includes("NEXT_PUBLIC_STRIPE_SECRET_KEY"));
    });

    test("audit-secrets.mjs rejects private process.env references in Client Components", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir });

      // Inject leaked private variable in client component
      fs.writeFileSync(
        path.join(tmpDir, "src/components/counter.tsx"),
        '"use client";\nconst secret = process.env.DATABASE_URL;\nexport function Counter() { return null; }\n',
        "utf-8"
      );

      const scriptPath = path.join(tmpDir, "scripts/audit-secrets.mjs");
      const run = spawnSync(process.execPath, [scriptPath], {
        cwd: tmpDir,
        encoding: "utf-8",
      });
      assert.strictEqual(run.status, 1);
      assert.ok(run.stderr.includes("[SEC-NEXT-01]"));
      assert.ok(run.stderr.includes("DATABASE_URL"));
    });

    test("audit-secrets.mjs rejects server-only module imports in Client Components", () => {
      createValidBaseManifest(tmpDir);
      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir });

      // Inject server-only import in client component
      fs.writeFileSync(
        path.join(tmpDir, "src/components/counter.tsx"),
        '"use client";\nimport "server-only";\nexport function Counter() { return null; }\n',
        "utf-8"
      );

      const scriptPath = path.join(tmpDir, "scripts/audit-secrets.mjs");
      const run = spawnSync(process.execPath, [scriptPath], {
        cwd: tmpDir,
        encoding: "utf-8",
      });
      assert.strictEqual(run.status, 1);
      assert.ok(run.stderr.includes("[SEC-NEXT-01]"));
      assert.ok(run.stderr.includes("server-only"));
    });
  });

  // ───────────────────────────────────────────────────────────
  // 9. Transaction Rollback & Pre-existing User Content Preservation
  // ───────────────────────────────────────────────────────────
  describe("Phase 4: Transaction Rollback & Directory Cleanup Safety", () => {
    test("rolls back newly created files and directories if manifest update fails", () => {
      const manifestPath = path.join(tmpDir, DEFAULT_PATHS.playbookDir, "manifest.json");
      fs.mkdirSync(path.join(tmpDir, DEFAULT_PATHS.playbookDir), { recursive: true });
      // Create a corrupted/malformed manifest that will fail schema validation when modified
      fs.writeFileSync(manifestPath, '{"broken": true}', "utf-8");

      const manager = new StackManager({ stacksDir: repoStacksDir });

      assert.throws(
        () => manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir }),
        (err: unknown) =>
          err instanceof StackError &&
          (err.code === "MANIFEST_UPDATE_FAILED" || err.code === "MANIFEST_VALIDATION_FAILED")
      );

      // Verify created files were cleaned up
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "package.json")), false);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "src/app/layout.tsx")), false);
      // Verify created directories were cleaned up
      assert.strictEqual(fs.existsSync(path.join(tmpDir, "src/app")), false);

      // Verify original manifest was restored
      const restored = fs.readFileSync(manifestPath, "utf-8");
      assert.strictEqual(restored, '{"broken": true}');
    });

    test("preserves pre-existing user files and directories untouched", () => {
      createValidBaseManifest(tmpDir);
      // Create user pre-existing files and folders outside template
      fs.mkdirSync(path.join(tmpDir, "src/user-module"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src/user-module/custom.ts"), "export const custom = true;\n", "utf-8");
      fs.writeFileSync(path.join(tmpDir, "README.user.md"), "# Custom User Doc\n", "utf-8");

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const res = manager.scaffoldStack({ stackName: "nextjs", targetDir: tmpDir });

      assert.strictEqual(res.success, true);
      // User pre-existing content must remain intact
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, "README.user.md"), "utf-8"), "# Custom User Doc\n");
      assert.strictEqual(
        fs.readFileSync(path.join(tmpDir, "src/user-module/custom.ts"), "utf-8"),
        "export const custom = true;\n"
      );
    });
  });
});
