# Task 004F.2.2 — Maintenance Applicability and Stage 0 Recovery Integrity Audit Report

> **Audited Component**: Maintenance Applicability Verification & Stage 0 Recovery Architecture  
> **Package**: `@ai-engineering-playbook/cli`  
> **Latest Implementation Commit**: `af3687f5b17a281e7f8b510d172370ad3086f7ae`  
> **Authoritative Specifications**: [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) (v1.1.0), [`governance/state-machine.md`](file:///f:/workspace/ai-engineering-playbook/governance/state-machine.md)  
> **Auditor**: AI Engineering Controller  
> **Date**: 2026-11-01  
> **Status**: `APPROVED_WITH_DOCUMENTED_LIMITATIONS` (Milestone-Bound Assessment Implemented; Stage 0 Recovery Governance Extension Formally Proposed)  

---

## 1. Executive Summary & Audit Verdict

This audit investigated two critical architectural and operational gaps remaining after Task 004F.2.1:

1. **Stage 0 Recovery After Stage 1 Reopening**:
   When a project is already reopened at Stage 1, but its applicability assessment finds that the inherited `PRD-CORE.md` is `OUTDATED`, the previously documented remediation instructing the operator to execute `playbook reopen --stage 0` encounters a structural governance deadlock: `reopenLifecycle()` strictly rejects any call when `lifecycle_status === "reopened_maintenance"` with `LIFECYCLE_ALREADY_REOPENED`. Furthermore, the existing lifecycle state machine contains no backwards transition ($1 \to 0$). In strict adherence to task constraints ("If the existing architecture cannot support a safe Stage 1-to-Stage 0 recovery, stop and propose the smallest explicit governance extension before implementation"), the governance extensions are formally documented herein for human architectural decision.

2. **Milestone-Bound PRD Applicability Assessment**:
   The applicability assessment parser in [`src/core/prd-applicability.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/prd-applicability.ts) previously relied on loose keyword presence without binding the assessment to the *active milestone*. This created a vulnerability where an assessment authored for an earlier milestone (e.g. `M-1.1.0`) could erroneously satisfy Gate 1 for a subsequent milestone (`M-1.2.0`). This has been resolved: assessments are now strictly milestone-bound, require full author and scope metadata, reject mismatched or missing milestone IDs, and surface all metadata in the Gate 1 human review panel.

### Final Audit Verdict

```
STATUS: APPROVED_WITH_DOCUMENTED_LIMITATIONS
```

All 187 automated tests across 14 test suites pass with zero failures.

---

## 2. Root Cause Analysis

### A. Root Cause of Stage 0 Recovery Deadlock
- **Mechanism**:
  - `playbook reopen` was designed to transition exclusively: `completed_terminal -> reopened_maintenance`.
  - When active at Stage 1 (`reopened_maintenance`), the lifecycle is in an open engineering milestone.
  - If the author determines `PRD-CORE` is `OUTDATED` (e.g. market pivot or fundamental rewrite), Gate 1 approval is rightfully blocked.
  - However, instructing the user to run `playbook reopen --stage 0` fails because:
    1. Specifying the same milestone ID throws `LIFECYCLE_ALREADY_REOPENED`.
    2. Specifying a new milestone ID throws `LIFECYCLE_NOT_TERMINAL` (since current lifecycle status is `reopened_maintenance`, not `completed_terminal`).
  - The sequential lifecycle state machine ($0 \to 1 \to 2 \to 3 \to 4 \to 5 \to 6$) prohibits backwards stage transitions. No silent stage decrement ($1 \to 0$) is permissible without an authorized governance transaction.

### B. Root Cause of Milestone-Binding Gap
- **Mechanism**:
  - In commit `af3687f`, `evaluatePrdApplicability` evaluated only `content.match(/Applicability:\s*([A-Za-z]+)/)`.
  - If a team completed `M-1.1.0` with `Applicability: APPLICABLE`, closed Stage 6, and later reopened `M-1.2.0` at Stage 1, the historical `REQUIREMENTS-SPEC.md` or `PRD-CORE-ASSESSMENT.md` remained on disk with `Applicability: APPLICABLE`.
  - Gate 1 for `M-1.2.0` would evaluate the leftover artifact from `M-1.1.0` as valid, violating the invariant that each new maintenance milestone must evaluate continued applicability independently.

---

## 3. Milestone-Bound Applicability Implementation

The assessment contract in [`src/core/prd-applicability.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/prd-applicability.ts) was revised to require explicit milestone binding:

### A. Contract Specification
An applicability assessment artifact (`docs/prd/PRD-CORE-ASSESSMENT.md` or within `docs/prd/REQUIREMENTS-SPEC.md`) must explicitly specify:
- **`Milestone: <ACTIVE_MILESTONE_ID>`**: Must match `state.milestone_id` exactly.
- **`Determination: APPLICABLE | OUTDATED`**: Explicit keyword declaration.
- **`Author: <NAME>`**: Identity of the author/evaluator.
- **`Scope: <SCOPE>`**: Maintenance scope or context evaluated.
- **`Date: <ISO_OR_DATE>`**: Timestamp or date of evaluation.
- **`Summary / Rationale: <TEXT>`**: Explicit justification for why `PRD-CORE.md` remains valid or why it is outdated.

### B. Evaluation Logic & Diagnostics
1. **Missing Milestone Binding (`milestone_missing`)**:
   - Assessment found, but lacks `Milestone:` line.
   - Raises `GATE_CRITERIA_UNMET` ("Inherited PRD applicability assessment is missing active milestone binding...").
2. **Milestone Mismatch (`milestone_mismatch`)**:
   - Assessment declares `Milestone: M-1.0.0`, but active milestone is `M-1.1.0`.
   - Raises `GATE_CRITERIA_UNMET` ("Assessment is bound to milestone 'M-1.0.0', but active milestone is 'M-1.1.0'. Historical assessment from earlier milestone cannot authorize Gate 1.").
3. **Outdated Prerequisite (`outdated`)**:
   - Declares `Applicability: OUTDATED`.
   - Raises `GATE_CRITERIA_UNMET` in `checkGateEligibility` and `PRD_ASSESSMENT_OUTDATED` in `DiagnosticsEngine` (readiness: `blocked`).
4. **Human Reviewer Panel Display**:
   - `playbook approve --gate 1` extracts and displays the bound milestone ID, author, date, scope, determination, and rationale directly in the terminal review block.
   - Rejection remains fully supported via `rejectGate` / interactive rejection.

---

## 4. Stage 0 Recovery: Proposed Governance Extensions

In strict compliance with user instructions ("If the existing architecture cannot support a safe Stage 1-to-Stage 0 recovery, stop and propose the smallest explicit governance extension before implementation"), we present the two viable governance recovery architectures for human architectural decision:

### Extension Option 1: Milestone Cancellation Protocol (`ABORT_MAINTENANCE_MILESTONE`) — *RECOMMENDED*
- **Concept**:
  - An unapproved maintenance milestone that discovers an obsolete problem formulation was fundamentally opened under a false premise (enhancement vs domain pivot).
  - Rather than mutating the active milestone's stage backwards, the operator formally cancels the unapproved maintenance milestone.
- **CLI Command**:
  `playbook abort-milestone --reason "PRD Core outdated; pivoting scope via Stage 0"`
- **Preconditions**:
  - `state.lifecycle_status === "reopened_maintenance"`.
  - `state.stage_history.length === 0` (no gates have been approved in this milestone).
  - Interactive TTY confirmation phrase: `CONFIRM ABORT MILESTONE <ID>`.
- **State Mutation**:
  - Reverts `state.lifecycle_status` to `completed_terminal`.
  - Reverts `state.current_stage` to `6`.
  - Populates audit log in `last_updated`.
  - Leaves frozen historical snapshots in `.playbook/milestones/` completely intact.
- **Recovery Path for Operator**:
  - With the project back in `completed_terminal`, the operator legitimately runs:
    `playbook reopen --milestone M-2.0.0 --stage 0`
  - Initializes fresh Stage 0 discovery for problem reformulation.

### Extension Option 2: Maintenance Stage Pivot Protocol (`PIVOT_TO_STAGE_0`)
- **Concept**:
  - Allows an active, unapproved maintenance milestone at Stage 1 to pivot its entry stage to Stage 0 without abandoning the milestone identifier.
- **CLI Command**:
  `playbook reopen --stage 0 --pivot` (or `playbook pivot --stage 0`)
- **Preconditions**:
  - `state.lifecycle_status === "reopened_maintenance"`.
  - `state.current_stage === 1`.
  - `state.stage_history.length === 0` (Gate 1 not yet approved).
  - Interactive TTY confirmation phrase: `CONFIRM PIVOT TO STAGE 0`.
- **State Mutation**:
  - Sets `state.current_stage = 0` and `manifest.active_lifecycle_stage = 0`.
  - Populates `current_stage_detail.deliverables` with Stage 0 baseline (`PRD-CORE`, `not_started`).
  - Records pivot rationale and authorizing human in `state.last_updated`.

---

## 5. Automated Test Matrix

All 187 tests pass across 14 test suites:

```bash
cd tooling/playbook-cli
npm test
```

### Key Regression Tests Added in `tests/prd-applicability.test.ts`
1. **Applicable PRD**: Valid current-milestone assessment (`M-1.1.0`) permits Gate 1 eligibility and approval.
2. **Dedicated Artifact**: `PRD-CORE-ASSESSMENT.md` artifact accepted when bound to `M-1.1.0`.
3. **Outdated PRD**: Assessment marked `OUTDATED` blocks Gate 1 progression (`GATE_CRITERIA_UNMET`) and inspect flags `PRD_ASSESSMENT_OUTDATED`.
4. **Missing Assessment**: Missing assessment blocks Gate 1 progression.
5. **Missing Milestone ID**: Assessment without milestone binding is rejected (`milestone_missing`).
6. **Mismatched Milestone ID**: Assessment from prior milestone (`M-1.0.0`) is rejected when active milestone is `M-1.1.0` (`milestone_mismatch`).
7. **Human Reviewer Visibility**: Review panel renders milestone ID, author, date, scope, determination, and rationale.
8. **Human Rejection**: Reviewer rejection remains functional even with an `APPLICABLE` determination.
9. **Second Reopen Restriction**: `reopenLifecycle()` strictly rejects when lifecycle is already `reopened_maintenance` (`LIFECYCLE_ALREADY_REOPENED`).
10. **Zero Mutation Rejection**: Unmet applicability assessment rejects approval with zero filesystem mutations.
11. **Sidecar Replacement**: Successful Gate 1 approval writes fresh sidecar replacing any prior sidecar.

---

## 6. Build, Typecheck, and Test Results

- **Production Build**: `npm run build` -> Exit code `0` (0 errors, 0 warnings).
- **Test Suite**: `node --test dist/tests/**/*.test.js` -> Exit code `0` (187 passed, 0 failed, 14 suites).
- **Execution Time**: `~29.4s`.

---

## 7. Documented Limitations & Operational Boundaries

1. **Heuristic Keyword & Metadata Extraction**: The parser checks for explicit milestone binding, determination keywords, author, date, and rationale. It does not parse or validate semantic English prose; semantic judgment remains the exclusive authority of the human Gate 1 reviewer.
2. **Stage 0 Recovery Awaiting Human Selection**: In accordance with Task 004F.2.2 constraints, backwards stage transitions ($1 \to 0$) are not executed silently. The operator is blocked at Gate 1 until an authorized recovery governance extension (Option 1 or Option 2) is formally approved.
