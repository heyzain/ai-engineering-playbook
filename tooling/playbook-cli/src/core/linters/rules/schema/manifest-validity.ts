import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseJsonSafely, findPropertyLocation, getOrCreateValidator } from "./helpers.js";

const MANIFEST_PATH = ".playbook/manifest.json";

export const ruleSchemaManifestValidity: GovernanceRule = {
  id: "RULE-SCHEMA-MANIFEST-VALIDITY",
  category: "schema",
  name: "Project Manifest Schema Validity",
  description:
    "Validates that the project manifest (.playbook/manifest.json) exists, is syntactically valid JSON, and strictly conforms to the canonical project-manifest schema without prohibited properties.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [MANIFEST_PATH],
  evaluationMethod: "json_schema",
  version: "1.0.0",
  remediation:
    "Repair .playbook/manifest.json to strictly satisfy all required fields, valid enum values, and constraints in project-manifest.schema.json.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    // 1. Missing file check
    if (!context.fileExists(MANIFEST_PATH)) {
      findings.push({
        ruleId: ruleSchemaManifestValidity.id,
        diagnosticCode: "MANIFEST_MISSING",
        severity: ruleSchemaManifestValidity.severity,
        enforcement: ruleSchemaManifestValidity.defaultEnforcement,
        message: `Project manifest file '${MANIFEST_PATH}' is missing.`,
        filePath: MANIFEST_PATH,
        line: 1,
        column: 1,
        expected: "Existing .playbook/manifest.json matching project-manifest.schema.json",
        actual: "File does not exist",
        remediation:
          "Initialize the project using 'playbook init' or author a compliant .playbook/manifest.json.",
        blocksOperation: true,
      });
      return findings;
    }

    // 2. Read file
    let content: string;
    try {
      content = context.readFile(MANIFEST_PATH);
    } catch (err: unknown) {
      findings.push({
        ruleId: ruleSchemaManifestValidity.id,
        diagnosticCode: "MANIFEST_UNREADABLE",
        severity: ruleSchemaManifestValidity.severity,
        enforcement: ruleSchemaManifestValidity.defaultEnforcement,
        message: `Failed to read project manifest '${MANIFEST_PATH}': ${err instanceof Error ? err.message : String(err)}`,
        filePath: MANIFEST_PATH,
        line: 1,
        column: 1,
        expected: "Readable UTF-8 JSON file",
        actual: "Read failure",
        remediation: "Ensure the file is accessible, uncorrupted, and valid UTF-8.",
        blocksOperation: true,
      });
      return findings;
    }

    // 3. JSON Syntax check
    const parseResult = parseJsonSafely(content);
    if (!parseResult.success || !parseResult.data) {
      findings.push({
        ruleId: ruleSchemaManifestValidity.id,
        diagnosticCode: "MANIFEST_PARSE_ERROR",
        severity: ruleSchemaManifestValidity.severity,
        enforcement: ruleSchemaManifestValidity.defaultEnforcement,
        message: `Project manifest contains malformed JSON: ${parseResult.syntaxError?.message || "Invalid syntax"}`,
        filePath: MANIFEST_PATH,
        line: parseResult.syntaxError?.line || 1,
        column: parseResult.syntaxError?.column || 1,
        expected: "Valid JSON document",
        actual: "Syntax error",
        remediation: "Fix JSON syntax errors in .playbook/manifest.json.",
        blocksOperation: true,
      });
      return findings;
    }

    // 4. Schema validation using canonical SchemaValidator
    const validator = getOrCreateValidator(context.projectDir);
    const result = validator.validateManifest(parseResult.data);

    if (!result.valid && result.errors.length > 0) {
      for (const error of result.errors) {
        // Skip generic meta-error if more specific errors are present
        if (error.keyword === "if") continue;

        const loc = findPropertyLocation(content, error.instancePath);
        const targetPath = error.instancePath || "/";
        let message = `Manifest schema violation at '${targetPath}': ${error.message}`;

        if (error.keyword === "required" && error.params && "missingProperty" in error.params) {
          message = `Missing required property '${error.params.missingProperty}' in manifest at '${targetPath}'.`;
        } else if (error.keyword === "additionalProperties" && error.params && "additionalProperty" in error.params) {
          message = `Prohibited additional property '${error.params.additionalProperty}' declared in manifest at '${targetPath}'.`;
        } else if (error.keyword === "type") {
          message = `Invalid property type for '${targetPath}': ${error.message}.`;
        } else if (error.keyword === "enum") {
          message = `Unsupported value for '${targetPath}': ${error.message}.`;
        }

        findings.push({
          ruleId: ruleSchemaManifestValidity.id,
          diagnosticCode: "MANIFEST_SCHEMA_VIOLATION",
          severity: ruleSchemaManifestValidity.severity,
          enforcement: ruleSchemaManifestValidity.defaultEnforcement,
          message,
          filePath: MANIFEST_PATH,
          line: loc.line,
          column: loc.column,
          expected: `Schema constraint (${error.keyword}) on ${targetPath}`,
          actual: error.message,
          remediation: `Update '${MANIFEST_PATH}' to conform to project-manifest.schema.json: ${error.message}`,
          blocksOperation: true,
        });
      }
    }

    return findings;
  },
};
