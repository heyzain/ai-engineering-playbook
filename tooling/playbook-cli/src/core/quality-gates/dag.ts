import type { QualityGateCheck } from "../../types/quality-gates.js";
import { QualityGateConfigError } from "./config.js";

export interface DagResolutionResult {
  /** Ordered checks in topological sequence */
  orderedChecks: QualityGateCheck[];
  /** Execution levels for parallel scheduling: checks at level N can execute in parallel once level N-1 is complete */
  levels: QualityGateCheck[][];
}

/**
 * Resolves the dependency DAG for a set of checks.
 * Uses Kahn's algorithm to perform cycle detection and compute execution levels.
 * Throws `QualityGateConfigError` with `CONFIG_CYCLIC_DEPENDENCY` if a cycle is detected.
 * Throws `QualityGateConfigError` with `CONFIG_MISSING_DEPENDENCY` if a dependency does not exist.
 */
export function resolveCheckDag(checks: QualityGateCheck[]): DagResolutionResult {
  if (checks.length === 0) {
    return { orderedChecks: [], levels: [] };
  }

  const checkMap = new Map<string, QualityGateCheck>();
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // dependency -> dependent

  for (const check of checks) {
    checkMap.set(check.id, check);
    inDegree.set(check.id, 0);
    adjList.set(check.id, []);
  }

  // Validate dependencies and populate in-degree and adjacency
  for (const check of checks) {
    const deps = check.depends_on || [];
    for (const depId of deps) {
      if (!checkMap.has(depId)) {
        throw new QualityGateConfigError(
          "CONFIG_MISSING_DEPENDENCY",
          `Check '${check.id}' depends on nonexistent check '${depId}'.`,
          { check_id: check.id, missing_dependency: depId }
        );
      }
      inDegree.set(check.id, (inDegree.get(check.id) || 0) + 1);
      adjList.get(depId)!.push(check.id);
    }
  }

  // Kahn's algorithm with level tracking
  let currentLevel: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      currentLevel.push(id);
    }
  }

  const orderedChecks: QualityGateCheck[] = [];
  const levels: QualityGateCheck[][] = [];
  let visitedCount = 0;

  while (currentLevel.length > 0) {
    // Sort current level by check ID for determinism
    currentLevel.sort();
    const levelChecks: QualityGateCheck[] = currentLevel.map((id) => checkMap.get(id)!);
    levels.push(levelChecks);
    orderedChecks.push(...levelChecks);
    visitedCount += currentLevel.length;

    const nextLevel: string[] = [];
    for (const u of currentLevel) {
      for (const v of adjList.get(u)!) {
        const newDeg = inDegree.get(v)! - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          nextLevel.push(v);
        }
      }
    }

    currentLevel = nextLevel;
  }

  if (visitedCount < checks.length) {
    // Collect unvisited checks involved in cycle
    const cycleNodes: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg > 0) {
        cycleNodes.push(id);
      }
    }

    throw new QualityGateConfigError(
      "CONFIG_CYCLIC_DEPENDENCY",
      `Circular dependency detected in quality gate checks: ${cycleNodes.join(" -> ")}`,
      { cycle_checks: cycleNodes }
    );
  }

  return { orderedChecks, levels };
}
