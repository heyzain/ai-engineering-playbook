#!/usr/bin/env node

/**
 * Gate: expo-secret-audit
 * 
 * Verifies Mobile Secret Defense Protocol (SEC-MOB-01) for Expo applications:
 * 1. Mobile JavaScript bundles and assets are publicly inspectable.
 * 2. Zero private credentials, backend secrets, or private signing keys in .env* files.
 * 3. EXPO_PUBLIC_* prefix rule: Only public variables may carry the prefix;
 *    private credentials must never be named or exposed via EXPO_PUBLIC_*.
 * 4. Auth tokens and sensitive credentials must never be passed to unencrypted AsyncStorage.
 * 5. Scans app/, src/, and plugins/ for hardcoded private keys.
 */

import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEYWORDS = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;
const SENSITIVE_STORAGE_KEY_REGEX = /AsyncStorage\.setItem\s*\(\s*['"`]([^'"`]*?(?:token|auth|jwt|secret|password|passwd|credential|bearer|session|private)[^'"`]*?)['"`]/i;
const PRIVATE_KEY_BLOCK_REGEX = /-----BEGIN\s+(?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)?\s*PRIVATE\s+KEY-----/;

let violationsCount = 0;

function reportViolation(file, line, message) {
  violationsCount++;
  console.error(`✖ [expo-secret-audit] ${file}${line ? `:${line}` : ""}: ${message}`);
}

function auditEnvFiles(projectDir) {
  if (!fs.existsSync(projectDir)) return;
  const entries = fs.readdirSync(projectDir);
  const envFiles = entries.filter((e) => e.startsWith(".env") && fs.statSync(path.join(projectDir, e)).isFile());

  for (const envFile of envFiles) {
    if (envFile === ".env.example") continue;

    const fullPath = path.join(projectDir, envFile);
    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;

      const eqIdx = line.indexOf("=");
      if (eqIdx <= 0) continue;

      const key = line.slice(0, eqIdx).trim();

      // Case A: Variable is NOT EXPO_PUBLIC_ and contains sensitive keyword
      if (!key.startsWith("EXPO_PUBLIC_") && SENSITIVE_KEYWORDS.test(key)) {
        reportViolation(
          envFile,
          i + 1,
          `Sensitive secret key '${key}' declared in mobile environment file. Mobile client bundles are public and decompilable. Private secrets must reside exclusively in backend services.`
        );
      }

      // Case B: Variable IS EXPO_PUBLIC_ but contains sensitive secret keywords
      if (key.startsWith("EXPO_PUBLIC_")) {
        const afterPrefix = key.slice("EXPO_PUBLIC_".length);
        if (/(SECRET|PRIVATE|PASSWD|PASSWORD|ADMIN_TOKEN|SIGNING_KEY)/i.test(afterPrefix)) {
          reportViolation(
            envFile,
            i + 1,
            `Prohibited secret variable '${key}' exposed via EXPO_PUBLIC_* prefix. Bundled code is publicly inspectable; never expose private credentials to client bundles.`
          );
        }
      }
    }
  }
}

function auditSourceFile(fullPath, projectDir) {
  const relPath = path.relative(projectDir, fullPath).replace(/\\/g, "/");
  const content = fs.readFileSync(fullPath, "utf-8");

  // Private key block check
  if (PRIVATE_KEY_BLOCK_REGEX.test(content)) {
    reportViolation(
      relPath,
      null,
      "Embedded private cryptographic key block detected. Private keys must never be shipped in client application bundles."
    );
  }

  // AsyncStorage sensitive key check
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const storageMatch = line.match(SENSITIVE_STORAGE_KEY_REGEX);
    if (storageMatch) {
      const keyName = storageMatch[1];
      reportViolation(
        relPath,
        i + 1,
        `Prohibited sensitive key '${keyName}' passed to unencrypted AsyncStorage.setItem(). Use expo-secure-store for credentials and authentication tokens.`
      );
    }
  }
}

function scanDirectory(dir, projectDir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".expo" ||
        entry.name === "android" ||
        entry.name === "ios" ||
        entry.name === "web-build"
      ) {
        continue;
      }
      scanDirectory(fullPath, projectDir);
    } else if (entry.isFile() && /\.(tsx|ts|jsx|js|mjs)$/.test(entry.name)) {
      auditSourceFile(fullPath, projectDir);
    }
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Expo Public Secret Leak Audit (expo-secret-audit)...");

  auditEnvFiles(projectDir);
  scanDirectory(path.join(projectDir, "app"), projectDir);
  scanDirectory(path.join(projectDir, "src"), projectDir);
  scanDirectory(path.join(projectDir, "plugins"), projectDir);

  if (violationsCount > 0) {
    console.error(`\nexpo-secret-audit failed with ${violationsCount} security violation(s).`);
    process.exit(1);
  } else {
    console.log("✔ Expo secret audit passed. Zero credential leaks or unsafe public env variables detected.");
    process.exit(0);
  }
}

main();
