# Task 004F.2.4-B — Maintenance Stage Pivot Implementation Report

**Document ID**: `TASK-004F.2.4-B-STAGE-PIVOT-IMPLEMENTATION-REPORT`  
**Date**: 2026-11-01  
**Status**: COMPLETE / READY FOR HUMAN AUDIT  
**Governing Architecture**: `governance/maintenance-stage-pivot-design.md` v1.3.0  
**Phase A Foundation**: Commit `7bb91e6` (Upgraded `WriteAheadTransactionManager` & Storage Scaffolding)  
**Adversarial WAL Audit**: Commits `06b86f5`, `f0ab76a`  

---

## 1. Executive Summary

Task 004F.2.4-B implements the maintenance Stage 1-to-Stage 0 recovery pivot (`PIVOT_TO_STAGE_0`) specified in `governance/maintenance-stage-pivot-design.md` v1.3.0.

This implementation provides a human-authorized, transactionally verified mechanism for projects in `reopened_maintenance` mode to recover from Stage 1 to Stage 0 when an inherited Problem Statement (`docs/prd/PRD-CORE.md`) is declared `OUTDATED`.

### Key Verification Milestones
- **All 40 formal test scenarios** (T1 to T40) specified in Section 8 of the v1.3.0 governance design are implemented and passing.
- **Full regression suite passing**: 245 tests pass across 16 test suites (`npm test --prefix tooling/playbook-cli`), with 0 failures, 0 skipped, and 0 warnings.
- **Zero unjournaled filesystem mutations**: All filesystem operations (snapshot creation, audit creation, banner-prefixed PRD archival, active PRD unlinking, sidecar purging, state mutation, and manifest synchronization) occur under a single write-ahead transaction journal governed by the upgraded `WriteAheadTransactionManager`.
- **Gate 0 Negative Byte-Match Guardrail**: Gate 0 eligibility checks compare the raw SHA-256 hash of `docs/prd/PRD-CORE.md` against all historical outdated PRD hashes for the milestone, preventing silent document recycling.

---

## 2. Components Implemented

### 2.1 Core Pivot Engine (`tooling/playbook-cli/src/core/pivot.ts`)
1. **Preflight Eligibility Inspection (`checkPivotEligibility`)**:
   - Verifies target stage is strictly `0` (`PIVOT_TARGET_UNSUPPORTED`).
   - Verifies required storage layout exists: `.playbook/pivots/`, `docs/pivots/`, `docs/prd/archive/` (`PIVOT_STORAGE_LAYOUT_MISSING`).
   - Validates `.playbook/manifest.json` and `.playbook/state.json` against JSON Schemas (`PIVOT_ABORTED`).
   - Enforces preconditions:
     - **C1**: `state.lifecycle_status === "reopened_maintenance"` (`LIFECYCLE_NOT_MAINTENANCE`).
     - **C2**: `state.current_stage === 1` (`PIVOT_INVALID_STAGE`).
     - **C3**: `state.stage_status !== "approved"` and `human_approval.decision !== "GATE_APPROVED"` (`STAGE_ALREADY_APPROVED`).
     - **C4**: `docs/prd/PRD-CORE.md` exists and `evaluatePrdApplicability(...)` reports `status === "outdated"` (`PIVOT_PRD_NOT_OUTDATED`).
   - Captures an immutable `PrePromptBaseline` (state hash, manifest hash, active PRD hash, assessment path/hash/status, and sidecar status).
2. **Monotonic Sequence Discovery & Collision Avoidance (`discoverNextPivotId`)**:
   - Under transaction lock, scans three directories simultaneously:
     - `.playbook/pivots/` matching `^state-PVT-${escapedMilestone}-([0-9]{3,})\.json$`
     - `docs/pivots/` matching `^PVT-${escapedMilestone}-([0-9]{3,})\.md$`
     - `docs/prd/archive/` matching `^PRD-CORE\.PVT-${escapedMilestone}-([0-9]{3,})\.outdated\.md$`
   - Computes candidate sequence $\max(S) + 1$ (or `1` if empty) formatted as zero-padded 3-digit integer (`001`).
   - Verifies all three candidate target paths are unoccupied; advances sequence if any collision is detected.
3. **Authoritative Lock & TOCTOU Drift Revalidation**:
   - Re-reads all baseline files under `.playbook/transaction.lock`.
   - Compares current hashes and metadata against `PrePromptBaseline`. If any drift occurred during operator prompt wait, aborts with `STATE_CONCURRENTLY_MODIFIED` and zero disk mutations.
   - Revalidates C1–C6 under lock.
4. **Unified WAL Transaction Construction (`executeStagePivot`)**:
   - Computes original raw PRD hash (`sourcePrdHash`).
   - Stages write of pre-pivot state snapshot to `.playbook/pivots/state-<PVT_ID>.json` (`createOnly: true`, `readOnlyOnCommit: true`).
   - Stages write of markdown audit record to `docs/pivots/<PVT_ID>.md` (`createOnly: true`) recording all metadata, invalidation rationale, preserved deliverables, and Stage 1 RFC/ADR/exception dispositions.
   - Stages write of archived PRD to `docs/prd/archive/PRD-CORE.<PVT_ID>.outdated.md` (`createOnly: true`) with prepended governance warning banner.
   - Stages unlink of active `docs/prd/PRD-CORE.md` (`mustExist: true`, `expectedSha256: sourcePrdHash`).
   - Stages unlink of `.playbook/approval-fingerprint.json` (`mustExist: false`).
   - Stages write of re-initialized Stage 0 `.playbook/state.json` (baseline `PRD-CORE` deliverable `not_started`/`unvalidated`, `pivots[]` ledger updated, exit package clean).
   - Stages write of `.playbook/manifest.json` (`active_lifecycle_stage: 0`).
   - Prepares and commits transaction using `WriteAheadTransactionManager`.

### 2.2 CLI Command & Dispatch (`tooling/playbook-cli/src/commands/pivot.ts` & `src/bin/playbook.ts`)
- **TTY Guard**: Checks `process.stdin.isTTY`. Rejects headless, piped, or automated execution with `TTY_REQUIRED` (exit code 1).
- **Interactive Prompts**: Interactively prompts for missing options (`--authorized-by`, `--role`, `--reason`).
- **Confirmation Phrase**: Prompts for exact confirmation phrase:
  $$\texttt{"CONFIRM PIVOT TO STAGE 0 "} + \texttt{state.milestone\_id}$$
  Aborts with `PIVOT_ABORTED` on any mismatch.
- **Output Formats**: Outputs formatted human-readable terminal summary or machine-readable JSON (`--json`).
- **CLI Registration**: Registered under `playbook pivot --stage 0 [OPTIONS]` and documented in `playbook --help`.

### 2.3 State Schema Extension (Phase 2)
- Added `pivots: []` array to `schemas/project-state.schema.json` and `src/types/state.ts` with `additionalProperties: false` conforming to Section 4.7 Phase 2 of the governance design.
- Retains `stage_history` ledger integrity untouched (unapproved Stage 1 records are never inserted into `stage_history`).

### 2.4 Gate 0 Negative Byte-Match Guardrail (`tooling/playbook-cli/src/core/approval.ts`)
- In `checkGateEligibility`, when `requestedGate === 0`:
  - Inspects active `docs/prd/PRD-CORE.md` raw SHA-256 hash.
  - Compares hash against all recorded `source_prd_sha256` entries in `state.pivots` and audit records in `docs/pivots/`.
  - If identical, rejects Gate 0 approval with `PRD_CONTENT_UNALTERED`.
  - Ensures a different byte hash is required, while maintaining the boundary that true semantic freshness requires human discovery and Gate 0 sign-off.

---

## 3. Formal Test Matrix Verification (40 Scenarios)

All 40 formal test scenarios defined in `governance/maintenance-stage-pivot-design.md` Section 8 were implemented in `tooling/playbook-cli/tests/pivot.test.ts`.

| Test # | Scenario Name | Test Purpose & Invariant | Status |
| :---: | :--- | :--- | :---: |
| **T1** | Valid Stage 1-to-Stage 0 Pivot | Verifies complete successful transition, ID generation, artifacts, and manifest sync | **PASS** |
| **T2** | Pivot Rejected from Stage 2 | Enforces boundary that pivot is strictly permitted from Stage 1 | **PASS** |
| **T3** | Pivot Rejected After Gate 1 Approval | Prohibits unapproving an already approved Stage 1 requirements baseline | **PASS** |
| **T4** | Pivot Rejected for Non-Maintenance | Enforces `reopened_maintenance` restriction (`active`, `completed_terminal`, `paused`) | **PASS** |
| **T5** | Pivot Rejected without OUTDATED Assessment | Rejects if assessment is `APPLICABLE`, missing, or bound to wrong milestone | **PASS** |
| **T6** | Non-TTY Invocation Rejected | Ensures automated/headless execution is blocked with `TTY_REQUIRED` | **PASS** |
| **T7** | Incorrect Confirmation Phrase Rejected | Rejects typos or milestone mismatches in confirmation prompt | **PASS** |
| **T8** | Missing Justification Rejected | Rejects empty or whitespace-only `--reason` | **PASS** |
| **T9** | Historical Stage 1 Preservation | Snapshot matches pre-pivot state; disk artifacts preserved | **PASS** |
| **T10** | Fresh Stage 0 Initialization | Deliverables reset to `PRD-CORE` `not_started`, `evidence: []`, exit package clean | **PASS** |
| **T11** | Stale Approval Rejection | Stale Stage 1 sidecar fails Gate 0 eligibility check (`APPROVAL_FINGERPRINT_MALFORMED`) | **PASS** |
| **T12** | Transaction Interruption & Recovery | Interrupted write during `COMMITTING` phase rolls forward cleanly on recovery | **PASS** |
| **T13** | Normal Stage 0 Progression & Closure | Fresh PRD authoring, Gate 0 approval, and advancement succeed after pivot | **PASS** |
| **T14** | Concurrent Pivot Attempts (Lock Contention) | Process holding lock blocks concurrent pivot with `LOCK_HELD_BY_ACTIVE_PROCESS` | **PASS** |
| **T15** | TOCTOU State Modification Under Prompt | Concurrently modified state detected under lock; rejects with `STATE_CONCURRENTLY_MODIFIED` | **PASS** |
| **T16** | Repeated Pivot Without Historical Overwrite | Sequential pivots generate `001` then `002`; both snapshots & audits preserved | **PASS** |
| **T17** | Snapshot Staging / Write Failure | Staging failure unlinks `.tmp` files, aborts transaction, preserves Stage 1 | **PASS** |
| **T18** | Audit Document Write Failure | Write failure rolls back staged files, aborts transaction, preserves Stage 1 | **PASS** |
| **T19** | WAL Preparation Failure | Failure writing `tx-journal.json` aborts transaction, releases lock, preserves Stage 1 | **PASS** |
| **T20** | Crash Recovery with Incomplete Artifacts | Orphaned `.tmp` files left from crash are cleaned up during lock recovery | **PASS** |
| **T21** | PRD-CORE Archival & Byte-Match Guardrail | Raw PRD hash retained; Gate 0 rejects identical bytes with `PRD_CONTENT_UNALTERED` | **PASS** |
| **T22** | Historical RFC, ADR, Exception Dispositions | Stage 1 exceptions marked `invalidated_by_pivot`; RFCs superseded; Stage 0 arrays empty | **PASS** |
| **T23** | Crash Before Durable Journal | Crash before `PREPARING` durability leaves zero target staging or live-file changes | **PASS** |
| **T24** | Crash During PRD Archive and Unlink | Crash while unlinking `PRD-CORE.md` rolls forward to complete unlink and finalize Stage 0 | **PASS** |
| **T25** | PREPARED Rollback Preserves Active PRD | Crash during `PREPARED` rolls back staging temps; active `PRD-CORE.md` untouched | **PASS** |
| **T26** | Snapshot/Audit Cleanup Without Historical Loss | Cleanup removes orphaned `.tmp` without touching finalized historical snapshots | **PASS** |
| **T27** | Repeated Pivot Sequence Discovery Across 3 Dirs | Gaps across dirs detected; scanner selects monotonic max+1 sequence | **PASS** |
| **T28** | Filename-Pattern Regex Correctness | Invalid file naming patterns ignored; only canonical patterns matched | **PASS** |
| **T29** | Lock Path Consistency Verification | Lock strictly acquired and verified at `.playbook/transaction.lock` | **PASS** |
| **T30** | Manifest Path Consistency Verification | Manifest strictly read and written at `.playbook/manifest.json` | **PASS** |
| **T31** | State Drift Involving Assessment Artifact | Assessment modified from `OUTDATED` to `APPLICABLE` rejects under lock | **PASS** |
| **T32** | Hash-Different but Semantically Stale PRD | Different hash clears byte-match guardrail; semantic review left to human Gate 0 | **PASS** |
| **T33** | Sidecar Cleanup Failure Defense-in-Depth | Lingering sidecar with Gate 1 detected by Gate 0 eligibility check | **PASS** |
| **T34** | Journal-First Staging Invariant | Staging temps never created before durable `PREPARING` journal | **PASS** |
| **T35** | Crash During PREPARING | Staged temps removed during rollback; live targets untouched | **PASS** |
| **T36** | Missing Temp During COMMITTING | Missing staged temp reconstructed from durable journal content on roll-forward | **PASS** |
| **T37** | Create-Only Collision During Recovery | Unexpected collision on create-only target fails safely with `TRANSACTION_RECOVERY_REQUIRED` | **PASS** |
| **T38** | Original PRD Hash Survives Archive Banner | Pre-banner `source_prd_sha256` preserved in state/journal; Gate 0 compares against it | **PASS** |
| **T39** | Corrupt Journal Fails Closed | Corrupted journal triggers fail-closed manual triage requirement | **PASS** |
| **T40** | COMMITTED Cleanup Is Idempotent | Crash during backup deletion finishes cleanup idempotently on next recovery | **PASS** |

---

## 4. Test Suite Execution Results

```text
> @ai-engineering-playbook/cli@1.0.0 test
> node --test dist/tests/**/*.test.js

ℹ tests 245
ℹ suites 16
ℹ pass 245
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 55739.3667
```

---

## 5. Non-Negotiables and Governance Compliance Verification

1. **Human Sovereignty Preservation**: The pivot command requires an interactive terminal (`TTY_REQUIRED`), authentic claimed human identity (`AGENT_APPROVAL_PROHIBITED`), professional role, non-empty justification (`PIVOT_REASON_REQUIRED`), and exact typed phrase verification. AI agents cannot self-execute or bypass the pivot workflow.
2. **Deterministic Crash Recovery**: Rollback-safe before `COMMITTING`; roll-forward only after durable `COMMITTING` intent. Zero unjournaled filesystem side-effects.
3. **No Historical Work Destruction**: Stage 1 state snapshot is preserved under `.playbook/pivots/` with OS-level write protection (`readOnlyOnCommit: true`); audit markdown is preserved under `docs/pivots/`; the outdated Problem Statement is archived with a governance banner under `docs/prd/archive/`.
4. **Honest Freshness Guarantees**: Gate 0 automates byte-level negative checks (`PRD_CONTENT_UNALTERED`) while acknowledging that semantic freshness requires human domain discovery and Gate 0 sign-off.
5. **Preservation of Stage History Ledger**: The pivoted Stage 1 is not recorded in `stage_history` (which requires monotonic, approved gate completions); instead, historical pivots are recorded in the dedicated `pivots[]` ledger and filesystem archive.
