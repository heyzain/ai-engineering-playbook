import type { Buffer } from "node:buffer";

/**
 * Functional categories for governance rules.
 */
export type RuleCategory =
  | "documentation"
  | "schema"
  | "invariant"
  | "stack"
  | "security"
  | (string & {});

/**
 * Intrinsic severity of a defect or policy violation.
 */
export type RuleSeverity = "error" | "warning" | "info";

/**
 * Operational enforcement behavior applied to a finding.
 */
export type RuleEnforcement = "blocking" | "warning" | "advisory";

/**
 * Primary static analysis technique utilized by a rule evaluator.
 */
export type RuleEvaluationMethod =
  | "markdown_ast"
  | "json_schema"
  | "json_ast"
  | "yaml_ast"
  | "regex_pattern"
  | "structural"
  | "cross_reference"
  | (string & {});

/**
 * Metadata defining optional automated remediation capability.
 */
export interface RuleAutofixMetadata {
  readonly isSupported: boolean;
  readonly description?: string;
}

/**
 * File metadata returned by statFile in execution context.
 */
export interface FileStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * Resource and execution limits enforced by the rule execution context.
 */
export interface ExecutionLimits {
  /** Maximum permissible file size in bytes before rejecting with FILE_TOO_LARGE. Default: 5MB. */
  readonly maxFileSizeBytes: number;
  /** Maximum number of files processed during directory enumeration. Default: 10,000. */
  readonly maxFilesScanned: number;
  /** Maximum execution duration per rule in milliseconds. Default: 30,000ms. */
  readonly timeoutMs: number;
}

/**
 * Controlled, read-only execution context passed to rule evaluators.
 * Guarantees zero project state mutation, path traversal rejection, and bounded resource limits.
 */
export interface RuleExecutionContext {
  /** Absolute path to the repository / project root directory. */
  readonly projectDir: string;

  /** Configured resource and file limits. */
  readonly limits: ExecutionLimits;

  /**
   * Scans and returns relative POSIX file paths matching target globs, respecting exclusions and limits.
   */
  listFiles(globs?: string[], excludeGlobs?: string[]): string[];

  /**
   * Safely reads text contents of a relative file path with UTF-8 validation and size bounds.
   * Throws PATH_TRAVERSAL_DETECTED, FILE_TOO_LARGE, or INVALID_UTF8 on failure.
   */
  readFile(relativeFilePath: string): string;

  /**
   * Safely reads raw binary bytes of a relative file path with size bounds.
   */
  readFileBuffer(relativeFilePath: string): Buffer;

  /**
   * Checks whether a relative path exists within the repository root without escaping.
   */
  fileExists(relativeFilePath: string): boolean;

  /**
   * Returns metadata for a relative path within the repository root.
   */
  statFile(relativeFilePath: string): FileStat;

  /**
   * Normalizes a file path to POSIX forward-slash format without leading './'.
   */
  normalizePath(filePath: string): string;
}

/**
 * Strongly typed, provider-neutral contract for all governance rules.
 */
export interface GovernanceRule {
  /** Stable, unique rule identifier matching ^[A-Z0-9]+(-[A-Z0-9]+)*$ (e.g. RULE-DOC-REF-INTEGRITY). */
  readonly id: string;

  /** Category grouping. */
  readonly category: RuleCategory;

  /** Concise, human-readable rule name. */
  readonly name: string;

  /** Comprehensive rule description and governance rationale. */
  readonly description: string;

  /** Intrinsic severity of violations. */
  readonly severity: RuleSeverity;

  /** Default operational enforcement. */
  readonly defaultEnforcement: RuleEnforcement;

  /** Glob patterns defining targeted files. */
  readonly targetGlobs: string[];

  /** Glob patterns defining excluded files. */
  readonly excludeGlobs?: string[];

  /** Primary evaluation technique. */
  readonly evaluationMethod: RuleEvaluationMethod;

  /** Version of the rule specification (e.g. 1.0.0). */
  readonly version: string;

  /** Actionable remediation instruction. */
  readonly remediation?: string;

  /** Optional automated fix metadata (disabled by default). */
  readonly autofix?: RuleAutofixMetadata;

  /**
   * Evaluates the rule against the repository using the controlled execution context.
   * Returns an array of findings, a single finding, or void if compliant.
   */
  evaluate(context: RuleExecutionContext): Promise<RuleFinding[] | void> | RuleFinding[] | void;
}

/**
 * Standardized, validated finding emitted when a rule detects a violation or non-compliance.
 */
export interface RuleFinding {
  /** Identifier of the rule emitting this finding. */
  readonly ruleId: string;

  /** Diagnostic error or warning code (e.g. UNRESOLVED_MARKDOWN_LINK). */
  readonly diagnosticCode: string;

  /** Inherent defect severity. */
  readonly severity: RuleSeverity;

  /** Operational enforcement applied to this finding. */
  readonly enforcement: RuleEnforcement;

  /** Human-readable explanation of the defect. */
  readonly message: string;

  /** Relative POSIX path to the affected file (null for repository-wide defects). */
  readonly filePath?: string | null;

  /** Line number (1-based, if applicable). */
  readonly line?: number | null;

  /** Column number (1-based, if applicable). */
  readonly column?: number | null;

  /** Description of what was expected. */
  readonly expected?: string | null;

  /** Description of what was actually discovered. */
  readonly actual?: string | null;

  /** Actionable remediation guidance. */
  readonly remediation?: string | null;

  /** Whether this finding blocks lifecycle or gate progression. */
  readonly blocksOperation: boolean;
}

/**
 * Configuration options for the Linter Engine execution.
 */
export interface LinterEngineConfig {
  /** Target project root directory (defaults to process.cwd()). */
  readonly projectDir: string;

  /** Optional filter to restrict execution to specific rule categories. */
  readonly categories?: RuleCategory[];

  /** Optional filter to restrict execution to specific rule IDs. */
  readonly ruleIds?: string[];

  /**
   * Strict mode: treats all warning findings as blocking violations (blocksOperation = true).
   * Mandated in automated CI pipelines.
   */
  readonly strict?: boolean;

  /** Maximum permissible warnings before execution is marked as failed. Default: unlimited (-1). */
  readonly maxWarnings?: number;

  /** Optional override for execution and resource limits. */
  readonly limits?: Partial<ExecutionLimits>;
}

/**
 * Overall status of a linter execution run.
 */
export type LinterExecutionStatus = "passed" | "failed" | "incomplete";

/**
 * Evaluation failure record when a rule throws an exception or exhausts resource limits.
 */
export interface RuleEvaluationFailure {
  readonly ruleId: string;
  readonly error: string;
  readonly code?: string;
}

/**
 * Comprehensive result produced by the Linter Engine.
 */
export interface LinterEngineResult {
  /** Overall run status. */
  readonly status: LinterExecutionStatus;

  /** Total rules registered in the registry. */
  readonly registeredRuleCount: number;

  /** Number of rules actively executed. */
  readonly executedRuleCount: number;

  /** Number of rules skipped due to category/rule filtering. */
  readonly skippedRuleCount: number;

  /** Canonically sorted, deduplicated findings. */
  readonly findings: RuleFinding[];

  /** Statistical summary of findings. */
  readonly summary: {
    readonly totalFindings: number;
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
    readonly blocking: number;
    readonly nonBlocking: number;
    readonly advisory: number;
  };

  /** Recorded rule crashes or evaluation aborts. */
  readonly evaluationFailures: RuleEvaluationFailure[];

  /** Total execution duration in milliseconds. */
  readonly durationMs: number;
}
