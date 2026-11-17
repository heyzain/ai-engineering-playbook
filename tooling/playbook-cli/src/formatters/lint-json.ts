import type { LinterEngineResult, RuleFinding, RuleEvaluationFailure } from "../core/linters/types.js";

export interface LintJsonFinding {
  readonly rule_id: string;
  readonly diagnostic_code: string;
  readonly category: string;
  readonly severity: string;
  readonly enforcement: string;
  readonly message: string;
  readonly file_path: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly remediation: string | null;
  readonly blocks_operation: boolean;
}

export interface LintJsonReport {
  readonly schema_version: "1.0";
  readonly status: "passed" | "failed" | "incomplete";
  readonly complete: boolean;
  readonly summary: {
    readonly rules_total: number;
    readonly rules_evaluated: number;
    readonly rules_passed: number;
    readonly rules_failed: number;
    readonly findings_total: number;
    readonly blocking_findings: number;
    readonly warning_findings: number;
    readonly advisory_findings: number;
  };
  readonly categories: string[];
  readonly findings: LintJsonFinding[];
  readonly execution_failures: RuleEvaluationFailure[];
  readonly execution: {
    readonly started_at: string;
    readonly completed_at: string;
    readonly duration_ms: number;
  };
}

/**
 * Maps LinterEngineResult into canonical machine-readable JSON report.
 */
export function buildLintJsonReport(
  result: LinterEngineResult,
  evaluatedCategories: string[],
  startedAt: Date,
  completedAt: Date
): LintJsonReport {
  const failedRuleIds = new Set<string>();
  for (const f of result.findings) {
    if (f.blocksOperation) {
      failedRuleIds.add(f.ruleId);
    }
  }
  for (const failure of result.evaluationFailures) {
    failedRuleIds.add(failure.ruleId);
  }

  const rulesPassed = Math.max(0, result.executedRuleCount - failedRuleIds.size);
  const rulesFailed = failedRuleIds.size;
  const isComplete = result.status !== "incomplete" && result.evaluationFailures.length === 0;

  const findings: LintJsonFinding[] = result.findings.map((f: RuleFinding) => {
    // Determine category from ruleId prefix or lookup
    let cat = "unknown";
    if (f.ruleId.startsWith("RULE-DOC-")) cat = "documentation";
    else if (f.ruleId.startsWith("RULE-SCHEMA-") || f.ruleId.startsWith("RULE-CFG-")) cat = "schema";
    else if (f.ruleId.startsWith("RULE-GOV-")) cat = "invariant";
    else if (f.ruleId.startsWith("RULE-STK-")) cat = "stack";
    else if (f.ruleId.startsWith("RULE-SEC-")) cat = "security";

    return {
      rule_id: f.ruleId,
      diagnostic_code: f.diagnosticCode,
      category: cat,
      severity: f.severity,
      enforcement: f.enforcement,
      message: f.message,
      file_path: f.filePath ?? null,
      line: f.line ?? null,
      column: f.column ?? null,
      expected: f.expected ?? null,
      actual: f.actual ?? null,
      remediation: f.remediation ?? null,
      blocks_operation: f.blocksOperation,
    };
  });

  return {
    schema_version: "1.0",
    status: result.status,
    complete: isComplete,
    summary: {
      rules_total: result.registeredRuleCount,
      rules_evaluated: result.executedRuleCount,
      rules_passed: rulesPassed,
      rules_failed: rulesFailed,
      findings_total: result.summary.totalFindings,
      blocking_findings: result.summary.blocking,
      warning_findings: result.summary.nonBlocking,
      advisory_findings: result.summary.advisory,
    },
    categories: evaluatedCategories,
    findings,
    execution_failures: result.evaluationFailures,
    execution: {
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: result.durationMs,
    },
  };
}

/**
 * Serializes the canonical machine-readable JSON report.
 */
export function formatLintJson(report: LintJsonReport): string {
  return JSON.stringify(report, null, 2);
}
