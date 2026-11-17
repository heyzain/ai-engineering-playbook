import { LinterError } from "./errors.js";
import { RuleRegistry } from "./rule-registry.js";
import { DefaultRuleExecutionContext } from "./execution-context.js";
import { FindingAggregator } from "./finding-aggregator.js";
import { resolveFindingEnforcement } from "./enforcement.js";
import type {
  LinterEngineConfig,
  LinterEngineResult,
  LinterExecutionStatus,
  RuleEvaluationFailure,
  RuleFinding,
  GovernanceRule,
} from "./types.js";

/**
 * Core Governance Linter execution engine.
 * Orchestrates deterministic rule selection, controlled execution,
 * finding aggregation, and canonical result calculation.
 */
export class LinterEngine {
  private readonly registry: RuleRegistry;

  constructor(registry?: RuleRegistry) {
    this.registry = registry ?? new RuleRegistry();
  }

  /**
   * Returns the underlying RuleRegistry instance.
   */
  public getRegistry(): RuleRegistry {
    return this.registry;
  }

  /**
   * Executes linting rules deterministically against a project directory.
   */
  public async run(config: LinterEngineConfig): Promise<LinterEngineResult> {
    const startTime = Date.now();

    if (!config || !config.projectDir) {
      throw new LinterError("INVALID_CONFIG", "projectDir is required in LinterEngineConfig.");
    }

    // 1. Create controlled execution context
    const context = new DefaultRuleExecutionContext(config.projectDir, config.limits);

    // 2. Filter active rules deterministically
    const allRules = this.registry.list(); // Already sorted by rule ID
    const activeRules = this.filterRules(allRules, config);
    const skippedRuleCount = allRules.length - activeRules.length;

    const aggregator = new FindingAggregator();
    const evaluationFailures: RuleEvaluationFailure[] = [];
    const strict = Boolean(config.strict);

    // 3. Execute active rules sequentially in deterministic order
    for (const rule of activeRules) {
      try {
        const findings = await this.executeRuleWithTimeout(rule, context);
        if (findings) {
          const findingsArray = Array.isArray(findings) ? findings : [findings];
          for (const rawFinding of findingsArray) {
            // Re-resolve enforcement if strict mode is active
            let processedFinding = rawFinding;
            if (strict && rawFinding.severity === "warning" && !rawFinding.blocksOperation) {
              const resolved = resolveFindingEnforcement(rawFinding.severity, rawFinding.enforcement, true);
              processedFinding = {
                ...rawFinding,
                enforcement: resolved.enforcement,
                blocksOperation: resolved.blocksOperation,
              };
            }
            aggregator.add(processedFinding, rule.id);
          }
        }
      } catch (err: unknown) {
        // Capture rule crashes and evaluator aborts; never silently swallow errors
        const errMsg = err instanceof Error ? err.message : String(err);
        const errCode = err instanceof LinterError ? String(err.code) : "EVALUATION_FAILED";
        evaluationFailures.push({
          ruleId: rule.id,
          error: errMsg,
          code: errCode,
        });
      }
    }

    // 4. Canonical sorting and deduplication
    const sortedFindings = aggregator.getDeduplicatedAndSorted();

    // 5. Compute summary statistics
    let errorsCount = 0;
    let warningsCount = 0;
    let infoCount = 0;
    let blockingCount = 0;
    let nonBlockingCount = 0;
    let advisoryCount = 0;

    for (const f of sortedFindings) {
      if (f.severity === "error") errorsCount++;
      else if (f.severity === "warning") warningsCount++;
      else if (f.severity === "info") infoCount++;

      if (f.blocksOperation) {
        blockingCount++;
      } else if (f.enforcement === "warning") {
        nonBlockingCount++;
      } else if (f.enforcement === "advisory") {
        advisoryCount++;
      }
    }

    // 6. Determine overall execution status
    const maxWarnings = config.maxWarnings ?? -1;
    const warningsExceeded = maxWarnings >= 0 && warningsCount > maxWarnings;

    let status: LinterExecutionStatus = "passed";
    if (evaluationFailures.length > 0) {
      const hasResourceLimitAbort = evaluationFailures.some(
        (f) =>
          f.code === "RULE_TIMEOUT" ||
          f.code === "FILE_TOO_LARGE" ||
          f.code === "FILE_COUNT_EXCEEDED" ||
          f.code === "RESOURCE_EXHAUSTED"
      );
      status = hasResourceLimitAbort ? "incomplete" : "failed";
    } else if (blockingCount > 0 || warningsExceeded) {
      status = "failed";
    }

    const durationMs = Date.now() - startTime;

    return {
      status,
      registeredRuleCount: allRules.length,
      executedRuleCount: activeRules.length,
      skippedRuleCount,
      findings: sortedFindings,
      summary: {
        totalFindings: sortedFindings.length,
        errors: errorsCount,
        warnings: warningsCount,
        info: infoCount,
        blocking: blockingCount,
        nonBlocking: nonBlockingCount,
        advisory: advisoryCount,
      },
      evaluationFailures,
      durationMs,
    };
  }

  /**
   * Filters rules based on requested categories and rule IDs.
   */
  private filterRules(rules: GovernanceRule[], config: LinterEngineConfig): GovernanceRule[] {
    const categorySet = config.categories && config.categories.length > 0 ? new Set(config.categories) : null;
    const ruleIdSet = config.ruleIds && config.ruleIds.length > 0 ? new Set(config.ruleIds) : null;

    return rules.filter((rule) => {
      if (categorySet && !categorySet.has(rule.category)) {
        return false;
      }
      if (ruleIdSet && !ruleIdSet.has(rule.id)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Executes a single rule evaluator with bounded timeout protection.
   */
  private async executeRuleWithTimeout(
    rule: GovernanceRule,
    context: DefaultRuleExecutionContext
  ): Promise<RuleFinding[] | RuleFinding | void> {
    const timeoutMs = context.limits.timeoutMs;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new LinterError(
            "RULE_TIMEOUT",
            `Rule '${rule.id}' exceeded maximum execution timeout of ${timeoutMs}ms.`,
            { ruleId: rule.id, timeoutMs }
          )
        );
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([Promise.resolve(rule.evaluate(context)), timeoutPromise]);
      return result;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
