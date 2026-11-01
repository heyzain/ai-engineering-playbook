# Architecture Review & Design Integrity Audit Report: Task 004F.2.3.1

> **Document Reference**: `TASK-004F.2.3.1-DESIGN-INTEGRITY-REPORT.md`  
> **Status**: `DESIGN_READY_FOR_REVIEW`  
> **Task**: Task 004F.2.3.1 — Stage Pivot Design Integrity Corrections  
> **Date**: 2026-11-01  
> **Author**: AI Engineering Playbook Architecture Group  
> **Governing Specifications**:
> - [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) v1.2.0
> - [`governance/state-machine.md`](../../governance/state-machine.md) v1.3.0
> - [`governance/lifecycle-reopening-design.md`](../../governance/lifecycle-reopening-design.md) v1.2.0

---

## 1. Executive Summary & Review Findings

Following the human architectural review of Task 004F.2.3 (`PIVOT_TO_STAGE_0`), seven design issues were identified that required correction prior to runtime implementation. 

This audit report documents the formal resolution of each issue in [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) v1.1.0:

1. **Transaction Lock Ordering & TOCTOU Elimination**: Precondition evaluation has been restructured into an advisory pre-check and an authoritative validation executed exclusively under the transaction lock.
2. **Canonical Unique Pivot Identity**: Introduced the `PVT-<MILESTONE_ID>-<SEQ>` event naming convention with collision defense and multi-pivot support within the same milestone.
3. **Artifact Staging & WAL Recovery Boundary Analysis**: Added atomic staging (`.tmp.<PID>`), partial artifact cleanup, and boundary-by-boundary crash recovery semantics.
4. **PRD-CORE Archival & Freshness Enforcement**: Mandated moving the outdated PRD to `docs/prd/archive/PRD-CORE.<PIVOT_ID>.outdated.md` with an archival warning banner and unlinking the active path, ensuring fresh authoring in Stage 0.
5. **RFC, ADR, and Exception Dispositions**: Clarified that on-disk records are permanent, Stage 1 exceptions are explicitly invalidated by pivot, and stage-detail arrays are cleanly scoped for Stage 0.
6. **Terminology & Schema Alignment**: Corrected `manifest.active_lifecycle` to `active_lifecycle_stage`, replaced claims of filesystem immutability with operating-system write protection (`0o444`), and clarified working-tree Git status.
7. **Expanded Test Matrix**: Expanded the test design from 13 to 22 comprehensive automated scenarios.

**This task is strictly DESIGN ONLY. No runtime code, CLI commands, schemas, or automated tests have been implemented.**

---

## 2. Detailed Audit Resolutions

### 2.1 Correction 1: Transaction Lock Ordering & Race Elimination

#### Issue Identified
In v1.0.0, preconditions C1–C6 were checked before acquiring `.playbook/transaction.lock`. If state was modified (e.g. Gate 1 was approved or another process advanced the milestone) while the operator was responding to the interactive confirmation prompt, a Time-Of-Check to Time-Of-Use (TOCTOU) race occurred, allowing the pivot to execute against stale assumptions.

#### Resolution in v1.1.0
- **Two-Stage Check Protocol**:
  1. *Advisory Pre-Check (Pre-Prompt)*: Non-locking, read-only validation to fast-fail if the terminal is non-interactive (`TTY_REQUIRED`) or if the project is not in `reopened_maintenance`.
  2. *Interactive Prompt*: Operator supplies authorizer, role, reason, and types the confirmation phrase.
  3. *Exclusive Lock Acquisition*: The engine acquires `.playbook/transaction.lock`. If held by another active process, it retries with exponential backoff up to 10 seconds before failing closed with `LOCK_HELD_BY_ACTIVE_PROCESS`.
  4. *Authoritative Re-Read & Validation (Under Lock)*: Under the lock, the engine freshly reads `state.json`, `manifest.json`, and evaluates `evaluatePrdApplicability()`. If state drifted during the prompt (e.g. `current_stage !== 1` or `stage_status === 'approved'`), the transaction aborts with `STATE_CONCURRENTLY_MODIFIED` with zero disk mutations.

---

### 2.2 Correction 2: Unique Pivot Event Identity & Repeated Pivots

#### Issue Identified
v1.0.0 relied on loosely formatted timestamp strings (`state-<milestone_id>-stage-1-<timestamp>.json`), lacked collision handling, and did not explicitly specify how multiple pivots within the same milestone are isolated.

#### Resolution in v1.1.0
- **Canonical Pattern**:
  $$\texttt{PVT-}<\text{MILESTONE\_ID}>\texttt{-}<\text{SEQ}>$$
  Example: `PVT-M-1.1.0-001`.
- **Sequence Discovery & Immutability**:
  Under the transaction lock, `.playbook/pivots/` is scanned for existing records matching `state-<MILESTONE_ID>-pivot-*.json`. The highest sequence number $N$ is incremented to $N+1$.
- **Collision Defense**:
  If any calculated path already exists, the sequence is automatically advanced. If a collision cannot be safely disambiguated without overwriting, the operation aborts with `PIVOT_EVENT_ID_COLLISION`. Existing pivot records are **never overwritten**.
- **Repeated Pivot Support**:
  If a project pivots to Stage 0 (`PVT-M-1.1.0-001`), re-enters Stage 1, and again finds its PRD outdated, it can legitimately execute a second pivot (`PVT-M-1.1.0-002`). Both snapshots, audit documents, and archived PRDs co-exist permanently.

---

### 2.3 Correction 3: Artifact Staging & WAL Recovery Boundaries

#### Issue Identified
v1.0.0 lacked explicit failure semantics for partial file writes when creating snapshots or audit documents, creating a risk that incomplete files could be mistaken for committed pivots.

#### Resolution in v1.1.0
- **Atomic File Staging**:
  All generated artifacts are written first to process-isolated staging paths:
  - Snapshot: `.playbook/pivots/state-<PIVOT_ID>.json.tmp.<PID>`
  - Audit doc: `docs/pivots/<PIVOT_ID>.md.tmp.<PID>`
  - Archived PRD: `docs/prd/archive/PRD-CORE.<PIVOT_ID>.outdated.md.tmp.<PID>`
  Only after write and flush succeed are files atomically renamed via `fs.renameSync`.
- **Boundary Failure Matrix**:
  - *Failure during staging*: Staging `.tmp` files are immediately unlinked, lock is released, state remains at Stage 1.
  - *Interruption during `PREPARED` WAL phase*: Recovery roll-back deletes journal, cleans up staging files, leaves project at Stage 1.
  - *Interruption during `COMMITTING` WAL phase*: Recovery rolls forward, atomically overwriting `state.json` and `manifest.json` to complete the pivot to Stage 0.
  - *Stale file reconciliation*: Any lingering `.tmp.<PID>` files in `.playbook/pivots/` or `docs/pivots/` from a previous crash are pruned automatically during subsequent lock recovery.

---

### 2.4 Correction 4: PRD-CORE Historical Preservation & Fresh Stage 0 Authoring

#### Issue Identified
v1.0.0 left `docs/prd/PRD-CORE.md` in place on disk. An AI agent entering Stage 0 could inspect the directory, see `PRD-CORE.md`, and mistakenly treat the obsolete document as the newly authored problem statement.

#### Resolution in v1.1.0
- **Archival to Historical Path**:
  The outdated `docs/prd/PRD-CORE.md` is copied to `docs/prd/archive/PRD-CORE.<PIVOT_ID>.outdated.md`. A prominent warning alert is prepended:
  ```markdown
  > [!WARNING]
  > **ARCHIVED & OUTDATED PROBLEM STATEMENT**
  > This document was declared OUTDATED during Stage 1 under Pivot Event <PIVOT_ID>.
  > It is preserved strictly for audit and historical context. It is NOT the active problem statement.
  ```
- **Active Path Removal**:
  The file at `docs/prd/PRD-CORE.md` is removed/unlinked from the active path.
- **Fresh Authoring Mandate**:
  Upon entering Stage 0, `fs.existsSync("docs/prd/PRD-CORE.md")` returns `false`. Deliverable `PRD-CORE` is initialized as `status: "not_started"`, `validation_status: "unvalidated"`, with empty `evidence: []`. Gate 0 approval checks will verify that the new file exists, contains fresh non-placeholder content, and does not have the SHA-256 hash of the archived outdated version.

---

### 2.5 Correction 5: RFC, ADR, and Exception Dispositions

#### Issue Identified
v1.0.0 reset `rfcs`, `adrs`, and `exceptions` arrays in `current_stage_detail` without explaining how historical records are preserved and disposed.

#### Resolution in v1.1.0
- **Permanent On-Disk Artifacts**:
  Markdown files in `docs/rfcs/`, `docs/adrs/`, and `governance/exceptions/` are permanent project assets tracked by Git. The CLI never unlinks or deletes them.
- **Snapshot Preservation**:
  The pre-pivot snapshot `.playbook/pivots/state-<PIVOT_ID>.json` preserves the complete Stage 1 `current_stage_detail` including all RFCs, ADRs, and Exceptions.
- **Explicit Dispositions in Audit Document**:
  `docs/pivots/<PIVOT_ID>.md` contains a dedicated Section 4 enumerating dispositions:
  - *Exceptions*: Marked `invalidated_by_pivot`. Exceptions granted for Stage 1 requirements have zero standing in Stage 0.
  - *RFCs*: Marked `superseded_by_pivot` or flagged for re-review in Stage 0.
  - *ADRs*: Preserved on disk; architectural decisions flagged for re-evaluation against the new Stage 0 problem formulation.
- **Stage Scoping**:
  In `state.current_stage_detail`, arrays are initialized empty `[]` for Stage 0, following the standard lifecycle scoping convention in `advancement.ts`.

---

### 2.6 Correction 6: Terminology and Schema Alignment

#### Issue Identified
- Mention of `manifest.active_lifecycle` conflicted with the manifest schema property `active_lifecycle_stage`.
- Claims of "filesystem immutability" overstated the protection provided by POSIX permissions.
- The phrase "committed markdown record" could be misinterpreted as the CLI executing `git commit`.

#### Resolution in v1.1.0
- Standardized manifest references to `active_lifecycle_stage` across all specifications.
- Replaced "filesystem immutability" with technically accurate terminology: **operating-system file write protection** (`0o444` on POSIX / read-only attribute on Windows).
- Clarified that writing snapshot and audit files writes them to the local working directory. Committing files to version control remains under explicit human developer authority via `git add` and `git commit`.

---

### 2.7 Correction 7: Expanded Test Matrix

#### Resolution in v1.1.0
Expanded the verification test matrix from 13 to 22 explicit scenarios:
- **T1–T13**: Core baseline scenarios (happy path, stage boundaries, unapproved guards, non-maintenance rejection, assessment checks, TTY enforcement, confirmation phrase, missing justification, historical preservation, fresh initialization, sidecar invalidation, WAL recovery, lifecycle closure).
- **T14**: Concurrent pivot attempts (lock contention timeout).
- **T15**: TOCTOU state modification during prompt wait.
- **T16**: Repeated pivot within the same milestone without overwriting historical records.
- **T17**: Snapshot staging and write failure rollback.
- **T18**: Audit document write failure rollback.
- **T19**: WAL preparation failure fail-closed behavior.
- **T20**: Crash recovery with incomplete `.tmp` staging artifacts.
- **T21**: PRD-CORE archival and fresh authoring enforcement (hash collision rejection).
- **T22**: Historical RFC, ADR, and Exception dispositions and exception invalidation.

---

## 3. Regression & Tooling Check

As a sanity check, the existing Playbook CLI test suite was executed against the current codebase:
- **Test Command**: `npm test --prefix tooling/playbook-cli`
- **Results**: **187 tests passed, 0 failed, 14 test suites**.
- **Confirmation**: No runtime code was modified; all existing functionality remains intact.

---

## 4. Conclusion & Handshake Status

All seven review items have been resolved and incorporated into [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) (v1.2.0) and finalized in [`docs/audits/TASK-004F.2.3.2-TRANSACTION-INTEGRITY-REPORT.md`](TASK-004F.2.3.2-TRANSACTION-INTEGRITY-REPORT.md).

**Final Status**: `DESIGN_READY_FOR_REVIEW`  
The design is ready for human architectural sign-off prior to scheduling runtime implementation in Task 004F.2.4.
