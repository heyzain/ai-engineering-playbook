import { LinterError } from "./errors.js";
import { validateSeverity, validateEnforcement } from "./enforcement.js";
import { deduplicateFindings } from "./finding-sorter.js";
import type { RuleFinding } from "./types.js";

export const DIAGNOSTIC_CODE_PATTERN = /^[A-Z0-9_]+(-[A-Z0-9_]+)*$/;

/**
 * Validates a finding emitted by a rule evaluator before aggregation.
 * Throws MALFORMED_FINDING on any integrity defect.
 * Never silently repairs malformed evaluator output.
 */
export function validateFinding(finding: unknown, expectedRuleId: string): RuleFinding {
  if (!finding || typeof finding !== "object") {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Evaluator for rule '${expectedRuleId}' returned a non-object finding.`,
      { finding }
    );
  }

  const f = finding as Partial<RuleFinding>;

  if (f.ruleId !== expectedRuleId) {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding ruleId mismatch: expected '${expectedRuleId}', got '${String(f.ruleId)}'.`,
      { expectedRuleId, actualRuleId: f.ruleId }
    );
  }

  if (typeof f.diagnosticCode !== "string" || !f.diagnosticCode.trim()) {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding from rule '${expectedRuleId}' has missing or empty diagnosticCode.`,
      { finding }
    );
  }

  const diagCode = f.diagnosticCode.trim();
  if (!DIAGNOSTIC_CODE_PATTERN.test(diagCode)) {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding from rule '${expectedRuleId}' has invalid diagnosticCode format: '${diagCode}'. Must be uppercase alphanumeric with underscores/hyphens.`,
      { diagnosticCode: diagCode }
    );
  }

  validateSeverity(f.severity);
  validateEnforcement(f.enforcement);

  if (typeof f.message !== "string" || !f.message.trim()) {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding from rule '${expectedRuleId}' has missing or empty message text.`,
      { finding }
    );
  }

  if (typeof f.blocksOperation !== "boolean") {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding from rule '${expectedRuleId}' must declare boolean blocksOperation.`,
      { finding }
    );
  }

  const expectedBlocks = f.enforcement === "blocking";
  if (f.blocksOperation !== expectedBlocks) {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding blocksOperation (${f.blocksOperation}) contradicts enforcement '${f.enforcement}' (expected ${expectedBlocks}).`,
      { enforcement: f.enforcement, blocksOperation: f.blocksOperation }
    );
  }

  if (f.filePath !== undefined && f.filePath !== null && typeof f.filePath !== "string") {
    throw new LinterError(
      "MALFORMED_FINDING",
      `Finding filePath must be a string or null if provided.`,
      { filePath: f.filePath }
    );
  }

  if (f.line !== undefined && f.line !== null) {
    if (typeof f.line !== "number" || f.line < 1 || !Number.isInteger(f.line)) {
      throw new LinterError(
        "MALFORMED_FINDING",
        `Finding line must be a positive 1-based integer if provided.`,
        { line: f.line }
      );
    }
  }

  if (f.column !== undefined && f.column !== null) {
    if (typeof f.column !== "number" || f.column < 1 || !Number.isInteger(f.column)) {
      throw new LinterError(
        "MALFORMED_FINDING",
        `Finding column must be a positive 1-based integer if provided.`,
        { column: f.column }
      );
    }
  }

  return {
    ruleId: f.ruleId,
    diagnosticCode: diagCode,
    severity: f.severity,
    enforcement: f.enforcement,
    message: f.message.trim(),
    filePath: f.filePath ?? null,
    line: f.line ?? null,
    column: f.column ?? null,
    expected: f.expected ?? null,
    actual: f.actual ?? null,
    remediation: f.remediation ?? null,
    blocksOperation: f.blocksOperation,
  };
}

/**
 * Aggregates, validates, deduplicates, and canonically sorts findings.
 */
export class FindingAggregator {
  private readonly rawFindings: RuleFinding[] = [];

  /**
   * Validates and adds a single finding.
   */
  public add(finding: RuleFinding, expectedRuleId: string): void {
    const validated = validateFinding(finding, expectedRuleId);
    this.rawFindings.push(validated);
  }

  /**
   * Validates and adds multiple findings.
   */
  public addAll(findings: readonly RuleFinding[], expectedRuleId: string): void {
    for (const f of findings) {
      this.add(f, expectedRuleId);
    }
  }

  /**
   * Returns all accumulated findings deduplicated and canonically sorted.
   */
  public getDeduplicatedAndSorted(): RuleFinding[] {
    return deduplicateFindings(this.rawFindings);
  }

  /**
   * Total raw findings count before deduplication.
   */
  public get totalCount(): number {
    return this.rawFindings.length;
  }

  /**
   * Clears accumulated findings.
   */
  public clear(): void {
    this.rawFindings.length = 0;
  }
}
