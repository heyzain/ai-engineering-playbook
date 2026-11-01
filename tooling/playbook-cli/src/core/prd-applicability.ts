import fs from "node:fs";
import path from "node:path";
import type { CurrentStageDetail } from "../types/state.js";

export interface PrdApplicabilityAssessment {
  status: "applicable" | "outdated" | "ambiguous" | "missing";
  path: string | null;
  determination: string | null;
  summary: string | null;
  reason: string | null;
}

/**
 * Evaluates whether the inherited foundational Problem Statement (docs/prd/PRD-CORE.md)
 * remains applicable for a reopened maintenance milestone.
 *
 * Checks:
 * 1. Dedicated assessment artifact at docs/prd/PRD-CORE-ASSESSMENT.md or deliverable 'PRD-ASSESSMENT'
 * 2. Explicit applicability assessment section within docs/prd/REQUIREMENTS-SPEC.md (REQ-SPEC)
 *
 * Determination keywords:
 * - APPLICABLE / VALID / CONFIRMED -> applicable
 * - OUTDATED / INVALID / PIVOT_REQUIRED / INAPPLICABLE -> outdated
 * - Present but missing determination -> ambiguous
 * - Not found -> missing
 */
export function evaluatePrdApplicability(
  targetDir: string,
  stageDetail?: CurrentStageDetail | null
): PrdApplicabilityAssessment {
  const candidatePaths: string[] = [];

  // Check if a deliverable specifies an assessment artifact
  if (stageDetail?.deliverables) {
    for (const d of stageDetail.deliverables) {
      if (d.id === "PRD-ASSESSMENT" || d.id === "PRD-CORE-ASSESSMENT") {
        candidatePaths.push(d.artifact_path);
      }
    }
  }

  // Conventional paths
  candidatePaths.push("docs/prd/PRD-CORE-ASSESSMENT.md");
  candidatePaths.push("docs/prd/REQUIREMENTS-SPEC.md");

  for (const relPath of candidatePaths) {
    const absPath = path.resolve(targetDir, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const parsed = parseAssessmentContent(content, relPath);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Ignore transient read errors
    }
  }

  return {
    status: "missing",
    path: null,
    determination: null,
    summary: null,
    reason: null,
  };
}

function parseAssessmentContent(
  content: string,
  relPath: string
): PrdApplicabilityAssessment | null {
  const isDedicatedFile = relPath.toLowerCase().includes("assessment");
  const hasAssessmentSection =
    /(?:#+\s*.*(?:applicability|prd\s+core|problem\s+statement).*|\bapplicability:\b|\bprd_status:\b)/i.test(
      content
    );

  if (!isDedicatedFile && !hasAssessmentSection) {
    return null;
  }

  // Look for determination keyword
  const match = content.match(
    /(?:applicability|determination|prd\s+status|status)\s*:\s*([A-Za-z_-]+)/i
  );

  let determination: string | null = null;
  if (match) {
    determination = match[1].trim().toUpperCase();
  }

  // Extract Summary if present
  let summary: string | null = null;
  const summaryMatch = content.match(
    /(?:summary|traceability|rationale)\s*:\s*([^\r\n]+)/i
  );
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Extract Reason if present
  let reason: string | null = null;
  const reasonMatch = content.match(
    /(?:reason|invalidation\s+reason)\s*:\s*([^\r\n]+)/i
  );
  if (reasonMatch) {
    reason = reasonMatch[1].trim();
  }

  if (
    determination === "APPLICABLE" ||
    determination === "VALID" ||
    determination === "CONFIRMED"
  ) {
    return {
      status: "applicable",
      path: relPath,
      determination,
      summary:
        summary ||
        "Foundational problem formulation in docs/prd/PRD-CORE.md remains valid for maintenance scope.",
      reason: null,
    };
  }

  if (
    determination === "OUTDATED" ||
    determination === "INVALID" ||
    determination === "PIVOT_REQUIRED" ||
    determination === "INAPPLICABLE" ||
    determination === "SUPERSEDED"
  ) {
    return {
      status: "outdated",
      path: relPath,
      determination,
      summary: null,
      reason:
        reason ||
        summary ||
        "Foundational problem formulation is no longer applicable to maintenance scope.",
    };
  }

  return {
    status: "ambiguous",
    path: relPath,
    determination,
    summary,
    reason,
  };
}
