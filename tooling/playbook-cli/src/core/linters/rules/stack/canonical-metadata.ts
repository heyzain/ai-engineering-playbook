import path from "node:path";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { getStackDirectories, parseJsonSafely, findPropertyLocation } from "./helpers.js";

const CANONICAL_STACK_ITEMS = [
  "stack.json",
  "spec.md",
  "README.md",
  "quality-gates.partial.json",
  "rif-patterns.json",
  "template",
] as const;

const KEBAB_CASE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const ruleStkCanonicalMetadata: GovernanceRule = {
  id: "RULE-STK-CANONICAL-METADATA",
  category: "stack",
  name: "Canonical Technology Stack Metadata & Structure",
  description:
    "Verifies that every technology stack directory under stacks/ contains the 6 canonical files/directories (stack.json, spec.md, README.md, quality-gates.partial.json, rif-patterns.json, template/) and valid stack.json metadata.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: ["stacks/*/stack.json", "stacks/*"],
  evaluationMethod: "filesystem_structural",
  version: "1.0.0",
  remediation:
    "Scaffold all 6 canonical stack items in stacks/<technology>/ and ensure stack.json declares valid id, name, version, frameworkTarget, and description.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const stackDirs = getStackDirectories(context);

    if (stackDirs.length === 0) {
      return findings;
    }

    for (const stackId of stackDirs) {
      const stackBase = path.posix.join("stacks", stackId);

      // 1. Verify existence of all 6 canonical items
      for (const item of CANONICAL_STACK_ITEMS) {
        const itemRelPath = path.posix.join(stackBase, item);
        if (!context.fileExists(itemRelPath)) {
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "MISSING_CANONICAL_STACK_FILE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Technology stack '${stackId}' is missing canonical required item '${item}'. Every stack must provide: stack.json, spec.md, README.md, quality-gates.partial.json, rif-patterns.json, and template/.`,
            filePath: itemRelPath,
            line: 1,
            column: 1,
            expected: `Canonical stack item '${itemRelPath}' exists`,
            actual: "Item missing",
            remediation: `Scaffold missing '${item}' under '${stackBase}/'.`,
            blocksOperation: true,
          });
        }
      }

      // 2. Verify template/ is a directory if it exists
      const templateRelPath = path.posix.join(stackBase, "template");
      if (context.fileExists(templateRelPath)) {
        try {
          const stat = context.statFile(templateRelPath);
          if (!stat.isDirectory) {
            findings.push({
              ruleId: ruleStkCanonicalMetadata.id,
              diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
              severity: ruleStkCanonicalMetadata.severity,
              enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
              message: `Canonical stack item '${templateRelPath}' must be a directory containing project starter files.`,
              filePath: templateRelPath,
              line: 1,
              column: 1,
              expected: "Directory",
              actual: "Regular file",
              remediation: `Replace file '${templateRelPath}' with a template/ directory.`,
              blocksOperation: true,
            });
          }
        } catch {
          // File stat error handled gracefully
        }
      }

      // 3. Verify stack.json metadata validity
      const stackJsonRelPath = path.posix.join(stackBase, "stack.json");
      if (context.fileExists(stackJsonRelPath)) {
        let content = "";
        try {
          content = context.readFile(stackJsonRelPath);
        } catch (err: unknown) {
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Failed to read stack metadata '${stackJsonRelPath}': ${err instanceof Error ? err.message : String(err)}`,
            filePath: stackJsonRelPath,
            line: 1,
            column: 1,
            expected: "Readable UTF-8 JSON file",
            actual: "Read failure",
            remediation: `Ensure '${stackJsonRelPath}' is accessible and readable.`,
            blocksOperation: true,
          });
          continue;
        }

        const parseResult = parseJsonSafely<Record<string, unknown>>(content);
        if (!parseResult.success || !parseResult.data) {
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' contains malformed or unparseable JSON: ${parseResult.syntaxError?.message || "Syntax error"}`,
            filePath: stackJsonRelPath,
            line: 1,
            column: 1,
            expected: "Valid JSON adhering to stack metadata contract",
            actual: "Malformed JSON",
            remediation: `Fix syntax errors in '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
          continue;
        }

        const data = parseResult.data;

        // Check required property: id
        if (!data.id || typeof data.id !== "string") {
          const loc = findPropertyLocation(content, "/id");
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' is missing required 'id' string property.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: `id: "${stackId}"`,
            actual: "missing id",
            remediation: `Declare 'id': "${stackId}" in '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        } else {
          const declaredId = data.id.trim();
          if (!KEBAB_CASE_ID_PATTERN.test(declaredId)) {
            const loc = findPropertyLocation(content, "/id");
            findings.push({
              ruleId: ruleStkCanonicalMetadata.id,
              diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
              severity: ruleStkCanonicalMetadata.severity,
              enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
              message: `Stack metadata '${stackJsonRelPath}' declares invalid id '${declaredId}'. Must be lowercase alphanumeric with hyphens (e.g. '${stackId}').`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: `id matching pattern ^[a-z0-9]+(-[a-z0-9]+)*$`,
              actual: `id: "${declaredId}"`,
              remediation: `Format 'id' as lowercase kebab-case.`,
              blocksOperation: true,
            });
          } else if (declaredId !== stackId) {
            const loc = findPropertyLocation(content, "/id");
            findings.push({
              ruleId: ruleStkCanonicalMetadata.id,
              diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
              severity: ruleStkCanonicalMetadata.severity,
              enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
              message: `Stack metadata '${stackJsonRelPath}' declares id '${declaredId}' which does not match parent directory name '${stackId}'.`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: `id: "${stackId}"`,
              actual: `id: "${declaredId}"`,
              remediation: `Ensure 'id' matches the stack directory name '${stackId}'.`,
              blocksOperation: true,
            });
          }
        }

        // Check required property: name
        if (!data.name || typeof data.name !== "string" || !data.name.trim()) {
          const loc = findPropertyLocation(content, "/name");
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' is missing required 'name' string property.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Non-empty string name",
            actual: "missing name",
            remediation: `Add a human-readable 'name' property to '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        }

        // Check required property: version
        if (!data.version || typeof data.version !== "string" || !SEMVER_VERSION_PATTERN.test(data.version.trim())) {
          const loc = findPropertyLocation(content, "/version");
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' specifies invalid or missing semver 'version' ('${data.version ?? ""}').`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Valid semver string (e.g. '1.0.0')",
            actual: `version: "${data.version ?? ""}"`,
            remediation: `Set 'version' to a valid semver string in '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        }

        // Check required property: frameworkTarget
        if (!data.frameworkTarget || typeof data.frameworkTarget !== "string" || !data.frameworkTarget.trim()) {
          const loc = findPropertyLocation(content, "/frameworkTarget");
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' is missing required 'frameworkTarget' string property.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Non-empty frameworkTarget description",
            actual: "missing frameworkTarget",
            remediation: `Declare 'frameworkTarget' (e.g. 'Next.js 15 LTS') in '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        }

        // Check required property: description
        if (!data.description || typeof data.description !== "string" || !data.description.trim()) {
          const loc = findPropertyLocation(content, "/description");
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' is missing required 'description' string property.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Non-empty description",
            actual: "missing description",
            remediation: `Add a 'description' to '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        }

        // Check optional property 'dependencies': if declared, must be an array of strings
        if (data.dependencies !== undefined && !Array.isArray(data.dependencies)) {
          const loc = findPropertyLocation(content, "/dependencies");
          findings.push({
            ruleId: ruleStkCanonicalMetadata.id,
            diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
            severity: ruleStkCanonicalMetadata.severity,
            enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
            message: `Stack metadata '${stackJsonRelPath}' declares 'dependencies' which is not an array. Must be an array of stack identifiers.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Array of dependency stack identifiers (e.g. ['react-native'])",
            actual: typeof data.dependencies,
            remediation: `Format 'dependencies' as an array of strings in '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        }
      }

      // 4. Verify spec.md substantive content and dependency consistency with stack.json
      const specRelPath = path.posix.join(stackBase, "spec.md");
      if (context.fileExists(specRelPath)) {
        try {
          const specContent = context.readFile(specRelPath);
          if (specContent.trim().length < 20) {
            findings.push({
              ruleId: ruleStkCanonicalMetadata.id,
              diagnosticCode: "INCOMPLETE_STACK_STRUCTURE",
              severity: ruleStkCanonicalMetadata.severity,
              enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
              message: `Stack specification '${specRelPath}' is empty or truncated (< 20 characters).`,
              filePath: specRelPath,
              line: 1,
              column: 1,
              expected: "Substantive stack architectural specification",
              actual: "Empty or truncated spec.md",
              remediation: `Document normative stack architecture and rules in '${specRelPath}'.`,
              blocksOperation: true,
            });
          }

          // Check consistency between spec.md declared dependencies and stack.json dependencies
          // Parity with StackManager.getStackInfo conflict detection
          const depMatch =
            specContent.match(/> \*\*Dependencies\*\*:\s*([^\n\r]+)/i) ||
            specContent.match(/(?:^|\n)dependencies:\s*\[?([^\]\n\r]+)\]?/i) ||
            specContent.match(/(?:^|\n)Dependencies:\s*\[?([^\]\n\r]+)\]?/i);

          if (depMatch && depMatch[1]) {
            const raw = depMatch[1].trim();
            const specDeps =
              !raw || raw.toLowerCase() === "none" || raw === "[]"
                ? []
                : raw
                    .split(/[,;\s]+/)
                    .map((d) => d.replace(/[`"'[\]]/g, "").trim())
                    .filter(Boolean);

            const stackJsonRelPath = path.posix.join(stackBase, "stack.json");
            if (context.fileExists(stackJsonRelPath)) {
              try {
                const stackJsonRaw = context.readFile(stackJsonRelPath);
                const parsed = parseJsonSafely<Record<string, unknown>>(stackJsonRaw);
                if (parsed.success && parsed.data && Array.isArray(parsed.data.dependencies)) {
                  const jsonDeps = parsed.data.dependencies.map(String).map((s) => s.trim()).filter(Boolean);
                  const setJson = new Set(jsonDeps);
                  const setSpec = new Set(specDeps);
                  const differs = setJson.size !== setSpec.size || [...setJson].some((d) => !setSpec.has(d));
                  if (differs) {
                    findings.push({
                      ruleId: ruleStkCanonicalMetadata.id,
                      diagnosticCode: "STACK_METADATA_CONFLICT",
                      severity: ruleStkCanonicalMetadata.severity,
                      enforcement: ruleStkCanonicalMetadata.defaultEnforcement,
                      message: `Conflict detected in stack '${stackId}': stack.json declares dependencies [${jsonDeps.join(", ")}] but spec.md declares [${specDeps.join(", ")}]. Authoritative stack.json and human-readable spec.md must be consistent.`,
                      filePath: specRelPath,
                      line: 1,
                      column: 1,
                      expected: `Dependencies in spec.md match stack.json [${jsonDeps.join(", ")}]`,
                      actual: `spec.md declares [${specDeps.join(", ")}]`,
                      remediation: `Align dependencies declared in '${specRelPath}' with '${stackJsonRelPath}'.`,
                      blocksOperation: true,
                    });
                  }
                }
              } catch {
                // Handled gracefully
              }
            }
          }
        } catch {
          // Handled gracefully
        }
      }
    }

    return findings;
  },
};
