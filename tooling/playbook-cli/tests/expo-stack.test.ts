import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SchemaValidator } from "../src/core/validator.js";
import { StackManager, StackError } from "../src/core/stacks/stack-manager.js";
import { runStackList, runStackApply, runStackCompose } from "../src/commands/stack.js";
import { runInit } from "../src/commands/init.js";
import { computeRif } from "../src/core/quality-gates/rif.js";
import { QualityGateRunner } from "../src/core/quality-gates/runner.js";
import { classifyMobileWorkflow } from "../src/core/mobile/workflow-classifier.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { QualityGatesConfig } from "../src/types/quality-gates.js";
import type { ProjectManifest } from "../src/types/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Task 007D.3 — Expo Extension Stack Implementation", () => {
  let tmpDir: string;
  let repoStacksDir: string;
  let validator: SchemaValidator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-expo-test-"));
    validator = new SchemaValidator();

    let curr = path.resolve(__dirname);
    repoStacksDir = "";
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(curr, "stacks");
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "expo"))) {
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

  function createValidBaseManifest(
    projectDir: string,
    overrides: Partial<ProjectManifest> = {}
  ): ProjectManifest {
    const manifest: ProjectManifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      project_id: "test-expo-app",
      project_name: "Test Expo App",
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
    fs.writeFileSync(
      path.join(playbookDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8"
    );
    return manifest;
  }

  function createValidQualityGatesConfig(projectDir: string): QualityGatesConfig {
    const config: QualityGatesConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "test-expo-app",
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
          stage_name: "Implementation & Verification",
          checks: [
            {
              id: "core-typecheck",
              name: "Base Typecheck",
              type: "build_typecheck",
              deliverable_id: "DELIV-1",
              command: "tsc",
              args: ["--noEmit"],
              severity: "blocking",
            },
          ],
        },
      ],
    };

    const playbookDir = path.join(projectDir, DEFAULT_PATHS.playbookDir);
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.writeFileSync(
      path.join(playbookDir, "quality-gates.json"),
      JSON.stringify(config, null, 2),
      "utf-8"
    );
    return config;
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Stack Metadata & Canonical Dependency Declaration
  // ─────────────────────────────────────────────────────────────

  describe("1. Stack Metadata & Canonical Dependency Declaration", () => {
    test("StackManager discovers expo stack with canonical metadata and react-native dependency", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const info = manager.getStackInfo("expo");

      assert.equal(info.id, "expo");
      assert.equal(info.name, "Expo");
      assert.equal(info.version, "1.1.0");
      assert.match(info.frameworkTarget, /Expo SDK 58/);
      assert.deepEqual(info.dependencies, ["react-native"]);
      assert.deepEqual(info.compatibility, {
        "react-native": ">= 0.88.0 < 0.89.0",
        react: "19.3.0",
        node: ">= 22.13.0",
      });
      assert.equal(info.packageOverrides?.dependencies?.["react-native"], "0.88.1");
      assert.equal(info.packageOverrides?.dependencies?.react, "19.3.0");
      assert.equal(info.packageOverrides?.devDependencies?.typescript, "~6.0.3");
      assert.equal(info.packageOverrides?.devDependencies?.["@types/react-native"], undefined);
      assert.equal(info.hasTemplate, true);
      assert.equal(info.hasQualityGates, true);
      assert.equal(info.hasRifPatterns, true);
      assert.ok(fs.existsSync(info.specPath));
    });

    test("resolves canonical dependency chain: expo -> react-native", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const resolved = manager.resolveDependencies(["expo"]);
      assert.deepEqual(resolved, ["react-native", "expo"]);
    });

    test("listStacks includes nextjs, react-native, and expo", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const stacks = manager.listStacks();
      const ids = stacks.map((s) => s.id);

      assert.ok(ids.includes("nextjs"), "Must include nextjs");
      assert.ok(ids.includes("react-native"), "Must include react-native");
      assert.ok(ids.includes("expo"), "Must include expo");

      const expoInfo = stacks.find((s) => s.id === "expo");
      assert.deepEqual(expoInfo?.dependencies, ["react-native"]);
    });

    test("fails closed if react-native foundation dependency is missing from stacksDir", () => {
      // Create isolated mock stacks directory with expo but without react-native
      const isolatedMock = path.join(tmpDir, "broken-stacks");
      fs.mkdirSync(isolatedMock, { recursive: true });
      const expoDir = path.join(isolatedMock, "expo");
      fs.mkdirSync(expoDir, { recursive: true });
      fs.writeFileSync(
        path.join(expoDir, "stack.json"),
        JSON.stringify({
          id: "expo",
          name: "Expo",
          version: "1.0.0",
          dependencies: ["react-native"],
        }),
        "utf-8"
      );

      const manager = new StackManager({ stacksDir: isolatedMock });
      assert.throws(
        () => manager.resolveDependencies(["expo"]),
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.equal(err.code, "STACK_DEPENDENCY_MISSING");
          assert.match(err.message, /requires dependency 'react-native'/);
          return true;
        }
      );
    });

    test("circular dependency protection prevents cycles involving expo", () => {
      const cyclicMock = path.join(tmpDir, "cyclic-stacks");
      fs.mkdirSync(cyclicMock, { recursive: true });

      // Create cycle: expo -> react-native -> expo
      const expoDir = path.join(cyclicMock, "expo");
      fs.mkdirSync(expoDir, { recursive: true });
      fs.writeFileSync(
        path.join(expoDir, "stack.json"),
        JSON.stringify({ id: "expo", dependencies: ["react-native"] }),
        "utf-8"
      );

      const rnDir = path.join(cyclicMock, "react-native");
      fs.mkdirSync(rnDir, { recursive: true });
      fs.writeFileSync(
        path.join(rnDir, "stack.json"),
        JSON.stringify({ id: "react-native", dependencies: ["expo"] }),
        "utf-8"
      );

      const manager = new StackManager({ stacksDir: cyclicMock });
      assert.throws(
        () => manager.resolveDependencies(["expo"]),
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.equal(err.code, "CIRCULAR_DEPENDENCY_DETECTED");
          return true;
        }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Mobile Workflow Classification & Ambiguity Detection
  // ─────────────────────────────────────────────────────────────

  describe("2. Mobile Workflow Classification & Ambiguity Protocol", () => {
    test("classifies Bare React Native when manifest specifies ['react-native'] without Expo files", () => {
      const projectDir = path.join(tmpDir, "wf-bare");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native"] });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({ name: "bare-app", dependencies: { "react-native": "0.76.3" } })
      );

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "COMPLETE");
      assert.equal(res.workflow, "bare-react-native");
      assert.equal(res.source, "manifest");
    });

    test("classifies Expo Managed when manifest specifies ['react-native', 'expo'] and native dirs absent/gitignored", () => {
      const projectDir = path.join(tmpDir, "wf-managed");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native", "expo"] });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "managed-app",
          dependencies: { expo: "~58.0.0", "react-native": "0.88.0" },
        })
      );
      fs.writeFileSync(path.join(projectDir, "app.json"), JSON.stringify({ expo: { name: "app" } }));

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "COMPLETE");
      assert.equal(res.workflow, "expo-managed");
      assert.equal(res.source, "manifest");
    });

    test("classifies Expo Prebuild / Committed CNG when native dirs exist and are not gitignored", () => {
      const projectDir = path.join(tmpDir, "wf-cng");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native", "expo"] });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "cng-app",
          dependencies: { expo: "~58.0.0", "react-native": "0.88.0" },
        })
      );
      fs.writeFileSync(path.join(projectDir, "app.json"), JSON.stringify({ expo: { name: "app" } }));
      fs.mkdirSync(path.join(projectDir, "ios"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "android"), { recursive: true });

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "COMPLETE");
      assert.equal(res.workflow, "expo-committed-cng");
      assert.equal(res.source, "manifest");
    });

    test("halts with AMBIGUOUS_WORKFLOW_CONFIGURATION and INCOMPLETE when manifest declares bare RN but Expo exists", () => {
      const projectDir = path.join(tmpDir, "wf-conflict-1");
      // Conflicting state: manifest declares bare RN, but package has expo and app.json exists
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native"] });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "conflict-app",
          dependencies: { expo: "~58.0.0", "react-native": "0.88.0" },
        })
      );
      fs.writeFileSync(path.join(projectDir, "app.json"), JSON.stringify({ expo: { name: "conflict" } }));

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "INCOMPLETE");
      assert.equal(res.errorCode, "AMBIGUOUS_WORKFLOW_CONFIGURATION");
      assert.match(res.message || "", /Conflicting mobile workflow configuration/);
    });

    test("halts with AMBIGUOUS_WORKFLOW_CONFIGURATION when manifest declares Expo but package lacks expo", () => {
      const projectDir = path.join(tmpDir, "wf-conflict-2");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native", "expo"] });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "conflict-app",
          dependencies: { "react-native": "0.88.0" }, // Missing 'expo'!
        })
      );

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "INCOMPLETE");
      assert.equal(res.errorCode, "AMBIGUOUS_WORKFLOW_CONFIGURATION");
      assert.match(res.message || "", /package\.json lacks 'expo' dependency/);
    });

    test("halts with AMBIGUOUS_WORKFLOW_CONFIGURATION when metadata specifies expo-managed but native dirs committed", () => {
      const projectDir = path.join(tmpDir, "wf-conflict-3");
      createValidBaseManifest(projectDir, {
        technology_stacks: ["react-native", "expo"],
        metadata: { mobile_workflow: "expo-managed" },
      });
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "conflict-app",
          dependencies: { expo: "~58.0.0", "react-native": "0.88.0" },
        })
      );
      fs.writeFileSync(path.join(projectDir, "app.json"), JSON.stringify({ expo: { name: "conflict" } }));
      fs.mkdirSync(path.join(projectDir, "ios"), { recursive: true }); // Unignored committed ios directory!

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "INCOMPLETE");
      assert.equal(res.errorCode, "AMBIGUOUS_WORKFLOW_CONFIGURATION");
      assert.match(res.message || "", /native ios\/android directories are committed in Git/);
    });

    test("fallback introspection correctly classifies when manifest is uninitialized", () => {
      const projectDir = path.join(tmpDir, "wf-introspection");
      fs.mkdirSync(projectDir, { recursive: true });
      // No manifest file!
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "intro-app",
          dependencies: { expo: "~58.0.0", "react-native": "0.88.0" },
        })
      );

      const res = classifyMobileWorkflow(projectDir);
      assert.equal(res.status, "COMPLETE");
      assert.equal(res.workflow, "expo-managed");
      assert.equal(res.source, "introspection");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Quality Gates Composition & RIF Patterns
  // ─────────────────────────────────────────────────────────────

  describe("3. Quality Gates Composition & RIF Patterns", () => {
    test("loads expo quality-gates.partial.json without duplicate dependencies declaration", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const partial = manager.loadStackQualityGates("expo");

      assert.equal(partial.stack, "expo");
      assert.equal(partial.version, "1.0.0");
      assert.equal((partial as any).dependencies, undefined, "Subordinate partial must not declare dependencies");

      const allChecks = partial.gates.flatMap((g) => g.checks);
      const checkIds = allChecks.map((c) => c.id);

      assert.ok(checkIds.includes("expo-config-validate"));
      assert.ok(checkIds.includes("expo-doctor"));
      assert.ok(checkIds.includes("expo-route-structure"));
      assert.ok(checkIds.includes("expo-plugin-validate"));
      assert.ok(checkIds.includes("expo-secret-audit"));
      assert.ok(checkIds.includes("expo-test"));

      // Confirm zero collision with React Native or Next.js check IDs
      const rnChecks = manager.loadStackQualityGates("react-native").gates.flatMap((g) => g.checks).map((c) => c.id);
      for (const id of checkIds) {
        assert.ok(!rnChecks.includes(id), `Expo gate '${id}' must not collide with React Native foundation gates`);
      }
    });

    test("composes Core, React Native, and Expo quality gates into single unified configuration", () => {
      const projectDir = path.join(tmpDir, "composed-gates-app");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const result = manager.composeQualityGates({
        targetDir: projectDir,
        stackNames: ["expo"], // Should auto-resolve react-native and expo
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.composedStacks, ["react-native", "expo"]);

      const composedConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, DEFAULT_PATHS.playbookDir, "quality-gates.json"), "utf-8")
      ) as QualityGatesConfig;

      const stage4 = composedConfig.gates.find((g) => g.stage === 4);
      assert.ok(stage4);
      const stage4Ids = stage4.checks.map((c) => c.id);

      // Core check
      assert.ok(stage4Ids.includes("core-typecheck"));

      // Inherited React Native foundation checks
      assert.ok(stage4Ids.includes("rn-typecheck"));
      assert.ok(stage4Ids.includes("rn-lint"));
      assert.ok(stage4Ids.includes("mobile-secret-audit"));
      assert.ok(stage4Ids.includes("rn-platform-companion"));
      assert.ok(stage4Ids.includes("rn-accessibility"));

      // Expo extension checks
      assert.ok(stage4Ids.includes("expo-config-validate"));
      assert.ok(stage4Ids.includes("expo-doctor"));
      assert.ok(stage4Ids.includes("expo-route-structure"));
      assert.ok(stage4Ids.includes("expo-plugin-validate"));
      assert.ok(stage4Ids.includes("expo-secret-audit"));

      const stage5 = composedConfig.gates.find((g) => g.stage === 5);
      assert.ok(stage5);
      const stage5Ids = stage5.checks.map((c) => c.id);
      assert.ok(stage5Ids.includes("rn-test"));
      assert.ok(stage5Ids.includes("expo-test"));
    });

    test("composition is idempotent across repeated invocations", () => {
      const projectDir = path.join(tmpDir, "idempotent-gates-app");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });

      const firstRun = manager.composeQualityGates({ targetDir: projectDir, stackNames: ["expo"] });
      const secondRun = manager.composeQualityGates({ targetDir: projectDir, stackNames: ["expo"] });

      assert.equal(firstRun.totalChecks, secondRun.totalChecks);
      assert.equal(secondRun.addedChecks.length, 0, "Second composition must add 0 duplicate checks");
    });

    test("merged RIF patterns exclude .expo/** and track app/** and plugins/**", () => {
      const projectDir = path.join(tmpDir, "rif-app");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native", "expo"] });

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const patterns = manager.getMergedRifPatterns(projectDir);

      assert.ok(patterns.exclude_patterns.includes(".expo/**"));
      assert.ok(patterns.exclude_patterns.includes("node_modules/**"));
      assert.ok(patterns.text_patterns.some((p) => p.startsWith("app/")));
      assert.ok(patterns.text_patterns.some((p) => p.startsWith("plugins/")));

      // Create tracked route file and excluded .expo cache
      fs.mkdirSync(path.join(projectDir, "app"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "app", "index.tsx"), "export default function Home() { return null; }\n");

      fs.mkdirSync(path.join(projectDir, ".expo"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".expo", "cache.json"), '{"cache": 1}\n');

      const check = {
        id: "expo-check",
        name: "Test Expo Check",
        type: "build_typecheck" as const,
        deliverable_id: "CODE-IMPL",
        command: "node",
        args: ["-v"],
        inputs: ["**/*"],
      };

      const rifResult = computeRif({ projectDir, check });
      const paths = rifResult.file_manifest.map((f: { path: string }) => f.path);
      assert.ok(paths.includes("app/index.tsx"));
      assert.ok(!paths.some((p: string) => p.startsWith(".expo")));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Starter Template Scaffolding & Multi-Stack Application
  // ─────────────────────────────────────────────────────────────

  describe("4. Starter Template Scaffolding & Multi-Stack Application", () => {
    test("scaffolds Expo starter extending React Native foundation", () => {
      const projectDir = path.join(tmpDir, "scaffold-expo-app");
      createValidBaseManifest(projectDir, { project_id: "expo-omega" });
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const result = manager.scaffoldStack({
        stackName: "expo",
        targetDir: projectDir,
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.appliedStacks, ["react-native", "expo"]);

      // Verify foundational React Native files are present
      assert.ok(fs.existsSync(path.join(projectDir, "src", "components", "ui", "button.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "components", "ui", "modal.ios.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "components", "ui", "modal.android.tsx")));

      // Verify Expo extension files are present
      assert.ok(fs.existsSync(path.join(projectDir, "app.json")));
      assert.ok(fs.existsSync(path.join(projectDir, "eas.json")));
      assert.ok(fs.existsSync(path.join(projectDir, "app", "_layout.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "app", "index.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "app", "(tabs)", "_layout.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "app", "(tabs)", "explore.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "app", "+not-found.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "plugins", "with-security-headers.js")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-expo-config.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-expo-doctor.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-routes.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-expo-plugins.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-expo-secrets.mjs")));

      // Verify package.json contains PROJECT_ID and Expo dependencies
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
      assert.equal(pkg.name, "expo-omega");
      assert.equal(pkg.main, "expo-router/entry");
      assert.equal(pkg.dependencies.expo, "~58.0.23");
      assert.equal(pkg.dependencies["react-native"], "0.88.1");
      assert.equal(pkg.dependencies.react, "19.3.0");
      assert.equal(pkg.dependencies["react-dom"], "19.3.0");
      assert.equal(pkg.dependencies["expo-router"], "~58.0.30");
      assert.equal(pkg.dependencies["expo-secure-store"], "~58.0.2");
      assert.equal(pkg.dependencies["expo-constants"], "~58.0.15");
      assert.equal(pkg.dependencies["expo-linking"], "~58.0.16");
      assert.equal(pkg.dependencies["expo-status-bar"], "~58.0.4");
      assert.equal(pkg.dependencies["react-native-safe-area-context"], "~5.11.1");
      assert.equal(pkg.dependencies["react-native-screens"], "~4.30.1");
      assert.equal(pkg.devDependencies.typescript, "~6.0.3");
      assert.equal(pkg.devDependencies["@types/react-native"], undefined);

      // Verify app.json contains PROJECT_ID substitutions and normalized Android package
      const appJson = JSON.parse(fs.readFileSync(path.join(projectDir, "app.json"), "utf-8"));
      assert.equal(appJson.expo.name, "expo-omega");
      assert.equal(appJson.expo.slug, "expo-omega");
      assert.equal(appJson.expo.scheme, "expo-omega");
      assert.equal(appJson.expo.ios.bundleIdentifier, "com.playbook.expo-omega");
      assert.equal(appJson.expo.android.package, "com.playbook.expo_omega");

      // Verify manifest contains both technology stacks in prerequisite order
      const manifest = JSON.parse(
        fs.readFileSync(path.join(projectDir, DEFAULT_PATHS.playbookDir, "manifest.json"), "utf-8")
      ) as ProjectManifest;
      assert.deepEqual(manifest.technology_stacks, ["react-native", "expo"]);
    });

    test("fails closed with STACK_INCOMPATIBLE_DEPENDENCY when applying expo to existing React Native project with incompatible RN 0.76.3", () => {
      const projectDir = path.join(tmpDir, "upgrade-incompatible-rn");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native"] });
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });

      // First apply react-native (foundation has RN 0.76.3 LTS)
      manager.scaffoldStack({ stackName: "react-native", targetDir: projectDir, force: true });

      // Attempt to apply expo on top of RN 0.76.3 without compatible dependencies
      assert.throws(
        () => {
          manager.scaffoldStack({
            stackName: "expo",
            targetDir: projectDir,
            force: true,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.equal(err.code, "STACK_INCOMPATIBLE_DEPENDENCY");
          assert.match(err.message, /Incompatible pre-existing dependency: 'react-native' version '0\.76\.3'/);
          return true;
        }
      );
    });

    test("succeeds when applying expo to existing project with compatible React Native 0.88.0 and React 19.3.0", () => {
      const projectDir = path.join(tmpDir, "upgrade-compatible-rn");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native"] });
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });

      // Create pre-existing project with compatible RN 0.88.0
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({
          name: "compatible-app",
          dependencies: {
            react: "19.3.0",
            "react-native": "0.88.0",
          },
        }, null, 2)
      );

      const applyResult = manager.scaffoldStack({
        stackName: "expo",
        targetDir: projectDir,
        force: true,
      });

      assert.equal(applyResult.success, true);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(projectDir, DEFAULT_PATHS.playbookDir, "manifest.json"), "utf-8")
      ) as ProjectManifest;
      assert.deepEqual(manifest.technology_stacks, ["react-native", "expo"]);
    });

    test("multi-stack composition rejects unmanaged dependency version conflicts without explicit packageOverrides", () => {
      const mockStacksDir = path.join(tmpDir, "mock-conflict-stacks");
      fs.mkdirSync(mockStacksDir, { recursive: true });

      // Stack base
      const baseDir = path.join(mockStacksDir, "base-stack");
      fs.mkdirSync(path.join(baseDir, "template"), { recursive: true });
      fs.writeFileSync(
        path.join(baseDir, "stack.json"),
        JSON.stringify({ id: "base-stack", name: "Base", version: "1.0.0", dependencies: [] })
      );
      fs.writeFileSync(
        path.join(baseDir, "template", "package.json"),
        JSON.stringify({ name: "app", dependencies: { "shared-lib": "1.0.0" } })
      );

      // Stack ext (conflicts on shared-lib version 2.0.0, but omits packageOverrides)
      const extDir = path.join(mockStacksDir, "ext-stack");
      fs.mkdirSync(path.join(extDir, "template"), { recursive: true });
      fs.writeFileSync(
        path.join(extDir, "stack.json"),
        JSON.stringify({ id: "ext-stack", name: "Ext", version: "1.0.0", dependencies: ["base-stack"] })
      );
      fs.writeFileSync(
        path.join(extDir, "template", "package.json"),
        JSON.stringify({ name: "app", dependencies: { "shared-lib": "2.0.0" } })
      );

      const targetDir = path.join(tmpDir, "unmanaged-conflict-test");
      fs.mkdirSync(targetDir, { recursive: true });

      const manager = new StackManager({ stacksDir: mockStacksDir });
      assert.throws(
        () => {
          manager.scaffoldStack({ stackName: "ext-stack", targetDir });
        },
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.equal(err.code, "STACK_UNRESOLVED_DEPENDENCY_CONFLICT");
          assert.match(err.message, /Conflicting dependency declaration for 'shared-lib'/);
          return true;
        }
      );
    });

    test("CLI runInit with --stack expo scaffolds governance, resolves React Native, and applies Expo", async () => {
      const initTarget = path.join(tmpDir, "cli-expo-init");
      const result = await runInit({
        cwd: initTarget,
        projectId: "cli-expo-app",
        name: "CLI Expo App",
        stack: "expo",
        nonInteractive: true,
      });

      assert.equal(result.success, true);
      assert.ok(fs.existsSync(path.join(initTarget, "app.json")));
      assert.ok(fs.existsSync(path.join(initTarget, "app", "index.tsx")));

      const manifest = JSON.parse(
        fs.readFileSync(path.join(initTarget, DEFAULT_PATHS.playbookDir, "manifest.json"), "utf-8")
      ) as ProjectManifest;
      assert.deepEqual(manifest.technology_stacks, ["react-native", "expo"]);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Gate Audit Scripts Execution
  // ─────────────────────────────────────────────────────────────

  describe("5. Gate Audit Scripts Verification", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = path.join(tmpDir, "audit-target-app");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "expo", targetDir: projectDir });
    });

    // 5.1 audit-expo-config.mjs
    test("audit-expo-config.mjs passes on pristine template", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-config.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 0, `Config audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /Expo configuration in app\.json and eas\.json is valid/);
    });

    test("audit-expo-config.mjs rejects missing scheme in app.json", () => {
      const appJsonPath = path.join(projectDir, "app.json");
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
      delete appJson.expo.scheme;
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2), "utf-8");

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-config.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Missing or empty 'expo\.scheme'/);
    });

    // 5.2 audit-expo-doctor.mjs
    test("audit-expo-doctor.mjs passes on pristine template", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-doctor.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 0, `Doctor audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /All Expo dependencies conform to official SDK 58 compatibility matrix/);
    });

    test("audit-expo-doctor.mjs rejects incompatible React Native version", () => {
      const pkgPath = path.join(projectDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      pkg.dependencies["react-native"] = "0.76.3"; // Incompatible with SDK 58 (requires 0.88.x)
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-doctor.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Incompatible React Native version '0\.76\.3' for Expo SDK 58/);
    });

    test("audit-expo-doctor.mjs rejects deprecated @types/react-native", () => {
      const pkgPath = path.join(projectDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      pkg.devDependencies["@types/react-native"] = "0.73.0";
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-doctor.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Unnecessary and deprecated dependency '@types\/react-native'/);
    });

    // 5.3 audit-routes.mjs
    test("audit-routes.mjs passes on pristine template", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-routes.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 0, `Route audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /Expo Router route tree and default exports verified/);
    });

    test("audit-routes.mjs rejects route file lacking export default component", () => {
      const badRoute = path.join(projectDir, "app", "broken.tsx");
      fs.writeFileSync(badRoute, "export const Broken = () => null;\n", "utf-8");

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-routes.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Route file lacks a mandatory 'export default'/);
    });

    // 5.4 audit-expo-plugins.mjs
    test("audit-expo-plugins.mjs passes on pristine template", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-plugins.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 0, `Plugin audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /Expo Config Plugins verified/);
    });

    // 5.5 audit-expo-secrets.mjs
    test("audit-expo-secrets.mjs passes on pristine template", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-secrets.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 0, `Secret audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /Zero credential leaks or unsafe public env variables detected/);
    });

    test("audit-expo-secrets.mjs rejects sensitive secret prefixed with EXPO_PUBLIC_", () => {
      fs.writeFileSync(
        path.join(projectDir, ".env"),
        "EXPO_PUBLIC_DATABASE_PASSWORD=super_secret_db_password_12345\n",
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-expo-secrets.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Prohibited secret variable 'EXPO_PUBLIC_DATABASE_PASSWORD' exposed via EXPO_PUBLIC_\*/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. QualityGateRunner Execution on Scaffolded Expo Project
  // ─────────────────────────────────────────────────────────────

  describe("6. Actual QualityGateRunner Execution on Expo Project", () => {
    test("executes composed Stage 4 quality gates via actual QualityGateRunner", async () => {
      const projectDir = path.join(tmpDir, "runner-app");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "expo", targetDir: projectDir });
      manager.composeQualityGates({ targetDir: projectDir, stackNames: ["expo"] });

      // Create state.json with Stage 4 in progress conforming to project-state.schema.json
      const state = {
        $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
        schema_version: "1.1.0",
      transaction_sequence: 0,
      audit_trail: [],
        project_id: "test-expo-app",
        playbook_version: "1.0.0",
        milestone_id: "M-1.0.0",
        milestone_name: "Initial Release",
        lifecycle_status: "active",
        current_stage: 4,
        stage_status: "in_progress",
        current_stage_detail: {
          stage: 4,
          stage_name: "Implementation & Unit Verification",
          started_at: "2026-11-06T10:00:00.000Z",
          deliverables: [
            {
              id: "CODE-IMPL",
              name: "Code Implementation",
              artifact_path: "app/index.tsx",
              status: "in_progress",
              validation_status: "unvalidated",
              exception_ref: null,
              evidence: [],
            },
            {
              id: "DELIV-1",
              name: "Base Deliverable",
              artifact_path: "src/index.ts",
              status: "in_progress",
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
            path: "docs/gates/GATE-4-EXIT-PACKAGE.md",
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
          timestamp: "2026-11-06T10:00:00.000Z",
          updated_by: "test-engineer",
          actor_type: "human",
          reason: "Stage 4 testing",
        },
      };
      fs.writeFileSync(
        path.join(projectDir, DEFAULT_PATHS.playbookDir, "state.json"),
        JSON.stringify(state, null, 2),
        "utf-8"
      );

      const runner = new QualityGateRunner(projectDir);

      // 1. Execute expo-config-validate through actual QualityGateRunner
      const runReport = await runner.run({
        stage: 4,
        checkId: "expo-config-validate",
      });
      assert.equal(runReport.summary.total, 1);
      assert.equal(runReport.summary.passed, 1);
      assert.equal(runReport.summary.failed, 0);

      // 2. Execute expo-doctor through actual QualityGateRunner
      const docReport = await runner.run({
        stage: 4,
        checkId: "expo-doctor",
      });
      assert.equal(docReport.summary.total, 1);
      assert.equal(docReport.summary.passed, 1);
      assert.equal(docReport.summary.failed, 0);

      // 3. Execute expo-route-structure through actual QualityGateRunner
      const routeReport = await runner.run({
        stage: 4,
        checkId: "expo-route-structure",
      });
      assert.equal(routeReport.summary.total, 1);
      assert.equal(routeReport.summary.passed, 1);
      assert.equal(routeReport.summary.failed, 0);

      // 4. Execute expo-plugin-validate through actual QualityGateRunner
      const pluginReport = await runner.run({
        stage: 4,
        checkId: "expo-plugin-validate",
      });
      assert.equal(pluginReport.summary.total, 1);
      assert.equal(pluginReport.summary.passed, 1);
      assert.equal(pluginReport.summary.failed, 0);

      // 5. Execute expo-secret-audit through actual QualityGateRunner
      const secReport = await runner.run({
        stage: 4,
        checkId: "expo-secret-audit",
      });
      assert.equal(secReport.summary.total, 1);
      assert.equal(secReport.summary.passed, 1);
      assert.equal(secReport.summary.failed, 0);

      // 6. Execute inherited React Native foundation gates through actual QualityGateRunner
      const mobSecReport = await runner.run({
        stage: 4,
        checkId: "mobile-secret-audit",
      });
      assert.equal(mobSecReport.summary.passed, 1);

      const compReport = await runner.run({
        stage: 4,
        checkId: "rn-platform-companion",
      });
      assert.equal(compReport.summary.passed, 1);

      const a11yReport = await runner.run({
        stage: 4,
        checkId: "rn-accessibility",
      });
      assert.equal(a11yReport.summary.passed, 1);
    });

    test("executes Stage 5 expo-test and inherited rn-test via actual QualityGateRunner", async () => {
      const projectDir = path.join(tmpDir, "runner-stage5-app");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "expo", targetDir: projectDir });
      manager.composeQualityGates({ targetDir: projectDir, stackNames: ["expo"] });

      // Create state.json with Stage 5 in progress conforming to project-state.schema.json
      const state = {
        $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
        schema_version: "1.1.0",
      transaction_sequence: 0,
      audit_trail: [],
        project_id: "test-expo-app",
        playbook_version: "1.0.0",
        milestone_id: "M-1.0.0",
        milestone_name: "Initial Release",
        lifecycle_status: "active",
        current_stage: 5,
        stage_status: "in_progress",
        current_stage_detail: {
          stage: 5,
          stage_name: "Integration & System Verification",
          started_at: "2026-11-06T10:00:00.000Z",
          deliverables: [
            {
              id: "INTEG-TEST",
              name: "Integration Test Suite",
              artifact_path: "__tests__/routes.test.js",
              status: "in_progress",
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
            path: "docs/gates/GATE-5-EXIT-PACKAGE.md",
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
          timestamp: "2026-11-06T10:00:00.000Z",
          updated_by: "test-engineer",
          actor_type: "human",
          reason: "Stage 5 testing",
        },
      };
      fs.writeFileSync(
        path.join(projectDir, DEFAULT_PATHS.playbookDir, "state.json"),
        JSON.stringify(state, null, 2),
        "utf-8"
      );

      const runner = new QualityGateRunner(projectDir);

      // Execute expo-test through actual QualityGateRunner
      const testReport = await runner.run({
        stage: 5,
        checkId: "expo-test",
      });

      assert.equal(testReport.summary.total, 1);
      assert.equal(testReport.summary.passed, 1);
      assert.equal(testReport.summary.failed, 0);

      // Execute rn-test through actual QualityGateRunner
      const rnTestReport = await runner.run({
        stage: 5,
        checkId: "rn-test",
      });

      assert.equal(rnTestReport.summary.total, 1);
      assert.equal(rnTestReport.summary.passed, 1);
      assert.equal(rnTestReport.summary.failed, 0);
    });
  });
});
