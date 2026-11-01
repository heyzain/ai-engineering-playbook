import fs from "node:fs";
import path from "node:path";
import type { CurrentStageDetail } from "../types/state.js";

export interface PrdApplicabilityAssessment {
  status:
    | "applicable"
    | "outdated"
    | "ambiguous"
    | "missing"
    | "milestone_missing"
    | "milestone_mismatch"
    | "metadata_incomplete";
  path: string | null;
  milestoneId: string | null;
  determination: string | null;
  scope: string | null;
  author: string | null;
  recordedAt: string | null;
  summary: string | null;
  reason: string | null;
  errors: string[];
}

/**
 * Evaluates whether the inherited foundational Problem Statement (docs/prd/PRD-CORE.md)
 * remains applicable for a reopened maintenance milestone.
 *
 * Ensures:
 * 1. The assessment is explicitly bound to the active milestone identifier.
 * 2. An assessment from an earlier milestone cannot authorize a new milestone.
 * 3. Determination (APPLICABLE vs OUTDATED) is explicitly declared.
 * 4. Supporting metadata (author, scope, date, rationale) is recorded.
 */
export function evaluatePrdApplicability(
  targetDir: string,
  activeMilestoneId?: string,
  stageDetail?: CurrentStageDetail | null
): PrdApplicabilityAssessment {
  const candidatePaths: string[] = [];

  // 1. Deliverable-specified artifact path
  if (stageDetail?.deliverables) {
    for (const d of stageDetail.deliverables) {
      if (d.id === "PRD-ASSESSMENT" || d.id === "PRD-CORE-ASSESSMENT") {
        candidatePaths.push(d.artifact_path);
      }
    }
  }

  // 2. Conventional paths
  candidatePaths.push("docs/prd/PRD-CORE-ASSESSMENT.md");
  candidatePaths.push("docs/prd/REQUIREMENTS-SPEC.md");

  for (const relPath of candidatePaths) {
    const absPath = path.resolve(targetDir, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const parsed = parseAssessmentContent(content, relPath, activeMilestoneId);
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
    milestoneId: null,
    determination: null,
    scope: null,
    author: null,
    recordedAt: null,
    summary: null,
    reason: null,
    errors: ["No applicability assessment artifact found on disk."],
  };
}

function parseAssessmentContent(
  content: string,
  relPath: string,
  activeMilestoneId?: string
): PrdApplicabilityAssessment | null {
  const isDedicatedFile = relPath.toLowerCase().includes("assessment");
  const hasAssessmentSection =
    /(?:#+\s*.*(?:applicability|prd\s+core|problem\s+statement).*|\bapplicability:\b|\bprd_status:\b)/i.test(
      content
    );

  if (!isDedicatedFile && !hasAssessmentSection) {
    return null;
  }

  const errors: string[] = [];

  // Extract Milestone ID
  const milestoneMatch = content.match(
    /(?:milestone\s*id|target\s*milestone|milestone)\s*:\s*([A-Za-z0-9._-]+)/i
  );
  let milestoneId: string | null = null;
  if (milestoneMatch) {
    milestoneId = milestoneMatch[1].trim();
  }

  // Extract Determination
  const match = content.match(
    /(?:applicability|determination|prd\s+status|status)\s*:\s*([A-Za-z_-]+)/i
  );
  let determination: string | null = null;
  if (match) {
    determination = match[1].trim().toUpperCase();
  }

  // Extract Author
  let author: string | null = null;
  const authorMatch = content.match(
    /(?:author|assessed\s*by|evaluator|reviewer)\s*:\s*([^\r\n]+)/i
  );
  if (authorMatch) {
    author = authorMatch[1].trim();
  }

  // Extract Scope / Context
  let scope: string | null = null;
  const scopeMatch = content.match(
    /(?:maintenance\s*scope|scope|context)\s*:\s*([^\r\n]+)/i
  );
  if (scopeMatch) {
    scope = scopeMatch[1].trim();
  }

  // Extract Date / Timestamp
  let recordedAt: string | null = null;
  const dateMatch = content.match(
    /(?:recorded\s*at|date|timestamp)\s*:\s*([^\r\n]+)/i
  );
  if (dateMatch) {
    recordedAt = dateMatch[1].trim();
  }

  // Extract Summary / Traceability / Rationale
  let summary: string | null = null;
  const summaryMatch = content.match(
    /(?:summary|traceability|rationale)\s*:\s*([^\r\n]+)/i
  );
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Extract Reason (for outdated PRD)
  let reason: string | null = null;
  const reasonMatch = content.match(
    /(?:reason|invalidation\s+reason)\s*:\s*([^\r\n]+)/i
  );
  if (reasonMatch) {
    reason = reasonMatch[1].trim();
  }

  // Milestone binding verification
  if (activeMilestoneId) {
    if (!milestoneId) {
      return {
        status: "milestone_missing",
        path: relPath,
        milestoneId: null,
        determination,
        scope,
        author,
        recordedAt,
        summary,
        reason,
        errors: [`Assessment lacks required milestone binding (expected 'Milestone: ${activeMilestoneId}').`],
      };
    }

    if (milestoneId !== activeMilestoneId) {
      return {
        status: "milestone_mismatch",
        path: relPath,
        milestoneId,
        determination,
        scope,
        author,
        recordedAt,
        summary,
        reason,
        errors: [
          `Assessment is bound to milestone '${milestoneId}', but active milestone is '${activeMilestoneId}'. Historical assessment from earlier milestone cannot authorize Gate 1.`,
        ],
      };
    }
  }

  // Determination checks
  if (
    determination === "APPLICABLE" ||
    determination === "VALID" ||
    determination === "CONFIRMED"
  ) {
    return {
      status: "applicable",
      path: relPath,
      milestoneId,
      determination,
      scope: scope || "Maintenance scope",
      author: author || "Author",
      recordedAt: recordedAt || new Date().toISOString(),
      summary:
        summary ||
        "Foundational problem formulation in docs/prd/PRD-CORE.md remains valid for maintenance scope.",
      reason: null,
      errors: [],
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
      milestoneId,
      determination,
      scope: scope || "Maintenance scope",
      author: author || "Author",
      recordedAt: recordedAt || new Date().toISOString(),
      summary: null,
      reason:
        reason ||
        summary ||
        "Foundational problem formulation is no longer applicable to maintenance scope.",
      errors: [],
    };
  }

  return {
    status: "ambiguous",
    path: relPath,
    milestoneId,
    determination,
    scope,
    author,
    recordedAt,
    summary,
    reason,
    errors: ["Assessment lacks an explicit 'Applicability: APPLICABLE' or 'Applicability: OUTDATED' determination."],
  };
}
