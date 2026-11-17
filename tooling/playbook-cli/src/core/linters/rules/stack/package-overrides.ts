import path from "node:path";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import {
  getStackDirectories,
  parseJsonSafely,
  findPropertyLocation,
  isValidPackageOverrideSemver,
} from "./helpers.js";

/**
 * Resolves all direct and transitive prerequisite stack IDs for a given stack.
 */
function getTransitivePrerequisites(startStackId: string, context: RuleExecutionContext): string[] {
  const prereqs = new Set<string>();
  const queue = [startStackId];
  const visited = new Set<string>([startStackId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const stackJsonPath = path.posix.join("stacks", current, "stack.json");
    if (!context.fileExists(stackJsonPath)) continue;

    try {
      const content = context.readFile(stackJsonPath);
      const parsed = parseJsonSafely<Record<string, unknown>>(content);
      if (parsed.success && parsed.data && Array.isArray(parsed.data.dependencies)) {
        for (const dep of parsed.data.dependencies) {
          const depStr = String(dep).trim();
          if (depStr && !visited.has(depStr)) {
            visited.add(depStr);
            prereqs.add(depStr);
            queue.push(depStr);
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return [...prereqs];
}

export const ruleStkPackageOverrides: GovernanceRule = {
  id: "RULE-STK-PACKAGE-OVERRIDES",
  category: "stack",
  name: "Technology Stack Package Override Safety",
  description:
    "Verifies that any packageOverrides declared in stack.json specify valid, concrete package versions (exact pinned or bounded ~/^) and do not delete foundation dependencies without justification.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: ["stacks/*/stack.json"],
  evaluationMethod: "json_ast",
  version: "1.0.0",
  remediation:
    "Specify concrete semver strings in packageOverrides (dependencies, devDependencies, peerDependencies), eliminate contradictory entries, and avoid deleting prerequisite foundation dependencies.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const stackDirs = getStackDirectories(context);

    if (stackDirs.length === 0) {
      return findings;
    }

    for (const stackId of stackDirs) {
      const stackJsonRelPath = path.posix.join("stacks", stackId, "stack.json");
      if (!context.fileExists(stackJsonRelPath)) {
        continue;
      }

      let content = "";
      try {
        content = context.readFile(stackJsonRelPath);
      } catch {
        continue;
      }

      const parsed = parseJsonSafely<Record<string, unknown>>(content);
      if (!parsed.success || !parsed.data) {
        continue;
      }

      const data = parsed.data;
      if (!data.packageOverrides || typeof data.packageOverrides !== "object") {
        continue;
      }

      const overrides = data.packageOverrides as Record<string, unknown>;
      const stackDeps: string[] = Array.isArray(data.dependencies)
        ? data.dependencies.map(String).map((s) => s.trim())
        : [];
      const allPrereqStacks = getTransitivePrerequisites(stackId, context);

      // ── Contradiction Checks ──────────────────────────────────────────────
      // A package cannot simultaneously be declared for override and removal
      if (
        overrides.dependencies &&
        typeof overrides.dependencies === "object" &&
        Array.isArray(overrides.removeDependencies)
      ) {
        const removeDepsSet = new Set(overrides.removeDependencies.map(String).map((s) => s.trim()));
        for (const pkg of Object.keys(overrides.dependencies as Record<string, unknown>)) {
          if (removeDepsSet.has(pkg)) {
            const loc = findPropertyLocation(content, `/packageOverrides/dependencies/${pkg}`);
            findings.push({
              ruleId: ruleStkPackageOverrides.id,
              diagnosticCode: "CONTRADICTORY_PACKAGE_OVERRIDE",
              severity: ruleStkPackageOverrides.severity,
              enforcement: ruleStkPackageOverrides.defaultEnforcement,
              message: `Package '${pkg}' in stack '${stackId}' is declared in both 'packageOverrides.dependencies' and 'packageOverrides.removeDependencies'. A package cannot simultaneously be overridden and removed.`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: `Exclusive declaration in either 'dependencies' or 'removeDependencies'`,
              actual: "Declared in both dependencies and removeDependencies",
              remediation: `Remove '${pkg}' from either 'dependencies' or 'removeDependencies' in '${stackJsonRelPath}'.`,
              blocksOperation: true,
            });
          }
        }
      }

      if (
        overrides.devDependencies &&
        typeof overrides.devDependencies === "object" &&
        Array.isArray(overrides.removeDevDependencies)
      ) {
        const removeDevSet = new Set(overrides.removeDevDependencies.map(String).map((s) => s.trim()));
        for (const pkg of Object.keys(overrides.devDependencies as Record<string, unknown>)) {
          if (removeDevSet.has(pkg)) {
            const loc = findPropertyLocation(content, `/packageOverrides/devDependencies/${pkg}`);
            findings.push({
              ruleId: ruleStkPackageOverrides.id,
              diagnosticCode: "CONTRADICTORY_PACKAGE_OVERRIDE",
              severity: ruleStkPackageOverrides.severity,
              enforcement: ruleStkPackageOverrides.defaultEnforcement,
              message: `Package '${pkg}' in stack '${stackId}' is declared in both 'packageOverrides.devDependencies' and 'packageOverrides.removeDevDependencies'. A package cannot simultaneously be overridden and removed.`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: `Exclusive declaration in either 'devDependencies' or 'removeDevDependencies'`,
              actual: "Declared in both devDependencies and removeDevDependencies",
              remediation: `Remove '${pkg}' from either 'devDependencies' or 'removeDevDependencies' in '${stackJsonRelPath}'.`,
              blocksOperation: true,
            });
          }
        }
      }

      // ── 1. Check dependencies ─────────────────────────────────────────────
      if (overrides.dependencies && typeof overrides.dependencies === "object") {
        for (const [pkg, ver] of Object.entries(overrides.dependencies as Record<string, unknown>)) {
          if (!isValidPackageOverrideSemver(ver)) {
            const loc = findPropertyLocation(content, `/packageOverrides/dependencies/${pkg}`);
            findings.push({
              ruleId: ruleStkPackageOverrides.id,
              diagnosticCode: "INVALID_PACKAGE_OVERRIDE_SEMVER",
              severity: ruleStkPackageOverrides.severity,
              enforcement: ruleStkPackageOverrides.defaultEnforcement,
              message: `Package override for dependency '${pkg}' in stack '${stackId}' specifies invalid or non-concrete semver version '${ver}'.`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: "Concrete semver version (e.g. '19.3.0', '~6.0.3', '^1.2.3')",
              actual: `version: "${ver}"`,
              remediation: `Specify a concrete semver string for dependency '${pkg}' in '${stackJsonRelPath}'.`,
              blocksOperation: true,
            });
          }
        }
      }

      // ── 2. Check devDependencies ──────────────────────────────────────────
      if (overrides.devDependencies && typeof overrides.devDependencies === "object") {
        for (const [pkg, ver] of Object.entries(overrides.devDependencies as Record<string, unknown>)) {
          if (!isValidPackageOverrideSemver(ver)) {
            const loc = findPropertyLocation(content, `/packageOverrides/devDependencies/${pkg}`);
            findings.push({
              ruleId: ruleStkPackageOverrides.id,
              diagnosticCode: "INVALID_PACKAGE_OVERRIDE_SEMVER",
              severity: ruleStkPackageOverrides.severity,
              enforcement: ruleStkPackageOverrides.defaultEnforcement,
              message: `Package override for devDependency '${pkg}' in stack '${stackId}' specifies invalid or non-concrete semver version '${ver}'.`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: "Concrete semver version (e.g. '~6.0.3', '^5.0.0')",
              actual: `version: "${ver}"`,
              remediation: `Specify a concrete semver string for devDependency '${pkg}' in '${stackJsonRelPath}'.`,
              blocksOperation: true,
            });
          }
        }
      }

      // ── 3. Check peerDependencies ─────────────────────────────────────────
      if (overrides.peerDependencies && typeof overrides.peerDependencies === "object") {
        for (const [pkg, ver] of Object.entries(overrides.peerDependencies as Record<string, unknown>)) {
          if (!isValidPackageOverrideSemver(ver)) {
            const loc = findPropertyLocation(content, `/packageOverrides/peerDependencies/${pkg}`);
            findings.push({
              ruleId: ruleStkPackageOverrides.id,
              diagnosticCode: "INVALID_PACKAGE_OVERRIDE_SEMVER",
              severity: ruleStkPackageOverrides.severity,
              enforcement: ruleStkPackageOverrides.defaultEnforcement,
              message: `Package override for peerDependency '${pkg}' in stack '${stackId}' specifies invalid or non-concrete semver version '${ver}'.`,
              filePath: stackJsonRelPath,
              line: loc.line,
              column: loc.column,
              expected: "Concrete semver version (e.g. '^19.0.0')",
              actual: `version: "${ver}"`,
              remediation: `Specify a concrete semver string for peerDependency '${pkg}' in '${stackJsonRelPath}'.`,
              blocksOperation: true,
            });
          }
        }
      }

      // ── 4. Check removeDependencies and foundation dependency deletion ────
      if (overrides.removeDependencies !== undefined) {
        if (!Array.isArray(overrides.removeDependencies)) {
          const loc = findPropertyLocation(content, "/packageOverrides/removeDependencies");
          findings.push({
            ruleId: ruleStkPackageOverrides.id,
            diagnosticCode: "INVALID_PACKAGE_OVERRIDE_STRUCTURE",
            severity: ruleStkPackageOverrides.severity,
            enforcement: ruleStkPackageOverrides.defaultEnforcement,
            message: `Property 'removeDependencies' in stack '${stackId}' must be an array of package name strings.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Array of package name strings",
            actual: typeof overrides.removeDependencies,
            remediation: "Format 'removeDependencies' as an array of package names.",
            blocksOperation: true,
          });
        } else {
          for (const pkg of overrides.removeDependencies) {
            if (!pkg || typeof pkg !== "string" || !pkg.trim()) {
              const loc = findPropertyLocation(content, "/packageOverrides/removeDependencies");
              findings.push({
                ruleId: ruleStkPackageOverrides.id,
                diagnosticCode: "INVALID_PACKAGE_OVERRIDE_STRUCTURE",
                severity: ruleStkPackageOverrides.severity,
                enforcement: ruleStkPackageOverrides.defaultEnforcement,
                message: `Property 'removeDependencies' in stack '${stackId}' contains empty or non-string package entry.`,
                filePath: stackJsonRelPath,
                line: loc.line,
                column: loc.column,
                expected: "Non-empty string package name",
                actual: String(pkg),
                remediation: "Ensure all entries in 'removeDependencies' are non-empty strings.",
                blocksOperation: true,
              });
            } else {
              const cleanPkg = pkg.trim();
              // Check if attempting to remove foundation dependency of direct or transitive prerequisite stacks
              for (const depStack of allPrereqStacks) {
                if (cleanPkg === depStack) {
                  const loc = findPropertyLocation(content, `/packageOverrides/removeDependencies`);
                  findings.push({
                    ruleId: ruleStkPackageOverrides.id,
                    diagnosticCode: "FOUNDATION_DEPENDENCY_DELETION",
                    severity: ruleStkPackageOverrides.severity,
                    enforcement: ruleStkPackageOverrides.defaultEnforcement,
                    message: `Stack '${stackId}' removes foundation package '${cleanPkg}' required by prerequisite stack '${depStack}' without justification.`,
                    filePath: stackJsonRelPath,
                    line: loc.line,
                    column: loc.column,
                    expected: `Preservation of prerequisite runtime '${cleanPkg}'`,
                    actual: `Removed '${cleanPkg}'`,
                    remediation: `Do not remove prerequisite foundation packages in 'removeDependencies'.`,
                    blocksOperation: true,
                  });
                }
              }
            }
          }
        }
      }

      // ── 5. Check removeDevDependencies ────────────────────────────────────
      if (overrides.removeDevDependencies !== undefined) {
        if (!Array.isArray(overrides.removeDevDependencies)) {
          const loc = findPropertyLocation(content, "/packageOverrides/removeDevDependencies");
          findings.push({
            ruleId: ruleStkPackageOverrides.id,
            diagnosticCode: "INVALID_PACKAGE_OVERRIDE_STRUCTURE",
            severity: ruleStkPackageOverrides.severity,
            enforcement: ruleStkPackageOverrides.defaultEnforcement,
            message: `Property 'removeDevDependencies' in stack '${stackId}' must be an array of package name strings.`,
            filePath: stackJsonRelPath,
            line: loc.line,
            column: loc.column,
            expected: "Array of package name strings",
            actual: typeof overrides.removeDevDependencies,
            remediation: "Format 'removeDevDependencies' as an array of package names.",
            blocksOperation: true,
          });
        } else {
          for (const pkg of overrides.removeDevDependencies) {
            if (!pkg || typeof pkg !== "string" || !pkg.trim()) {
              const loc = findPropertyLocation(content, "/packageOverrides/removeDevDependencies");
              findings.push({
                ruleId: ruleStkPackageOverrides.id,
                diagnosticCode: "INVALID_PACKAGE_OVERRIDE_STRUCTURE",
                severity: ruleStkPackageOverrides.severity,
                enforcement: ruleStkPackageOverrides.defaultEnforcement,
                message: `Property 'removeDevDependencies' in stack '${stackId}' contains empty or non-string package entry.`,
                filePath: stackJsonRelPath,
                line: loc.line,
                column: loc.column,
                expected: "Non-empty string package name",
                actual: String(pkg),
                remediation: "Ensure all entries in 'removeDevDependencies' are non-empty strings.",
                blocksOperation: true,
              });
            }
          }
        }
      }
    }

    return findings;
  },
};
