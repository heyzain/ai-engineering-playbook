import path from "node:path";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { getStackDirectories, parseJsonSafely, findPropertyLocation } from "./helpers.js";

export const ruleStkDependencyDag: GovernanceRule = {
  id: "RULE-STK-DEPENDENCY-DAG",
  category: "stack",
  name: "Technology Stack Dependency DAG Integrity",
  description:
    "Verifies that the stack dependency graph is strictly acyclic, references existing stacks, and that subordinate files (quality-gates.partial.json, rif-patterns.json) do NOT declare dependencies.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [
    "stacks/*/stack.json",
    "stacks/*/quality-gates.partial.json",
    "stacks/*/rif-patterns.json",
  ],
  evaluationMethod: "cross_reference",
  version: "1.0.0",
  remediation:
    "Declare dependencies strictly in stack.json, ensure all referenced dependencies exist under stacks/, and eliminate any circular dependency cycles.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const stackDirs = getStackDirectories(context);

    if (stackDirs.length === 0) {
      return findings;
    }

    const availableStacks = new Set<string>(stackDirs);
    const dependencyGraph = new Map<string, string[]>();

    // ── 1. Check Subordinate Files (quality-gates.partial.json & rif-patterns.json) ──
    for (const stackId of stackDirs) {
      const qgRelPath = path.posix.join("stacks", stackId, "quality-gates.partial.json");
      if (context.fileExists(qgRelPath)) {
        try {
          const content = context.readFile(qgRelPath);
          const parsed = parseJsonSafely<Record<string, unknown>>(content);
          if (parsed.success && parsed.data && "dependencies" in parsed.data) {
            const depsVal = parsed.data.dependencies;
            // Any presence of dependencies property, even empty or populated, is prohibited in subordinate files
            if (depsVal !== undefined && depsVal !== null) {
              const loc = findPropertyLocation(content, "/dependencies");
              findings.push({
                ruleId: ruleStkDependencyDag.id,
                diagnosticCode: "SUBORDINATE_DEPENDENCY_DECLARATION",
                severity: ruleStkDependencyDag.severity,
                enforcement: ruleStkDependencyDag.defaultEnforcement,
                message: `Subordinate file '${qgRelPath}' declares unauthorized 'dependencies'. Dependencies must strictly be declared only in stack.json to preserve single source of truth.`,
                filePath: qgRelPath,
                line: loc.line,
                column: loc.column,
                expected: "No 'dependencies' property in subordinate files",
                actual: `'dependencies': ${JSON.stringify(depsVal)}`,
                remediation: `Remove 'dependencies' from '${qgRelPath}' and declare dependencies in stacks/${stackId}/stack.json instead.`,
                blocksOperation: true,
              });
            }
          }
        } catch {
          // Handled gracefully
        }
      }

      const rifRelPath = path.posix.join("stacks", stackId, "rif-patterns.json");
      if (context.fileExists(rifRelPath)) {
        try {
          const content = context.readFile(rifRelPath);
          const parsed = parseJsonSafely<Record<string, unknown>>(content);
          if (parsed.success && parsed.data && "dependencies" in parsed.data) {
            const depsVal = parsed.data.dependencies;
            if (depsVal !== undefined && depsVal !== null) {
              const loc = findPropertyLocation(content, "/dependencies");
              findings.push({
                ruleId: ruleStkDependencyDag.id,
                diagnosticCode: "SUBORDINATE_DEPENDENCY_DECLARATION",
                severity: ruleStkDependencyDag.severity,
                enforcement: ruleStkDependencyDag.defaultEnforcement,
                message: `Subordinate file '${rifRelPath}' declares unauthorized 'dependencies'. Dependencies must strictly be declared only in stack.json to preserve single source of truth.`,
                filePath: rifRelPath,
                line: loc.line,
                column: loc.column,
                expected: "No 'dependencies' property in subordinate files",
                actual: `'dependencies': ${JSON.stringify(depsVal)}`,
                remediation: `Remove 'dependencies' from '${rifRelPath}' and declare dependencies in stacks/${stackId}/stack.json instead.`,
                blocksOperation: true,
              });
            }
          }
        } catch {
          // Handled gracefully
        }
      }

      // Read stack.json to build dependency graph
      const stackJsonRelPath = path.posix.join("stacks", stackId, "stack.json");
      if (context.fileExists(stackJsonRelPath)) {
        try {
          const content = context.readFile(stackJsonRelPath);
          const parsed = parseJsonSafely<Record<string, unknown>>(content);
          if (parsed.success && parsed.data) {
            let deps: string[] = [];
            if (Array.isArray(parsed.data.dependencies)) {
              const seenDeps = new Set<string>();
              const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

              for (const rawDep of parsed.data.dependencies) {
                if (typeof rawDep !== "string" || !rawDep.trim()) {
                  const loc = findPropertyLocation(content, "/dependencies");
                  findings.push({
                    ruleId: ruleStkDependencyDag.id,
                    diagnosticCode: "INVALID_STACK_DEPENDENCY_ID",
                    severity: ruleStkDependencyDag.severity,
                    enforcement: ruleStkDependencyDag.defaultEnforcement,
                    message: `Invalid dependency identifier '${String(rawDep)}' in stacks/${stackId}/stack.json. Must be a non-empty string.`,
                    filePath: stackJsonRelPath,
                    line: loc.line,
                    column: loc.column,
                    expected: "Non-empty string dependency identifier",
                    actual: String(rawDep),
                    remediation: `Remove or fix invalid dependency entry in '${stackJsonRelPath}'.`,
                    blocksOperation: true,
                  });
                  continue;
                }

                const dep = rawDep.trim();

                // Check identifier format
                if (!idPattern.test(dep)) {
                  const loc = findPropertyLocation(content, "/dependencies");
                  findings.push({
                    ruleId: ruleStkDependencyDag.id,
                    diagnosticCode: "INVALID_STACK_DEPENDENCY_ID",
                    severity: ruleStkDependencyDag.severity,
                    enforcement: ruleStkDependencyDag.defaultEnforcement,
                    message: `Invalid dependency identifier '${dep}' in stacks/${stackId}/stack.json. Must be lowercase alphanumeric with hyphens (e.g. 'react-native').`,
                    filePath: stackJsonRelPath,
                    line: loc.line,
                    column: loc.column,
                    expected: "Lowercase alphanumeric with hyphens",
                    actual: dep,
                    remediation: `Use valid kebab-case stack identifier in '${stackJsonRelPath}'.`,
                    blocksOperation: true,
                  });
                  continue;
                }

                // Check self-dependency (direct 1-node cycle)
                if (dep === stackId) {
                  const loc = findPropertyLocation(content, "/dependencies");
                  findings.push({
                    ruleId: ruleStkDependencyDag.id,
                    diagnosticCode: "CYCLIC_STACK_DEPENDENCY",
                    severity: ruleStkDependencyDag.severity,
                    enforcement: ruleStkDependencyDag.defaultEnforcement,
                    message: `Stack '${stackId}' cannot declare a self-dependency on itself in stack.json. Circular self-reference is prohibited.`,
                    filePath: stackJsonRelPath,
                    line: loc.line,
                    column: loc.column,
                    expected: `No self-dependency in '${stackJsonRelPath}'`,
                    actual: `Self-dependency: '${dep}'`,
                    remediation: `Remove '${dep}' from dependencies in '${stackJsonRelPath}'.`,
                    blocksOperation: true,
                  });
                  continue;
                }

                // Check duplicate dependency declaration
                if (seenDeps.has(dep)) {
                  const loc = findPropertyLocation(content, "/dependencies");
                  findings.push({
                    ruleId: ruleStkDependencyDag.id,
                    diagnosticCode: "DUPLICATE_STACK_DEPENDENCY",
                    severity: ruleStkDependencyDag.severity,
                    enforcement: ruleStkDependencyDag.defaultEnforcement,
                    message: `Duplicate dependency declaration in stacks/${stackId}/stack.json: '${dep}' is declared more than once.`,
                    filePath: stackJsonRelPath,
                    line: loc.line,
                    column: loc.column,
                    expected: `Unique dependency declaration for '${dep}'`,
                    actual: `Duplicate: '${dep}'`,
                    remediation: `Remove duplicate '${dep}' from dependencies in '${stackJsonRelPath}'.`,
                    blocksOperation: true,
                  });
                  continue;
                }

                seenDeps.add(dep);
                deps.push(dep);
              }
            }
            dependencyGraph.set(stackId, deps);
          } else {
            dependencyGraph.set(stackId, []);
          }
        } catch {
          dependencyGraph.set(stackId, []);
        }
      } else {
        dependencyGraph.set(stackId, []);
      }
    }

    // ── 2. Check Missing Dependencies in stack.json ─────────────────────────
    for (const [stackId, deps] of dependencyGraph.entries()) {
      const stackJsonRelPath = path.posix.join("stacks", stackId, "stack.json");
      for (const dep of deps) {
        if (!availableStacks.has(dep)) {
          findings.push({
            ruleId: ruleStkDependencyDag.id,
            diagnosticCode: "MISSING_STACK_DEPENDENCY",
            severity: ruleStkDependencyDag.severity,
            enforcement: ruleStkDependencyDag.defaultEnforcement,
            message: `Technology stack '${stackId}' requires dependency '${dep}', but '${dep}' does not exist in stacks directory.`,
            filePath: stackJsonRelPath,
            line: 1,
            column: 1,
            expected: `Existing dependency stack under stacks/${dep}/`,
            actual: `Missing stack '${dep}'`,
            remediation: `Scaffold missing stack '${dep}' or remove it from dependencies in '${stackJsonRelPath}'.`,
            blocksOperation: true,
          });
        }
      }
    }

    // ── 3. Check Circular Dependencies (Cycles in DAG) ──────────────────────
    const state = new Map<string, "visiting" | "visited">();
    const activePath: string[] = [];
    const reportedCycles = new Set<string>();

    function dfs(node: string) {
      state.set(node, "visiting");
      activePath.push(node);

      const deps = dependencyGraph.get(node) || [];
      for (const dep of deps) {
        if (state.get(dep) === "visiting") {
          const cycleStartIndex = activePath.indexOf(dep);
          const cycle =
            cycleStartIndex >= 0
              ? [...activePath.slice(cycleStartIndex), dep]
              : [...activePath, dep];
          const cycleKey = cycle.slice().sort().join(" -> ");

          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);
            const sourceFile = path.posix.join("stacks", node, "stack.json");
            findings.push({
              ruleId: ruleStkDependencyDag.id,
              diagnosticCode: "CYCLIC_STACK_DEPENDENCY",
              severity: ruleStkDependencyDag.severity,
              enforcement: ruleStkDependencyDag.defaultEnforcement,
              message: `Circular dependency detected in technology stacks: ${cycle.join(" -> ")}. Stack composition requires a strictly acyclic DAG.`,
              filePath: sourceFile,
              line: 1,
              column: 1,
              expected: "Acyclic stack dependency DAG",
              actual: `Cycle: ${cycle.join(" -> ")}`,
              remediation: `Remove circular reference between ${cycle.join(" and ")} to restore DAG acyclicity.`,
              blocksOperation: true,
            });
          }
        } else if (!state.has(dep) && availableStacks.has(dep)) {
          dfs(dep);
        }
      }

      state.set(node, "visited");
      activePath.pop();
    }

    for (const stackId of dependencyGraph.keys()) {
      if (!state.has(stackId)) {
        dfs(stackId);
      }
    }

    return findings;
  },
};
