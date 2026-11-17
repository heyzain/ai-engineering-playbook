import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  evaluateRuleRnCompanion,
  evaluateRuleRnAccessibility,
  evaluateRuleMobSecStorage,
  evaluateRuleExpoPlugins,
  evaluateRuleExpoRouter,
  evaluateMobileRifRules,
} from "../src/core/mobile/rif-rules.js";
import { StackManager } from "../src/core/stacks/stack-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoStacksDir = path.resolve(__dirname, "../../../../stacks");

describe("Task 007D.4 — Mobile RIF Rules Implementation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-mobile-rif-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RULE-RN-COMPANION
  // ───────────────────────────────────────────────────────────────────────────
  describe("RULE-RN-COMPANION: Platform File Companion Parity", () => {
    test("PASS: exact companion pairing (.ios.tsx + .android.tsx)", () => {
      const modalDir = path.join(tmpDir, "src/components/ui");
      fs.mkdirSync(modalDir, { recursive: true });
      fs.writeFileSync(path.join(modalDir, "modal.ios.tsx"), "export function Modal() { return null; }\n");
      fs.writeFileSync(path.join(modalDir, "modal.android.tsx"), "export function Modal() { return null; }\n");

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: universal fallback companion (.ios.tsx + .tsx)", () => {
      const pickerDir = path.join(tmpDir, "src/components/ui");
      fs.mkdirSync(pickerDir, { recursive: true });
      fs.writeFileSync(path.join(pickerDir, "picker.ios.tsx"), "export function Picker() { return null; }\n");
      fs.writeFileSync(path.join(pickerDir, "picker.tsx"), "export function Picker() { return null; }\n");

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: universal native fallback (.ios.tsx + .native.tsx)", () => {
      const sheetDir = path.join(tmpDir, "src/components/ui");
      fs.mkdirSync(sheetDir, { recursive: true });
      fs.writeFileSync(path.join(sheetDir, "sheet.ios.tsx"), "export function Sheet() { return null; }\n");
      fs.writeFileSync(path.join(sheetDir, "sheet.native.tsx"), "export function Sheet() { return null; }\n");

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: unpaired platform file fails closed with UNPAIRED_PLATFORM_FILE", () => {
      const widgetDir = path.join(tmpDir, "src/components/ui");
      fs.mkdirSync(widgetDir, { recursive: true });
      fs.writeFileSync(path.join(widgetDir, "widget.ios.tsx"), "export function Widget() { return null; }\n");

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "UNPAIRED_PLATFORM_FILE");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "src/components/ui/widget.ios.tsx");
      assert.strictEqual(finding.severity, "blocking");
    });

    test("PASS: platform-exclusive module with header directive and guarded import", () => {
      const servicesDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(servicesDir, { recursive: true });

      // Exclusive iOS module
      fs.writeFileSync(
        path.join(servicesDir, "healthkit.ios.ts"),
        "// @playbook-platform-exclusive ios\nexport const HealthKit = { isAvailable: true };\n"
      );

      // Consumer with Platform guard
      fs.writeFileSync(
        path.join(servicesDir, "tracker.ts"),
        `import { Platform } from 'react-native';\nlet healthKit: any;\nif (Platform.OS === 'ios') {\n  healthKit = require('./healthkit');\n}\n`
      );

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: platform-exclusive module registered in options/rif-patterns", () => {
      const servicesDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(servicesDir, { recursive: true });

      fs.writeFileSync(
        path.join(servicesDir, "apple-pay.ios.ts"),
        "export const ApplePay = { pay: () => {} };\n"
      );

      const result = evaluateRuleRnCompanion(tmpDir, {
        platformExclusiveModules: {
          "src/services/apple-pay": "ios",
        },
      });
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: platform-exclusive module with unguarded static import fails with UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT", () => {
      const servicesDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(servicesDir, { recursive: true });

      fs.writeFileSync(
        path.join(servicesDir, "passkit.ios.ts"),
        "// @playbook-platform-exclusive ios\nexport const PassKit = {};\n"
      );

      // Unguarded static import in platform-neutral code
      fs.writeFileSync(
        path.join(servicesDir, "wallet.ts"),
        `import { PassKit } from './passkit';\nexport function getWallet() { return PassKit; }\n`
      );

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "src/services/wallet.ts");
      assert.strictEqual(finding.severity, "blocking");
    });

    test("PASS: explicit no-op stub companion satisfies bilateral resolution natively", () => {
      const servicesDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(servicesDir, { recursive: true });

      // iOS active implementation
      fs.writeFileSync(path.join(servicesDir, "biometrics.ios.ts"), "export const Biometrics = { authenticate: () => true };\n");
      // Android no-op stub
      fs.writeFileSync(path.join(servicesDir, "biometrics.android.ts"), "export const Biometrics = { authenticate: () => false };\n");

      const result = evaluateRuleRnCompanion(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: oversized source file fails closed with OVERSIZED_SOURCE_FILE", () => {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      // Create a 2MB file
      const bigBuffer = Buffer.alloc(2 * 1024 * 1024, "a");
      fs.writeFileSync(path.join(srcDir, "huge.ts"), bigBuffer);

      const result = evaluateRuleRnCompanion(tmpDir, { maxFileSizeBytes: 1024 * 1024 });
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "OVERSIZED_SOURCE_FILE");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "src/huge.ts");
      assert.strictEqual(finding.severity, "blocking");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. RULE-RN-ACCESSIBILITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("RULE-RN-ACCESSIBILITY: Mobile Interactive Accessibility Audit", () => {
    test("PASS: interactive Pressable with valid role and descriptive label", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "button.tsx"),
        `<Pressable accessibilityRole="button" accessibilityLabel="Submit payment" onPress={() => {}} />\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: interactive control with JSX expression label and role", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "dynamic-btn.tsx"),
        `<TouchableOpacity accessibilityRole={customRole} accessibilityLabel={t("actions.save")} />\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: Pressable lacking accessibilityRole fails with MISSING_ACCESSIBILITY_ROLE", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "bad-btn.tsx"),
        `<Pressable accessibilityLabel="Close dialog" onPress={() => {}} />\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MISSING_ACCESSIBILITY_ROLE");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "src/components/bad-btn.tsx");
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: Pressable with invalid accessibilityRole fails with INVALID_ACCESSIBILITY_ROLE", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "invalid-role.tsx"),
        `<Pressable accessibilityRole="custom-widget-type" accessibilityLabel="Submit" onPress={() => {}} />\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "INVALID_ACCESSIBILITY_ROLE");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: TouchableOpacity lacking accessibilityLabel fails with MISSING_ACCESSIBILITY_LABEL", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "unlabeled.tsx"),
        `<TouchableOpacity accessibilityRole="button" onPress={() => {}} />\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MISSING_ACCESSIBILITY_LABEL");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: generic placeholder accessibilityLabel ('button', 'click') fails with GENERIC_ACCESSIBILITY_LABEL", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "generic.tsx"),
        `<Pressable accessibilityRole="button" accessibilityLabel="button" onPress={() => {}} />\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "GENERIC_ACCESSIBILITY_LABEL");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("PASS: non-interactive components (<View>, <Text>) do not require accessibility roles", () => {
      const compDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(
        path.join(compDir, "layout.tsx"),
        `<View style={{ flex: 1 }}><Text>Hello World</Text></View>\n`
      );

      const result = evaluateRuleRnAccessibility(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RULE-MOB-SEC-STORAGE
  // ───────────────────────────────────────────────────────────────────────────
  describe("RULE-MOB-SEC-STORAGE: Mobile Secret & Secure Storage Auditor", () => {
    test("PASS: ordinary AsyncStorage storing non-sensitive preference and cache", () => {
      const svcDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(svcDir, { recursive: true });
      fs.writeFileSync(
        path.join(svcDir, "prefs.ts"),
        `import AsyncStorage from '@react-native-async-storage/async-storage';\n` +
          `AsyncStorage.setItem('theme_mode', 'dark');\n` +
          `AsyncStorage.setItem('preferred_locale', 'en-US');\n` +
          `AsyncStorage.setItem('offline_article_cache', JSON.stringify(cache));\n`
      );

      const result = evaluateRuleMobSecStorage(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: ordinary AsyncStorage storing sensitive token fails with UNENCRYPTED_SENSITIVE_STORAGE", () => {
      const svcDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(svcDir, { recursive: true });
      fs.writeFileSync(
        path.join(svcDir, "bad-auth.ts"),
        `import AsyncStorage from '@react-native-async-storage/async-storage';\n` +
          `AsyncStorage.setItem('auth_token', token);\n`
      );

      const result = evaluateRuleMobSecStorage(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "UNENCRYPTED_SENSITIVE_STORAGE");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "src/services/bad-auth.ts");
      assert.strictEqual(finding.severity, "blocking");
    });

    test("PASS: approved secure storage abstraction (SecureStore) storing sensitive token", () => {
      const svcDir = path.join(tmpDir, "src/services");
      fs.mkdirSync(svcDir, { recursive: true });
      fs.writeFileSync(
        path.join(svcDir, "secure-auth.ts"),
        `import * as SecureStore from 'expo-secure-store';\n` +
          `await SecureStore.setItemAsync('auth_token', token);\n`
      );

      const result = evaluateRuleMobSecStorage(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: private secrets in mobile .env file fails with MOBILE_ENV_SECRET_LEAK", () => {
      fs.writeFileSync(path.join(tmpDir, ".env"), "DATABASE_PASSWORD=supersecret123\nAPI_SECRET_KEY=sk_12345\n");

      const result = evaluateRuleMobSecStorage(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MOBILE_ENV_SECRET_LEAK");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: sensitive secret prefixed with EXPO_PUBLIC_ fails with EXPO_PUBLIC_SECRET_LEAK", () => {
      fs.writeFileSync(
        path.join(tmpDir, ".env"),
        "EXPO_PUBLIC_STRIPE_SECRET_KEY=sk_live_99999\nEXPO_PUBLIC_API_URL=https://api.example.com\n"
      );

      const result = evaluateRuleMobSecStorage(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "EXPO_PUBLIC_SECRET_LEAK");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: embedded cryptographic private key fails with EMBEDDED_PRIVATE_KEY", () => {
      const certDir = path.join(tmpDir, "src");
      fs.mkdirSync(certDir, { recursive: true });
      fs.writeFileSync(
        path.join(certDir, "cert.ts"),
        `const privateKey = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA0...\\n-----END RSA PRIVATE KEY-----";\n`
      );

      const result = evaluateRuleMobSecStorage(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "EMBEDDED_PRIVATE_KEY");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RULE-EXPO-PLUGINS
  // ───────────────────────────────────────────────────────────────────────────
  describe("RULE-EXPO-PLUGINS: Expo Config Plugins & CNG Integrity", () => {
    test("PASS: Bare React Native workflow with committed native dirs is not falsely rejected", () => {
      // Create Bare React Native project manifest
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native"] })
      );
      fs.mkdirSync(path.join(tmpDir, "android/app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "ios"), { recursive: true });

      const result = evaluateRuleExpoPlugins(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: Expo Managed workflow without native dirs passes", () => {
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native", "expo"] })
      );
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));
      fs.writeFileSync(path.join(tmpDir, "app.json"), JSON.stringify({ expo: { name: "TestApp", slug: "test" } }));

      const result = evaluateRuleExpoPlugins(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: Expo Managed workflow with committed un-gitignored native dirs fails with UNMANAGED_NATIVE_DRIFT", () => {
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({
          technology_stacks: ["react-native", "expo"],
          metadata: { mobile_workflow: "expo-managed" },
        })
      );
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));
      fs.writeFileSync(path.join(tmpDir, "app.json"), JSON.stringify({ expo: { name: "TestApp", slug: "test" } }));
      fs.mkdirSync(path.join(tmpDir, "android"), { recursive: true });

      const result = evaluateRuleExpoPlugins(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "UNMANAGED_NATIVE_DRIFT");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("PASS: Expo Committed CNG with valid local Config Plugin exporting a function", () => {
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({
          technology_stacks: ["react-native", "expo"],
          metadata: { mobile_workflow: "expo-committed-cng" },
        })
      );
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));
      fs.mkdirSync(path.join(tmpDir, "android"), { recursive: true });

      const pluginDir = path.join(tmpDir, "plugins");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "withCustomConfig.js"),
        "module.exports = function withCustomConfig(config) { return config; };\n"
      );

      fs.writeFileSync(
        path.join(tmpDir, "app.json"),
        JSON.stringify({
          expo: {
            name: "TestApp",
            slug: "test",
            plugins: ["./plugins/withCustomConfig.js"],
          },
        })
      );

      const result = evaluateRuleExpoPlugins(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: Expo project with missing local Config Plugin fails with PLUGIN_FILE_NOT_FOUND", () => {
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native", "expo"] })
      );
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));
      fs.writeFileSync(
        path.join(tmpDir, "app.json"),
        JSON.stringify({
          expo: {
            name: "TestApp",
            slug: "test",
            plugins: ["./plugins/nonExistentPlugin.js"],
          },
        })
      );

      const result = evaluateRuleExpoPlugins(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "PLUGIN_FILE_NOT_FOUND");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: local Config Plugin that does not export a function fails with INVALID_PLUGIN_EXPORT", () => {
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native", "expo"] })
      );
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { expo: "^58.0.0" } }));

      const pluginDir = path.join(tmpDir, "plugins");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "brokenPlugin.js"), "const foo = 'bar'; // no export\n");

      fs.writeFileSync(
        path.join(tmpDir, "app.json"),
        JSON.stringify({
          expo: {
            name: "TestApp",
            slug: "test",
            plugins: ["./plugins/brokenPlugin.js"],
          },
        })
      );

      const result = evaluateRuleExpoPlugins(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "INVALID_PLUGIN_EXPORT");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. RULE-EXPO-ROUTER
  // ───────────────────────────────────────────────────────────────────────────
  describe("RULE-EXPO-ROUTER: Expo Router Directory & Route Contract", () => {
    test("PASS: valid app/ with _layout, +not-found, and routes exporting default components", () => {
      const appDir = path.join(tmpDir, "app");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "_layout.tsx"), "export default function RootLayout() { return null; }\n");
      fs.writeFileSync(path.join(appDir, "+not-found.tsx"), "export default function NotFoundScreen() { return null; }\n");
      fs.writeFileSync(path.join(appDir, "index.tsx"), "export default function HomeScreen() { return null; }\n");

      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: API routes under app/api/ export HTTP methods without requiring default React export", () => {
      const appDir = path.join(tmpDir, "app/api");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "app/_layout.tsx"), "export default function Layout() { return null; }\n");
      fs.writeFileSync(path.join(tmpDir, "app/+not-found.tsx"), "export default function NotFound() { return null; }\n");
      fs.writeFileSync(
        path.join(appDir, "auth.ts"),
        "export async function GET(request: Request) { return new Response('ok'); }\n"
      );

      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("PASS: private non-route files (e.g. _components/) do not require default export", () => {
      const compDir = path.join(tmpDir, "app/_components");
      fs.mkdirSync(compDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "app/_layout.tsx"), "export default function Layout() { return null; }\n");
      fs.writeFileSync(path.join(tmpDir, "app/+not-found.tsx"), "export default function NotFound() { return null; }\n");
      fs.writeFileSync(path.join(compDir, "header.tsx"), "export const Header = () => null;\n");

      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findings.length, 0);
    });

    test("FAIL: missing app/ directory fails with MISSING_APP_DIR", () => {
      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MISSING_APP_DIR");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: missing _layout.tsx fails with MISSING_ROOT_LAYOUT", () => {
      const appDir = path.join(tmpDir, "app");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "+not-found.tsx"), "export default function NotFound() { return null; }\n");
      fs.writeFileSync(path.join(appDir, "index.tsx"), "export default function HomeScreen() { return null; }\n");

      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MISSING_ROOT_LAYOUT");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: missing +not-found.tsx fails with MISSING_NOT_FOUND_ROUTE", () => {
      const appDir = path.join(tmpDir, "app");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "_layout.tsx"), "export default function Layout() { return null; }\n");
      fs.writeFileSync(path.join(appDir, "index.tsx"), "export default function HomeScreen() { return null; }\n");

      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MISSING_NOT_FOUND_ROUTE");
      assert.ok(finding);
      assert.strictEqual(finding.severity, "blocking");
    });

    test("FAIL: route file lacking default component export fails with MISSING_DEFAULT_EXPORT", () => {
      const appDir = path.join(tmpDir, "app");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "_layout.tsx"), "export default function Layout() { return null; }\n");
      fs.writeFileSync(path.join(appDir, "+not-found.tsx"), "export default function NotFound() { return null; }\n");
      // Screen lacks default export
      fs.writeFileSync(path.join(appDir, "settings.tsx"), "export function SettingsScreen() { return null; }\n");

      const result = evaluateRuleExpoRouter(tmpDir);
      assert.strictEqual(result.passed, false);
      const finding = result.findings.find((f) => f.code === "MISSING_DEFAULT_EXPORT");
      assert.ok(finding);
      assert.strictEqual(finding.filePath, "app/settings.tsx");
      assert.strictEqual(finding.severity, "blocking");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. RIF Composition & Stack Integration
  // ───────────────────────────────────────────────────────────────────────────
  describe("RIF Composition & Multi-Stack Integration", () => {
    test("StackManager composes React Native and Expo RIF patterns with deduplicated rules", () => {
      const manager = new StackManager({ stacksDir: repoStacksDir });
      const composed = manager.composeStackRifPatterns(["expo"]);

      assert.strictEqual(composed.stack, "expo");
      assert.ok(Array.isArray(composed.rules));
      assert.ok(composed.rules.includes("RULE-RN-COMPANION"));
      assert.ok(composed.rules.includes("RULE-RN-ACCESSIBILITY"));
      assert.ok(composed.rules.includes("RULE-MOB-SEC-STORAGE"));
      assert.ok(composed.rules.includes("RULE-EXPO-PLUGINS"));
      assert.ok(composed.rules.includes("RULE-EXPO-ROUTER"));

      // Check deduplication
      const uniqueRules = new Set(composed.rules);
      assert.strictEqual(uniqueRules.size, composed.rules.length);

      // Check exclusions include both .metro and .expo
      assert.ok(composed.exclude_patterns?.some((p) => p.includes(".metro")));
      assert.ok(composed.exclude_patterns?.some((p) => p.includes(".expo")));
    });

    test("evaluateMobileRifRules automatically deduces active rules from manifest", () => {
      fs.mkdirSync(path.join(tmpDir, ".playbook"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".playbook/manifest.json"),
        JSON.stringify({ technology_stacks: ["react-native"] })
      );

      const srcDir = path.join(tmpDir, "src/components");
      fs.mkdirSync(srcDir, { recursive: true });
      // Pristine components
      fs.writeFileSync(path.join(srcDir, "button.ios.tsx"), "export function Button() { return null; }\n");
      fs.writeFileSync(path.join(srcDir, "button.android.tsx"), "export function Button() { return null; }\n");
      fs.writeFileSync(
        path.join(srcDir, "pressable.tsx"),
        `<Pressable accessibilityRole="button" accessibilityLabel="Submit" onPress={() => {}} />\n`
      );

      const suiteResult = evaluateMobileRifRules({ projectDir: tmpDir });
      assert.strictEqual(suiteResult.passed, true);
      assert.ok(suiteResult.results["RULE-RN-COMPANION"]);
      assert.ok(suiteResult.results["RULE-RN-ACCESSIBILITY"]);
      assert.ok(suiteResult.results["RULE-MOB-SEC-STORAGE"]);
      // Expo rules not evaluated for pure React Native
      assert.strictEqual(suiteResult.results["RULE-EXPO-PLUGINS"], undefined);
      assert.strictEqual(suiteResult.results["RULE-EXPO-ROUTER"], undefined);
    });
  });
});
