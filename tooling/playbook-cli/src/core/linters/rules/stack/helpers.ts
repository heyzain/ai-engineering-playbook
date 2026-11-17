import fs from "node:fs";
import path from "node:path";
import type { RuleExecutionContext } from "../../types.js";
import { parseJsonSafely, findPropertyLocation } from "../schema/helpers.js";
import { isPlaceholder } from "../invariants/helpers.js";

export { parseJsonSafely, findPropertyLocation, isPlaceholder };

/**
 * Discovers stack candidate directory names located under stacks/ in the target project.
 * Uses safe path checks and does not escape project boundaries.
 */
export function getStackDirectories(context: RuleExecutionContext): string[] {
  const stacksRelPath = "stacks";
  if (!context.fileExists(stacksRelPath)) {
    return [];
  }

  try {
    const absStacksDir = path.join(context.projectDir, stacksRelPath);
    if (!fs.existsSync(absStacksDir) || !fs.statSync(absStacksDir).isDirectory()) {
      return [];
    }

    const entries = fs.readdirSync(absStacksDir, { withFileTypes: true });
    const stackNames: string[] = [];

    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith(".")) {
        // Confirm path is safely accessible within execution context
        try {
          if (context.fileExists(path.posix.join(stacksRelPath, ent.name))) {
            stackNames.push(ent.name);
          }
        } catch {
          // Skip if escaping or invalid
        }
      }
    }

    return stackNames.sort();
  } catch {
    return [];
  }
}

/**
 * Validates that a package override version is a valid, concrete semver string.
 * Strictly enforces concrete semver versions (exact e.g. '19.3.0', '=1.0.0', 'v1.0.0',
 * or bounded patch/minor prefix e.g. '~6.0.3', '^1.2.3').
 * Rejects empty strings, placeholders, tags ('latest', 'beta'), wildcards ('*', '1.x'),
 * and comparison inequalities ('>=', '<=', '>', '<').
 */
export function isValidPackageOverrideSemver(ver: unknown): boolean {
  if (typeof ver !== "string") return false;
  const trimmed = ver.trim();
  if (trimmed.length === 0) return false;
  if (isPlaceholder(trimmed)) return false;

  // Reject loose tags
  const looseTags = new Set(["latest", "beta", "next", "alpha", "canary", "dev", "master", "main", "any"]);
  if (looseTags.has(trimmed.toLowerCase())) return false;

  // Reject wildcards (*, 1.*, 1.x, 1.X, etc.)
  if (trimmed === "*" || trimmed.includes("*") || /\b[xX]\b/.test(trimmed) || /\.[xX]/.test(trimmed)) {
    return false;
  }

  // Reject open-ended or ambiguous comparison inequalities (>=, <=, >, <)
  // Package overrides must supply concrete replacement versions to package.json, not comparison ranges.
  if (/[><]/.test(trimmed)) {
    return false;
  }

  // Strictly enforce concrete semver format:
  // Optional prefix (=, v, V, ~, ^) followed by major.minor or major.minor.patch
  // with optional prerelease (-rc.1) and build metadata (+build.1).
  const concreteSemverPattern =
    /^[=vV~^]?\s*\d+(\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  return concreteSemverPattern.test(trimmed);
}
