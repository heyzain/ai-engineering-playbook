import fs from "node:fs";
import path from "node:path";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { StackManager, StackError } from "../../../stacks/stack-manager.js";
import { parseJsonSafely, findPropertyLocation } from "./helpers.js";

const MANIFEST_PATH = ".playbook/manifest.json";

function loadTemplatePackageJson(stacksDir: string, stackName: string): string | null {
  const templateDir = path.join(stacksDir, stackName, "template");
  const p1 = path.join(templateDir, "package.json");
  if (fs.existsSync(p1)) {
    try {
      return fs.readFileSync(p1, "utf-8");
    } catch {
      return null;
    }
  }
  const p2 = path.join(templateDir, "package.json.template");
  if (fs.existsSync(p2)) {
    try {
      return fs.readFileSync(p2, "utf-8");
    } catch {
      return null;
    }
  }
  return null;
}

export const ruleCfgStackDeclaration: GovernanceRule = {
  id: "RULE-CFG-STACK-DECLARATION",
  category: "schema",
  name: "Technology Stack Declaration & Consistency",
  description:
    "Validates that technology stack declarations in .playbook/manifest.json reference valid stack definitions, satisfy dependency DAG prerequisites, avoid circular dependencies, and do not introduce unresolvable dependency conflicts.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [MANIFEST_PATH],
  evaluationMethod: "cross_reference",
  version: "1.0.0",
  remediation:
    "Update technology_stacks in .playbook/manifest.json to declare valid, available stacks that satisfy prerequisite dependencies without conflict.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    // 1. If manifest does not exist or cannot be read, defer to RULE-SCHEMA-MANIFEST-VALIDITY
    if (!context.fileExists(MANIFEST_PATH)) {
      return findings;
    }

    let content: string;
    try {
      content = context.readFile(MANIFEST_PATH);
    } catch {
      return findings;
    }

    const parseResult = parseJsonSafely<Record<string, unknown>>(content);
    if (!parseResult.success || !parseResult.data) {
      return findings;
    }

    const manifest = parseResult.data;

    // 2. Extract declared stacks
    let declaredStacks: string[] = [];
    if (Array.isArray(manifest.technology_stacks)) {
      declaredStacks = manifest.technology_stacks.map(String);
    } else if (
      manifest.tech_stack &&
      typeof manifest.tech_stack === "object" &&
      Array.isArray((manifest.tech_stack as Record<string, unknown>).frameworks)
    ) {
      declaredStacks = ((manifest.tech_stack as Record<string, unknown>).frameworks as unknown[]).map(String);
    }

    // If no technology stacks are declared (e.g. agnostic or standard), compliant by default
    if (declaredStacks.length === 0) {
      return findings;
    }

    // 3. Resolve stacks directory: check if project has local stacks/ override, else canonical
    let customStacksDir: string | undefined;
    const localStacksPath = path.join(context.projectDir, "stacks");
    if (fs.existsSync(localStacksPath)) {
      try {
        const entries = fs.readdirSync(localStacksPath, { withFileTypes: true });
        if (entries.some((e) => e.isDirectory())) {
          customStacksDir = localStacksPath;
        }
      } catch {
        // fallback
      }
    }

    const manager = new StackManager({ stacksDir: customStacksDir });
    const loc = findPropertyLocation(content, "/technology_stacks");

    // 4. Validate identifier format and definition existence for each declared stack
    const validStackIds: string[] = [];
    const stackIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

    for (const stackName of declaredStacks) {
      const trimmed = (stackName || "").trim();
      if (!trimmed || !stackIdPattern.test(trimmed)) {
        findings.push({
          ruleId: ruleCfgStackDeclaration.id,
          diagnosticCode: "UNKNOWN_STACK_ID",
          severity: ruleCfgStackDeclaration.severity,
          enforcement: ruleCfgStackDeclaration.defaultEnforcement,
          message: `Invalid technology stack identifier '${stackName}'. Must be lowercase alphanumeric with hyphens (e.g. 'react-native').`,
          filePath: MANIFEST_PATH,
          line: loc.line,
          column: loc.column,
          expected: "Valid lowercase kebab-case stack identifier",
          actual: stackName,
          remediation: `Correct the stack identifier '${stackName}' in ${MANIFEST_PATH}.`,
          blocksOperation: true,
        });
        continue;
      }

      try {
        manager.getStackInfo(trimmed);
        validStackIds.push(trimmed);
      } catch (err: unknown) {
        if (err instanceof StackError) {
          if (err.code === "STACK_NOT_FOUND") {
            findings.push({
              ruleId: ruleCfgStackDeclaration.id,
              diagnosticCode: "STACK_DEFINITION_MISSING",
              severity: ruleCfgStackDeclaration.severity,
              enforcement: ruleCfgStackDeclaration.defaultEnforcement,
              message: `Technology stack '${trimmed}' declared in manifest but no definition found in stacks directory: ${manager.getStacksDir()}`,
              filePath: MANIFEST_PATH,
              line: loc.line,
              column: loc.column,
              expected: `Existing stack directory for '${trimmed}' with stack.json or spec.md`,
              actual: "Stack definition not found",
              remediation: `Ensure stack '${trimmed}' is available in the stacks directory or remove it from ${MANIFEST_PATH}.`,
              blocksOperation: true,
            });
          } else if (err.code === "STACK_METADATA_CONFLICT" || err.code === "STACK_METADATA_MALFORMED") {
            findings.push({
              ruleId: ruleCfgStackDeclaration.id,
              diagnosticCode: "STACK_CONFIG_CONFLICT",
              severity: ruleCfgStackDeclaration.severity,
              enforcement: ruleCfgStackDeclaration.defaultEnforcement,
              message: err.message,
              filePath: MANIFEST_PATH,
              line: loc.line,
              column: loc.column,
              expected: "Consistent and valid stack metadata",
              actual: err.message,
              remediation: `Resolve metadata conflicts or malformed configuration in stack '${trimmed}'.`,
              blocksOperation: true,
            });
          } else {
            findings.push({
              ruleId: ruleCfgStackDeclaration.id,
              diagnosticCode: "STACK_CONFIG_CONFLICT",
              severity: ruleCfgStackDeclaration.severity,
              enforcement: ruleCfgStackDeclaration.defaultEnforcement,
              message: err.message,
              filePath: MANIFEST_PATH,
              line: loc.line,
              column: loc.column,
              expected: "Valid technology stack configuration",
              actual: err.message,
              remediation: `Resolve configuration defect for stack '${trimmed}'.`,
              blocksOperation: true,
            });
          }
        } else {
          findings.push({
            ruleId: ruleCfgStackDeclaration.id,
            diagnosticCode: "STACK_CONFIG_CONFLICT",
            severity: ruleCfgStackDeclaration.severity,
            enforcement: ruleCfgStackDeclaration.defaultEnforcement,
            message: `Unexpected error validating stack '${trimmed}': ${err instanceof Error ? err.message : String(err)}`,
            filePath: MANIFEST_PATH,
            line: loc.line,
            column: loc.column,
            expected: "Valid technology stack configuration",
            actual: String(err),
            remediation: `Inspect stack definition '${trimmed}'.`,
            blocksOperation: true,
          });
        }
      }
    }

    if (validStackIds.length === 0) {
      return findings;
    }

    // 5. Dependency resolution & DAG cycle / missing dependency detection
    let resolvedStacks: string[] = [];
    try {
      resolvedStacks = manager.resolveDependencies(validStackIds);
    } catch (err: unknown) {
      if (err instanceof StackError) {
        if (err.code === "CIRCULAR_DEPENDENCY_DETECTED") {
          findings.push({
            ruleId: ruleCfgStackDeclaration.id,
            diagnosticCode: "CIRCULAR_STACK_DEPENDENCY",
            severity: ruleCfgStackDeclaration.severity,
            enforcement: ruleCfgStackDeclaration.defaultEnforcement,
            message: err.message,
            filePath: MANIFEST_PATH,
            line: loc.line,
            column: loc.column,
            expected: "Acyclic technology stack dependency DAG",
            actual: "Circular dependency detected",
            remediation: "Break the circular dependency in technology stack definitions.",
            blocksOperation: true,
          });
        } else if (err.code === "STACK_DEPENDENCY_MISSING") {
          findings.push({
            ruleId: ruleCfgStackDeclaration.id,
            diagnosticCode: "STACK_DEPENDENCY_MISSING",
            severity: ruleCfgStackDeclaration.severity,
            enforcement: ruleCfgStackDeclaration.defaultEnforcement,
            message: err.message,
            filePath: MANIFEST_PATH,
            line: loc.line,
            column: loc.column,
            expected: "All prerequisite technology stacks present in stacks directory",
            actual: "Prerequisite dependency missing",
            remediation: "Provide the missing prerequisite stack definition in stacks directory.",
            blocksOperation: true,
          });
        } else {
          findings.push({
            ruleId: ruleCfgStackDeclaration.id,
            diagnosticCode: "STACK_CONFIG_CONFLICT",
            severity: ruleCfgStackDeclaration.severity,
            enforcement: ruleCfgStackDeclaration.defaultEnforcement,
            message: err.message,
            filePath: MANIFEST_PATH,
            line: loc.line,
            column: loc.column,
            expected: "Valid stack dependency resolution",
            actual: err.message,
            remediation: "Resolve dependency conflicts in declared technology stacks.",
            blocksOperation: true,
          });
        }
      }
      return findings;
    }

    // 6. Expo and React Native foundation consistency
    // Expo must build on top of React Native foundation, and manifest must explicitly declare both
    if (declaredStacks.includes("expo")) {
      if (!declaredStacks.includes("react-native")) {
        findings.push({
          ruleId: ruleCfgStackDeclaration.id,
          diagnosticCode: "STACK_PREREQUISITE_INCONSISTENCY",
          severity: ruleCfgStackDeclaration.severity,
          enforcement: ruleCfgStackDeclaration.defaultEnforcement,
          message:
            "Technology stack 'expo' requires foundation stack 'react-native' to be explicitly declared in technology_stacks: ['react-native', 'expo'].",
          filePath: MANIFEST_PATH,
          line: loc.line,
          column: loc.column,
          expected: "Manifest technology_stacks declaring ['react-native', 'expo']",
          actual: `Declared: [${declaredStacks.map((s) => `'${s}'`).join(", ")}]`,
          remediation:
            "Update technology_stacks in .playbook/manifest.json to declare foundation 'react-native' alongside 'expo'.",
          blocksOperation: true,
        });
      }
    }

    // 7. Multi-stack package override and dependency conflict detection
    if (resolvedStacks.length > 1) {
      for (let i = 0; i < resolvedStacks.length; i++) {
        const stackA = resolvedStacks[i];
        for (let j = i + 1; j < resolvedStacks.length; j++) {
          const stackB = resolvedStacks[j];
          const infoB = manager.getStackInfo(stackB);
          const pkgA = loadTemplatePackageJson(manager.getStacksDir(), stackA);
          const pkgB = loadTemplatePackageJson(manager.getStacksDir(), stackB);

          if (pkgA && pkgB) {
            try {
              manager.mergePackageJson(pkgA, pkgB, stackA, infoB);
            } catch (err: unknown) {
              if (err instanceof StackError && err.code === "STACK_UNRESOLVED_DEPENDENCY_CONFLICT") {
                findings.push({
                  ruleId: ruleCfgStackDeclaration.id,
                  diagnosticCode: "STACK_CONFIG_CONFLICT",
                  severity: ruleCfgStackDeclaration.severity,
                  enforcement: ruleCfgStackDeclaration.defaultEnforcement,
                  message: err.message,
                  filePath: MANIFEST_PATH,
                  line: loc.line,
                  column: loc.column,
                  expected: "Compatible package versions across declared stacks or explicit packageOverrides in stack.json",
                  actual: "Unresolved package version conflict",
                  remediation: `Configure explicit packageOverrides in stack.json for '${stackB}' to reconcile conflicting dependencies with '${stackA}'.`,
                  blocksOperation: true,
                });
              }
            }
          }
        }
      }
    }

    // 8. Pre-existing package.json compatibility check
    try {
      manager.validatePreExistingCompatibility(context.projectDir, resolvedStacks);
    } catch (err: unknown) {
      if (err instanceof StackError && err.code === "STACK_INCOMPATIBLE_DEPENDENCY") {
        findings.push({
          ruleId: ruleCfgStackDeclaration.id,
          diagnosticCode: "STACK_CONFIG_CONFLICT",
          severity: ruleCfgStackDeclaration.severity,
          enforcement: ruleCfgStackDeclaration.defaultEnforcement,
          message: err.message,
          filePath: "package.json",
          line: 1,
          column: 1,
          expected: "Pre-existing dependencies satisfying stack compatibility constraints",
          actual: err.message,
          remediation: "Upgrade or align conflicting dependencies in package.json to satisfy declared technology stacks.",
          blocksOperation: true,
        });
      }
    }

    return findings;
  },
};
