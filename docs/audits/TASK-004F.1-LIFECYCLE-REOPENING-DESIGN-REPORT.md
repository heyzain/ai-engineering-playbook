# Task 004F.1 — Controlled Lifecycle Reopening: Architecture & Design Report

> **Component**: Controlled Lifecycle Reopening Governance Architecture  
> **Package**: `@ai-engineering-playbook/cli`  
> **Author**: AI Engineering Controller  
> **Date**: 2026-11-01  
> **Task Ref**: Task 004F.1  
> **Deliverable Document**: [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md)  
> **Status**: Completed Architectural Specification & Review Report  

---

## 1. Executive Summary & Verdict

Task 004F.1 establishes the architectural contract, state transitions, transaction integration, milestone preservation model, and CLI interface for **Controlled Lifecycle Reopening (`REOPEN_LIFECYCLE`)**.

In accordance with task constraints, **no runtime code was implemented and no existing behavior was modified**. This task produces a rigorous, production-grade architectural specification that bridges the gap between documented state machine concepts and future CLI implementation.

### Final Verdict

```
DESIGN_READY_FOR_REVIEW
```

> [!NOTE]
> The architectural design satisfies all core engineering constitution principles, preserves the immutability of completed milestone snapshots, prevents AI agent self-reopening, leverages the shared Write-Ahead Logging (WAL) and flock concurrency engines, and provides full backward and forward compatibility with existing Draft 2020-12 JSON schemas.

---

## 2. Phase 1 — Existing Architecture Audit Findings

A comprehensive audit of the current governance layer, schemas, and CLI implementation revealed the following ground truths:

1. **State Machine Invariant**:
   - Advancing Stage 6 executes `CLOSE_LIFECYCLE`, permanently locking `current_stage` at `6` and setting `lifecycle_status: "completed_terminal"`.
   - Repeated calls to `playbook advance` throw `ADVANCEMENT_BLOCKED`. Stage 7 is strictly prohibited and never created.
2. **Snapshot Creation & Immutability**:
   - The sealed state is atomically snapshotted to `.playbook/milestones/state-<milestone_id>.json` and set to read-only permissions (`0o444`).
   - Snapshot collision defense (`SNAPSHOT_CONFLICT`) prevents overwriting existing snapshot files.
3. **Approval Sidecar Severance**:
   - The approval sidecar `.playbook/approval-fingerprint.json` is unlinked upon Stage 6 closure, preventing stale reuse.
4. **Schema Alignment**:
   - `schemas/project-state.schema.json` already defines `lifecycle_status: "reopened_maintenance"` and specifies the complete data structure for `archived_milestones[]`.
   - `schemas/project-manifest.schema.json` defines `active_milestone_id` and `active_lifecycle_stage`.
5. **Runtime Tooling Gap**:
   - The CLI currently lacks any command (`playbook reopen`) to trigger `REOPEN_LIFECYCLE`.
   - While `CLOSE_LIFECYCLE` populates `stage_history`, `archived_milestones[]` remains empty `[]` in `state.json` until a formal reopening operation archives the completed milestone.
   - Reopening currently requires error-prone direct JSON file editing.

---

## 3. Phase 2 — Reopening Semantics & Core Decisions

### 3.1 Lifecycle Transition Matrix
- **Permitted**: `completed_terminal` $\rightarrow$ `reopened_maintenance`.
- **Prohibited**:
  - `completed_terminal` $\rightarrow$ `active` (rejected: project has prior production releases; must indicate maintenance).
  - `active` $\rightarrow$ `reopened_maintenance` (rejected with `LIFECYCLE_NOT_TERMINAL`: project is already active).
  - `paused` $\rightarrow$ `reopened_maintenance` (rejected with `LIFECYCLE_NOT_TERMINAL`: project must resume active development).
  - `reopened_maintenance` $\rightarrow$ `reopened_maintenance` (rejected with `LIFECYCLE_ALREADY_REOPENED`: milestone already in progress).

### 3.2 Stage Continuation Strategy
- **Default Entry Stage**: **Stage 1 (Requirements & Specification)**.
  - *Rationale*: Routine maintenance (feature enhancements, bug fixes, refactoring, performance tuning) does not invalidate the foundational Problem Statement (`PRD-CORE`). Forcing agents and engineers through Stage 0 Problem Discovery creates bureaucratic friction and low-value paperwork. Engineering begins with new requirements (`REQ-SPEC`).
- **Alternative Entry Stage**: **Stage 0 (Discovery & Problem Formulation)**.
  - *Rationale*: Reserved for major strategic pivots, fundamental architecture overhauls, or brand new business models requiring a new PRD Core. Enabled via explicit `--stage 0`.
- **Prohibited Stages**: Resuming at Stage 6 (deployment) or jumping directly to Stages 2–5 (architecture, code, testing) without specifications is strictly barred.

### 3.3 Milestone Preservation Strategy
- **Mandatory Milestone Increment**: Reopening **must never** continue under the existing milestone ID. A new milestone identifier (e.g. `M-1.1.0` or `M-2.0.0`) matching `^M-[a-zA-Z0-9.-]+$` is mandatory.
- **Milestone Archival Procedure**:
  - The completed milestone currently in `state.json` is appended to `state.archived_milestones[]` along with its full 7-stage history, exit package path, and snapshot reference.
  - The previous milestone's disk snapshot (`state-M-1.0.0.json`) remains permanently preserved on disk.
  - Active `state.stage_history` is re-initialized to `[]` for the new milestone.
  - Manifest `active_milestone_id` and `active_lifecycle_stage` are updated synchronously.

### 3.4 Approval and Evidence Invalidation Boundary
- **Sidecar Cleanup**: `.playbook/approval-fingerprint.json` is verified destroyed/unlinked.
- **Stage Approval Reset**: `current_stage_detail.human_approval` is reset to `status: "not_requested"` and `stage_status: "not_started"`.
- **Evidence Freshness**: Deliverables start with `status: "not_started"` and empty `evidence: []`. Prior evidence logs in `.playbook/logs/` are historical and cannot satisfy new deliverable requirements.
- **Exceptions & RFCs**: Active RFCs and exceptions are initialized to `[]`. No prior waivers carry over automatically.

### 3.5 Human Authorization & Anti-Agent Safeguards
- **Mandatory Interactive TTY**: `playbook reopen` requires `process.stdin.isTTY === true`. Automated background scripts and headless agents are rejected with `TTY_REQUIRED`.
- **Agent Name Filtering**: Reopening authorizations claiming AI agent identities (`AI`, `Bot`, `Agent`, `Claude`, `GPT`, etc.) are rejected with `AGENT_REOPEN_PROHIBITED`.
- **Explicit Typed Confirmation Phrase**: Requires typing `CONFIRM REOPEN MILESTONE <NEW_MILESTONE_ID>`.
- **Mandatory Business Justification**: Requires non-empty `--reason` string.
- **Intellectual Honesty on Identity**: The report reiterates that TTY checks and confirmation phrases are operational execution guardrails against accidental agent self-triggering, not cryptographic proofs of human identity. Cryptographic non-repudiation is established at the Git forge layer (signed commits, branch protection, PR approvals).

---

## 4. Phase 3 — Transaction & Recovery Design

Controlled reopening integrates directly into the existing Write-Ahead Transaction Journal (`WriteAheadTransactionManager`) and lock manager (`TransactionLockManager`):

- **Action Identifier**: `"REOPEN_LIFECYCLE"`
- **Concurrency Protection**: Exclusive advisory flock on `.playbook/playbook.lock`.
- **Atomic WAL Payload**:
  1. `.playbook/state.json`: State mutation with new milestone ID, archived milestone appended, stage reset, deliverables initialized.
  2. `.playbook/manifest.json`: Manifest synchronized to new milestone ID and target stage.
- **Post-Commit Hook**: Unlinks `.playbook/approval-fingerprint.json` if present.
- **Crash Recovery**:
  - Interruption in `PREPARED`: Journal rolls back cleanly to `completed_terminal`.
  - Interruption in `COMMITTING`: Journal rolls forward to complete `reopened_maintenance`.

---

## 5. Phase 4 — CLI Interface & Contract Proposal

The design proposes a new CLI command:

```bash
playbook reopen \
  --milestone M-1.1.0 \
  --name "Q1 Maintenance and Enhancements" \
  --stage 1 \
  --authorized-by "Alice Human" \
  --role "Principal Architect" \
  --reason "Implement distributed caching and resolve performance bottleneck"
```

### Proposed Diagnostics & Failure Codes
- `LIFECYCLE_NOT_TERMINAL`: Attempting to reopen an unsealed or active project.
- `MILESTONE_ID_COLLISION`: Reusing an existing milestone ID found in `archived_milestones` or disk snapshots.
- `INVALID_REOPEN_STAGE`: Specifying an entry stage other than `0` or `1`.
- `TTY_REQUIRED`: Non-interactive headless invocation.
- `AGENT_REOPEN_PROHIBITED`: AI agent name supplied as authorizer.
- `CONFIRMATION_PHRASE_MISMATCH`: Incorrect typed confirmation phrase.
- `SNAPSHOT_MISSING`: Prior milestone snapshot file missing from `.playbook/milestones/`.

---

## 6. Phase 5 — Test Strategy Matrix

A 17-scenario test matrix is defined in [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) Section 10, categorizing test obligations into automated CLI integration tests, fault-injection tests, and manual terminal UX reviews:

- **Automated Tests (16 scenarios)**: Happy path Stage 1 reopen, Stage 0 pivot reopen, snapshot preservation, TTY rejection, agent name rejection, confirmation phrase validation, milestone collision rejection, active/paused lifecycle rejection, sidecar destruction, stale approval immunity, manifest synchronization, multi-milestone iteration, WAL prepared rollback, WAL committing roll-forward, and lock contention.
- **Manual Verification (1 scenario)**: Interactive terminal prompt UX, formatting readability, and confirmation phrase typing ergonomics.

---

## 7. Unresolved Decisions & Architectural Trade-offs

1. **Stage 1 vs. Stage 0 Defaulting**: Defaulting to Stage 1 for maintenance was selected over forcing Stage 0 to prevent artificial paperwork overhead and agent hallucinations, while explicitly keeping Stage 0 available for major pivots via `--stage 0`.
2. **Exit Package Versioning**: Retaining standard paths (`GATE-1-EXIT-PACKAGE.md`) in `state.json` while allowing teams to customize the path per milestone was selected to preserve consistency with existing schema and validation rules.
3. **Dedicated CLI Command vs. Manual State Editing**: Implementing `playbook reopen` as an atomic CLI command is strongly recommended for Task 004F.2 to eliminate the human error associated with manual JSON editing of `archived_milestones`.

---

## 8. Conclusion

The architecture design document [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) provides a comprehensive, constitutionally compliant blueprint for lifecycle reopening.

All requirements of Task 004F.1 have been satisfied without runtime code changes or schema mutations.

**Final Recommendation**: Approve design document and proceed to implementation under Task 004F.2.
