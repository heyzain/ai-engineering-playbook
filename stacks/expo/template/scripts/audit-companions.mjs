#!/usr/bin/env node

/**
 * RULE-RN-COMPANION: Platform File Companion Parity Auditor (Expo Overlay)
 * 
 * Enforces bilateral platform resolution across iOS and Android targets across src/ and app/.
 */

import fs from "node:fs";
import path from "node:path";

const PLATFORM_EXT_REGEX = /\.(ios|android|native)\.(tsx|ts|jsx|js)$/;
const BASE_EXT_REGEX = /\.(tsx|ts|jsx|js)$/;
const EXCLUSIVE_DIRECTIVE_REGEX = /^\s*(?:\/\/|\/\*)\s*@playbook-platform-exclusive\s+(ios|android)/m;

let violationsCount = 0;

function reportViolation(code, file, message) {
  violationsCount++;
  console.error(`✖ [RULE-RN-COMPANION] ${code}: ${file} — ${message}`);
}

function collectSourceFiles(dir, projectDir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "android" || entry.name === "ios" || entry.name === "dist" || entry.name === ".metro" || entry.name === ".expo") {
        continue;
      }
      collectSourceFiles(fullPath, projectDir, fileList);
    } else if (entry.isFile() && BASE_EXT_REGEX.test(entry.name)) {
      if (entry.name.endsWith(".d.ts")) continue;
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Platform Companion Parity Audit (RULE-RN-COMPANION)...");

  const allFiles = [];
  collectSourceFiles(path.join(projectDir, "src"), projectDir, allFiles);
  collectSourceFiles(path.join(projectDir, "app"), projectDir, allFiles);
  if (fs.existsSync(path.join(projectDir, "App.tsx"))) {
    allFiles.push(path.join(projectDir, "App.tsx"));
  }

  const moduleMap = new Map();

  for (const file of allFiles) {
    const relPath = path.relative(projectDir, file).replace(/\\/g, "/");
    let stem;
    let platform = "universal";

    const platMatch = relPath.match(PLATFORM_EXT_REGEX);
    if (platMatch) {
      platform = platMatch[1];
      stem = relPath.replace(PLATFORM_EXT_REGEX, "");
    } else {
      stem = relPath.replace(BASE_EXT_REGEX, "");
    }

    if (!moduleMap.has(stem)) {
      moduleMap.set(stem, []);
    }
    moduleMap.get(stem).push({ fullPath: file, relPath, platform });
  }

  const platformExclusiveModules = new Map();

  for (const [stem, variants] of moduleMap.entries()) {
    const hasIos = variants.some((v) => v.platform === "ios");
    const hasAndroid = variants.some((v) => v.platform === "android");
    const hasNative = variants.some((v) => v.platform === "native");
    const hasUniversal = variants.some((v) => v.platform === "universal");

    const iosResolves = hasIos || hasNative || hasUniversal;
    const androidResolves = hasAndroid || hasNative || hasUniversal;

    if (iosResolves && !androidResolves) {
      const iosVariant = variants.find((v) => v.platform === "ios");
      const content = fs.readFileSync(iosVariant.fullPath, "utf-8");
      const head = content.slice(0, 500);
      const directiveMatch = head.match(EXCLUSIVE_DIRECTIVE_REGEX);

      if (directiveMatch && directiveMatch[1].toLowerCase() === "ios") {
        platformExclusiveModules.set(stem, { target: "ios", file: iosVariant.relPath });
      } else {
        reportViolation(
          "UNPAIRED_PLATFORM_FILE",
          iosVariant.relPath,
          `Module has iOS candidate but resolves to 0 candidates on Android. Provide an Android companion (.android.tsx), universal fallback (.tsx/.native.tsx), or mark as platform-exclusive with '// @playbook-platform-exclusive ios'.`
        );
      }
    } else if (androidResolves && !iosResolves) {
      const androidVariant = variants.find((v) => v.platform === "android");
      const content = fs.readFileSync(androidVariant.fullPath, "utf-8");
      const head = content.slice(0, 500);
      const directiveMatch = head.match(EXCLUSIVE_DIRECTIVE_REGEX);

      if (directiveMatch && directiveMatch[1].toLowerCase() === "android") {
        platformExclusiveModules.set(stem, { target: "android", file: androidVariant.relPath });
      } else {
        reportViolation(
          "UNPAIRED_PLATFORM_FILE",
          androidVariant.relPath,
          `Module has Android candidate but resolves to 0 candidates on iOS. Provide an iOS companion (.ios.tsx), universal fallback (.tsx/.native.tsx), or mark as platform-exclusive with '// @playbook-platform-exclusive android'.`
        );
      }
    }
  }

  if (platformExclusiveModules.size > 0) {
    for (const file of allFiles) {
      const relPath = path.relative(projectDir, file).replace(/\\/g, "/");
      const isPlatformSpecific = PLATFORM_EXT_REGEX.test(relPath);
      const platMatch = relPath.match(PLATFORM_EXT_REGEX);
      const filePlatform = platMatch ? platMatch[1] : null;

      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split(/\r?\n/);

      for (const [stem, { target, file: exclusiveFile }] of platformExclusiveModules.entries()) {
        const baseName = path.basename(stem);
        if (isPlatformSpecific && filePlatform === target) {
          continue;
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const staticMatch = line.match(/^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
          if (staticMatch) {
            const specifier = staticMatch[1];
            const specifierBase = path.basename(specifier).replace(PLATFORM_EXT_REGEX, "").replace(BASE_EXT_REGEX, "");

            if (specifierBase === baseName || specifier.endsWith(baseName)) {
              if (!isPlatformSpecific) {
                reportViolation(
                  "UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT",
                  `${relPath}:${i + 1}`,
                  `Unguarded static import of platform-exclusive module '${exclusiveFile}'. Static imports execute unconditionally on all platforms. Use dynamic require() with Platform.OS / Platform.select guard, or isolate in a platform-specific companion file.`
                );
              }
            }
          }

          const dynamicMatch = line.match(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
          if (dynamicMatch) {
            const specifier = dynamicMatch[1];
            const specifierBase = path.basename(specifier).replace(PLATFORM_EXT_REGEX, "").replace(BASE_EXT_REGEX, "");

            if (specifierBase === baseName || specifier.endsWith(baseName)) {
              const hasPlatformGuard = content.includes("Platform.OS") || content.includes("Platform.select");
              if (!hasPlatformGuard && !isPlatformSpecific) {
                reportViolation(
                  "UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT",
                  `${relPath}:${i + 1}`,
                  `Dynamic import of platform-exclusive module '${exclusiveFile}' lacks platform guard in file. Guard with Platform.OS === '${target}' or Platform.select().`
                );
              }
            }
          }
        }
      }
    }
  }

  if (violationsCount > 0) {
    console.error(`\nPlatform companion audit failed with ${violationsCount} defect(s).`);
    process.exit(1);
  } else {
    console.log("✔ Platform companion parity audit passed. All platform variants resolve symmetrically.");
    process.exit(0);
  }
}

main();
