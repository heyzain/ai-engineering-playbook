#!/usr/bin/env node

/**
 * Gate: expo-doctor
 * 
 * Evaluates declared and installed dependencies against the official Expo SDK 58 compatibility matrix:
 * - Expo SDK: 58.x (reference baseline: ~58.0.0)
 * - React Native: 0.88.x (reference baseline: 0.88.0)
 * - React: 19.3.x (reference baseline: 19.3.0)
 * - Expo Router: 58.x (reference baseline: ~58.0.0)
 * - Node.js: >= 22.13.0 (22.13+ LTS, 24.3+, 26+; odd versions 23/25 unsupported)
 *
 * Rejects incompatible dependency combinations and unvetted ranges.
 */

import fs from "node:fs";
import path from "node:path";

let violationsCount = 0;

function reportViolation(message) {
  violationsCount++;
  console.error(`✖ [expo-doctor] ${message}`);
}

function parseSemverMajorMinor(versionStr) {
  const clean = (versionStr || "").replace(/^[\^~>=<]+/, "").trim();
  const parts = clean.split(".");
  return {
    major: parseInt(parts[0], 10),
    minor: parseInt(parts[1], 10),
    patch: parseInt(parts[2], 10),
    raw: versionStr,
  };
}

function auditDependencies(projectDir) {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    reportViolation("package.json not found.");
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    reportViolation(`Malformed package.json: ${err.message}`);
    return;
  }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  // 1. Validate Expo Core SDK
  const expoVer = deps.expo;
  if (!expoVer) {
    reportViolation("Missing mandatory 'expo' dependency in package.json.");
    return;
  }

  const parsedExpo = parseSemverMajorMinor(expoVer);
  if (parsedExpo.major !== 58) {
    reportViolation(
      `Incompatible Expo SDK version '${expoVer}'. Active reference baseline requires Expo SDK 58 (e.g. '~58.0.0').`
    );
  }

  // 2. Validate React Native Core
  const rnVer = deps["react-native"];
  if (!rnVer) {
    reportViolation("Missing 'react-native' dependency in package.json.");
  } else {
    const parsedRn = parseSemverMajorMinor(rnVer);
    if (parsedRn.major !== 0 || parsedRn.minor !== 88) {
      reportViolation(
        `Incompatible React Native version '${rnVer}' for Expo SDK 58. Official pairing requires React Native 0.88.x (e.g. '0.88.0').`
      );
    }
  }

  // 3. Validate React
  const reactVer = deps.react;
  if (!reactVer) {
    reportViolation("Missing 'react' dependency in package.json.");
  } else {
    const parsedReact = parseSemverMajorMinor(reactVer);
    if (parsedReact.major !== 19 || parsedReact.minor !== 3) {
      reportViolation(
        `Incompatible React version '${reactVer}' for Expo SDK 58. Official pairing requires React 19.3.x (e.g. '19.3.0'). React 18 is deprecated in SDK 58.`
      );
    }
  }

  // 4. Validate Expo Router
  const routerVer = deps["expo-router"];
  if (routerVer) {
    const parsedRouter = parseSemverMajorMinor(routerVer);
    if (parsedRouter.major !== 58) {
      reportViolation(
        `Incompatible 'expo-router' version '${routerVer}'. Expo SDK 58 aligns package versioning with SDK 58 (e.g. '~58.0.30').`
      );
    }
  }

  // 5. Validate Deprecated Type Packages
  if (devDeps["@types/react-native"] || deps["@types/react-native"]) {
    reportViolation(
      "Unnecessary and deprecated dependency '@types/react-native' detected. React Native 0.88 provides built-in TypeScript types directly in 'react-native'. Remove '@types/react-native' to prevent type declaration collisions."
    );
  }

  // 6. Node.js Engine Check: >= 22.13.0 (and reject odd 23/25)
  const currentEngine = process.version; // e.g. "v24.14.0"
  const cleanVersion = currentEngine.replace(/^v/, "");
  const [major, minor] = cleanVersion.split(".").map((n) => parseInt(n, 10));

  if (major < 22 || (major === 22 && minor < 13)) {
    reportViolation(
      `Node.js version ${currentEngine} is below the minimum required Node.js 22.13.0 LTS for Expo SDK 58.`
    );
  } else if (major % 2 !== 0) {
    // Odd numbered releases like 23, 25 are unsupported by Expo official policy
    reportViolation(
      `Node.js version ${currentEngine} is an odd-numbered release. Expo SDK 58 officially requires even LTS releases (22.13+, 24.3+, 26+).`
    );
  }
}

async function main() {
  const projectDir = process.cwd();
  console.log("Running Expo SDK & Dependency Compatibility Audit (expo-doctor)...");

  // Step 1: Hermetic static dependency matrix audit
  auditDependencies(projectDir);

  if (violationsCount > 0) {
    console.error(`\nexpo-doctor detected ${violationsCount} incompatible dependency defect(s).`);
    process.exit(1);
  }

  console.log("✔ All Expo dependencies conform to official SDK 58 compatibility matrix.");

  // Step 2: Live official Expo Doctor invocation if dependencies are installed
  const hasInstalledExpo = fs.existsSync(path.join(projectDir, "node_modules", "expo"));
  if (hasInstalledExpo) {
    console.log("Executing official Expo Doctor (npx expo-doctor)...");
    try {
      const { spawnSync } = await import("node:child_process");
      const doctorProc = spawnSync("npx", ["expo-doctor"], {
        cwd: projectDir,
        encoding: "utf-8",
        shell: process.platform === "win32",
      });

      if (doctorProc.stdout) process.stdout.write(doctorProc.stdout);
      if (doctorProc.stderr) process.stderr.write(doctorProc.stderr);

      if (doctorProc.status !== 0) {
        console.error(`\n✖ Official Expo Doctor check failed with exit code ${doctorProc.status}.`);
        process.exit(doctorProc.status || 1);
      }
      console.log("✔ Official Expo Doctor verification passed.");
    } catch (err) {
      console.error(`✖ Failed to execute official Expo Doctor: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log("ℹ [expo-doctor] node_modules not yet installed on disk. Offline hermetic matrix verified. Run 'npm install && npx expo-doctor' for live official diagnostics.");
  }

  process.exit(0);
}

main();
