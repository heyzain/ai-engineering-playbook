# Task 004F.2.4-A Implementation & Verification Report: WAL Engine & Storage Scaffolding Upgrade

> **Author**: Antigravity (AI Engineering Agent)  
> **Date**: 2026-11-01  
> **Task Scope**: Phase A ONLY — WAL Engine & Storage Scaffolding Upgrade  
> **Approved Design Reference**: `governance/maintenance-stage-pivot-design.md` v1.3.0  
> **Status**: COMPLETED & VERIFIED (Zero Regressions)

---

## 1. Executive Summary

This report documents the completion of **Task 004F.2.4-A**, upgrading the Write-Ahead Transaction Engine (`WriteAheadTransactionManager`) and storage scaffolding in `@ai-engineering-playbook/cli`. The upgrade implements the exact transaction guarantees, multi-operation specifications, crash recovery rules, and storage layout required by the approved Stage Pivot Governance Design v1.3.0 (`governance/maintenance-stage-pivot-design.md`).

In strict compliance with the task instructions:
- **Phase A ONLY**: Neither `playbook pivot`, `pivot.ts`, `commands/pivot.ts`, nor any Stage Pivot business logic was implemented in this task.
- **Zero Regressions**: All 187 existing automated tests pass without modification.
- **Comprehensive Verification**: 11 new automated test scenarios verify every new transaction phase, operation type, fault injection hook, crash recovery boundary, and scaffolding method. The CLI test suite now passes **198 tests across 15 test suites**.

---

## 2. Forensic Invariant Implementations

### 2.1 Transaction Phase Extension (`PREPARING`)
- **Phase Union**: `TransactionPhase` in `src/core/transaction/types.ts` is now defined as:
  $$\text{TransactionPhase} = \texttt{"PREPARING"} \mid \texttt{"PREPARED"} \mid \texttt{"COMMITTING"} \mid \texttt{"COMMITTED"}$$
- **Journal Parser Compatibility**: `parseJournal` in `src/core/transaction/journal.ts` accepts `PREPARING` alongside existing phases. Any unrecognized phase or malformed JSON continues to fail closed (`readJournal().isCorrupted: true`).
- **Crash Recovery Contract**:
  - Both `PREPARING` and `PREPARED` phases are rollback-safe. Recovery verifies that no live target files were modified, deletes transaction-owned `.tmp` files and `.bak` files, safely restores original files if divergence is detected, and removes the journal.

### 2.2 Journal-First Staging Invariant
Prior to this task, `prepare()` staged `.tmp` and `.bak` files before writing the journal. In accordance with Section 6.2 and Section 7.1 of Design v1.3.0, the staging order was inverted:
1. **Pre-Staging Validation**: Candidate paths are validated against canonical project containment; initial hashes and presence are captured.
2. **Durable Journal in `PREPARING`**: `tx-journal.json` is durably written to disk in phase `PREPARING` with complete file specifications and full serialized `target_content`.
3. **Staging File Creation**: Temporary staging files (`<target>.tmp.<tx_id>`) are created **only after** the `PREPARING` journal is durable and fsynced.
4. **Transition to `PREPARED`**: After all staged files are fsynced and their hashes verified, the journal transitions to `PREPARED`.
5. **Target Invariant**: No live target file is renamed, overwritten, or unlinked in either `PREPARING` or `PREPARED`.

### 2.3 Multi-Operation Transaction Support (`FileOperationSpec`)
The transaction engine now supports atomic execution of mixed write and unlink operations:
- **Discriminated Union**:
  ```typescript
  export type FileOperationSpec = FileWriteSpec | FileUnlinkSpec;
  ```
- **Write Operations (`FileWriteSpec`)**:
  - `createOnly: boolean`: If target already exists at `prepare()`, rejects immediately with `TARGET_ALREADY_EXISTS`. If target is created externally prior to commit, commit aborts with `EXTERNAL_TARGET_MODIFIED`.
  - `expectedPreviousSha256?: string`: Validates that the pre-existing target file matches the expected pre-prompt hash, defending against TOCTOU drift.
  - `readOnlyOnCommit?: boolean`: Sets file permissions to `0o444` upon successful commit, providing OS-level write protection for snapshot files (`state-PVT-*.json`).
- **Unlink Operations (`FileUnlinkSpec`)**:
  - `mustExist?: boolean`: When `false`, an absent target is treated as a safe no-op. When `true` (default), absence fails closed.
  - `expectedSha256?: string`: Validates target hash before unlinking.
  - **Commit Behavior**: During `COMMITTING`, existing targets are safely moved to `<target>.bak.<tx_id>` before final removal.
- **Backward Compatibility**: Existing callers passing objects without an `operation` property (`FileWriteSpec`) are transparently normalized to `operation: "write"`.

### 2.4 Durable Recovery & Roll-Forward Guarantees
- **Durable Target Content Reconstruction**: If a staged temporary file is missing during `COMMITTING` roll-forward (e.g. lost during an ungraceful system power interruption), `recover()` reconstructs the staging file from `file.target_content` in the journal, verifies the hash, and completes the roll-forward.
- **Create-Only Collision Defense (B9)**: If an unexpected file appears at a create-only target path during `COMMITTING` roll-forward with mismatched hash, `recover()` refuses to overwrite or destroy the artifact and halts in a recoverable state with `TRANSACTION_RECOVERY_REQUIRED` for human triage.
- **Unlink Crash Recovery**: If a crash occurs during target unlinking, `recover()` in `COMMITTING` ensures the target is safely removed and parent directories are fsynced.
- **Idempotent Cleanup (B10)**: The `cleanupJournalDurable` and `cleanupTransactionFiles` routines handle cleanup idempotently. If interrupted after `COMMITTED`, subsequent invocations verify post-conditions and purge leftover backups without re-applying mutations.
- **Cross-Platform Read-Only Deletion**: `safeUnlink` in `fs-utils.ts` handles Windows `EPERM`/`EACCES` on read-only files by temporarily granting write permission (`0o666`) before unlinking, ensuring clean rollback of write-protected files.

---

## 3. Storage Scaffolding Extensions

### 3.1 Canonical Paths (`constants.ts`)
The following canonical storage paths defined in Design v1.3.0 were added to `DEFAULT_PATHS`:
- `pivotsDir: ".playbook/pivots"`
- `docsPivotsDir: "docs/pivots"`
- `prdArchiveDir: "docs/prd/archive"`

### 3.2 Project Scaffolder (`scaffold.ts`)
- **Initialization**: `ProjectScaffolder.scaffold()` now provisions `.playbook/pivots/`, `docs/prd/archive/`, and `docs/pivots/` along with `.gitkeep` files during initial downstream project scaffolding.
- **Storage Layout Provisioning (`ensureStorageLayout`)**: Added non-destructive method `ensureStorageLayout(targetDir: string, createGitkeeps = false)`:
  - Verifies presence of all canonical directories.
  - Recursively creates missing directories without touching existing files.
  - Does not require or validate `manifest.json` or `state.json`, allowing safe layout provisioning on initialized downstream projects.

---

## 4. Verification & Test Evidence

### 4.1 Test Execution Summary
Automated tests were executed using Node.js built-in test runner across the entire CLI package:
```text
npm test --prefix tooling/playbook-cli
```
**Results**:
- **Total Test Suites**: 15 suites (14 baseline + 1 new suite)
- **Total Tests**: 198 tests (187 baseline + 11 new tests)
- **Passed**: 198 tests (100%)
- **Failed**: 0
- **Regressions**: 0

### 4.2 New Test Suite: `transaction-engine-v130.test.ts`
The dedicated test suite covers the following invariants:
1. **Invariant 1 (`failAfterJournalPreparing`)**: Verifies journal exists in `PREPARING` phase on crash, zero `.tmp` files exist on disk, and rollback recovery cleans up journal cleanly.
2. **Invariant 2 (`failAfterStagingBeforePrepared`)**: Verifies crash after staging files leaves journal in `PREPARING` with `.tmp` files present, and rollback recovery purges `.tmp` files and journal without touching live targets.
3. **Invariant 3 (`createOnly`)**: Verifies `createOnly: true` rejects overwrite of existing target with `TARGET_ALREADY_EXISTS`.
4. **Invariant 4 (`expectedPreviousSha256`)**: Verifies hash verification on existing files rejects drift with `EXTERNAL_TARGET_MODIFIED` and accepts matching hashes.
5. **Invariant 5 (`readOnlyOnCommit`)**: Verifies `readOnlyOnCommit: true` sets `0o444` write protection on target files.
6. **Invariant 6 (`FileUnlinkSpec`)**: Verifies unlinking of existing files with expected hash and safe no-op handling for absent optional files (`mustExist: false`).
7. **Invariant 7 (Missing `.tmp` in `COMMITTING`)**: Simulates deletion of `.tmp` staging file after entering `COMMITTING`; verifies `recover()` reconstructs temporary file from durable journal `target_content` and successfully rolls forward.
8. **Invariant 8 (Unlink crash in `COMMITTING`)**: Simulates crash during unlink (`failDuringUnlinkCommit`); verifies `recover()` completes unlink and marks transaction `COMMITTED`.
9. **Invariant 9 (Create-only collision in `COMMITTING`)**: Simulates unexpected rogue file appearing at create-only target during `COMMITTING`; verifies `recover()` preserves artifact and fails closed with `TRANSACTION_RECOVERY_REQUIRED`.
10. **Storage Scaffolding Provisioning**: Verifies `ProjectScaffolder.scaffold()` creates `.playbook/pivots`, `docs/prd/archive`, and `docs/pivots` with `.gitkeep` files.
11. **Non-Destructive Layout Verification**: Verifies `ensureStorageLayout()` detects missing directories in existing projects and creates them non-destructively.

---

## 5. Non-Negotiables, Trust Boundaries & Limitations

1. **Phase A Boundary**: No CLI command (`playbook pivot`) or business logic (`src/core/pivot.ts`) was authored. Phase A strictly established the transaction and storage foundations.
2. **Asserted vs Cryptographic Identity**: Identity tracking remains asserted per v1.3.0 Section 3.3. Phase A did not introduce external authentication mechanisms.
3. **Operating System Permission Semantics**: `readOnlyOnCommit` applies `0o444` chmod. On POSIX filesystems, this strips write bits; on Windows NTFS, Node.js maps this to `FILE_ATTRIBUTE_READONLY`. This provides protection against accidental mutation, but root/administrative processes can still override permissions.
4. **Directory Fsync Semantics**: On POSIX, directory descriptors are fsynced; on Windows NTFS, directory entry durability is deferred to NTFS metadata journaling as documented in `fs-utils.ts`.

---

## 6. Readiness for Phase B

Phase A is complete. The transaction engine and storage scaffolding fully satisfy the contractual prerequisites of `governance/maintenance-stage-pivot-design.md` v1.3.0. The repository is ready for Phase B: implementation of `src/core/pivot.ts`, `src/commands/pivot.ts`, and the 40 formal test scenarios.
