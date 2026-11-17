/**
 * Standard error codes emitted by the Governance Linter subsystem.
 */
export type LinterErrorCode =
  | "INVALID_RULE_ID"
  | "DUPLICATE_RULE_ID"
  | "INVALID_RULE_DEFINITION"
  | "RULE_NOT_FOUND"
  | "PATH_TRAVERSAL_DETECTED"
  | "SYMLINK_ESCAPE_DETECTED"
  | "FILE_TOO_LARGE"
  | "FILE_COUNT_EXCEEDED"
  | "INVALID_UTF8"
  | "MALFORMED_FINDING"
  | "INVALID_SEVERITY"
  | "INVALID_ENFORCEMENT"
  | "INVALID_CONFIG"
  | "EVALUATION_FAILED"
  | "RULE_TIMEOUT"
  | "RESOURCE_EXHAUSTED";

/**
 * Standard typed error class for Governance Linter failures.
 */
export class LinterError extends Error {
  readonly code: LinterErrorCode | string;
  readonly details?: unknown;

  constructor(code: LinterErrorCode | string, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "LinterError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
