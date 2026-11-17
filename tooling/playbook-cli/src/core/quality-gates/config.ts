import fs from "node:fs";
import path from "node:path";
import { SchemaValidator } from "../validator.js";
import { DEFAULT_PATHS, type GovernanceProfile } from "../../constants.js";
import type {
  QualityGatesConfig,
  QualityGateStage,
  QualityGateCheck,
} from "../../types/quality-gates.js";
import { findConflictingPatterns, matchesGlob } from "./glob.js";

export class QualityGateConfigError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "QualityGateConfigError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates whether a check configuration contains contradictory pattern classifications.
 * Throws `QualityGateConfigError` with code `CONFIG_PATTERN_CONFLICT` if text and binary patterns conflict.
 */
export function validateCheckPatterns(check: QualityGateCheck): void {
  const textPatterns = check.text_patterns || [];
  const binaryPatterns = check.binary_patterns || [];

  if (textPatterns.length === 0 || binaryPatterns.length === 0) {
    return;
  }

  // Check 1: Direct identical pattern overlap
  const directConflicts = findConflictingPatterns(textPatterns, binaryPatterns);
  if (directConflicts.length > 0) {
    throw new QualityGateConfigError(
      "CONFIG_PATTERN_CONFLICT",
      `Check '${check.id}' has conflicting patterns declared in both text_patterns and binary_patterns: ${directConflicts.join(", ")}`,
      { check_id: check.id, conflicts: directConflicts }
    );
  }

  // Check 2: Cross-matching literal pattern overlap
  for (const tp of textPatterns) {
    for (const bp of binaryPatterns) {
      if (tp === bp || matchesGlob(tp, bp) || matchesGlob(bp, tp)) {
        throw new QualityGateConfigError(
          "CONFIG_PATTERN_CONFLICT",
          `Check '${check.id}' has overlapping text_pattern '${tp}' and binary_pattern '${bp}'. Overlapping classifications are strictly prohibited.`,
          { check_id: check.id, text_pattern: tp, binary_pattern: bp }
        );
      }
    }
  }
}

/**
 * Loads, parses, and validates the quality gates configuration file (`.playbook/quality-gates.json`).
 * Enforces schema conformance and pattern conflict rejection.
 */
export function loadQualityGatesConfig(
  projectDir: string,
  options?: {
    customPath?: string;
    validator?: SchemaValidator;
  }
): QualityGatesConfig {
  const resolvedDir = path.resolve(projectDir);
  const configPath = options?.customPath
    ? path.resolve(options.customPath)
    : path.join(resolvedDir, DEFAULT_PATHS.playbookDir, "quality-gates.json");

  if (!fs.existsSync(configPath)) {
    throw new QualityGateConfigError(
      "CONFIG_NOT_FOUND",
      `Quality gates configuration not found at: ${configPath}`,
      { path: configPath }
    );
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QualityGateConfigError("CONFIG_UNREADABLE", `Cannot read quality-gates.json: ${msg}`, {
      path: configPath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QualityGateConfigError("CONFIG_MALFORMED", `Syntax error in quality-gates.json: ${msg}`, {
      path: configPath,
    });
  }

  const validator = options?.validator || new SchemaValidator();
  const validationRes = validator.validateQualityGates(parsed);

  if (!validationRes.valid) {
    throw new QualityGateConfigError(
      "CONFIG_SCHEMA_ERROR",
      `quality-gates.json failed schema validation:\n${validationRes.formattedErrors}`,
      { errors: validationRes.errors }
    );
  }

  const config = parsed as QualityGatesConfig;

  // Validate check unique IDs and pattern conflicts across all stages
  for (const gate of config.gates) {
    const checkIdSet = new Set<string>();
    for (const check of gate.checks) {
      if (checkIdSet.has(check.id)) {
        throw new QualityGateConfigError(
          "CONFIG_DUPLICATE_CHECK_ID",
          `Duplicate check ID '${check.id}' detected in stage ${gate.stage}.`,
          { stage: gate.stage, check_id: check.id }
        );
      }
      checkIdSet.add(check.id);

      // Validate pattern conflict policy
      validateCheckPatterns(check);
    }
  }

  return config;
}

/**
 * Returns the quality gate configuration for a specific lifecycle stage.
 */
export function getStageQualityGate(
  config: QualityGatesConfig,
  stage: number
): QualityGateStage | null {
  const found = config.gates.find((g) => g.stage === stage);
  return found || null;
}

/**
 * Filters checks applicable to the active governance profile.
 */
export function filterChecksForProfile(
  checks: QualityGateCheck[],
  profile: GovernanceProfile
): QualityGateCheck[] {
  return checks.filter((check) => {
    if (!check.profiles || check.profiles.length === 0) {
      return true; // default: runs in all profiles
    }
    return check.profiles.includes(profile);
  });
}
