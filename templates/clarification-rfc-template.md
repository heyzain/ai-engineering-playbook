# Clarification Request (RFC) Template

> **Template Version**: 1.0.0  
> **Applicable Stages**: Operational Step 3 (Gap Analysis) across all Lifecycle Stages (Stages 0–6)  
> **Storage Location**: `docs/rfcs/RFC-YYYYMMDD-###.md` or directly emitted in the development conversation / issue tracker.

---

## Operational Guidance for This Template

### 1. When to Use
- **Trigger**: The moment an AI agent or engineer discovers an ambiguity, contradictory specification, unstated boundary condition, missing error state, or ungrounded architectural assumption.
- **Strict Prohibition**: **The AI agent must never silently resolve decisions that require human input.** Guessing, assuming reasonable defaults, or hallucinating business logic is strictly forbidden by the [Engineering Constitution](../core/engineering-constitution.md) and [ENGINEERING_CONTROLLER.md](../governance/ENGINEERING_CONTROLLER.md).

### 2. Who Creates It
- **Author**: The AI agent (or engineer) encountering the requirement gap or ambiguity.
- **Resolver**: Authorized Human Engineer, Technical Lead, or Product Owner.

### 3. Mandatory vs. Optional Sections
- **Mandatory**:
  - Section 1: RFC Metadata (RFC ID, Date, Originating Stage, Blocked Task)
  - Section 2: Unresolved Question & Context
  - Section 3: Why Clarification is Necessary (Blast radius & risk of guessing)
  - Section 4: Analyzed Options & Trade-Off Matrix (Minimum 2 viable options)
  - Section 5: AI Recommendation & Constitutional Rationale
  - Section 6: Actionable Human Decision Required
  - Section 7: Decision Outcome & Human Sign-Off (Completed after human input)
  - Section 8: Impact on Existing Artifacts (Downstream updates)
- **Optional**:
  - Section 9: Code / Specification Excerpt illustrating the conflict

### 4. Information Sufficiency Criteria
- The question must not be an open-ended or lazy prompt (e.g., "What should I do next?").
- The RFC must present concrete, actionable options with balanced trade-off analysis.
- The AI recommendation must cite specific engineering principles (e.g., simplicity, explicit contracts, performance budget) rather than subjective intuition.

### 5. Handling Missing Information
- While an RFC is in `Pending Decision` status, the agent is in a **HALTED** operational state regarding the blocked requirement.
- The agent may continue work on independent, unblocked tasks within the current stage only if permitted by the human engineer.

### 6. Validation and Quality Gate Checks
- No stage gate (particularly Gate 1 and Gate 2) can be approved with unresolved or open Clarification RFCs.

---

# RFC-[YYYYMMDD]-[###]: [Concise Title of Ambiguity, e.g., Deletion Strategy for Inactive Customer Records]

## 1. Document Metadata

| Field | Value |
| :--- | :--- |
| **RFC ID** | `RFC-YYYYMMDD-###` |
| **Date Opened** | [YYYY-MM-DD] |
| **Originating Stage** | `Stage 0` \| `Stage 1` \| `Stage 2` \| `Stage 3` \| `Stage 4` \| `Stage 5` \| `Stage 6` |
| **Blocked Task / Requirement** | [e.g., Task 004 / Requirement `REQ-003`] |
| **Author** | [AI Agent Name / Human Engineer] |
| **Designated Resolver** | [Name / Role of Human Authority] |
| **Status** | `Pending Decision` \| `Resolved` \| `Withdrawn` |
| **Resolution Date** | [YYYY-MM-DD or `N/A`] |

---

## 2. Background & Unresolved Question

### 2.1 Context
[Provide the background facts, relevant existing specifications, or current implementation details.]

### 2.2 The Specific Ambiguity or Contradiction
[State the exact gap or contradiction clearly and concisely.]

*Realistic Example*:
> In `PRD-20261030-001`, `REQ-003` specifies: *"Users can delete their workspace."* However, the specification does not define whether workspace resources (associated API keys, audit logs, and historical transactions) must be hard-deleted immediately or soft-deleted with a 30-day retention grace period. Furthermore, `NFR-001` mandates compliance with regulatory audit retention for financial transactions.

---

## 3. Why Clarification is Necessary

- **Downstream Architectural Impact**: Database schema design (Stage 2) requires determining whether entity tables include `deleted_at` timestamp columns, cascade triggers, or archival tables.
- **Compliance & Data Loss Risk**: Hard-deletion permanently destroys records and violates audit retention requirements (`NFR-001`). Conversely, unannounced soft-deletion may conflict with user expectations and privacy mandates (e.g., GDPR Right to Erasure).
- **Prohibition on Assumption**: The AI agent cannot assume customer policy on data retention without human authority.

---

## 4. Analyzed Options & Trade-Off Matrix

### Option A: [Title, e.g., Immediate Hard Deletion with Cascade]
- **Technical Description**: Execute an immediate SQL `DELETE CASCADE` removing the workspace, keys, and transaction history.
- **Advantages / Pros**:
  - Simple implementation; zero background retention cleaner required.
  - Guarantees immediate cleanup of storage.
- **Disadvantages / Liabilities**:
  - Irreversible data loss if triggered accidentally.
  - Violates audit trail retention requirements specified in `NFR-001`.

### Option B: [Title, e.g., Two-Tier Soft Deletion with 30-Day Retention] (Recommended)
- **Technical Description**: Set `status = 'deleted'` and record `deleted_at = NOW()`. Revoke access tokens immediately. Retain records for 30 days before background vacuuming, while preserving financial transaction rows permanently with anonymized references.
- **Advantages / Pros**:
  - Allows accidental deletion recovery within 30 days.
  - Fully preserves financial transaction auditability under `NFR-001`.
- **Disadvantages / Liabilities**:
  - Requires adding `deleted_at` filters to all active queries.
  - Requires an automated background purge job after retention expiration.

---

## 5. AI Recommendation & Constitutional Rationale

- **Recommendation**: **Adopt Option B (Two-Tier Soft Deletion)**.
- **Constitutional Alignment**:
  - Adheres to [Engineering Constitution Principle 6 (Explicit Contracts)](../core/engineering-constitution.md#principle-6-explicit-contracts-and-interface-first-design) by making the lifecycle states explicit rather than destroying state silently.
  - Protects system invariants around compliance and auditability (`Principle 3: Determinism`).

---

## 6. Actionable Human Decision Required

Please review the analyzed options and confirm how you wish to proceed:

```markdown
[ ] Option A: Immediate Hard Deletion
[x] Option B: Two-Tier Soft Deletion with 30-Day Retention (AI Recommended)
[ ] Option C: Alternative Direction (Specify below)
```

---

## 7. Decision Outcome & Human Sign-Off

*(To be filled by the Human Engineer upon resolution)*

| Field | Value |
| :--- | :--- |
| **Selected Decision** | `Option B: Two-Tier Soft Deletion with 30-Day Retention` |
| **Human Approver** | [Human Name / Role] |
| **Decision Date** | YYYY-MM-DD |
| **Additional Guidance / Notes** | Retain financial records permanently; purge transient logs after 30 days. |
| **Approval Method** | [Explicit in-chat confirmation / PR comment / Issue update] |

---

## 8. Impact on Existing Artifacts

Once this RFC is marked `Resolved`, the following artifacts must be updated synchronously:

| Target Artifact | Required Change | Completion Status |
| :--- | :--- | :--- |
| `docs/prd/PRD-20261030-001.md` | Update `REQ-003` to specify soft-delete state machine and retention period. | `Pending Update` |
| `docs/adr/ADR-YYYYMMDD-002.md` | Author ADR documenting workspace lifecycle states and background vacuum worker. | `Pending Update` |
