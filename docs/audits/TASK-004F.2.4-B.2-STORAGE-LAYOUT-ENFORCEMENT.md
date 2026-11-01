# Task 004F.2.4-B.2 — Pivot Storage Layout Enforcement Report

> **Author**: Antigravity (AI Engineering Agent)  
> **Date**: 2026-11-01  
> **Target Subsystem**: Stage Pivot Engine & Write-Ahead Transaction Manager  
> **Governing Architecture**: `governance/maintenance-stage-pivot-design.md` v1.3.0 (Section 4.1, 6.1)  
> **Preceding Audits**: `TASK-004F.2.4-B.1` (Commit `fa5c937`), `TASK-004F.2.4-B.1.1` (Commit `29f4dc4`)  
> **Test Suite**: 254 passing tests across 17 test suites (`tooling/playbook-cli`), 0 failures, 0 warnings.  
> **Final Status**: **S1 DESIGN DEVIATION RESOLVED — VERDICT: PASS**

---

## 1. Executive Summary & Objective

In Task 004F.2.4-B.1.1, an architectural audit identified a design deviation regarding Requirement S1:
> *"Required parent directories (`.playbook/pivots/`, `docs/pivots/`, and `docs/prd/archive/`) must exist before the pivot transaction starts. `playbook init` must provision them; an existing project missing any directory fails preflight with `PIVOT_STORAGE_LAYOUT_MISSING`. Directory creation is not an unjournaled side effect of pivot execution."* (Design v1.3.0 Section 6.1)

Although `checkPivotEligibility` performed an advisory preflight directory check, two architectural vulnerabilities existed:
1. **Lack of Under-Lock Enforcement**: The storage layout was not re-validated after acquiring the exclusive transaction lock, leaving a Time-Of-Check-To-Time-Of-Use (TOCTOU) gap if a directory was removed while prompting the operator.
2. **Unjournaled Fallback Directory Creation**: `WriteAheadTransactionManager.prepare()` contained an unconditional `fs.mkdirSync(tmpDir, { recursive: true })` fallback during temporary file staging, meaning an unprovisioned directory could be created silently as an unjournaled side effect.
3. **No Automated Test Coverage**: None of the 40 original tests in `pivot.test.ts` exercised `PIVOT_STORAGE_LAYOUT_MISSING`.

Task 004F.2.4-B.2 resolves this deviation across the core engine, transaction manager, and test suites.

---

## 2. Technical Architecture & Implementation Details

### 2.1 Explicit Identification of Required Pivot Storage Directories
All directories required for Stage Pivot are canonically exported in `src/core/pivot.ts`:
```typescript
export const REQUIRED_PIVOT_DIRECTORIES = [
  DEFAULT_PATHS.pivotsDir,      // ".playbook/pivots"
  DEFAULT_PATHS.docsPivotsDir,  // "docs/pivots"
  DEFAULT_PATHS.prdArchiveDir,  // "docs/prd/archive"
] as const;
```

### 2.2 Reusable Layout Assertion Helper
A dedicated validation function `assertPivotStorageLayout(targetDir: string)` was implemented in `src/core/pivot.ts`:
```typescript
export function assertPivotStorageLayout(targetDir: string): void {
  for (const relDir of REQUIRED_PIVOT_DIRECTORIES) {
    const absDir = path.resolve(targetDir, relDir);
    if (!fs.existsSync(absDir)) {
      throw new TransactionError(
        "PIVOT_STORAGE_LAYOUT_MISSING",
        `Required pivot storage directory is missing: "${relDir}". Provision storage layout before executing pivot.`,
        { missingDirectory: relDir, targetPath: relDir }
      );
    }
  }
}
```

### 2.3 Defense-in-Depth Validation Protocol
Validation now occurs at three distinct layers:
1. **Advisory Preflight Check (`checkPivotEligibility`)**:
   Executed before interactive prompts to give early feedback to the operator.
2. **Authoritative Under-Lock Revalidation (`executeStagePivot`)**:
   Executed immediately after acquiring `.playbook/transaction.lock` and before discovering pivot sequences or preparing WAL actions. If a directory was deleted while awaiting human confirmation, execution aborts with `PIVOT_STORAGE_LAYOUT_MISSING`.
3. **Pre-Prepare Revalidation (`executeStagePivot`)**:
   Executed immediately before `txManager.prepare()`. If a directory disappears between sequence discovery and prepare, execution aborts with `PIVOT_STORAGE_LAYOUT_MISSING`.

### 2.4 Scoped Transaction Manager Directory Enforcement
Rather than globally removing `mkdirSync` (which would break other workflows that legitimately create subdirectories), `WriteAheadTransactionManager` was upgraded with scoped enforcement:
- Added `TransactionPrepareOptions` with `requireParentDirectoriesExist?: boolean`.
- Added `requireParentDirectoriesExist?: boolean` to `TransactionManagerOptions` and `FileWriteSpec`.
- In `WriteAheadTransactionManager.prepare()`:
  - During Step 1 (Pre-flight validation before creating the journal), if `requireParentDirectoriesExist` is true, the engine checks `fs.existsSync(path.dirname(absTarget))`. If missing, it throws `PIVOT_STORAGE_LAYOUT_MISSING` before writing `tx-journal.json`.
  - During Step 2 (Temporary staging), if `requireParentDirectoriesExist` is true and `!fs.existsSync(tmpDir)`, it throws `PIVOT_STORAGE_LAYOUT_MISSING` rather than calling `fs.mkdirSync`.
- In `executeStagePivot`, `prepare()` is called with `{ requireParentDirectoriesExist: true }`.
- Default behavior: For general workflows where `requireParentDirectoriesExist` is omitted or `false`, the standard `mkdirSync` fallback is preserved.

### 2.5 Strict Fail-Closed Invariants
When storage layout validation fails:
- **No Directory Created**: `fs.mkdirSync` is never invoked.
- **No Transaction Journal Created**: `tx-journal.json` is not written to disk.
- **No Staging Files Created**: No `.tmp.<txId>` files are written.
- **No State Mutation**: `state.json` remains at Stage 1, `manifest.json` remains at Stage 1, and `docs/prd/PRD-CORE.md` remains intact.
- **Phase A.2 Invariant Maintained**: No speculative wildcard sweeps are performed; unjournaled files remain safely retained.

---

## 3. Automated Test Verification (`pivot-storage-enforcement.test.ts`)

A dedicated test suite was implemented in `tooling/playbook-cli/tests/pivot-storage-enforcement.test.ts` containing 9 comprehensive scenarios:

| # | Test Scenario | Verification Mechanism | Result |
| :-: | :--- | :--- | :-: |
| **1a** | Missing `.playbook/pivots` in preflight & execution | Preflight throws `PIVOT_STORAGE_LAYOUT_MISSING`; public API rejects; dir not created; zero mutations | **PASS** |
| **1b** | Missing `docs/pivots` in preflight & execution | Preflight throws `PIVOT_STORAGE_LAYOUT_MISSING`; public API rejects; dir not created; zero mutations | **PASS** |
| **1c** | Missing `docs/prd/archive` in preflight & execution | Preflight throws `PIVOT_STORAGE_LAYOUT_MISSING`; public API rejects; dir not created; zero mutations | **PASS** |
| **2** | Directory disappearing between preflight and lock | Baseline captured; dir deleted before lock; under-lock check detects omission; aborts without recreating dir | **PASS** |
| **3** | Directory disappearing after lock acquisition before prepare | Simulated via `beforePrepare` hook under lock; re-check throws before prepare; zero journal or temp files | **PASS** |
| **4a** | Scoped enforcement in `txManager.prepare` | `requireParentDirectoriesExist: true` halts closed without journal and without calling `fs.mkdirSync` | **PASS** |
| **4b** | Default transaction manager behavior | Workflow without `requireParentDirectoriesExist` retains expected `mkdirSync` fallback for general operations | **PASS** |
| **5** | Valid storage layout pivot execution | All directories exist; end-to-end pivot succeeds; state transitions cleanly from Stage 1 to Stage 0 | **PASS** |
| **6** | CLI `runPivot` error reporting | Public CLI execution on missing layout outputs formatted `PIVOT_STORAGE_LAYOUT_MISSING` error | **PASS** |

---

## 4. Full Regression Test Execution

Command executed:
```powershell
npm test --prefix tooling/playbook-cli
```

### Output Summary:
- **Total Test Suites**: 17 passing suites (0 failing)
- **Total Test Cases**: **254 passing tests** (0 failing, 0 skipped, 0 cancelled)
- **Execution Duration**: ~34.5 seconds
- **Exit Code**: `0`

---

## 5. Requirement S1 Reassessment & Final Verdict

### Updated Design-to-Code Mapping for Requirement S1

| Req ID | Requirement Description | Design Ref | Implementation Ref | Test Ref | Evidence / Status | Verdict |
| :---: | :--- | :--- | :--- | :--- | :--- | :---: |
| **S1** | Storage directory layout verified under lock; no unjournaled directory creation | Sec 4.1, Sec 6.1 | `src/core/pivot.ts:81-95`, `src/core/pivot.ts:570-580`, `src/core/transaction/transaction-manager.ts:250-265,335-345` | `tests/pivot-storage-enforcement.test.ts` (Scenarios 1a, 1b, 1c, 2, 3, 4a) | Preflight and under-lock revalidation abort with `PIVOT_STORAGE_LAYOUT_MISSING`; `mkdirSync` disabled via `requireParentDirectoriesExist: true`; zero unjournaled directory creation | **PASS** |

### Final Verdict: **PASS**

Requirement S1 is no longer a design deviation. It is fully enforced under the exclusive transaction lock, guarded by scoped transaction manager options, and verified by comprehensive automated tests across all failure and edge-case permutations.
