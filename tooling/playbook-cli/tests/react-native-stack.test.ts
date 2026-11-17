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
import { DEFAULT_PATHS } from "../src/constants.js";
import type { QualityGatesConfig } from "../src/types/quality-gates.js";
import type { ProjectManifest } from "../src/types/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Task 007D.2 — React Native Foundation Stack Implementation", () => {
  let tmpDir: string;
  let repoStacksDir: string;
  let validator: SchemaValidator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-rn-test-"));
    validator = new SchemaValidator();

    let curr = path.resolve(__dirname);
    repoStacksDir = "";
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(curr, "stacks");
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "react-native"))) {
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
      project_id: "test-rn-app",
      project_name: "Test React Native App",
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
      project_id: "test-rn-app",
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
    fs.writeFileSync(path.join(playbookDir, "quality-gates.json"), JSON.stringify(config, null, 2), "utf-8");
    return config;
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Stack Metadata & Discovery
  // ─────────────────────────────────────────────────────────────

  describe("1. Stack Metadata & Canonical Discovery", () => {
    test("StackManager discovers react-native stack with canonical metadata", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const info = manager.getStackInfo("react-native");

      assert.equal(info.id, "react-native");
      assert.equal(info.name, "React-native");
      assert.equal(info.version, "1.0.0");
      assert.match(info.frameworkTarget, /React Native >= 0\.74\.0/);
      assert.deepEqual(info.dependencies, []);
      assert.equal(info.hasTemplate, true);
      assert.equal(info.hasQualityGates, true);
      assert.equal(info.hasRifPatterns, true);
      assert.ok(fs.existsSync(info.specPath));
    });

    test("react-native declares zero dependencies and has no Expo coupling", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const info = manager.getStackInfo("react-native");

      assert.deepEqual(info.dependencies, []);
      assert.ok(!(info.dependencies as string[]).includes("expo"));

      const resolved = manager.resolveDependencies(["react-native"]);
      assert.deepEqual(resolved, ["react-native"]);
    });

    test("listStacks includes both nextjs and react-native", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const stacks = manager.listStacks();

      const ids = stacks.map((s) => s.id);
      assert.ok(ids.includes("nextjs"), "Must include nextjs");
      assert.ok(ids.includes("react-native"), "Must include react-native");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Quality Gates & RIF Composition
  // ─────────────────────────────────────────────────────────────

  describe("2. Quality Gates & RIF Composition", () => {
    test("loads quality-gates.partial.json with exactly 6 approved gates", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const partial = manager.loadStackQualityGates("react-native");

      assert.equal(partial.stack, "react-native");
      assert.equal(partial.version, "1.0.0");

      const allChecks = partial.gates.flatMap((g) => g.checks);
      assert.equal(allChecks.length, 6);

      const checkIds = allChecks.map((c) => c.id);
      assert.ok(checkIds.includes("rn-typecheck"));
      assert.ok(checkIds.includes("rn-lint"));
      assert.ok(checkIds.includes("rn-test"));
      assert.ok(checkIds.includes("mobile-secret-audit"));
      assert.ok(checkIds.includes("rn-platform-companion"));
      assert.ok(checkIds.includes("rn-accessibility"));

      // Confirm no collision with Next.js gates
      const nextPartial = manager.loadStackQualityGates("nextjs");
      const nextCheckIds = nextPartial.gates.flatMap((g) => g.checks).map((c) => c.id);
      for (const id of checkIds) {
        assert.ok(!nextCheckIds.includes(id), `Gate ID '${id}' must not collide with Next.js`);
      }
    });

    test("composes React Native gates deterministically into project quality-gates.json", () => {
      const projectDir = path.join(tmpDir, "project-qg");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const result = manager.composeQualityGates({
        targetDir: projectDir,
        stackNames: ["react-native"],
      });

      assert.equal(result.success, true);
      assert.equal(result.composedStacks?.includes("react-native"), true);
      assert.equal(result.addedChecks.length, 6);

      const composedConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, DEFAULT_PATHS.playbookDir, "quality-gates.json"), "utf-8")
      ) as QualityGatesConfig;

      const stage4 = composedConfig.gates.find((g) => g.stage === 4);
      assert.ok(stage4);
      const stage4Ids = stage4.checks.map((c) => c.id);
      assert.ok(stage4Ids.includes("core-typecheck")); // pre-existing check preserved
      assert.ok(stage4Ids.includes("rn-typecheck"));
      assert.ok(stage4Ids.includes("rn-lint"));
      assert.ok(stage4Ids.includes("mobile-secret-audit"));
      assert.ok(stage4Ids.includes("rn-platform-companion"));
      assert.ok(stage4Ids.includes("rn-accessibility"));

      const stage5 = composedConfig.gates.find((g) => g.stage === 5);
      assert.ok(stage5);
      const stage5Ids = stage5.checks.map((c) => c.id);
      assert.ok(stage5Ids.includes("rn-test"));
    });

    test("loads rif-patterns.json and excludes build outputs from RIF hash calculation", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const rif = manager.loadStackRifPatterns("react-native");

      assert.equal(rif.stack, "react-native");
      assert.ok(rif.exclude_patterns?.includes("node_modules/**"));
      assert.ok(rif.exclude_patterns?.includes(".metro/**"));
      assert.ok(rif.exclude_patterns?.includes("android/build/**"));
      assert.ok(rif.exclude_patterns?.includes("ios/build/**"));

      const projectDir = path.join(tmpDir, "project-rif");
      createValidBaseManifest(projectDir, { technology_stacks: ["react-native"] });

      // Create a tracked source file
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const mobile = true;\n");

      // Create an excluded metro cache artifact
      fs.mkdirSync(path.join(projectDir, ".metro"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".metro", "cache.json"), '{"cache": 123}\n');

      const check = {
        id: "rn-check",
        name: "Test RN Check",
        type: "build_typecheck" as const,
        deliverable_id: "CODE-IMPL",
        command: "node",
        args: ["-v"],
        inputs: ["**/*"],
      };

      const rifResult = computeRif({
        projectDir,
        check,
      });

      // Metro cache file must be excluded from RIF
      const manifestFilePaths = rifResult.file_manifest.map((f: { path: string }) => f.path);
      assert.ok(manifestFilePaths.includes("src/index.ts"));
      assert.ok(!manifestFilePaths.some((p: string) => p.startsWith(".metro")));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Starter Template & Scaffolding
  // ─────────────────────────────────────────────────────────────

  describe("3. Starter Template & Scaffolding Invariants", () => {
    test("scaffolds React Native starter template with correct PROJECT_ID substitution", () => {
      const projectDir = path.join(tmpDir, "project-scaffold");
      createValidBaseManifest(projectDir, { project_id: "mobile-alpha" });
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      const result = manager.scaffoldStack({
        stackName: "react-native",
        targetDir: projectDir,
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.appliedStacks, ["react-native"]);

      // Verify files generated
      assert.ok(fs.existsSync(path.join(projectDir, "package.json")));
      assert.ok(fs.existsSync(path.join(projectDir, "tsconfig.json")));
      assert.ok(fs.existsSync(path.join(projectDir, "eslint.config.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "metro.config.js")));
      assert.ok(fs.existsSync(path.join(projectDir, "babel.config.js")));
      assert.ok(fs.existsSync(path.join(projectDir, "index.js")));
      assert.ok(fs.existsSync(path.join(projectDir, "App.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "components", "ui", "button.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "components", "ui", "modal.ios.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "components", "ui", "modal.android.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "screens", "home-screen.tsx")));
      assert.ok(fs.existsSync(path.join(projectDir, "src", "services", "storage.ts")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-secrets.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-companions.mjs")));
      assert.ok(fs.existsSync(path.join(projectDir, "scripts", "audit-accessibility.mjs")));

      // Verify PROJECT_ID replacement in package.json and index.js
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
      assert.equal(pkg.name, "mobile-alpha");
      assert.equal(pkg.dependencies.react, "18.3.1");
      assert.equal(pkg.dependencies["react-native"], "0.76.3");
      assert.equal(pkg.dependencies.expo, undefined, "Must NOT have Expo dependency");

      const indexContent = fs.readFileSync(path.join(projectDir, "index.js"), "utf-8");
      assert.match(indexContent, /registerComponent\('mobile-alpha'/);

      // Verify manifest was updated
      const manifest = JSON.parse(
        fs.readFileSync(path.join(projectDir, DEFAULT_PATHS.playbookDir, "manifest.json"), "utf-8")
      ) as ProjectManifest;
      assert.ok(manifest.technology_stacks?.includes("react-native"));
    });

    test("blocks overwrite of pre-existing files when force is false", () => {
      const projectDir = path.join(tmpDir, "project-collision");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      // Create a pre-existing App.tsx
      fs.writeFileSync(path.join(projectDir, "App.tsx"), "// Custom User App\n", "utf-8");

      const manager = new StackManager({ stacksDir: repoStacksDir });
      assert.throws(
        () => manager.scaffoldStack({ stackName: "react-native", targetDir: projectDir, force: false }),
        (err: unknown) => {
          assert.ok(err instanceof StackError);
          assert.equal(err.code, "COLLISION_DETECTED");
          return true;
        }
      );

      // Verify original file was preserved
      assert.equal(fs.readFileSync(path.join(projectDir, "App.tsx"), "utf-8"), "// Custom User App\n");
    });

    test("CLI runInit with --stack react-native scaffolds governance and stack in one command", async () => {
      const initTarget = path.join(tmpDir, "cli-init-app");
      const result = await runInit({
        cwd: initTarget,
        projectId: "cli-init-app",
        name: "CLI Init App",
        stack: "react-native",
        nonInteractive: true,
      });

      assert.equal(result.success, true);
      assert.ok(fs.existsSync(path.join(initTarget, DEFAULT_PATHS.playbookDir, "manifest.json")));
      assert.ok(fs.existsSync(path.join(initTarget, "package.json")));
      assert.ok(fs.existsSync(path.join(initTarget, "App.tsx")));

      const manifest = JSON.parse(
        fs.readFileSync(path.join(initTarget, DEFAULT_PATHS.playbookDir, "manifest.json"), "utf-8")
      ) as ProjectManifest;
      assert.ok(manifest.technology_stacks?.includes("react-native"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Engineering Rules & Mobile Quality Gate Audits
  // ─────────────────────────────────────────────────────────────

  describe("4. Engineering Rules & Quality Gate Audits", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = path.join(tmpDir, "scaffolded-app");
      createValidBaseManifest(projectDir);
      createValidQualityGatesConfig(projectDir);

      const manager = new StackManager({ stacksDir: repoStacksDir });
      manager.scaffoldStack({ stackName: "react-native", targetDir: projectDir });
    });

    // 4.1 Secret & Storage Audit (RULE-MOB-SEC-STORAGE)
    test("audit-secrets.mjs passes on pristine template scaffold", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-secrets.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 0, `Audit secrets failed: ${proc.stderr}`);
      assert.match(proc.stdout, /Zero credential leaks detected/);
    });

    test("audit-secrets.mjs rejects sensitive secrets in .env file", () => {
      fs.writeFileSync(path.join(projectDir, ".env"), "BACKEND_API_SECRET=super_secret_signing_key_12345\n", "utf-8");

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-secrets.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Sensitive secret key 'BACKEND_API_SECRET'/);
    });

    test("audit-secrets.mjs rejects unencrypted AsyncStorage.setItem storing sensitive auth tokens", () => {
      const badFilePath = path.join(projectDir, "src", "services", "bad-auth.ts");
      fs.writeFileSync(
        badFilePath,
        `import AsyncStorage from '@react-native-async-storage/async-storage';\n` +
        `export async function saveAuth(token: string) {\n` +
        `  await AsyncStorage.setItem('auth_token', token);\n` +
        `}\n`,
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-secrets.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /Prohibited sensitive key 'auth_token' passed to unencrypted AsyncStorage/);
    });

    // 4.2 Platform Companion Audit (RULE-RN-COMPANION)
    test("audit-companions.mjs passes on pristine template scaffold", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-companions.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 0, `Companion audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /All platform variants resolve symmetrically/);
    });

    test("audit-companions.mjs rejects unpaired platform file with UNPAIRED_PLATFORM_FILE", () => {
      const unpairedFile = path.join(projectDir, "src", "components", "ui", "camera.ios.tsx");
      fs.writeFileSync(unpairedFile, "export const Camera = () => null;\n", "utf-8");

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-companions.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /UNPAIRED_PLATFORM_FILE/);
      assert.match(proc.stderr, /resolves to 0 candidates on Android/);
    });

    test("audit-companions.mjs accepts platform-exclusive module with exemption directive and guarded import", () => {
      const exclusiveFile = path.join(projectDir, "src", "components", "ui", "apple-pay.ios.tsx");
      fs.writeFileSync(
        exclusiveFile,
        `// @playbook-platform-exclusive ios\n` +
        `export const ApplePay = () => null;\n`,
        "utf-8"
      );

      // Consumer file with guarded platform import
      const consumerFile = path.join(projectDir, "src", "components", "checkout.tsx");
      fs.writeFileSync(
        consumerFile,
        `import { Platform } from 'react-native';\n` +
        `export function Checkout() {\n` +
        `  if (Platform.OS === 'ios') {\n` +
        `    const { ApplePay } = require('./ui/apple-pay');\n` +
        `  }\n` +
        `}\n`,
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-companions.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 0, `Should pass with guarded import: ${proc.stderr}`);
    });

    test("audit-companions.mjs rejects unguarded static import of platform-exclusive module", () => {
      const exclusiveFile = path.join(projectDir, "src", "components", "ui", "apple-pay.ios.tsx");
      fs.writeFileSync(
        exclusiveFile,
        `// @playbook-platform-exclusive ios\n` +
        `export const ApplePay = () => null;\n`,
        "utf-8"
      );

      // Cross-platform consumer file with UNGUARDED static import
      const consumerFile = path.join(projectDir, "src", "components", "checkout.tsx");
      fs.writeFileSync(
        consumerFile,
        `import { ApplePay } from './ui/apple-pay';\n` +
        `export function Checkout() {\n` +
        `  return null;\n` +
        `}\n`,
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-companions.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT/);
    });

    // 4.3 Accessibility Audit (RULE-RN-ACCESSIBILITY)
    test("audit-accessibility.mjs passes on pristine template scaffold", () => {
      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-accessibility.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 0, `Accessibility audit failed: ${proc.stderr}`);
      assert.match(proc.stdout, /All interactive controls declare valid roles and descriptive labels/);
    });

    test("audit-accessibility.mjs rejects Pressable lacking accessibilityRole", () => {
      const badComponent = path.join(projectDir, "src", "components", "bad-button.tsx");
      fs.writeFileSync(
        badComponent,
        `import React from 'react';\n` +
        `import { Pressable, Text } from 'react-native';\n` +
        `export const BadBtn = () => (\n` +
        `  <Pressable accessibilityLabel="Click here">\n` +
        `    <Text>Click</Text>\n` +
        `  </Pressable>\n` +
        `);\n`,
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-accessibility.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /lacks mandatory 'accessibilityRole'/);
    });

    test("audit-accessibility.mjs rejects Pressable lacking accessibilityLabel", () => {
      const badComponent = path.join(projectDir, "src", "components", "bad-label.tsx");
      fs.writeFileSync(
        badComponent,
        `import React from 'react';\n` +
        `import { Pressable, Text } from 'react-native';\n` +
        `export const BadBtn = () => (\n` +
        `  <Pressable accessibilityRole="button">\n` +
        `    <Text>Submit</Text>\n` +
        `  </Pressable>\n` +
        `);\n`,
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-accessibility.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /lacks mandatory 'accessibilityLabel'/);
    });

    test("audit-accessibility.mjs rejects generic placeholder accessibilityLabel", () => {
      const badComponent = path.join(projectDir, "src", "components", "placeholder-btn.tsx");
      fs.writeFileSync(
        badComponent,
        `import React from 'react';\n` +
        `import { Pressable, Text } from 'react-native';\n` +
        `export const BadBtn = () => (\n` +
        `  <Pressable accessibilityRole="button" accessibilityLabel="button">\n` +
        `    <Text>Submit</Text>\n` +
        `  </Pressable>\n` +
        `);\n`,
        "utf-8"
      );

      const proc = spawnSync(process.execPath, [path.join(projectDir, "scripts", "audit-accessibility.mjs")], {
        cwd: projectDir,
        encoding: "utf-8",
      });

      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /generic placeholder accessibilityLabel 'button'/);
    });
  });
});
