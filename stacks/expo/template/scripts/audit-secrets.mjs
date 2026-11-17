#!/usr/bin/env node

/**
 * RULE-MOB-SEC-STORAGE: Mobile Secret & Secure Storage Auditor (Expo Overlay)
 * 
 * Verifies that:
 * 1. No sensitive secrets or private credentials are inlined in .env* files.
 * 2. Source code (src/, app/, plugins/) does not store sensitive keys in unencrypted AsyncStorage.
 * 3. No hardcoded private keys or cryptographic signing tokens are embedded in client bundles.
 */

import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEYWORDS = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;
const SENSITIVE_STORAGE_KEY_REGEX = /AsyncStorage\.setItem\s*\(\s*['"`]([^'"`]*?(?:token|auth|jwt|secret|password|passwd|credential|bearer|session|private)[^'"`]*?)['"`]/i;
const PRIVATE_KEY_BLOCK_REGEX = /-----BEGIN\s+(?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)?\s*PRIVATE\s+KEY-----/;

let violationsCount = 0;

function reportViolation(file, line, message) {
  violationsCount++;
  console.error(`✖ [RULE-MOB-SEC-STORAGE] ${file}${line ? `:${line}` : ""}: ${message}`);
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
      if (!key.startsWith("EXPO_PUBLIC_") && SENSITIVE_KEYWORDS.test(key)) {
        reportViolation(
          envFile,
          i + 1,
          `Sensitive secret key '${key}' declared in mobile environment file. In mobile applications, client bundles are public and decompilable. Never embed private secrets in client environment configurations.`
        );
      }
    }
  }
}

function auditSingleFile(fullPath, projectDir) {
  const relPath = path.relative(projectDir, fullPath).replace(/\\/g, "/");
  const content = fs.readFileSync(fullPath, "utf-8");

  if (PRIVATE_KEY_BLOCK_REGEX.test(content)) {
    reportViolation(
      relPath,
      null,
      `Embedded private cryptographic key block detected. Private keys must never be shipped in mobile application bundles.`
    );
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const storageMatch = line.match(SENSITIVE_STORAGE_KEY_REGEX);
    if (storageMatch) {
      const keyName = storageMatch[1];
      reportViolation(
        relPath,
        i + 1,
        `Prohibited sensitive key '${keyName}' passed to unencrypted AsyncStorage.setItem(). Sensitive auth tokens and credentials must use OS-protected secure storage (iOS Keychain / Android Keystore).`
      );
    }
  }
}

function auditSourceFiles(targetPath, projectDir) {
  if (!fs.existsSync(targetPath)) return;

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (/\.(tsx|ts|jsx|js)$/.test(targetPath)) {
      auditSingleFile(targetPath, projectDir);
    }
    return;
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "android" || entry.name === "ios" || entry.name === "dist" || entry.name === ".metro" || entry.name === ".expo") {
        continue;
      }
      auditSourceFiles(fullPath, projectDir);
    } else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      auditSingleFile(fullPath, projectDir);
    }
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Mobile Secret & Secure Storage Audit (RULE-MOB-SEC-STORAGE)...");

  auditEnvFiles(projectDir);
  auditSourceFiles(path.join(projectDir, "src"), projectDir);
  auditSourceFiles(path.join(projectDir, "app"), projectDir);
  auditSourceFiles(path.join(projectDir, "plugins"), projectDir);

  if (violationsCount > 0) {
    console.error(`\nAudit failed with ${violationsCount} security violation(s).`);
    process.exit(1);
  } else {
    console.log("✔ Mobile secret and storage audit passed. Zero credential leaks detected.");
    process.exit(0);
  }
}

main();
