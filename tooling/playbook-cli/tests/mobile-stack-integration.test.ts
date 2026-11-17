import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { StackManager } from "../src/core/stacks/stack-manager.js";
import { runInit } from "../src/commands/init.js";
import { runStackList, runStackApply, runStackCompose } from "../src/commands/stack.js";
import { QualityGateRunner } from "../src/core/quality-gates/runner.js";
import { evaluateMobileRifRules } from "../src/core/mobile/rif-rules.js";
import { classifyMobileWorkflow } from "../src/core/mobile/workflow-classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoStacksDir = path.resolve(__dirname, "../../../../stacks");
const cliBinPath = path.resolve(__dirname, "../src/bin/playbook.js");

describe("Task 007D.5 — Mobile Stack Integration and Final Regression", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-mobile-integ-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Stack Discovery and Dependency Resolution Workflows
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Stack Discovery and CLI Invocations", () => {
    test("playbook stack list returns nextjs, react-native, and expo", () => {
      const res = runStackList({ stacksDir: repoStacksDir });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.exitCode, 0);
      assert.ok(res.data);
      const stackIds = res.data.map((s) => s.id);
      assert.ok(stackIds.includes("react-native"));
      assert.ok(stackIds.includes("expo"));
      assert.ok(stackIds.includes("nextjs"));

      const expoInfo = res.data.find((s) => s.id === "expo");
      assert.deepStrictEqual(expoInfo?.dependencies, ["react-native"]);
    });

    test("playbook init --stack react-native scaffolds bare RN governance and template", async () => {
      const targetDir = path.join(tmpDir, "bare-rn");
      const res = await runInit({
        projectId: "bare-rn-app",
        name: "Bare RN App",
        cwd: targetDir,
        stack: "react-native",
        nonInteractive: true,
        force: true,
      });

      assert.strictEqual(res.success, true);
      const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, ".playbook/manifest.json"), "utf-8"));
      assert.deepStrictEqual(manifest.technology_stacks, ["react-native"]);

      // Verify no Expo dependencies or files are present
      const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"));
      assert.strictEqual("expo" in (pkg.dependencies || {}), false);
      assert.strictEqual("expo-router" in (pkg.dependencies || {}), false);
      assert.strictEqual(fs.existsSync(path.join(targetDir, "app.json")), false);
      assert.strictEqual(fs.existsSync(path.join(targetDir, "app")), false);
      assert.ok(fs.existsSync(path.join(targetDir, "App.tsx")));
    });

    test("playbook init --stack expo automatically resolves React Native prerequisites", async () => {
      const targetDir = path.join(tmpDir, "expo-app");
      const res = await runInit({
        projectId: "expo-app",
        name: "Expo App",
        cwd: targetDir,
        stack: "expo",
        nonInteractive: true,
        force: true,
      });

      assert.strictEqual(res.success, true);
      const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, ".playbook/manifest.json"), "utf-8"));
      assert.deepStrictEqual(manifest.technology_stacks, ["react-native", "expo"]);

      // Verify package overrides: RN 0.88.1, React 19.3.0, @types/react-native removed
      const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"));
      assert.strictEqual(pkg.dependencies["react-native"], "0.88.1");
      assert.strictEqual(pkg.dependencies["react"], "19.3.0");
      assert.strictEqual(pkg.dependencies["expo"], "~58.0.23");
      assert.strictEqual(pkg.dependencies["expo-router"], "~58.0.30");
      assert.strictEqual("@types/react-native" in (pkg.devDependencies || {}), false);

      // Verify both app/ (Expo Router) and RN files exist
      assert.ok(fs.existsSync(path.join(targetDir, "app/_layout.tsx")));
      assert.ok(fs.existsSync(path.join(targetDir, "app/+not-found.tsx")));
      assert.ok(fs.existsSync(path.join(targetDir, "app.json")));
    });

    test("playbook stack apply expo to pre-existing compatible project resolves and layers cleanly", async () => {
      const targetDir = path.join(tmpDir, "pre-existing");
      await runInit({
        projectId: "pre-existing",
        name: "Pre Existing",
        cwd: targetDir,
        stack: "react-native",
        nonInteractive: true,
        force: true,
      });

      // Update dependencies to compatible RN 0.88.1 / React 19.3.0
      const pkgPath = path.join(targetDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      pkg.dependencies["react-native"] = "0.88.1";
      pkg.dependencies["react"] = "19.3.0";
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");

      const res = runStackApply("expo", {
        cwd: targetDir,
        stacksDir: repoStacksDir,
        force: true,
      });

      assert.strictEqual(res.success, true);
      const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, ".playbook/manifest.json"), "utf-8"));
      assert.deepStrictEqual(manifest.technology_stacks, ["react-native", "expo"]);
    });

    test("playbook stack apply expo to incompatible RN 0.76.3 fails closed before file mutations", () => {
      const targetDir = path.join(tmpDir, "incompatible");
      fs.mkdirSync(path.join(targetDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, ".playbook/manifest.json"),
        JSON.stringify({
          schema_version: "1.0.0",
          project_id: "incompatible",
          project_name: "Incompatible App",
          target_directory: targetDir,
          governance_profile: "standard",
          active_lifecycle_stage: 0,
          technology_stacks: ["react-native"],
        })
      );
      fs.writeFileSync(
        path.join(targetDir, "package.json"),
        JSON.stringify({
          name: "incompatible",
          dependencies: {
            "react-native": "0.76.3",
            react: "18.3.1",
          },
        })
      );

      const res = runStackApply("expo", {
        cwd: targetDir,
        stacksDir: repoStacksDir,
        force: true,
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert.strictEqual(res.error, "STACK_INCOMPATIBLE_DEPENDENCY");

      // Verify no expo files were written (zero mutations / rollback)
      assert.strictEqual(fs.existsSync(path.join(targetDir, "app.json")), false);
      assert.strictEqual(fs.existsSync(path.join(targetDir, "app")), false);
    });

    test("playbook stack compose is idempotent across repeated invocations", async () => {
      const targetDir = path.join(tmpDir, "compose-test");
      await runInit({
        projectId: "compose-app",
        name: "Compose App",
        cwd: targetDir,
        stack: "expo",
        nonInteractive: true,
        force: true,
      });

      const qgPath = path.join(targetDir, ".playbook/quality-gates.json");
      const beforeContent = fs.readFileSync(qgPath, "utf-8");

      // Re-run composition
      const res1 = runStackCompose({ cwd: targetDir, stacksDir: repoStacksDir });
      assert.strictEqual(res1.success, true);
      const afterContent1 = fs.readFileSync(qgPath, "utf-8");
      assert.strictEqual(beforeContent, afterContent1);

      // Re-run again
      const res2 = runStackCompose({ cwd: targetDir, stacksDir: repoStacksDir });
      assert.strictEqual(res2.success, true);
      const afterContent2 = fs.readFileSync(qgPath, "utf-8");
      assert.strictEqual(afterContent1, afterContent2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Quality Gate Runner Execution (React Native & Expo)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Quality Gate Execution via QualityGateRunner", () => {
    test("executes React Native Stage 4 quality gates cleanly", async () => {
      const targetDir = path.join(tmpDir, "rn-gates");
      await runInit({
        projectId: "rn-gates-app",
        name: "RN Gates App",
        cwd: targetDir,
        stack: "react-native",
        nonInteractive: true,
        force: true,
      });

      // Align manifest and state with Stage 4 for gate execution
      const manifestPath = path.join(targetDir, ".playbook/manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.active_lifecycle_stage = 4;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      const statePath = path.join(targetDir, ".playbook/state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage = 4;
      state.current_stage_detail.stage = 4;
      state.current_stage_detail.stage_name = "Implementation & Unit Verification";
      if (!state.current_stage_detail.deliverables.some((d: any) => d.id === "CODE-IMPL")) {
        state.current_stage_detail.deliverables.push({
          id: "CODE-IMPL",
          name: "Code Implementation",
          artifact_path: "src",
          status: "in_progress",
          validation_status: "unvalidated",
          evidence: [],
        });
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const runner = new QualityGateRunner(targetDir);

      // Execute React Native mobile checks through QualityGateRunner
      const rnChecks = ["rn-platform-companion", "rn-accessibility", "mobile-secret-audit"];
      for (const checkId of rnChecks) {
        const report = await runner.run({ stage: 4, checkId });
        assert.strictEqual(report.summary.total, 1, `Check ${checkId} did not execute`);
        assert.strictEqual(report.summary.passed, 1, `Check ${checkId} did not pass`);
        assert.strictEqual(report.summary.failed, 0, `Check ${checkId} failed`);
      }
    });

    test("executes Expo Stage 4 quality gates including inherited RN gates cleanly", async () => {
      const targetDir = path.join(tmpDir, "expo-gates");
      await runInit({
        projectId: "expo-gates-app",
        name: "Expo Gates App",
        cwd: targetDir,
        stack: "expo",
        nonInteractive: true,
        force: true,
      });

      // Align manifest and state with Stage 4 for gate execution
      const manifestPath = path.join(targetDir, ".playbook/manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.active_lifecycle_stage = 4;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      const statePath = path.join(targetDir, ".playbook/state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state.current_stage = 4;
      state.current_stage_detail.stage = 4;
      state.current_stage_detail.stage_name = "Implementation & Unit Verification";
      if (!state.current_stage_detail.deliverables.some((d: any) => d.id === "CODE-IMPL")) {
        state.current_stage_detail.deliverables.push({
          id: "CODE-IMPL",
          name: "Code Implementation",
          artifact_path: "src",
          status: "in_progress",
          validation_status: "unvalidated",
          evidence: [],
        });
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const runner = new QualityGateRunner(targetDir);

      // Execute Expo checks through QualityGateRunner
      const expoChecks = [
        "expo-config-validate",
        "expo-doctor",
        "expo-route-structure",
        "expo-plugin-validate",
        "expo-secret-audit",
        "rn-platform-companion",
        "rn-accessibility",
        "mobile-secret-audit",
      ];

      for (const checkId of expoChecks) {
        const report = await runner.run({ stage: 4, checkId });
        assert.strictEqual(report.summary.total, 1, `Check ${checkId} did not execute`);
        assert.strictEqual(report.summary.passed, 1, `Check ${checkId} did not pass`);
        assert.strictEqual(report.summary.failed, 0, `Check ${checkId} failed`);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Integrated RIF Pipeline
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Integrated Mobile RIF Pipeline", () => {
    test("evaluates composed mobile rules on pristine Expo project with 0 findings", async () => {
      const targetDir = path.join(tmpDir, "expo-rif-clean");
      await runInit({
        projectId: "expo-rif-app",
        name: "Expo RIF App",
        cwd: targetDir,
        stack: "expo",
        nonInteractive: true,
        force: true,
      });

      const suiteResult = evaluateMobileRifRules({ projectDir: targetDir });
      assert.strictEqual(suiteResult.passed, true);
      assert.strictEqual(suiteResult.blockingFindings, 0);
      assert.ok(suiteResult.results["RULE-RN-COMPANION"]);
      assert.ok(suiteResult.results["RULE-RN-ACCESSIBILITY"]);
      assert.ok(suiteResult.results["RULE-MOB-SEC-STORAGE"]);
      assert.ok(suiteResult.results["RULE-EXPO-PLUGINS"]);
      assert.ok(suiteResult.results["RULE-EXPO-ROUTER"]);
    });

    test("evaluates composed mobile rules detecting blocking defect across stack boundaries", async () => {
      const targetDir = path.join(tmpDir, "expo-rif-defect");
      await runInit({
        projectId: "expo-rif-defect",
        name: "Expo Defect App",
        cwd: targetDir,
        stack: "expo",
        nonInteractive: true,
        force: true,
      });

      // Inject a violation in an Expo Router screen: Pressable missing accessibilityRole
      fs.writeFileSync(
        path.join(targetDir, "app/settings.tsx"),
        `import { Pressable, Text } from 'react-native';\n` +
          `export default function Settings() {\n` +
          `  return <Pressable accessibilityLabel="Save settings"><Text>Save</Text></Pressable>;\n` +
          `}\n`
      );

      const suiteResult = evaluateMobileRifRules({ projectDir: targetDir });
      assert.strictEqual(suiteResult.passed, false);
      assert.ok(suiteResult.blockingFindings >= 1);
      const a11yResult = suiteResult.results["RULE-RN-ACCESSIBILITY"];
      assert.strictEqual(a11yResult.passed, false);
      const finding = a11yResult.findings.find((f) => f.code === "MISSING_ACCESSIBILITY_ROLE");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "app/settings.tsx");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Workflow Classification Protocol
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Mobile Workflow Classification Matrix", () => {
    test("classifies Bare React Native when manifest specifies ['react-native'] without Expo files", () => {
      const targetDir = path.join(tmpDir, "bare-wf");
      fs.mkdirSync(path.join(targetDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native"] })
      );
      fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify({ dependencies: { "react-native": "0.76.3" } }));

      const res = classifyMobileWorkflow(targetDir);
      assert.strictEqual(res.status, "COMPLETE");
      assert.strictEqual(res.workflow, "bare-react-native");
    });

    test("classifies Expo Managed when manifest specifies ['react-native', 'expo'] without native dirs", () => {
      const targetDir = path.join(tmpDir, "managed-wf");
      fs.mkdirSync(path.join(targetDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native", "expo"] })
      );
      fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));

      const res = classifyMobileWorkflow(targetDir);
      assert.strictEqual(res.status, "COMPLETE");
      assert.strictEqual(res.workflow, "expo-managed");
    });

    test("classifies Expo Committed CNG when native dirs exist and are not gitignored", () => {
      const targetDir = path.join(tmpDir, "cng-wf");
      fs.mkdirSync(path.join(targetDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native", "expo"] })
      );
      fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));
      fs.mkdirSync(path.join(targetDir, "android"), { recursive: true });

      const res = classifyMobileWorkflow(targetDir);
      assert.strictEqual(res.status, "COMPLETE");
      assert.strictEqual(res.workflow, "expo-committed-cng");
    });

    test("halts with AMBIGUOUS_WORKFLOW_CONFIGURATION when manifest declares bare RN but Expo files exist", () => {
      const targetDir = path.join(tmpDir, "conflict-wf");
      fs.mkdirSync(path.join(targetDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native"] })
      );
      fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));
      fs.writeFileSync(path.join(targetDir, "app.json"), JSON.stringify({ expo: { name: "App" } }));

      const res = classifyMobileWorkflow(targetDir);
      assert.strictEqual(res.status, "INCOMPLETE");
      assert.strictEqual(res.errorCode, "AMBIGUOUS_WORKFLOW_CONFIGURATION");
    });
  });
});
