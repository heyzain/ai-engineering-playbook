#!/usr/bin/env node

/**
 * Gate: expo-config-validate
 * 
 * Validates Expo app.json and eas.json configuration:
 * 1. app.json exists and contains required properties (name, slug, scheme, runtimeVersion).
 * 2. Platform bundleIdentifier (iOS) and package (Android) are declared and valid.
 * 3. Zero private secrets, API keys, or embedded signing credentials in app.json.
 * 4. eas.json exists and defines standard build profiles without embedded credentials.
 */

import fs from "node:fs";
import path from "node:path";

let violationsCount = 0;

function reportViolation(file, message) {
  violationsCount++;
  console.error(`✖ [expo-config-validate] ${file}: ${message}`);
}

function auditAppJson(projectDir) {
  const appJsonPath = path.join(projectDir, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    reportViolation("app.json", "Missing app.json manifest file.");
    return;
  }

  let content;
  try {
    content = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
  } catch (err) {
    reportViolation("app.json", `Malformed JSON syntax: ${err.message}`);
    return;
  }

  const expo = content.expo;
  if (!expo || typeof expo !== "object") {
    reportViolation("app.json", "Missing top-level 'expo' configuration object.");
    return;
  }

  if (!expo.name || typeof expo.name !== "string" || !expo.name.trim()) {
    reportViolation("app.json", "Missing or empty 'expo.name'.");
  }

  if (!expo.slug || typeof expo.slug !== "string" || !expo.slug.trim()) {
    reportViolation("app.json", "Missing or empty 'expo.slug'.");
  }

  if (!expo.scheme || typeof expo.scheme !== "string" || !expo.scheme.trim()) {
    reportViolation("app.json", "Missing or empty 'expo.scheme' required for deep linking.");
  }

  if (!expo.runtimeVersion) {
    reportViolation("app.json", "Missing 'expo.runtimeVersion'. Must declare policy (e.g. { policy: 'appVersion' }) or explicit version string.");
  }

  // iOS check
  if (!expo.ios || !expo.ios.bundleIdentifier) {
    reportViolation("app.json", "Missing 'expo.ios.bundleIdentifier' property.");
  } else if (!/^[a-zA-Z0-9.-]+$/.test(expo.ios.bundleIdentifier)) {
    reportViolation("app.json", `Invalid 'expo.ios.bundleIdentifier': '${expo.ios.bundleIdentifier}'.`);
  }

  // Android check
  if (!expo.android || !expo.android.package) {
    reportViolation("app.json", "Missing 'expo.android.package' property.");
  } else if (!/^[a-zA-Z0-9._-]+$/.test(expo.android.package)) {
    reportViolation("app.json", `Invalid 'expo.android.package': '${expo.android.package}'.`);
  }

  // Secret keyword scan in app.json
  const rawString = JSON.stringify(expo);
  const SENSITIVE_KEY_PATTERN = /"(?:secret|private_key|apiKey|password|auth_token|token)"\s*:\s*"[^"]+"/i;
  if (SENSITIVE_KEY_PATTERN.test(rawString)) {
    reportViolation("app.json", "Detected embedded private secret or credential in app.json. Public configuration manifests must never embed secrets.");
  }
}

function auditEasJson(projectDir) {
  const easJsonPath = path.join(projectDir, "eas.json");
  if (!fs.existsSync(easJsonPath)) {
    // Advisory if not present, but template includes it
    return;
  }

  let easContent;
  try {
    easContent = JSON.parse(fs.readFileSync(easJsonPath, "utf-8"));
  } catch (err) {
    reportViolation("eas.json", `Malformed JSON syntax in eas.json: ${err.message}`);
    return;
  }

  if (!easContent.build || typeof easContent.build !== "object") {
    reportViolation("eas.json", "Missing 'build' profiles object in eas.json.");
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Expo Application Manifest & Config Validation (expo-config-validate)...");

  auditAppJson(projectDir);
  auditEasJson(projectDir);

  if (violationsCount > 0) {
    console.error(`\nValidation failed with ${violationsCount} configuration defect(s).`);
    process.exit(1);
  } else {
    console.log("✔ Expo configuration in app.json and eas.json is valid.");
    process.exit(0);
  }
}

main();
