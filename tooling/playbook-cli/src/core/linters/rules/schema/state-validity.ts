import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseJsonSafely, findPropertyLocation, getOrCreateValidator } from "./helpers.js";

const STATE_PATH = ".playbook/state.json";

export const ruleSchemaStateValidity: GovernanceRule = {
  id: "RULE-SCHEMA-STATE-VALIDITY",
  category: "schema",
  name: "Project State Schema Validity",
  description:
    "Validates that the project state file (.playbook/state.json) exists, is syntactically valid JSON, and strictly conforms to the canonical project-state schema without modifying state or invoking recovery.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [STATE_PATH],
  evaluationMethod: "json_schema",
  version: "1.0.0",
  remediation:
    "Repair .playbook/state.json to strictly satisfy all required fields, valid enum values, and structural constraints in project-state.schema.json.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    // 1. Missing file check
    if (!context.fileExists(STATE_PATH)) {
      findings.push({
        ruleId: ruleSchemaStateValidity.id,
        diagnosticCode: "STATE_MISSING",
        severity: ruleSchemaStateValidity.severity,
        enforcement: ruleSchemaStateValidity.defaultEnforcement,
        message: `Project state file '${STATE_PATH}' is missing.`,
        filePath: STATE_PATH,
        line: 1,
        column: 1,
        expected: "Existing .playbook/state.json matching project-state.schema.json",
        actual: "File does not exist",
        remediation:
          "Initialize project state using 'playbook init' or author a compliant .playbook/state.json.",
        blocksOperation: true,
      });
      return findings;
    }

    // 2. Read file (strictly read-only)
    let content: string;
    try {
      content = context.readFile(STATE_PATH);
    } catch (err: unknown) {
      findings.push({
        ruleId: ruleSchemaStateValidity.id,
        diagnosticCode: "STATE_UNREADABLE",
        severity: ruleSchemaStateValidity.severity,
        enforcement: ruleSchemaStateValidity.defaultEnforcement,
        message: `Failed to read project state '${STATE_PATH}': ${err instanceof Error ? err.message : String(err)}`,
        filePath: STATE_PATH,
        line: 1,
        column: 1,
        expected: "Readable UTF-8 JSON file",
        actual: "Read failure",
        remediation: "Ensure .playbook/state.json is accessible and valid UTF-8.",
        blocksOperation: true,
      });
      return findings;
    }

    // 3. JSON Syntax check
    const parseResult = parseJsonSafely(content);
    if (!parseResult.success || !parseResult.data) {
      findings.push({
        ruleId: ruleSchemaStateValidity.id,
        diagnosticCode: "STATE_PARSE_ERROR",
        severity: ruleSchemaStateValidity.severity,
        enforcement: ruleSchemaStateValidity.defaultEnforcement,
        message: `Project state contains malformed JSON: ${parseResult.syntaxError?.message || "Invalid syntax"}`,
        filePath: STATE_PATH,
        line: parseResult.syntaxError?.line || 1,
        column: parseResult.syntaxError?.column || 1,
        expected: "Valid JSON document",
        actual: "Syntax error",
        remediation: "Fix JSON syntax errors in .playbook/state.json.",
        blocksOperation: true,
      });
      return findings;
    }

    // 4. Schema validation using canonical SchemaValidator
    const validator = getOrCreateValidator(context.projectDir);
    const result = validator.validateState(parseResult.data);

    if (!result.valid && result.errors.length > 0) {
      for (const error of result.errors) {
        if (error.keyword === "if") continue;

        const loc = findPropertyLocation(content, error.instancePath);
        const targetPath = error.instancePath || "/";
        let message = `State schema violation at '${targetPath}': ${error.message}`;

        if (error.keyword === "required" && error.params && "missingProperty" in error.params) {
          message = `Missing required property '${error.params.missingProperty}' in state at '${targetPath}'.`;
        } else if (error.keyword === "additionalProperties" && error.params && "additionalProperty" in error.params) {
          message = `Prohibited additional property '${error.params.additionalProperty}' in state at '${targetPath}'.`;
        } else if (error.keyword === "type") {
          message = `Invalid property type for '${targetPath}': ${error.message}.`;
        } else if (error.keyword === "enum") {
          message = `Unsupported enum value for '${targetPath}': ${error.message}.`;
        }

        findings.push({
          ruleId: ruleSchemaStateValidity.id,
          diagnosticCode: "STATE_SCHEMA_VIOLATION",
          severity: ruleSchemaStateValidity.severity,
          enforcement: ruleSchemaStateValidity.defaultEnforcement,
          message,
          filePath: STATE_PATH,
          line: loc.line,
          column: loc.column,
          expected: `Schema constraint (${error.keyword}) on ${targetPath}`,
          actual: error.message,
          remediation: `Update '${STATE_PATH}' to conform to project-state.schema.json: ${error.message}`,
          blocksOperation: true,
        });
      }
    }

    return findings;
  },
};
