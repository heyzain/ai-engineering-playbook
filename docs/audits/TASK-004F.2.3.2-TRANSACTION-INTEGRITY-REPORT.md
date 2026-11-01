# Governance Audit & Architecture Report: Stage Pivot Transaction Integrity & Design Finalization

> **Document Reference**: `TASK-004F.2.3.2-TRANSACTION-INTEGRITY-REPORT.md`  
> **Status**: `DESIGN_READY_FOR_REVIEW`  
> **Task**: Task 004F.2.3.2 — Stage Pivot Transaction Integrity & Design Finalization  
> **Date**: 2026-11-01  
> **Author**: AI Engineering Playbook Architecture Group  
> **Governing Specifications**:
> - [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) v1.2.0
> - [`governance/state-machine.md`](../../governance/state-machine.md) v1.3.0
> - [`governance/lifecycle-reopening-design.md`](../../governance/lifecycle-reopening-design.md) v1.2.0
> - [`governance/downstream-storage-convention.md`](../../governance/downstream-storage-convention.md) v1.0.0

---

## 1. Executive Summary & Review Background

During architectural review of Task 004F.2.3.1, critical flaws were discovered in the transaction ordering, recovery contract, naming consistency, drift detection, and PRD freshness claims of the proposed Stage Pivot (`PIVOT_TO_STAGE_0`) architecture.

Specifically:
- The design executed destructive filesystem actions (renaming snapshot/audit files and unlinking the active PRD) *before* writing the `PREPARED` Write-Ahead Log (WAL) journal. A crash at that boundary would leave the live PRD deleted and uncommitted state files without a recovery journal.
- The snapshot sequence scanner regex was out of sync with the canonical filename pattern and only checked one directory instead of all three artifact locations.
- Path references conflicted between `.playbook/trans.lock` and `.playbook/transaction.lock`, and between `project.manifest.json` and `.playbook/manifest.json`.
- State drift detection lacked an explicit composite baseline fingerprint captured prior to human prompting.
- Automated SHA-256 hash checks were conflated with semantic freshness.

This report establishes the final, corrected architecture incorporated into [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) v1.2.0.

**In accordance with instructions, this task is strictly DESIGN ONLY. No runtime source code, CLI commands, schemas, or automated tests have been implemented.**

---

## 2. Identified Issues & Architectural Resolutions

### 2.1 Issue 1: Transaction Architecture & Premature Destructive Execution

#### Problem
In v1.1.0, the execution sequence staged snapshot and audit files, renamed them to their final paths, and unlinked `docs/prd/PRD-CORE.md` *prior* to creating the `PREPARED` WAL journal. If a crash or power failure occurred immediately after unlinking `PRD-CORE.md`, the active Problem Statement was permanently destroyed from disk while `state.json` and `manifest.json` remained at Stage 1, leaving the repository in an unrecoverable corrupted state without a WAL journal to roll back.

#### Resolution in v1.2.0
- **Unified Multi-Operation Transaction Spec (`FileOperationSpec`)**:
  The transaction manager interface is extended to support atomic writes and unlinks under a single journal:
  ```typescript
  export type FileOperationSpec =
    | { operation: "write"; targetPath: string; content: string; readOnlyOnCommit?: boolean }
    | { operation: "unlink"; targetPath: string };
  ```
- **Zero Live Mutations Before `PREPARED`**:
  All 7 operations are assembled and registered in a single WAL journal:
  1. `write`: Snapshot `.playbook/pivots/state-PVT-<M>-<SEQ>.json` (with `readOnlyOnCommit: true`)
  2. `write`: Audit document `docs/pivots/PVT-<M>-<SEQ>.md`
  3. `write`: Archived PRD `docs/prd/archive/PRD-CORE.PVT-<M>-<SEQ>.outdated.md`
  4. `unlink`: Active PRD `docs/prd/PRD-CORE.md` (backed up to `.bak.<txId>`)
  5. `write`: State `.playbook/state.json` (backed up to `.bak.<txId>`)
  6. `write`: Manifest `.playbook/manifest.json` (backed up to `.bak.<txId>`)
  7. `unlink`: Sidecar `.playbook/approval-fingerprint.json`
- **Strict Two-Phase Boundary**:
  During `PREPARE`, writes are staged to `<target>.tmp.<txId>` and existing targets are copied to `<target>.bak.<txId>`. **Not a single live file is renamed, modified, or unlinked until the journal is durably fsynced in `PREPARED` phase.**

---

### 2.2 Issue 2: Pivot Event ID Discovery & Sequence Scanner Inconsistency

#### Problem
The snapshot filename was specified as `state-PVT-<MILESTONE_ID>-<SEQ>.json`, but the sequence discovery scanner looked for `state-<MILESTONE_ID>-pivot-*.json`. Furthermore, scanning only `.playbook/pivots/` failed to account for collisions in `docs/pivots/` or `docs/prd/archive/`.

#### Resolution in v1.2.0
- **Canonical Event ID**:
  $$\texttt{PVT-}<\text{MILESTONE\_ID}>\texttt{-}<\text{SEQ}> \quad (\text{e.g. } \texttt{PVT-M-1.1.0-001})$$
- **Three-Directory Sequence Scanner**:
  Under the exclusive lock, the scanner inspects all three final target locations:
  1. `.playbook/pivots/` matching `^state-PVT-${escapedMilestone}-([0-9]{3,})\.json$`
  2. `docs/pivots/` matching `^PVT-${escapedMilestone}-([0-9]{3,})\.md$`
  3. `docs/prd/archive/` matching `^PRD-CORE\.PVT-${escapedMilestone}-([0-9]{3,})\.outdated\.md$`
- **Sequence Computation & Collision Defense**:
  Collects all sequences found across all three directories, selecting candidate $S = \max(\text{found}) + 1$. Verifies that **none** of the three candidate target paths exist on disk. If any collision exists, candidate sequence is incremented.
- **Handling Partially Existing Historical Artifacts**:
  If an un-journaled artifact exists, the engine never overwrites it, advances the sequence past it, and emits an audit diagnostic warning.

---

### 2.3 Issue 3: Inconsistent Lock, Reclaim, and Manifest Paths

#### Problem
Documentation contained conflicting references to `.playbook/trans.lock` (versus `.playbook/transaction.lock`), and `project.manifest.json` (versus `.playbook/manifest.json`).

#### Resolution in v1.2.0
All paths have been reconciled strictly to the canonical constants established in `src/constants.ts` and `governance/downstream-storage-convention.md`:
- Exclusive Lock: `.playbook/transaction.lock`
- Reclaim Lock: `.playbook/reclaim.lock`
- WAL Journal: `.playbook/tx-journal.json`
- State File: `.playbook/state.json`
- Manifest File: `.playbook/manifest.json`
- Manifest Property: `active_lifecycle_stage` (integer `0`)

---

### 2.4 Issue 4: Pre-Prompt Baseline Fingerprint & TOCTOU State Drift Detection

#### Problem
Between displaying the prompt to the human operator and acquiring the lock, minutes may elapse. If deliverables, state, or the PRD applicability assessment were modified concurrently, the pivot could execute against an invalidated premise.

#### Resolution in v1.2.0
Before presenting the prompt, the CLI captures an **Authoritative Pre-Prompt Baseline Fingerprint** composed of:
1. `state.lifecycle_status`
2. `state.milestone_id`
3. `state.current_stage`
4. `state.stage_status`
5. `state.current_stage_detail.human_approval.decision`
6. SHA-256 hash of `.playbook/state.json`
7. SHA-256 hash of `.playbook/manifest.json`
8. SHA-256 hash of `docs/prd/PRD-CORE.md`
9. SHA-256 hash of the PRD applicability assessment artifact
10. Evaluated PRD applicability status (`outdated`)

Immediately upon acquiring `.playbook/transaction.lock`, all files are re-read and the fingerprint is re-computed. If any byte or field has changed, the engine aborts with `STATE_CONCURRENTLY_MODIFIED`, releases the lock, and makes zero mutations.

---

### 2.5 Issue 5: PRD Freshness & Intellectual Honesty

#### Problem
v1.1.0 stated that comparing SHA-256 hashes against archived PRDs would prove that the Stage 0 PRD was "fresh." A hash comparison only proves that bytes differ; it cannot verify semantic validity or problem viability.

#### Resolution in v1.2.0
- **Negative Byte-Match Guardrail**: The automated check compares SHA-256 against archived PRDs strictly as a negative guardrail to reject copy-paste or unmodified text (`PRD_CONTENT_UNALTERED`).
- **Structural Conformance Check**: Automated linting asserts required section headers (Problem Statement, Non-Goals, Success Metrics).
- **Human Sovereignty for Semantic Freshness**: The specification explicitly states that **semantic freshness can only be evaluated through the human discovery process and certified at the interactive Gate 0 review (`playbook approve --gate 0`)**. Tooling makes zero claims of semantic verification.

---

### 2.6 Issue 6: Complete Artifact Recovery & Cleanup

#### Problem
Temporary `.tmp` files from aborted runs could linger or cause sequence confusion, and finalized artifacts lacked clear ownership rules during crash recovery.

#### Resolution in v1.2.0
- **Collision-Safe Temp Names**: `<target_path>.tmp.<tx_id>` and `<target_path>.bak.<tx_id>`, where `<tx_id>` includes high-resolution millisecond timestamp and UUID8.
- **Orphan Pruning**: Temporary files are unlinked **only** when no active journal claims them and the transaction lock is verified dead.
- **Finalized Immutability**: Finalized artifacts are never deleted during crash recovery.

---

### 2.7 Issue 7: State & Historical Preservation Semantics

#### Reconfirmation of Invariants
- **Pre-Pivot State**: Fully captured in `.playbook/pivots/state-<PVT_ID>.json` with OS write protection (`0o444`).
- **Stage History Integrity**: Pivoted Stage 1 is **strictly barred from `stage_history[]`** (preserving schema `enum: ["approved", "waived"]` and monotonic sequence $0 \to 1 \dots$).
- **RFC/ADR/Exception Dispositions**: All on-disk files in `docs/rfcs/`, `docs/adrs/`, `docs/exceptions/` are permanent. Stage 1 exceptions are explicitly invalidated by pivot in audit doc Section 4. Stage 0 `current_stage_detail` arrays start empty `[]`.
- **Sidecar Cleanup**: Unlinked during commit. Gate mismatch check ($1 \neq 0$) invalidates stale sidecars on disk.

---

## 3. Final Canonical Transaction Execution Sequence

```
┌────────────────────────────────────────────────────────────────────────┐
│ Canonical Pivot Execution Sequence                                     │
├────────────────────────────────────────────────────────────────────────┤
│ 1. ADVISORY PRE-CHECK: Fast-fail if not TTY or project uninitialized.  │
│ 2. CAPTURE PRE-PROMPT FINGERPRINT: Compute composite SHA-256 baseline. │
│ 3. OPERATOR PROMPT: Collect name, role, reason, confirmation phrase.   │
│ 4. ACQUIRE EXCLUSIVE LOCK: Acquire .playbook/transaction.lock.         │
│ 5. AUTHORITATIVE RE-READ & DRIFT CHECK: Re-read state, manifest, PRD,  │
│    assessment. Assert C1–C6. If baseline drifted, abort with           │
│    STATE_CONCURRENTLY_MODIFIED.                                        │
│ 6. DISCOVER UNIQUE PIVOT ID: Scan 3 directories for PVT-<M>-<SEQ>.     │
│ 7. CONSTRUCT UNIFIED TRANSACTION SPEC: Assemble 7 file operations:     │
│    - write:  .playbook/pivots/state-<PVT_ID>.json (readOnly: true)     │
│    - write:  docs/pivots/<PVT_ID>.md                                   │
│    - write:  docs/prd/archive/PRD-CORE.<PVT_ID>.outdated.md            │
│    - unlink: docs/prd/PRD-CORE.md                                      │
│    - write:  .playbook/state.json                                      │
│    - write:  .playbook/manifest.json                                   │
│    - unlink: .playbook/approval-fingerprint.json                       │
│ 8. WAL PREPARE (Phase 1):                                              │
│    - Pre-stage writes to <target>.tmp.<tx_id>                          │
│    - Pre-stage backups of existing targets to <target>.bak.<tx_id>     │
│    - Write and fsync .playbook/tx-journal.json (phase: PREPARED)       │
│ 9. WAL COMMIT (Phase 2):                                               │
│    - Update journal phase to COMMITTING and fsync                      │
│    - Rename .tmp files to live targets (apply 0o444 to snapshot)       │
│    - Safe unlink active PRD and approval sidecar                       │
│    - Update journal phase to COMMITTED and fsync                       │
│ 10. WAL FINALIZE & CLEANUP:                                            │
│    - Unlink all .bak.<tx_id> files                                     │
│    - Unlink .playbook/tx-journal.json                                  │
│    - Release .playbook/transaction.lock                                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Complete Crash Recovery Matrix

| Transaction Boundary | State on Disk at Crash | Recovery Action on Subsequent CLI Execution | Resulting State & Safety Guarantee |
| :--- | :--- | :--- | :--- |
| **Boundary 1: Crash before Step 8** (During memory assembly or before journal write) | No journal exists. `.playbook/transaction.lock` remains on disk. Staging `.tmp` files may exist. | Stale lock reclaimed. Recovery unlinks any orphaned `.tmp.<txId>` files. | **Fail-Closed**: State and all live files 100% untouched at Stage 1. Zero partial mutation. |
| **Boundary 2: Crash during Step 8** (Journal writing or fsyncing `PREPARED`) | Incomplete/corrupted journal or valid `PREPARED` journal on disk. Live files untouched; backups exist. | Transaction manager detects `PREPARED` journal. Executes **Rollback**: unlinks all `.tmp.<txId>` files, restores any modified files from `.bak.<txId>`, deletes journal, reclaims lock. | **Fail-Closed**: Project remains safely at Stage 1. `docs/prd/PRD-CORE.md` is guaranteed intact. |
| **Boundary 3: Crash during Step 9 (Phase transition to `COMMITTING`)** | Journal marked `COMMITTING`. Live files may be partially renamed/unlinked. | Transaction manager detects `COMMITTING` journal. Executes **Roll-Forward**: ensures all 5 write targets exist with exact `target_content`, ensures active PRD and sidecar are unlinked, transitions journal to `COMMITTED`. | **Consistency Guaranteed**: Atomic forward completion. Project reliably transitions to Stage 0. |
| **Boundary 4: Crash after state write but before manifest write** | `state.json` is Stage 0; `manifest.json` is Stage 1; journal is `COMMITTING`. | Transaction manager detects `COMMITTING` journal. Executes **Roll-Forward**: writes `manifest.json` from journal target content, ensuring both files are synchronized to Stage 0. | **Consistency Guaranteed**: Eliminates state-manifest drift. Both synchronized to Stage 0. |
| **Boundary 5: Crash after writes, before unlinking active PRD** | State and manifest committed; active PRD not yet unlinked; journal is `COMMITTING`. | Transaction manager detects `COMMITTING` journal. Executes **Roll-Forward**: unlinks `docs/prd/PRD-CORE.md`, marks `COMMITTED`, unlinks backups and journal. | **Consistency Guaranteed**: Prevents obsolete PRD from lingering in active path. |
| **Boundary 6: Crash during Step 10 (Sidecar Unlink or Finalize)** | All writes and unlinks finished; journal marked `COMMITTED` or backup unlinking in progress. | Transaction manager unlinks remaining `.bak.<txId>` files and unlinks `tx-journal.json`. If sidecar unlinking was interrupted, `checkGateEligibility` detects gate mismatch ($1 \neq 0$), rejecting the sidecar with `APPROVAL_FINGERPRINT_MALFORMED`. | **Zero Security Drift**: Stale sidecar cannot authorize Stage 0. |

---

## 5. Canonical Paths Reference Table

| Role | Canonical Path | Schema / Standard Reference |
| :--- | :--- | :--- |
| **Exclusive Transaction Lock** | `.playbook/transaction.lock` | `DEFAULT_PATHS.transactionLockFile` |
| **Stale Lock Reclamation Lock**| `.playbook/reclaim.lock` | `DEFAULT_PATHS.reclaimLockFile` |
| **Write-Ahead Log Journal** | `.playbook/tx-journal.json` | `DEFAULT_PATHS.transactionJournalFile` |
| **Canonical Project State** | `.playbook/state.json` | `schemas/project-state.schema.json` |
| **Canonical Project Manifest** | `.playbook/manifest.json` | `schemas/project-manifest.schema.json` |
| **Approval Fingerprint Sidecar** | `.playbook/approval-fingerprint.json` | `DEFAULT_PATHS.approvalFingerprintFile` |
| **Historical Pivot Snapshots** | `.playbook/pivots/state-<PVT_ID>.json` | `governance/maintenance-stage-pivot-design.md` |
| **Governance Pivot Audit Docs** | `docs/pivots/<PVT_ID>.md` | `governance/maintenance-stage-pivot-design.md` |
| **Archived Outdated PRDs** | `docs/prd/archive/PRD-CORE.<PVT_ID>.outdated.md` | `governance/maintenance-stage-pivot-design.md` |

---

## 6. Updated Test Matrix (33 Scenarios)

> [!IMPORTANT]
> **Distinction Between Design Test Cases and Executed Tests**:
> - **Executed Tests (Regression Sanity)**: 187 automated unit/integration tests currently run and pass in `tooling/playbook-cli` covering baseline commands.
> - **Design Test Matrix (Scenarios T1–T33)**: Formal design specifications defining the automated tests to be authored in Task 004F.2.4 when runtime implementation begins.

| Scenario ID | Name | Invariants & Coverage |
| :---: | :--- | :--- |
| **T1** | Valid Stage 1-to-Stage 0 Pivot | Happy path: event ID, snapshot, audit doc, PRD archived, manifest synced. |
| **T2** | Pivot Rejected from Stage 2 | Rejection from Stage 2 (`PIVOT_INVALID_STAGE`). |
| **T3** | Pivot Rejected After Gate 1 Approval | Rejection when Gate 1 approved (`STAGE_ALREADY_APPROVED`). |
| **T4** | Pivot Rejected for Non-Maintenance | Rejection for `active` or `completed_terminal` (`LIFECYCLE_NOT_MAINTENANCE`). |
| **T5** | Pivot Rejected without OUTDATED Assessment | Rejection if assessment is `APPLICABLE`, `MISSING`, or mismatched. |
| **T6** | Non-TTY Invocation Rejected | Strict interactive TTY enforcement (`TTY_REQUIRED`). |
| **T7** | Incorrect Confirmation Phrase Rejected | Typo or wrong milestone ID aborts (`PIVOT_ABORTED`). |
| **T8** | Missing Justification Rejected | Empty `--reason` rejects with `PIVOT_REASON_REQUIRED`. |
| **T9** | Historical Stage 1 Preservation | Snapshot matches pre-pivot state; disk files preserved. |
| **T10** | Fresh Stage 0 Initialization | `PRD-CORE` initialized as `not_started`, zero evidence, exit package clean. |
| **T11** | Stale Approval Rejection | Gate mismatch rejects stale sidecars (`APPROVAL_FINGERPRINT_MALFORMED`). |
| **T12** | Transaction Interruption & Recovery | Simulated crash during `COMMITTING` rolls forward cleanly. |
| **T13** | Normal Progression & Closure | Milestone completes Gate 0, advances 0 $\to$ 1..6, seals at Stage 6. |
| **T14** | Concurrent Pivot Attempts (Lock Contention) | Process B times out and rejects with `LOCK_HELD_BY_ACTIVE_PROCESS`. |
| **T15** | TOCTOU State Modification Under Prompt | Pre-prompt baseline drift detected; rejects with `STATE_CONCURRENTLY_MODIFIED`. |
| **T16** | Repeated Pivot Without Historical Overwrite | Pivot 1 and Pivot 2 co-exist side-by-side (`PVT-001`, `PVT-002`). |
| **T17** | Snapshot Staging / Write Failure | Disk failure during staging triggers rollback; state remains at Stage 1. |
| **T18** | Audit Document Write Failure | Disk failure during audit write triggers rollback; state remains at Stage 1. |
| **T19** | WAL Preparation Failure | Error creating journal aborts transaction fail-closed. |
| **T20** | Crash Recovery with Incomplete Artifacts | Orphaned `.tmp` files pruned during recovery without touching finalized files. |
| **T21** | PRD-CORE Archival & Freshness Enforcement | Active PRD unlinked; attempted Gate 0 with old hash rejected. |
| **T22** | Historical RFC/ADR/Exception Dispositions | Audit doc records dispositions; Stage 1 exceptions marked `invalidated_by_pivot`. |
| **T23** | Crash After Staging, Before WAL Prepare | Live files 100% untouched; staging cleaned up; remains at Stage 1. |
| **T24** | Crash During PRD Archive and Unlink | Crash in `COMMITTING` rolls forward, completing archive and unlink. |
| **T25** | Rollback Restoring Original Active PRD | Crash during `PREPARED` restores active `PRD-CORE.md` safely. |
| **T26** | Snapshot/Audit Cleanup Without Historical Loss | Cleanup removes `.tmp` without modifying finalized `state-PVT-001.json`. |
| **T27** | Repeated Sequence Discovery Across 3 Dirs | Gaps in sequence numbers across dirs correctly resolved to max + 1. |
| **T28** | Filename-Pattern Regex Correctness | Non-canonical files ignored; only valid patterns increment sequence. |
| **T29** | Lock Path Consistency Verification | Exclusive lock asserted strictly at `.playbook/transaction.lock`. |
| **T30** | Manifest Path Consistency Verification | Manifest asserted strictly at `.playbook/manifest.json`. |
| **T31** | State Drift Involving Assessment Artifact | Assessment modified during prompt triggers `STATE_CONCURRENTLY_MODIFIED`. |
| **T32** | Hash-Different but Semantically Stale PRD | Automated hash check passes, but human reviewer rejects at Gate 0. |
| **T33** | Sidecar Cleanup Failure Defense-in-Depth | Crash leaving sidecar is neutralized by gate mismatch guard ($1 \neq 0$). |

---

## 7. Remaining Limitations & Explicitly Unsupported Guarantees

1. **Asserted Identity Boundary**: Human identity is asserted through interactive TTY prompts; the CLI does not authenticate physical biometric or cryptographic identity.
2. **Local Workstation Boundary**: Transaction and lock guarantees protect against concurrent local processes on the same machine. Multi-machine network filesystems (NFS/CIFS) are unsupported.
3. **No Automatic PRD Authoring**: The pivot transition resets the problem formulation to Stage 0; it does **not** author `PRD-CORE.md`. Human and agent authoring must occur explicitly.
4. **No Semantic Verification by Tooling**: Automated checks compare SHA-256 hashes to detect identical files and verify schema sections. Tooling explicitly does **not** assert that a PRD is semantically sound or viable. That judgment belongs exclusively to human review.

---

## 8. Files Changed & Verification

- `governance/maintenance-stage-pivot-design.md` (Updated to v1.2.0)
- `docs/audits/TASK-004F.2.3.1-DESIGN-INTEGRITY-REPORT.md` (Updated cross-references)
- `docs/audits/TASK-004F.2.3.2-TRANSACTION-INTEGRITY-REPORT.md` (Created)

**Sanity Regression Check**: Full CLI test suite executed (`npm test --prefix tooling/playbook-cli`). All **187 unit/integration tests passed** with 0 regressions.

**Completion Status**: `DESIGN_READY_FOR_REVIEW` (awaiting human architectural sign-off before runtime implementation).
