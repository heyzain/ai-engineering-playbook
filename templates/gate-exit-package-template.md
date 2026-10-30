# Stage Gate Exit Package Template

> **Template Version**: 1.0.0  
> **Applicable Stages**: Exit transition for Stages 0 through 6 (Gates 0 through 6)  
> **Storage Location**: `docs/gates/GATE-[0-6]-EXIT-PACKAGE.md` or PR description / release summary.

---

## Operational Guidance for This Template

### 1. When to Use
- **Trigger**: Prepared at the conclusion of any Lifecycle Stage (Stages 0–6) to formally verify that all deliverables, validation criteria, and exit conditions defined in [stage-gate-rules.md](../governance/stage-gate-rules.md) are satisfied before advancing.
- **Strict Invariant**: **An AI completion report must never be treated as human approval.** Stage completion requires verifiable evidence, and progression to subsequent stages requires explicit human authorization.

### 2. Who Creates It
- **Author**: The AI agent compiles the deliverable summary, collects validation evidence, and drafts the package.
- **Approver**: Authorized Human Engineer, Tech Lead, or Product Owner.

### 3. Mandatory vs. Optional Sections
- **Mandatory**:
  - Section 1: Package & Stage Identification
  - Section 2: Stage Objectives & Scope Summary
  - Section 3: Deliverables Manifest & Status Table
  - Section 4: Verifiable Validation Evidence (Test logs, static analysis, command proof)
  - Section 5: Traceability Matrix (Requirements to deliverables)
  - Section 6: Outstanding Issues, Deferred Items & Accepted Limitations
  - Section 7: Related Governance Artifacts (ADRs, RFCs, Exception Records)
  - Section 8: AI Agent Completion Assertion (Non-approving assertion)
  - Section 9: Human Gate Sign-Off & Approval Record
- **Optional**:
  - Section 10: Performance / Benchmark Metrics (Mandatory for Stage 4 and Stage 5; optional for Stage 0 and 1)

### 4. Information Sufficiency Criteria
- Merely asserting "tests pass" or "criteria are met" is **strictly insufficient**.
- The package must embed concrete command output, test counts, linter outputs, or file links demonstrating compliance.
- Every deliverable must be marked as `Completed`, `Deferred` (with approved rationale), or `Waived` (with an authorized exception record).

### 5. Handling Missing Information
- If any required deliverable is missing, incomplete, or failing validation without an approved Exception Record (`EXC-YYYYMMDD-###.md`), the Controller blocks gate transition.

### 6. Validation and Quality Gate Checks
- Dual approval protocol applies:
  - **Solo Developer Mode**: Explicit in-chat human confirmation with recorded evidence.
  - **Team Mode**: Formal Pull Request review sign-off.

---

# Stage Gate [0–6] Exit Package: [Project Name / Milestone]

## 1. Package & Stage Identification

| Field | Value |
| :--- | :--- |
| **Project Name** | [Project Name] |
| **Completed Stage** | `Stage [0-6]: [Stage Name from stage-gate-rules.md]` |
| **Target Gate** | `Gate [0-6]` |
| **Target Next Stage** | `Stage [1-6]: [Next Stage Name]` |
| **Package Compilation Date** | [YYYY-MM-DD] |
| **AI Agent Compiler** | [Agent Name / Version] |
| **Authorized Human Reviewer** | [Human Lead / Reviewer Name] |
| **Gate Status** | `Pending Human Review` \| `Approved` \| `Rejected` |

---

## 2. Stage Objectives & Scope Summary

### 2.1 Stage Objectives
[Briefly summarize the primary objectives established for this stage in stage-gate-rules.md.]

### 2.2 Scope Completed in this Stage
[Summarize what was designed, specified, implemented, or hardened during this work cycle.]

---

## 3. Deliverables Manifest & Status

| Deliverable Name | File Path / Link | Expected Stage Requirement | Status (`Completed` \| `Deferred` \| `Waived`) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| [e.g., Requirements Spec] | [`docs/prd/PRD-001.md`](#) | Stage 1 Core Deliverable | `Completed` | 100% testable criteria |
| [e.g., System Architecture] | [`docs/adr/ADR-001.md`](#) | Stage 2 Architecture Design | `Completed` | Approved by lead |
| [e.g., Unit Test Suite] | [`tests/unit/`](#) | Stage 3 Verification | `Completed` | 42 passing tests |
| [e.g., Benchmark Suite] | [`tests/bench/`](#) | Stage 4 Performance Gate | `Waived` | Covered by `EXC-20261030-001` |

---

## 4. Verifiable Validation Evidence

Verifiable proof confirming that all stage exit criteria have been satisfied.

### 4.1 Automated Test Execution Results
```text
Test Suite Execution:
  PASS  tests/unit/telemetry_parser.test.ts (14 tests)
  PASS  tests/unit/idempotent_queue.test.ts (18 tests)
  PASS  tests/unit/error_envelope.test.ts (10 tests)

Test Suites: 3 passed, 3 total
Tests:       42 passed, 42 total
Snapshots:   0 total
Time:        1.42s
Ran all test suites.
Exit code: 0
```

### 4.2 Static Quality & Type Check Output
```text
> tsc --noEmit
Exit code: 0

> eslint src/ tests/ --max-warnings 0
Exit code: 0
```

### 4.3 Interface & Schema Validation
```text
> ajv validate -s schemas/telemetry_schema.json -d fixtures/telemetry_valid.json
schemas/telemetry_schema.json is valid
fixtures/telemetry_valid.json is valid
Exit code: 0
```

---

## 5. Traceability Matrix

| Requirement ID | Stage 1 Spec Description | Implementing Deliverable | Verification Test / Evidence | Status |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-001` | Ingest telemetry payload | `src/telemetry/parser.ts` | `tests/unit/telemetry_parser.test.ts` | `Verified` |
| `REQ-002` | Deduplicate repeated events | `src/telemetry/queue.ts` | `tests/unit/idempotent_queue.test.ts` | `Verified` |
| `NFR-001` | Fail fast on invalid payload | `src/common/errors.ts` | `tests/unit/error_envelope.test.ts` | `Verified` |

---

## 6. Outstanding Issues & Accepted Limitations

### 6.1 Outstanding Issues
- None blocking gate exit.
- Minor issue `ISSUE-104` (non-blocking documentation typo) logged for Stage 5 review.

### 6.2 Accepted Limitations
- Telemetry batching currently throttled to 1,000 items per chunk in accordance with `ADR-20261030-001`. Scale expansion scheduled for Milestone 2.

---

## 7. Related Governance Artifacts

| Governance Artifact | ID / Link | Status |
| :--- | :--- | :--- |
| **Architecture Decisions** | [`ADR-20261030-001`](#) | `Accepted` |
| **Clarification RFCs** | [`RFC-20261030-001`](#) | `Resolved` |
| **Gate Exceptions** | [`EXC-20261030-001`](#) | `Approved` |

---

## 8. AI Agent Completion Assertion

> **Agent Statement**:  
> *"I have verified all deliverables and gathered concrete evidence for Stage [X] in compliance with the Engineering Constitution and Stage-Gate Rules. I confirm that all tests pass and no unverified assumptions remain. This package is hereby submitted for human review. I acknowledge that I cannot approve this gate transition on my own authority."*  
>  
> **Compiler Signature**: `AI Agent [Agent Name]` | **Date**: `YYYY-MM-DD`

---

## 9. Human Gate Sign-Off & Approval Record

> [!IMPORTANT]
> **Mandatory Human Sign-Off**: Advancement to the next stage is strictly prohibited until an authorized human engineer signs below.

### Approval Mode:
- [ ] **Solo Developer Mode**: Explicit in-chat confirmation recorded below.
- [ ] **Team Mode**: Pull Request review sign-off completed.

| Field | Record |
| :--- | :--- |
| **Human Approver Name** | [Human Lead / Engineer Name] |
| **Role / Title** | [e.g., Tech Lead / Product Owner] |
| **Decision** | `GATE APPROVED — ADVANCE TO NEXT STAGE` \| `REJECTED — REWORK REQUIRED` |
| **Approval Date** | [YYYY-MM-DD] |
| **Approval Evidence / Reference** | [e.g., *"Confirmed in chat: Gate 2 Approved"* / PR #XX Approved] |
| **Notes / Conditions** | [Any specific instructions for the subsequent stage] |
