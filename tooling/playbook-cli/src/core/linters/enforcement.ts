import { LinterError } from "./errors.js";
import type { RuleSeverity, RuleEnforcement } from "./types.js";

export const VALID_SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "info"]);
export const VALID_ENFORCEMENTS: ReadonlySet<string> = new Set(["blocking", "warning", "advisory"]);

/**
 * Asserts that a value is a valid RuleSeverity.
 */
export function validateSeverity(severity: unknown): asserts severity is RuleSeverity {
  if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity)) {
    throw new LinterError(
      "INVALID_SEVERITY",
      `Invalid rule severity '${String(severity)}'. Allowed values are: 'error', 'warning', 'info'.`,
      { severity }
    );
  }
}

/**
 * Asserts that a value is a valid RuleEnforcement.
 */
export function validateEnforcement(enforcement: unknown): asserts enforcement is RuleEnforcement {
  if (typeof enforcement !== "string" || !VALID_ENFORCEMENTS.has(enforcement)) {
    throw new LinterError(
      "INVALID_ENFORCEMENT",
      `Invalid rule enforcement '${String(enforcement)}'. Allowed values are: 'blocking', 'warning', 'advisory'.`,
      { enforcement }
    );
  }
}

/**
 * Resolves the deterministic default operational enforcement for an intrinsic severity.
 */
export function resolveDefaultEnforcement(severity: RuleSeverity): RuleEnforcement {
  validateSeverity(severity);
  switch (severity) {
    case "error":
      return "blocking";
    case "warning":
      return "warning";
    case "info":
      return "advisory";
  }
}

export interface ResolvedFindingEnforcement {
  readonly enforcement: RuleEnforcement;
  readonly blocksOperation: boolean;
}

/**
 * Resolves operational enforcement and blocking status for a finding, taking strict mode
 * and non-downgrade invariants into account.
 *
 * Non-Negotiable Invariant:
 * Severity 'error' can NEVER be silently downgraded to 'warning' or 'advisory'.
 */
export function resolveFindingEnforcement(
  severity: RuleSeverity,
  configuredEnforcement?: RuleEnforcement,
  strict: boolean = false
): ResolvedFindingEnforcement {
  validateSeverity(severity);

  if (configuredEnforcement !== undefined) {
    validateEnforcement(configuredEnforcement);
  }

  // Non-downgrade invariant: errors must remain blocking
  if (severity === "error") {
    if (configuredEnforcement !== undefined && configuredEnforcement !== "blocking") {
      throw new LinterError(
        "INVALID_ENFORCEMENT",
        `Severity 'error' cannot be downgraded to '${configuredEnforcement}'. Errors must always be 'blocking'.`,
        { severity, configuredEnforcement }
      );
    }
    return {
      enforcement: "blocking",
      blocksOperation: true,
    };
  }

  // Warnings: non-blocking by default, promoted to blocking in strict mode
  if (severity === "warning") {
    if (strict) {
      return {
        enforcement: "blocking",
        blocksOperation: true,
      };
    }
    const effective = configuredEnforcement || "warning";
    return {
      enforcement: effective,
      blocksOperation: effective === "blocking",
    };
  }

  // Info: advisory by default
  const effective = configuredEnforcement || "advisory";
  return {
    enforcement: effective,
    blocksOperation: effective === "blocking",
  };
}
