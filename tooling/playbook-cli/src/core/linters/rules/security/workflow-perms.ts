import YAML from "yaml";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseYamlSafely, getYamlNodeLocation } from "./helpers.js";

export const ruleSecWorkflowPerms: GovernanceRule = {
  id: "RULE-SEC-WORKFLOW-PERMS",
  category: "security",
  name: "GitHub Actions Workflow Permissions Hardening",
  description:
    "Verifies that GitHub Actions workflows declare an explicit, top-level permissions block restricted to contents: read (or specific least-privilege permissions), barring write-all and unconstrained tokens.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [".github/workflows/**/*.yml", ".github/workflows/**/*.yaml"],
  evaluationMethod: "yaml_ast",
  version: "1.0.0",
  remediation:
    "Add 'permissions: { contents: read }' (or appropriate least-privilege read scopes) at the top level of the workflow.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const workflowFiles = context.listFiles(
      [".github/workflows/**/*.yml", ".github/workflows/**/*.yaml"],
      []
    );

    if (workflowFiles.length === 0) {
      return findings;
    }

    for (const filePath of workflowFiles) {
      let content = "";
      try {
        content = context.readFile(filePath);
      } catch (err: unknown) {
        findings.push({
          ruleId: ruleSecWorkflowPerms.id,
          diagnosticCode: "MISSING_PERMISSIONS_BLOCK",
          severity: ruleSecWorkflowPerms.severity,
          enforcement: ruleSecWorkflowPerms.defaultEnforcement,
          message: `Failed to read workflow file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
          filePath,
          line: 1,
          column: 1,
          expected: "Readable UTF-8 workflow file",
          actual: "Read failure",
          remediation: `Ensure '${filePath}' is accessible and valid UTF-8.`,
          blocksOperation: true,
        });
        continue;
      }

      if (!content.trim()) {
        findings.push({
          ruleId: ruleSecWorkflowPerms.id,
          diagnosticCode: "MISSING_PERMISSIONS_BLOCK",
          severity: ruleSecWorkflowPerms.severity,
          enforcement: ruleSecWorkflowPerms.defaultEnforcement,
          message: `Workflow file '${filePath}' is empty or contains only whitespace. An explicit top-level 'permissions' block is required.`,
          filePath,
          line: 1,
          column: 1,
          expected: "Explicit top-level permissions block (e.g. 'permissions: { contents: read }')",
          actual: "Empty workflow file",
          remediation: `Add a top-level 'permissions' block to '${filePath}'.`,
          blocksOperation: true,
        });
        continue;
      }

      const parseResult = parseYamlSafely(content);
      if (!parseResult.success || !parseResult.doc) {
        findings.push({
          ruleId: ruleSecWorkflowPerms.id,
          diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
          severity: ruleSecWorkflowPerms.severity,
          enforcement: ruleSecWorkflowPerms.defaultEnforcement,
          message: `Workflow file '${filePath}' contains malformed or unparseable YAML syntax: ${parseResult.syntaxError?.message || "Syntax error"}`,
          filePath,
          line: 1,
          column: 1,
          expected: "Valid YAML adhering to GitHub Actions workflow schema",
          actual: "YAML syntax error",
          remediation: `Fix syntax errors in '${filePath}'.`,
          blocksOperation: true,
        });
        continue;
      }

      const doc = parseResult.doc;
      const rootContents = doc.contents;

      if (!rootContents || !(rootContents instanceof YAML.YAMLMap)) {
        findings.push({
          ruleId: ruleSecWorkflowPerms.id,
          diagnosticCode: "MISSING_PERMISSIONS_BLOCK",
          severity: ruleSecWorkflowPerms.severity,
          enforcement: ruleSecWorkflowPerms.defaultEnforcement,
          message: `Workflow file '${filePath}' does not contain a top-level mapping with an explicit 'permissions' block.`,
          filePath,
          line: 1,
          column: 1,
          expected: "Top-level YAML mapping containing 'permissions'",
          actual: rootContents ? rootContents.constructor.name : "empty document",
          remediation: `Define a top-level 'permissions' declaration in '${filePath}'.`,
          blocksOperation: true,
        });
        continue;
      }

      // Locate top-level 'permissions' pair in root map
      const permissionsPair = rootContents.items.find(
        (item) => item.key instanceof YAML.Scalar && String(item.key.value) === "permissions"
      );

      if (!permissionsPair || permissionsPair.value === null || permissionsPair.value === undefined) {
        findings.push({
          ruleId: ruleSecWorkflowPerms.id,
          diagnosticCode: "MISSING_PERMISSIONS_BLOCK",
          severity: ruleSecWorkflowPerms.severity,
          enforcement: ruleSecWorkflowPerms.defaultEnforcement,
          message: `Workflow file '${filePath}' is missing an explicit, top-level 'permissions' declaration. Note: Job-level permissions do not substitute for a mandatory top-level declaration.`,
          filePath,
          line: 1,
          column: 1,
          expected: "Top-level 'permissions' block (e.g. 'permissions: { contents: read }')",
          actual: "Missing top-level permissions block",
          remediation: `Add 'permissions: { contents: read }' at the top level of '${filePath}'.`,
          blocksOperation: true,
        });
        continue;
      }

      const permValueNode = permissionsPair.value;
      const permLocation = getYamlNodeLocation(permissionsPair.key, parseResult.lineCounter);

      // Scenario 1: permissions is a scalar (e.g. 'write-all', 'read-all', '{}')
      if (permValueNode instanceof YAML.Scalar) {
        const valStr = String(permValueNode.value || "").trim().toLowerCase();
        if (valStr === "write-all" || valStr === "write") {
          findings.push({
            ruleId: ruleSecWorkflowPerms.id,
            diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
            severity: ruleSecWorkflowPerms.severity,
            enforcement: ruleSecWorkflowPerms.defaultEnforcement,
            message: `Workflow '${filePath}' declares unconstrained 'permissions: ${valStr}'. Broad write scopes violate least-privilege token access policies.`,
            filePath,
            line: permLocation.line,
            column: permLocation.column,
            expected: "Least-privilege permissions mapping (e.g. 'contents: read' or 'permissions: {}')",
            actual: `permissions: ${valStr}`,
            remediation: `Replace 'permissions: ${valStr}' with 'permissions: { contents: read }' or 'permissions: {}'.`,
            blocksOperation: true,
          });
        } else if (valStr === "read-all") {
          findings.push({
            ruleId: ruleSecWorkflowPerms.id,
            diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
            severity: ruleSecWorkflowPerms.severity,
            enforcement: ruleSecWorkflowPerms.defaultEnforcement,
            message: `Workflow '${filePath}' declares broad 'permissions: read-all'. Least-privilege token access requires restricting permissions to only required scopes (e.g. 'contents: read') or 'permissions: {}'.`,
            filePath,
            line: permLocation.line,
            column: permLocation.column,
            expected: "Least-privilege permissions mapping (e.g. 'contents: read' or 'permissions: {}')",
            actual: "permissions: read-all",
            remediation: `Replace 'permissions: read-all' with specific required scopes (e.g. 'permissions: { contents: read }') or 'permissions: {}'.`,
            blocksOperation: true,
          });
        } else if (valStr !== "{}" && valStr !== "none") {
          findings.push({
            ruleId: ruleSecWorkflowPerms.id,
            diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
            severity: ruleSecWorkflowPerms.severity,
            enforcement: ruleSecWorkflowPerms.defaultEnforcement,
            message: `Workflow '${filePath}' specifies unrecognized top-level permissions scalar '${valStr}'. Must be an explicit mapping of least-privilege scopes (e.g. 'contents: read') or 'permissions: {}'.`,
            filePath,
            line: permLocation.line,
            column: permLocation.column,
            expected: "Valid least-privilege permissions mapping (e.g. 'contents: read' or 'permissions: {}')",
            actual: `permissions: ${valStr}`,
            remediation: `Specify explicit mapping 'permissions: { contents: read }' or 'permissions: {}' in '${filePath}'.`,
            blocksOperation: true,
          });
        }
        continue;
      }

      // Scenario 2: permissions is a map of specific scopes
      if (permValueNode instanceof YAML.YAMLMap) {
        let hasAnyWriteScope = false;

        for (const item of permValueNode.items) {
          const scopeKey = item.key instanceof YAML.Scalar ? String(item.key.value).trim() : "";
          const scopeVal = item.value instanceof YAML.Scalar ? String(item.value.value).trim().toLowerCase() : "";
          const scopeLocation = getYamlNodeLocation(item.key, parseResult.lineCounter);

          if (scopeVal === "write") {
            hasAnyWriteScope = true;
            findings.push({
              ruleId: ruleSecWorkflowPerms.id,
              diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
              severity: ruleSecWorkflowPerms.severity,
              enforcement: ruleSecWorkflowPerms.defaultEnforcement,
              message: `Workflow '${filePath}' grants unsafe write scope '${scopeKey}: write'. CI workflows must adhere to least-privilege token access.`,
              filePath,
              line: scopeLocation.line,
              column: scopeLocation.column,
              expected: `'${scopeKey}: read' or omission of write scope`,
              actual: `${scopeKey}: write`,
              remediation: `Restrict scope '${scopeKey}' to 'read' or remove it from top-level permissions.`,
              blocksOperation: true,
            });
          }
        }

        // Check if permissions mapping is empty or lacks contents: read
        if (!hasAnyWriteScope && permValueNode.items.length > 0) {
          const contentsItem = permValueNode.items.find(
            (i) => i.key instanceof YAML.Scalar && String(i.key.value).trim() === "contents"
          );
          if (contentsItem && contentsItem.value instanceof YAML.Scalar) {
            const contentsVal = String(contentsItem.value.value).trim().toLowerCase();
            if (contentsVal !== "read" && contentsVal !== "none") {
              const loc = getYamlNodeLocation(contentsItem.key, parseResult.lineCounter);
              findings.push({
                ruleId: ruleSecWorkflowPerms.id,
                diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
                severity: ruleSecWorkflowPerms.severity,
                enforcement: ruleSecWorkflowPerms.defaultEnforcement,
                message: `Workflow '${filePath}' specifies invalid contents scope '${contentsVal}'. Must be 'contents: read'.`,
                filePath,
                line: loc.line,
                column: loc.column,
                expected: "contents: read",
                actual: `contents: ${contentsVal}`,
                remediation: `Set 'contents: read' in '${filePath}'.`,
                blocksOperation: true,
              });
            }
          }
        }
        continue;
      }

      // Any other unexpected structure (e.g. array)
      findings.push({
        ruleId: ruleSecWorkflowPerms.id,
        diagnosticCode: "UNSAFE_WORKFLOW_PERMISSIONS",
        severity: ruleSecWorkflowPerms.severity,
        enforcement: ruleSecWorkflowPerms.defaultEnforcement,
        message: `Workflow '${filePath}' defines an invalid 'permissions' structure (${permValueNode.constructor.name}). Must be a mapping of scopes or 'contents: read'.`,
        filePath,
        line: permLocation.line,
        column: permLocation.column,
        expected: "Mapping of scopes (e.g. { contents: read })",
        actual: permValueNode.constructor.name,
        remediation: `Format 'permissions' as a scope mapping in '${filePath}'.`,
        blocksOperation: true,
      });
    }

    return findings;
  },
};
