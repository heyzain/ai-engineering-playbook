#!/usr/bin/env node

/**
 * Gate: expo-route-structure
 * 
 * Verifies Expo Router directory conventions and route contracts:
 * 1. app/ directory exists and contains root layout app/_layout.tsx.
 * 2. Mandatory 404 fallback route app/+not-found.tsx exists.
 * 3. Every route file under app/ exports a default React component.
 *    Missing default exports produce runtime navigation crashes and fail closed.
 */

import fs from "node:fs";
import path from "node:path";

let violationsCount = 0;

function reportViolation(file, message) {
  violationsCount++;
  console.error(`✖ [expo-route-structure] ${file}: ${message}`);
}

const DEFAULT_EXPORT_REGEX = /(?:export\s+default\s+(?:function|class|const|let|var|\(?\w+\)?\s*=>)|export\s+default\s+[\w$]+;?)/;

function collectRouteFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRouteFiles(fullPath, fileList);
    } else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      if (!entry.name.endsWith(".d.ts")) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

function auditRouteStructure(projectDir) {
  const appDir = path.join(projectDir, "app");
  if (!fs.existsSync(appDir)) {
    reportViolation("app/", "Missing 'app/' root directory required by Expo Router.");
    return;
  }

  // 1. Mandatory Root Layout
  const rootLayoutTsx = path.join(appDir, "_layout.tsx");
  const rootLayoutJs = path.join(appDir, "_layout.js");
  if (!fs.existsSync(rootLayoutTsx) && !fs.existsSync(rootLayoutJs)) {
    reportViolation("app/_layout.tsx", "Missing mandatory root layout 'app/_layout.tsx'.");
  }

  // 2. Mandatory 404 Fallback Route
  const notFoundTsx = path.join(appDir, "+not-found.tsx");
  const notFoundJs = path.join(appDir, "+not-found.js");
  if (!fs.existsSync(notFoundTsx) && !fs.existsSync(notFoundJs)) {
    reportViolation("app/+not-found.tsx", "Missing mandatory 404 fallback route 'app/+not-found.tsx'.");
  }

  // 3. Scan all route files for default exports
  const routeFiles = collectRouteFiles(appDir);
  for (const file of routeFiles) {
    const relPath = path.relative(projectDir, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf-8");

    if (!DEFAULT_EXPORT_REGEX.test(content)) {
      reportViolation(
        relPath,
        "Route file lacks a mandatory 'export default' component. In Expo Router, every screen and layout file must default-export a React component."
      );
    }
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Expo Router Structure & Default Export Audit (expo-route-structure)...");

  auditRouteStructure(projectDir);

  if (violationsCount > 0) {
    console.error(`\nexpo-route-structure failed with ${violationsCount} routing defect(s).`);
    process.exit(1);
  } else {
    console.log("✔ Expo Router route tree and default exports verified.");
    process.exit(0);
  }
}

main();
