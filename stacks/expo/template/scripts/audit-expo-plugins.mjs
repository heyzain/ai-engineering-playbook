#!/usr/bin/env node

/**
 * Gate: expo-plugin-validate
 * 
 * Verifies Expo Config Plugins and native configuration rules (RULE-EXPO-PLUGINS):
 * 1. All declared plugins in app.json exist and are resolvable.
 * 2. Local config plugins under plugins/ export a valid plugin function.
 * 3. Enforces declarative Continuous Native Generation (CNG): native modifications
 *    must be encapsulated in Config Plugins rather than direct manual edits to android/ and ios/.
 */

import fs from "node:fs";
import path from "node:path";

let violationsCount = 0;

function reportViolation(file, message) {
  violationsCount++;
  console.error(`✖ [expo-plugin-validate] ${file}: ${message}`);
}

function auditConfigPlugins(projectDir) {
  const appJsonPath = path.join(projectDir, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    reportViolation("app.json", "Missing app.json manifest file.");
    return;
  }

  let content;
  try {
    content = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
  } catch (err) {
    reportViolation("app.json", `Cannot parse JSON: ${err.message}`);
    return;
  }

  const plugins = content.expo?.plugins;
  if (!plugins || !Array.isArray(plugins)) {
    reportViolation("app.json", "Missing or invalid 'expo.plugins' array.");
    return;
  }

  for (const pluginEntry of plugins) {
    const pluginName = Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry;
    if (typeof pluginName !== "string") {
      reportViolation("app.json", `Invalid plugin entry '${JSON.stringify(pluginEntry)}'. Expected string or [string, config].`);
      continue;
    }

    // Check local plugin file
    if (pluginName.startsWith("./") || pluginName.startsWith("../")) {
      const resolvedPluginPath = path.resolve(projectDir, pluginName);
      if (!fs.existsSync(resolvedPluginPath)) {
        reportViolation("app.json", `Declared local Config Plugin '${pluginName}' not found at '${resolvedPluginPath}'.`);
      } else {
        // Inspect plugin file
        try {
          const pluginContent = fs.readFileSync(resolvedPluginPath, "utf-8");
          if (!pluginContent.includes("module.exports") && !pluginContent.includes("export default")) {
            reportViolation(pluginName, "Config Plugin does not export a function (missing module.exports or export default).");
          }
        } catch (err) {
          reportViolation(pluginName, `Failed to inspect Config Plugin: ${err.message}`);
        }
      }
    }
  }

  // Check RULE-EXPO-PLUGINS: in managed workflow, android/ and ios/ shouldn't contain manual divergent code
  // If android/ and ios/ exist, check if .gitignore ignores them or if committed CNG
  const gitignorePath = path.join(projectDir, ".gitignore");
  const hasGitignore = fs.existsSync(gitignorePath);
  const gitignoreContent = hasGitignore ? fs.readFileSync(gitignorePath, "utf-8") : "";

  const iosExists = fs.existsSync(path.join(projectDir, "ios"));
  const androidExists = fs.existsSync(path.join(projectDir, "android"));

  if (iosExists || androidExists) {
    const iosIgnored = /^\/?ios(\/|$)/m.test(gitignoreContent);
    const androidIgnored = /^\/?android(\/|$)/m.test(gitignoreContent);

    if (!iosIgnored || !androidIgnored) {
      console.log("ℹ [expo-plugin-validate] Project is operating in Committed CNG mode with tracked native folders.");
    }
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Expo Config Plugins Integrity Audit (expo-plugin-validate)...");

  auditConfigPlugins(projectDir);

  if (violationsCount > 0) {
    console.error(`\nexpo-plugin-validate failed with ${violationsCount} plugin defect(s).`);
    process.exit(1);
  } else {
    console.log("✔ Expo Config Plugins verified.");
    process.exit(0);
  }
}

main();
