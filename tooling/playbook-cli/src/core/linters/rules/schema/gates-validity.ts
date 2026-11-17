import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseJsonSafely, findPropertyLocation, getOrCreateValidator } from "./helpers.js";

const GATES_PATH = ".playbook/quality-gates.json";

export const ruleSchemaGatesValidity: GovernanceRule = {
  id: "RULE-SCHEMA-GATES-VALIDITY",
  category: "schema",
  name: "Quality Gates Configuration Schema Validity",
  description:
    "Validates that the quality gates configuration (.playbook/quality-gates.json) exists, is valid JSON, and strictly satisfies the canonical quality-gates schema without executing gates or modifying files.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [GATES_PATH],
  evaluationMethod: "json_schema",
  version: "1.0.0",
  remediation:
    "Repair .playbook/quality-gates.json to strictly satisfy all required fields, stages, checks, and commands in quality-gates.schema.json.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    // 1. Missing file check
    if (!context.fileExists(GATES_PATH)) {
      findings.push({
        ruleId: ruleSchemaGatesValidity.id,
        diagnosticCode: "GATES_CONFIG_MISSING",
        severity: ruleSchemaGatesValidity.severity,
        enforcement: ruleSchemaGatesValidity.defaultEnforcement,
        message: `Quality gates configuration file '${GATES_PATH}' is missing.`,
        filePath: GATES_PATH,
        line: 1,
        column: 1,
        expected: "Existing .playbook/quality-gates.json matching quality-gates.schema.json",
        actual: "File does not exist",
        remediation:
          "Generate quality gates configuration using 'playbook init' or author a compliant .playbook/quality-gates.json.",
        blocksOperation: true,
      });
      return findings;
    }

    // 2. Read file (strictly read-only)
    let content: string;
    try {
      content = context.readFile(GATES_PATH);
    } catch (err: unknown) {
      findings.push({
        ruleId: ruleSchemaGatesValidity.id,
        diagnosticCode: "GATES_UNREADABLE",
        severity: ruleSchemaGatesValidity.severity,
        enforcement: ruleSchemaGatesValidity.defaultEnforcement,
        message: `Failed to read quality gates configuration '${GATES_PATH}': ${err instanceof Error ? err.message : String(err)}`,
        filePath: GATES_PATH,
        line: 1,
        column: 1,
        expected: "Readable UTF-8 JSON file",
        actual: "Read failure",
        remediation: "Ensure .playbook/quality-gates.json is accessible and valid UTF-8.",
        blocksOperation: true,
      });
      return findings;
    }

    // 3. JSON Syntax check
    const parseResult = parseJsonSafely(content);
    if (!parseResult.success || !parseResult.data) {
      findings.push({
        ruleId: ruleSchemaGatesValidity.id,
        diagnosticCode: "GATES_PARSE_ERROR",
        severity: ruleSchemaGatesValidity.severity,
        enforcement: ruleSchemaGatesValidity.defaultEnforcement,
        message: `Quality gates configuration contains malformed JSON: ${parseResult.syntaxError?.message || "Invalid syntax"}`,
        filePath: GATES_PATH,
        line: parseResult.syntaxError?.line || 1,
        column: parseResult.syntaxError?.column || 1,
        expected: "Valid JSON document",
        actual: "Syntax error",
        remediation: "Fix JSON syntax errors in .playbook/quality-gates.json.",
        blocksOperation: true,
      });
      return findings;
    }

    // 4. Schema validation using canonical SchemaValidator
    const validator = getOrCreateValidator(context.projectDir);
    const result = validator.validateQualityGates(parseResult.data);

    if (!result.valid && result.errors.length > 0) {
      for (const error of result.errors) {
        if (error.keyword === "if") continue;

        const loc = findPropertyLocation(content, error.instancePath);
        const targetPath = error.instancePath || "/";
        let message = `Quality gates schema violation at '${targetPath}': ${error.message}`;

        if (error.keyword === "required" && error.params && "missingProperty" in error.params) {
          message = `Missing required property '${error.params.missingProperty}' in quality gates at '${targetPath}'.`;
        } else if (error.keyword === "additionalProperties" && error.params && "additionalProperty" in error.params) {
          message = `Prohibited additional property '${error.params.additionalProperty}' in quality gates at '${targetPath}'.`;
        } else if (error.keyword === "type") {
          message = `Invalid property type for '${targetPath}': ${error.message}.`;
        } else if (error.keyword === "enum") {
          message = `Unsupported value for '${targetPath}': ${error.message}.`;
        }

        findings.push({
          ruleId: ruleSchemaGatesValidity.id,
          diagnosticCode: "GATES_SCHEMA_VIOLATION",
          severity: ruleSchemaGatesValidity.severity,
          enforcement: ruleSchemaGatesValidity.defaultEnforcement,
          message,
          filePath: GATES_PATH,
          line: loc.line,
          column: loc.column,
          expected: `Schema constraint (${error.keyword}) on ${targetPath}`,
          actual: error.message,
          remediation: `Update '${GATES_PATH}' to conform to quality-gates.schema.json: ${error.message}`,
          blocksOperation: true,
        });
      }
    }

    return findings;
  },
};
