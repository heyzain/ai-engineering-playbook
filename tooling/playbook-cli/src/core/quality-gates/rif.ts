import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeRelativePath, toPosixPath } from "../../utils/paths.js";
import type { QualityGateCheck } from "../../types/quality-gates.js";
import { matchesAnyGlob } from "./glob.js";

export const WELL_KNOWN_TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".ps1",
  ".txt",
  ".sql",
]);

export class RifError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "RifError";
    this.code = code;
    this.details = details;
  }
}

export type FileClassification = "text" | "binary";

/**
 * Determines file classification using the strict 3-tier hierarchy:
 * Tier 1: Explicit Check Declaration (binary_patterns vs text_patterns)
 * Tier 2: Well-Known Extensions
 * Tier 3: Safe Default -> BINARY (RAW BYTES) - Never silently normalize unclassified files.
 */
export function classifyFile(
  relativeFilePath: string,
  check?: QualityGateCheck
): FileClassification {
  const normPath = normalizeRelativePath(relativeFilePath);

  // Tier 1: Explicit Check Patterns
  if (check?.text_patterns && matchesAnyGlob(normPath, check.text_patterns)) {
    return "text";
  }
  if (check?.binary_patterns && matchesAnyGlob(normPath, check.binary_patterns)) {
    return "binary";
  }

  // Tier 2: Well-Known Extensions
  const ext = path.extname(normPath).toLowerCase();
  if (WELL_KNOWN_TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }

  // Tier 3: Safe Default for Unknown Files -> Raw Bytes Binary
  return "binary";
}

/**
 * Canonicalizes and hashes file bytes according to classification.
 * Text files: Strict UTF-8 validation (throws INVALID_UTF8_ENCODING on invalid UTF-8),
 * strips BOM, normalizes CRLF and lone CR to LF, and hashes UTF-8 bytes with SHA-256.
 * Binary files: Raw byte buffer hashed with SHA-256 directly without conversion.
 */
export function canonicalizeAndHashFileBuffer(
  buffer: Buffer,
  classification: FileClassification,
  filePathForDiagnostics: string = "file"
): { hash: string; canonicalBytes: Buffer } {
  if (classification === "binary") {
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    return { hash: `sha256:${hash}`, canonicalBytes: buffer };
  }

  // Strict UTF-8 validation
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(buffer);
  } catch (err: unknown) {
    throw new RifError(
      "INVALID_UTF8_ENCODING",
      `File '${filePathForDiagnostics}' classified as text contains invalid UTF-8 byte sequence.`,
      { file: filePathForDiagnostics, error: err instanceof Error ? err.message : String(err) }
    );
  }

  // UTF-8 BOM Stripping: If leading character is \uFEFF (0xEF, 0xBB, 0xBF), strip it
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Newline Normalization: CRLF (\r\n) and lone CR (\r) converted to LF (\n)
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const canonicalBytes = Buffer.from(normalized, "utf-8");
  const hash = crypto.createHash("sha256").update(canonicalBytes).digest("hex");
  return { hash: `sha256:${hash}`, canonicalBytes };
}

export interface FileEntryFingerprint {
  path: string;
  hash: string;
  classification: FileClassification;
}

export interface RifResult {
  rif: string;
  inputs_hash: string;
  lockfiles_hash: string;
  tool_version: string;
  env_keys_hash: string;
  working_tree_clean: boolean;
  file_manifest: FileEntryFingerprint[];
  secret_freshness_unbounded?: boolean;
  unbounded_secret_keys?: string[];
}

export const SECRET_KEY_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE/i;

/**
 * Checks whether an environment variable key is considered sensitive/secret.
 * Version identifiers (ending in _VERSION or _VER) are metadata and not classified as secrets.
 */
export function isSecretKey(key: string, customPatterns?: string[]): boolean {
  if (/_VERSION$|_VER$/i.test(key)) {
    return false;
  }
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }
  if (customPatterns) {
    for (const pat of customPatterns) {
      try {
        if (new RegExp(pat, "i").test(key)) {
          return true;
        }
      } catch {
        // ignore invalid regex
      }
    }
  }
  return false;
}

export interface ComputeRifOptions {
  projectDir: string;
  check: QualityGateCheck;
  toolVersion?: string;
  workingTreeClean?: boolean;
  ambientEnv?: Record<string, string | undefined>;
  sensitivePatterns?: string[];
}

/**
 * Computes the complete Reproducible Input Fingerprint (RIF) for a check.
 */
export function computeRif(options: ComputeRifOptions): RifResult {
  const projectDir = path.resolve(options.projectDir);
  const realProjectDir = fs.existsSync(projectDir) ? fs.realpathSync(projectDir) : projectDir;
  const check = options.check;

  // 1. Collect and filter input files
  const fileManifest: FileEntryFingerprint[] = [];
  const inputGlobs = check.inputs && check.inputs.length > 0 ? check.inputs : ["**/*"];

  // Incorporate declared technology stack exclusions from manifest if present
  const stackExcludesSet = new Set<string>();
  const manifestPath = path.join(realProjectDir, ".playbook", "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (Array.isArray(manifest.technology_stacks)) {
        for (const stackName of manifest.technology_stacks) {
          if (typeof stackName === "string") {
            if (stackName === "nextjs") {
              stackExcludesSet.add(".next/**");
              stackExcludesSet.add("out/**");
              stackExcludesSet.add("next-env.d.ts");
            } else if (stackName === "react-native") {
              stackExcludesSet.add(".metro/**");
              stackExcludesSet.add("metro-cache/**");
              stackExcludesSet.add("android/app/build/**");
              stackExcludesSet.add("android/.gradle/**");
              stackExcludesSet.add("android/build/**");
              stackExcludesSet.add("ios/build/**");
              stackExcludesSet.add("ios/Pods/**");
            } else if (stackName === "expo") {
              stackExcludesSet.add(".expo/**");
              stackExcludesSet.add(".expo-shared/**");
              stackExcludesSet.add("web-build/**");
            }
          }
        }
      }
    } catch {
      // ignore read/parse errors safely
    }
  }
  const stackExcludes = Array.from(stackExcludesSet).sort();

  const excludeGlobs = [
    ...(check.exclude || []),
    ...stackExcludes,
    "dist/**",
    "build/**",
    "coverage/**",
    "node_modules/**",
    ".git/**",
    ".playbook/logs/**",
    ".playbook/.tmp/**",
    ".playbook/state.json",
    ".playbook/approval-fingerprint.json",
    ".playbook/transaction.lock",
    ".playbook/tx-journal.json",
    ".playbook/exception-approvals/**",
    ".playbook/migrations/**",
    "*.tsbuildinfo",
  ];

  const matchedPaths = findMatchingFiles(realProjectDir, inputGlobs, excludeGlobs);
  // Deterministic UTF-16 code unit sort on relative POSIX paths
  matchedPaths.sort();

  for (const relPath of matchedPaths) {
    const fullPath = path.join(realProjectDir, relPath);

    // Symlink handling
    const lstat = fs.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(fullPath);
      } catch (err: unknown) {
        throw new RifError(
          "INVALID_SYMLINK_TARGET",
          `Symlink '${relPath}' target does not exist or cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
          { symlink: relPath, error: err instanceof Error ? err.message : String(err) }
        );
      }

      // Check if target escapes project root
      const relToTarget = path.relative(realProjectDir, realTarget);
      if (relToTarget.startsWith("..") || path.isAbsolute(relToTarget)) {
        throw new RifError(
          "INVALID_SYMLINK_TRAVERSAL",
          `Symlink '${relPath}' escapes project boundary pointing to: ${realTarget}`,
          { symlink: relPath, target: realTarget }
        );
      }
      // Internal symlink: hash relative target path string
      const symlinkPayload = `symlink:-> ${toPosixPath(relToTarget)}`;
      const hash = `sha256:${crypto.createHash("sha256").update(symlinkPayload, "utf-8").digest("hex")}`;
      fileManifest.push({
        path: relPath,
        hash,
        classification: "text",
      });
      continue;
    }

    if (!lstat.isFile()) {
      continue;
    }

    const classification = classifyFile(relPath, check);
    const buffer = fs.readFileSync(fullPath);
    const { hash } = canonicalizeAndHashFileBuffer(buffer, classification, relPath);

    fileManifest.push({
      path: relPath,
      hash,
      classification,
    });
  }

  // 2. Compute Input Files Hash: SHA256 over concatenated "path:hash\n"
  const inputFilesPayload = fileManifest
    .map((entry) => `${entry.path}:${entry.hash}\n`)
    .join("");
  const inputsHash = `sha256:${crypto.createHash("sha256").update(inputFilesPayload, "utf-8").digest("hex")}`;

  // 3. Compute Lockfiles Hash
  const lockfilesManifest: string[] = [];
  const lockfilePaths = (check.lockfiles || []).slice().sort();
  for (const lf of lockfilePaths) {
    const fullLfPath = path.join(realProjectDir, lf);
    if (fs.existsSync(fullLfPath)) {
      const buf = fs.readFileSync(fullLfPath);
      const h = crypto.createHash("sha256").update(buf).digest("hex");
      lockfilesManifest.push(`${normalizeRelativePath(lf)}:sha256:${h}`);
    } else {
      lockfilesManifest.push(`${normalizeRelativePath(lf)}:absent`);
    }
  }
  const lockfilesHash = `sha256:${crypto.createHash("sha256").update(lockfilesManifest.join("\n"), "utf-8").digest("hex")}`;

  // 4. Tool Version
  const toolVersion = options.toolVersion || "v1.0.0";

  // 5. Environment Fingerprinting with Safe Secret Handling
  const sourceEnv: Record<string, string | undefined> = {
    ...(options.ambientEnv || process.env),
    ...(check.env || {}),
  };

  const trackedKeys = Object.keys(check.env || {}).sort();
  const envManifestLines: string[] = [];
  const unboundedSecrets: string[] = [];

  for (const k of trackedKeys) {
    const val = check.env ? check.env[k] : undefined;
    if (val === undefined) {
      envManifestLines.push(`${k}:unset`);
      continue;
    }

    if (isSecretKey(k, options.sensitivePatterns)) {
      // Secret key: NEVER persist or hash raw secret value!
      // Check if a safe version identifier exists (e.g. ${k}_VERSION or ${k}_VER in check.env or ambientEnv)
      const versionKey = `${k}_VERSION`;
      const verKeyAlt = `${k}_VER`;
      const versionVal =
        check.env?.[versionKey] ||
        sourceEnv[versionKey] ||
        check.env?.[verKeyAlt] ||
        sourceEnv[verKeyAlt];

      if (versionVal !== undefined && versionVal.trim().length > 0) {
        envManifestLines.push(`${k}:version=${versionVal.trim()}`);
      } else {
        envManifestLines.push(`${k}:unversioned_secret`);
        unboundedSecrets.push(k);
      }
    } else {
      // Non-secret key: Hash key and canonical value
      envManifestLines.push(`${k}=${val}`);
    }
  }

  const envPayload = envManifestLines.join("\n");
  const envKeysHash = `sha256:${crypto.createHash("sha256").update(envPayload, "utf-8").digest("hex")}`;
  const secretFreshnessUnbounded = unboundedSecrets.length > 0;

  // 6. Clean State
  const workingTreeClean = options.workingTreeClean ?? true;

  // 7. Overall RIF: SHA256(inputsHash || lockfilesHash || toolVersion || envKeysHash || cleanState)
  const compositeRifPayload = [
    inputsHash,
    lockfilesHash,
    toolVersion,
    envKeysHash,
    `clean:${workingTreeClean}`,
  ].join("|");

  const rif = `sha256:${crypto.createHash("sha256").update(compositeRifPayload, "utf-8").digest("hex")}`;

  return {
    rif,
    inputs_hash: inputsHash,
    lockfiles_hash: lockfilesHash,
    tool_version: toolVersion,
    env_keys_hash: envKeysHash,
    working_tree_clean: workingTreeClean,
    file_manifest: fileManifest,
    secret_freshness_unbounded: secretFreshnessUnbounded,
    unbounded_secret_keys: unboundedSecrets,
  };
}

/**
 * Recursively scans directory and returns relative POSIX paths matching input patterns and not matching exclusions.
 */
function findMatchingFiles(
  rootDir: string,
  inputGlobs: string[],
  excludeGlobs: string[]
): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = normalizeRelativePath(path.relative(rootDir, fullPath));
      const isDir = entry.isDirectory();

      // Check exclusion (matches directory directly or with trailing slash)
      if (matchesAnyGlob(relPath, excludeGlobs) || (isDir && matchesAnyGlob(relPath + "/", excludeGlobs))) {
        continue;
      }

      if (isDir) {
        walk(fullPath);
      } else {
        if (matchesAnyGlob(relPath, inputGlobs)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(rootDir);
  return results;
}
