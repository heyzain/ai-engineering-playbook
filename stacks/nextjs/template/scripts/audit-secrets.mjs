#!/usr/bin/env node

/**
 * SEC-NEXT-01: Client Bundle & Environment Secret Leakage Auditor
 * 
 * Verifies that:
 * 1. No sensitive environment variables are exposed via the 'NEXT_PUBLIC_' prefix in .env* files.
 * 2. No Client Components ('use client') reference private server environment variables or server-only modules.
 * 3. No compiled client chunks (.next/static/) leak forbidden private variable names.
 * 
 * Limitations:
 * - This scanner performs static regex and token analysis. It cannot detect dynamic property access (e.g. process.env[dynamicKey]).
 * - It does not replace cryptographic secret scanning or production key management (KMS/Vault).
 */

import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEYWORD_REGEX = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;
const FORBIDDEN_SERVER_MODULES = [
  "server-only",
  "node:fs",
  "fs",
  "node:child_process",
  "child_process",
  "node:dns",
  "dns",
  "node:net",
  "net",
];

let violationsCount = 0;

function reportViolation(file, line, message) {
  violationsCount++;
  console.error(`✖ [SEC-NEXT-01] ${file}${line ? `:${line}` : ""}: ${message}`);
}

// 1. Audit .env* files in project root
function auditEnvFiles(projectDir) {
  const entries = fs.readdirSync(projectDir);
  const envFiles = entries.filter((e) => e.startsWith(".env") && fs.statSync(path.join(projectDir, e)).isFile());

  for (const envFile of envFiles) {
    const fullPath = path.join(projectDir, envFile);
    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;

      const eqIdx = line.indexOf("=");
      if (eqIdx <= 0) continue;

      const key = line.slice(0, eqIdx).trim();

      // Check for sensitive keywords with NEXT_PUBLIC_ prefix
      if (key.startsWith("NEXT_PUBLIC_") && SENSITIVE_KEYWORD_REGEX.test(key)) {
        reportViolation(
          envFile,
          i + 1,
          `Prohibited public secret declaration '${key}'. Variables with 'NEXT_PUBLIC_' prefix are inlined into client bundles and must never contain sensitive keys or tokens.`
        );
      }
    }
  }
}

// 2. Audit Client Components in src/
function auditClientComponents(dir, projectDir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(projectDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
      auditClientComponents(fullPath, projectDir);
    } else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      
      // Check if file is a Client Component
      const isClientComponent = /^\s*["']use client["']/m.test(content);
      if (!isClientComponent) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detect forbidden server module imports
        for (const mod of FORBIDDEN_SERVER_MODULES) {
          const importRegex = new RegExp(`(?:import\\s+.*["']|from\\s+["']|import\\s+["'])${mod}["']`);
          if (importRegex.test(line)) {
            reportViolation(
              relPath,
              i + 1,
              `Client Component imports server-only module '${mod}'. This breaks client hydration and leaks server utilities.`
            );
          }
        }

        // Detect direct references to private environment variables in client components
        const envMatches = line.matchAll(/process\.env\.([A-Z0-9_]+)/g);
        for (const match of envMatches) {
          const varName = match[1];
          if (!varName.startsWith("NEXT_PUBLIC_") && varName !== "NODE_ENV") {
            reportViolation(
              relPath,
              i + 1,
              `Client Component directly references private server environment variable 'process.env.${varName}'. Only 'NEXT_PUBLIC_*' or 'NODE_ENV' are permitted in client files.`
            );
          }
        }
      }
    }
  }
}

// 3. Audit client build chunks if .next/static/ exists
function auditBuildOutput(projectDir) {
  const staticChunksDir = path.join(projectDir, ".next", "static", "chunks");
  if (!fs.existsSync(staticChunksDir)) return;

  function scanChunks(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanChunks(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Check for common leaked private patterns
        const privateMatch = content.match(/NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)[A-Z0-9_]*/i);
        if (privateMatch) {
          const relPath = path.relative(projectDir, fullPath).replace(/\\/g, "/");
          reportViolation(
            relPath,
            null,
            `Compiled client chunk contains embedded sensitive public token: '${privateMatch[0]}'`
          );
        }
      }
    }
  }

  scanChunks(staticChunksDir);
}

// Main Execution
const projectDir = process.cwd();
console.log(`[SEC-NEXT-01] Auditing Next.js project for secret leakages: ${projectDir}`);

auditEnvFiles(projectDir);
auditClientComponents(path.join(projectDir, "src"), projectDir);
auditBuildOutput(projectDir);

if (violationsCount > 0) {
  console.error(`\n[SEC-NEXT-01] AUDIT FAILED: ${violationsCount} secret exposure violation(s) detected.`);
  process.exit(1);
} else {
  console.log("[SEC-NEXT-01] AUDIT PASSED: Zero client secret exposure violations detected.");
  process.exit(0);
}
