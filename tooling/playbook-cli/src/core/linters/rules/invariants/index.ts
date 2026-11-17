import type { GovernanceRule } from "../../types.js";
import { ruleGovNoAgentApproval } from "./no-agent-approval.js";
import { ruleGovImmutableWalCi } from "./immutable-wal-ci.js";
import { ruleGovEvidenceIntegrity } from "./evidence-integrity.js";
import { ruleGovExceptionBounds } from "./exception-bounds.js";
import { ruleGovStackSovereignty } from "./stack-sovereignty.js";

export * from "./no-agent-approval.js";
export * from "./immutable-wal-ci.js";
export * from "./evidence-integrity.js";
export * from "./exception-bounds.js";
export * from "./stack-sovereignty.js";
export * from "./helpers.js";

/**
 * All Category C Governance Invariants rules.
 */
export const INVARIANT_RULES: GovernanceRule[] = [
  ruleGovNoAgentApproval,
  ruleGovImmutableWalCi,
  ruleGovEvidenceIntegrity,
  ruleGovExceptionBounds,
  ruleGovStackSovereignty,
];
