import path from "node:path";
import fs from "node:fs";
import { RuleRegistry } from "../core/linters/rule-registry.js";
import { LinterEngine } from "../core/linters/engine.js";
import { ALL_PRODUCTION_RULES } from "../core/linters/rules/index.js";
import type { RuleCategory, LinterEngineConfig } from "../core/linters/types.js";
import { buildLintJsonReport, formatLintJson, type LintJsonReport } from "../formatters/lint-json.js";
import { formatLintTerminalReport } from "../formatters/lint-terminal.js";

export interface LintCommandOptions {
  cwd?: string;
  category?: string;
  rule?: string | string[];
  format?: string;
  json?: boolean;
  strict?: boolean;
  maxWarnings?: number;
  silent?: boolean;
}

export interface LintCommandResult {
  success: boolean;
  exitCode: number;
  status: "passed" | "failed" | "incomplete";
  output: string;
  report?: LintJsonReport;
  error?: string;
}

const CATEGORY_MAP: Record<string, RuleCategory> = {
  documentation: "documentation",
  docs: "documentation",
  doc: "documentation",
  schema: "schema",
  schemas: "schema",
  governance: "invariant",
  invariant: "invariant",
  invariants: "invariant",
  gov: "invariant",
  stack: "stack",
  stacks: "stack",
  security: "security",
  sec: "security",
};

export const SUPPORTED_CLI_CATEGORIES = [
  "documentation",
  "schema",
  "governance",
  "stack",
  "security",
] as const;

/**
 * Resolves a CLI category argument into canonical RuleCategory array.
 * Throws an error if an unrecognized category is provided.
 */
export function resolveCategories(categoryArg?: string): RuleCategory[] | undefined {
  if (!categoryArg || categoryArg.trim().toLowerCase() === "all") {
    return undefined; // All categories
  }

  const rawTokens = categoryArg
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const resolved: RuleCategory[] = [];
  for (const token of rawTokens) {
    if (token === "all") {
      return undefined;
    }
    const mapped = CATEGORY_MAP[token];
    if (!mapped) {
      throw new Error(
        `Unknown category "${token}". Supported categories: ${SUPPORTED_CLI_CATEGORIES.join(", ")}, all.`
      );
    }
    if (!resolved.includes(mapped)) {
      resolved.push(mapped);
    }
  }

  return resolved;
}

/**
 * Executes the Governance Linter Engine against a project repository.
 */
export async function runLint(options: LintCommandOptions = {}): Promise<LintCommandResult> {
  const startedAt = new Date();
  const targetDir = path.resolve(options.cwd || process.cwd());
  const isJson = Boolean(options.json || options.format === "json");

  // 1. Validate target directory existence
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    const errorMsg = `Target directory does not exist or is not a directory: '${targetDir}'`;
    if (!options.silent) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schema_version: "1.0",
              status: "failed",
              complete: false,
              error: "INVALID_PROJECT_DIR",
              message: errorMsg,
            },
            null,
            2
          )
        );
      } else {
        console.error(`\n✖ Governance Linter Error [INVALID_PROJECT_DIR]: ${errorMsg}`);
      }
    }
    return {
      success: false,
      exitCode: 2,
      status: "failed",
      output: errorMsg,
      error: errorMsg,
    };
  }

  // 2. Validate and resolve category filter
  let resolvedCategories: RuleCategory[] | undefined;
  try {
    resolvedCategories = resolveCategories(options.category);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!options.silent) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schema_version: "1.0",
              status: "failed",
              complete: false,
              error: "INVALID_CATEGORY",
              message,
            },
            null,
            2
          )
        );
      } else {
        console.error(`\n✖ CLI Argument Error [INVALID_CATEGORY]: ${message}`);
      }
    }
    return {
      success: false,
      exitCode: 2,
      status: "failed",
      output: message,
      error: message,
    };
  }

  // 3. Resolve rule IDs if provided
  let ruleIds: string[] | undefined;
  if (options.rule) {
    ruleIds = Array.isArray(options.rule)
      ? options.rule.map((r) => r.trim()).filter(Boolean)
      : options.rule
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
  }

  // 4. Validate format argument if explicitly provided
  if (options.format && options.format !== "json" && options.format !== "terminal") {
    const message = `Invalid format "${options.format}". Supported formats: terminal, json.`;
    if (!options.silent) {
      console.error(`\n✖ CLI Argument Error [INVALID_FORMAT]: ${message}`);
    }
    return {
      success: false,
      exitCode: 2,
      status: "failed",
      output: message,
      error: message,
    };
  }

  // 5. Initialize rule registry with all 21 production rules
  const registry = new RuleRegistry();
  for (const rule of ALL_PRODUCTION_RULES) {
    registry.register(rule);
  }

  // 6. Build linter engine config
  const engineConfig: LinterEngineConfig = {
    projectDir: targetDir,
    categories: resolvedCategories,
    ruleIds,
    strict: Boolean(options.strict),
    maxWarnings: options.maxWarnings,
  };

  const engine = new LinterEngine(registry);

  try {
    const result = await engine.run(engineConfig);
    const completedAt = new Date();

    const evaluatedCategories = resolvedCategories
      ? resolvedCategories.map(String)
      : ["documentation", "schema", "invariant", "stack", "security"];

    const report = buildLintJsonReport(result, evaluatedCategories, startedAt, completedAt);
    const output = isJson ? formatLintJson(report) : formatLintTerminalReport(report, targetDir);

    if (!options.silent) {
      console.log(output);
    }

    // Determine exit code strictly:
    // Exit Code 0: Clean success with no blocking findings
    // Exit Code 1: Blocking findings detected (or warnings in strict mode)
    // Exit Code 3: Evaluation failure or incomplete results (timeout, crash, resource exhaustion)
    let exitCode = 0;
    if (result.status === "incomplete" || result.evaluationFailures.length > 0) {
      exitCode = 3;
    } else if (result.summary.blocking > 0 || result.status === "failed") {
      exitCode = 1;
    } else {
      exitCode = 0;
    }

    const success = exitCode === 0;

    return {
      success,
      exitCode,
      status: result.status,
      output,
      report,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!options.silent) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schema_version: "1.0",
              status: "incomplete",
              complete: false,
              error: "ENGINE_CRASH",
              message,
            },
            null,
            2
          )
        );
      } else {
        console.error(`\n✖ Governance Linter Execution Crash: ${message}`);
      }
    }
    return {
      success: false,
      exitCode: 3,
      status: "incomplete",
      output: message,
      error: message,
    };
  }
}
