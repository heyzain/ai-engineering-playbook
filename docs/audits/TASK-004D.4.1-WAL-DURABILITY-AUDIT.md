# Task 004D.4.1 — WAL Durability & Crash-Recovery Audit Report

> **Audit Type**: Independent Code-Level Durability & Crash-Recovery Audit  
> **Target Component**: Write-Ahead Transaction Journal Engine (`tooling/playbook-cli/src/core/transaction/`)  
> **Auditor**: AI Engineering Controller  
> **Date**: 2026-10-31  
> **Task Ref**: Task 004D.4.1  
> **Preceding Implementation**: Task 004D.4 (Commit `49b6cfd`)  

---

## 1. Executive Summary & Verdict

An independent, rigorous code-level audit was conducted on the Write-Ahead Logging (WAL) transaction manager implemented in Task 004D.4. The audit inspected all transaction engine source files, filesystem utilities, serialization parsers, fault-injection hooks, automated tests, and the preceding implementation report.

The implementation successfully establishes the foundational principles of a crash-recoverable WAL engine:
- Strict integration with the canonical `TransactionLockManager` (exclusive mutual exclusion, nonce verification, fail-closed handling).
- A clean three-phase lifecycle (`PREPARED` $\to$ `COMMITTING` $\to$ `COMMITTED`).
- Complete target payload serialization within the journal, eliminating any dependency on transient in-memory state during recovery.
- Fail-closed handling for corrupted, truncated, or zero-byte journals (`CRITICAL_RECOVERY_FAILURE`), strictly preserving the unparseable journal on disk for operator triage.
- Exponential backoff retry logic (`atomicRenameWithRetry`) to bridge Windows transient file locks.
- 16 automated test scenarios verifying crash rollback, roll-forward, and recovery idempotency.

However, the audit revealed **two High-Severity defects** and **one Medium-Severity documentation discrepancy** that compromise durability guarantees and path security:

1. **HIGH (F-01)**: **Missing Target Directory Durability on POSIX**. While the journal writes synchronize `.playbook/`, target files renamed during `commit()` and `recover()` (such as `docs/gates/` or root files) **never synchronize their containing parent directories**. Under POSIX filesystem semantics (ext4 with `data=ordered`, XFS), an un-fsync'd directory entry can be lost or point to an invalid inode following a sudden power failure or OS crash.
2. **HIGH (F-04)**: **Missing Canonical Path Validation During Crash Recovery**. `recover()` resolves target paths directly using `path.resolve(this.targetDir, file.target_path)` without invoking `validateCanonicalPath`. Furthermore, `parseJournal()` only asserts that `target_path` is a non-empty string without checking for path traversal (`..`), absolute paths, UNC paths, or symlink boundaries. A corrupted, tampered, or injected journal could execute arbitrary file writes outside the workspace root during recovery.
3. **MEDIUM (F-02)**: **Overclaimed Windows NTFS Directory Durability in Implementation Report**. Section 5.1 of `TASK-004D.4-WAL-IMPLEMENTATION-REPORT.md` claims that directory metadata updates are committed synchronously on Windows NTFS. In reality, Node.js on Win32 cannot synchronize directory handles without native bindings (`EISDIR` / `EPERM`); directory metadata updates on NTFS are cached in memory and flushed asynchronously by NTFS checkpointing threads.

### Final Verdict

```
NOT_APPROVED
```

> [!CAUTION]
> **Progression Blocker**: Integration of the WAL engine into stage gate approval and stage advancement commands (Task 004D.5) **cannot proceed** while arbitrary path traversal is permitted during recovery (F-04) and parent directory synchronization is omitted on POSIX (F-01). A focused corrective task (**Task 004D.4.2**) must resolve these defects before Task 004D.5 commences.

---

## 2. Audit Scope & Inspected Artifacts

| File / Artifact | Lines | Purpose / Focus of Inspection |
| :--- | :---: | :--- |
| [`src/core/transaction/fs-utils.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/fs-utils.ts) | 236 | Atomic rename, directory fsync, canonical path containment, Windows backoff retry |
| [`src/core/transaction/journal.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts) | 181 | Journal serialization, JSON schema validation, durable multi-stage write, cleanup |
| [`src/core/transaction/transaction-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts) | 529 | Transaction preparation, 3-phase commit, crash recovery state machine, cleanup |
| [`src/core/transaction/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/types.ts) | 134 | Journal interfaces, recovery result types, fault injection hooks, structured errors |
| [`tests/transaction-manager.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/transaction-manager.test.ts) | 692 | 16 automated fault-injection and recovery scenarios, concurrency, idempotency |
| [`docs/audits/TASK-004D.4-WAL-IMPLEMENTATION-REPORT.md`](file:///f:/workspace/ai-engineering-playbook/docs/audits/TASK-004D.4-WAL-IMPLEMENTATION-REPORT.md) | 160 | Architecture claims, durability invariants, platform boundary assertions |

---

## 3. F-01: Target Directory Durability Analysis

### 3.1 Mechanics of Directory Durability on POSIX
Under POSIX filesystem semantics (including Linux ext4 in `data=ordered` mode, XFS, and APFS), file operations consist of two distinct metadata layers:
1. **File Inode & Extent Blocks**: Synchronized when `fsync(file_fd)` or `fdatasync(file_fd)` is executed on the open file handle.
2. **Directory Entry (Dirent) Table**: The parent directory maps a filename string to an inode number. Calling `rename(2)`, `unlink(2)`, or `link(2)` alters the parent directory's block buffer cache.

If an application writes file data, flushes the file descriptor via `fsync`, atomically renames the file over the destination, but **fails to call `fsync(parent_dir_fd)`**, a sudden power failure or host crash can result in:
- The updated file contents existing on physical blocks, but the directory entry in the parent directory still pointing to the old inode or an unallocated entry.
- On some filesystems (e.g., ext4 without `dirsync`), newly renamed files can appear with 0-byte size or disappear entirely upon journal replay after reboot.

### 3.2 Evaluation of Current Implementation
The utility function [`safeFsyncDir`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/fs-utils.ts#L146-L164) correctly implements POSIX directory synchronization:
```typescript
// tooling/playbook-cli/src/core/transaction/fs-utils.ts:146-164
export function safeFsyncDir(dirPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    if (fs.existsSync(dirPath)) {
      const dirFd = fs.openSync(dirPath, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  } catch {
    // Non-fatal if OS restricts directory open
  }
}
```

However, tracing the invocation of `safeFsyncDir` reveals that it is **only called for the journal's parent directory (`.playbook/`)**:
- [`writeJournalDurable`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts#L169): Calls `safeFsyncDir(path.dirname(journalPath))`.
- [`cleanupJournalDurable`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts#L180): Calls `safeFsyncDir(path.dirname(journalPath))`.

### 3.3 Missing Synchronization Points
In [`transaction-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts), when target files are replaced during `commit()` or `recover()`, their parent directories are **never synchronized**:

```
Missing fsync Points Identified:
──────────────────────────────────────────────────────────────────────────────
1. commit() [L256-299]:
   atomicRenameWithRetry(absTmp, absTarget, ...);
   --> MISSING: safeFsyncDir(path.dirname(absTarget));

2. recover() PREPARED Rollback [L379-384]:
   atomicRenameWithRetry(absBak, absTarget, ...);
   --> MISSING: safeFsyncDir(path.dirname(absTarget));

3. recover() PREPARED Rollback [L388]:
   safeWriteAndSync(absTarget, file.original_content);
   --> If file was recreated, directory entry needs: safeFsyncDir(path.dirname(absTarget));

4. recover() PREPARED Rollback [L393-394]:
   safeUnlink(absTarget); safeUnlink(absBak);
   --> MISSING: safeFsyncDir(path.dirname(absTarget));

5. recover() COMMITTING Roll-Forward [L423-428]:
   atomicRenameWithRetry(absTmp, absTarget, ...);
   --> MISSING: safeFsyncDir(path.dirname(absTarget));

6. cleanupTransactionFiles() [L521-528]:
   safeUnlink(absTmp); safeUnlink(absBak);
   --> MISSING: safeFsyncDir(path.dirname(absTmp));
──────────────────────────────────────────────────────────────────────────────
```

### 3.4 Impact Across Directory Boundaries
A transaction may modify files across different directories:
- `.playbook/state.json`
- `.playbook/manifest.json`
- `docs/gates/GATE-1-EXIT-PACKAGE.md`
- `governance/exceptions/EXC-20261031-001.md`

Synchronizing `.playbook/` **does not commit directory entries in `docs/gates/` or `governance/exceptions/`**. Without synchronizing each unique modified target directory, durable commit cannot be guaranteed on POSIX hosts.

### 3.5 Same-Volume Placement Analysis
The staging path derivation in [`prepare()`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L175-L176) is:
```typescript
const tmpRelative = `${relativePath}.tmp.${txId}`;
const bakRelative = `${relativePath}.bak.${txId}`;
```
Because `${relativePath}.tmp.${txId}` appends a suffix to the target filename, the temporary and backup files **always reside in the exact same parent directory as the target file**. This guarantees that source and destination paths remain on the exact same filesystem mount point and physical volume, strictly satisfying the preconditions for atomic POSIX `rename(2)` and Windows NTFS move operations.

---

## 4. F-02: Windows Durability Reality vs Claims

### 4.1 Node.js Filesystem Behavior on Windows
On Windows (`win32`), Node.js implements filesystem calls via libuv:
1. `fs.renameSync(src, dest)` invokes `MoveFileExW(src, dest, MOVEFILE_REPLACE_EXISTING)`. On local NTFS, this provides atomic directory entry replacement within the same volume.
2. Opening a directory handle via standard Node.js `fs.openSync(dirPath, "r")` fails with `EISDIR` (or `EPERM`). Windows requires the Win32 `CreateFileW` flag `FILE_FLAG_BACKUP_SEMANTICS` to obtain a handle to a directory, which standard Node.js runtime bindings do not expose.
3. Node.js `fs.fsyncSync` translates to Win32 `FlushFileBuffers(handle)`. Since directory handles cannot be opened, `safeFsyncDir` correctly recognizes this limitation and exits early on Windows:
   ```typescript
   if (process.platform === "win32") {
     return;
   }
   ```

### 4.2 Correction of Overclaims in Implementation Report
Section 5.1 of `TASK-004D.4-WAL-IMPLEMENTATION-REPORT.md` states:
> *"Windows NTFS: Directory handles cannot be synchronized via POSIX fsync (`EISDIR` / `EPERM`); directory metadata updates are committed synchronously as part of transactional NTFS file renaming."*

**This claim is technically inaccurate and overstates Windows guarantees**:
- NTFS maintains an internal journal (`$LogFile`, `$MFT`) to guarantee filesystem metadata integrity against corruption, but NTFS **does not synchronously commit directory metadata to physical media** on every individual `MoveFileExW` call.
- Metadata updates are written into the NTFS system cache in RAM and flushed asynchronously during periodic NTFS checkpointing (typically every 5 seconds) or when volume-level flushes occur.
- Unless an application issues a volume-level flush (`FlushFileBuffers` on the volume handle) or opens the directory handle via native C++ N-API bindings using `FILE_FLAG_BACKUP_SEMANTICS`, directory metadata updates on Windows NTFS remain **deferred and asynchronous**.
- **Corrected Claim**: On Windows NTFS without native Win32 bindings, directory metadata updates are committed to the filesystem cache and flushed asynchronously. The implementation provides atomic directory replacement under normal execution, but crash durability after sudden power cut relies on NTFS checkpoint replay.

### 4.3 Safety Audit of `atomicRenameWithRetry`
Windows file systems exhibit transient file locking when third-party software (such as antivirus scanners, search indexers, or backup agents) opens a newly created file for scanning.

[`atomicRenameWithRetry`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/fs-utils.ts#L170-L210) was audited for potential race conditions or atomicity compromises:
```typescript
export function atomicRenameWithRetry(
  srcPath: string,
  destPath: string,
  maxRetries = 5,
  retryDelayMs = 50,
  faultInjectionHooks?: { simulateRenameEbusyCount?: number }
): void {
  // Retries fs.renameSync on EBUSY, EPERM, EACCES with linear backoff
  ...
  fs.renameSync(srcPath, destPath);
  ...
}
```

**Audit Verdict on Retry Mechanism**:
- **Atomicity Preserved**: The function executes `fs.renameSync` on every retry attempt. It **never** falls back to non-atomic mechanisms (such as `fs.copyFileSync` followed by `fs.unlinkSync`).
- **No Inconsistent State**: If `fs.renameSync` fails on `EBUSY`, neither the source nor destination is altered. The live destination file continues to serve its prior content until the rename succeeds atomically.
- **Fail-Closed on Exhaustion**: If all retries fail, the error is re-thrown as a `TransactionError`, allowing the transaction to abort and recovery to restore state.
- **Conclusion**: `atomicRenameWithRetry` is safe, sound, and does not compromise atomicity.

---

## 5. F-03: Journal Lifecycle & Recovery Correctness

### 5.1 Three-Phase Journal Lifecycle
The engine enforces a strictly ordered state machine:
```
┌─────────────────────────────────────────────────────────────┐
│ 1. PREPARED    Staged .tmp & .bak written; live files intact│
│       ▼                                                     │
│ 2. COMMITTING  Commit decided; sequential live renames begin │
│       ▼                                                     │
│ 3. COMMITTED   All live files replaced; cleanup pending     │
└─────────────────────────────────────────────────────────────┘
```

Phase transitions are serialized and committed via [`writeJournalDurable`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts#L138-L170):
1. Payload is written to `${journalPath}.tmp.${tx_id}` via `safeWriteAndSync` (`writeSync` + `fsyncSync`).
2. Atomically renamed over `journalPath`.
3. Directory metadata flushed via `safeFsyncDir`.
This guarantees that **no action in a subsequent phase executes until the phase transition is durable on disk**.

### 5.2 Phase-by-Phase Recovery Assessment

#### Phase 1: `PREPARED` Rollback
- **Pre-Crash Condition**: Journal is in `PREPARED`. Live target files were not modified by `commit()`. Temporary (`.tmp`) and backup (`.bak`) files exist on disk.
- **Recovery Behavior** ([`transaction-manager.ts:366-407`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L366-L407)):
  - Removes `.tmp` files.
  - If `file.existed_before`: Restores from `absBak` via `atomicRenameWithRetry`, or rewrites `original_content` if hash diverged.
  - If `!file.existed_before`: Removes target file if created.
  - Cleans up journal.
- **Audit Finding (LOW)**: After restoring `absTarget` from `absBak` or `original_content`, lines 377–396 **do not compute the hash of the restored file to verify it matches `expected_source_hash`** before deleting the journal. If restore silently failed or target was locked, the journal is deleted regardless. Hash verification must be added prior to journal cleanup.

#### Phase 2: `COMMITTING` Roll-Forward
- **Pre-Crash Condition**: Journal is in `COMMITTING`. Target files may be untouched, partially replaced, or completely replaced.
- **Recovery Behavior** ([`transaction-manager.ts:410-464`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L410-L464)):
  - For each file in `journal.files`:
    - Checks `computeFileSha256(absTarget) === file.expected_target_hash`.
    - If mismatch, recreates `absTmp` from embedded `target_content` and renames over `absTarget`.
    - Computes `finalHash` and asserts `finalHash === file.expected_target_hash`.
    - Throws `CRITICAL_RECOVERY_FAILURE` if hash does not match.
    - Removes `.bak` and `.tmp` files only after successful verification.
  - Transitions journal to `COMMITTED`.
  - Cleans up journal.
- **Audit Verdict**: Fully deterministic, self-contained, and crash-resilient. Tested extensively in Scenarios 3, 4, 5, and 9.

#### Phase 3: `COMMITTED` Final Cleanup
- **Pre-Crash Condition**: Journal is in `COMMITTED`. All live targets were replaced, but cleanup of temporary files and journal was interrupted.
- **Recovery Behavior** ([`transaction-manager.ts:466-497`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L466-L497)):
  - Verifies that every file matches `file.expected_target_hash`.
  - Removes residual `.tmp` and `.bak` files.
  - Deletes journal.
- **Audit Verdict**: Strictly idempotent. Verified in Scenario 7.

#### Corrupted / Incomplete Journal Handling
- If `tx-journal.json` is 0 bytes, contains malformed JSON, or lacks mandatory fields:
  - [`readJournal`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts#L100-L133) flags `isCorrupted: true`.
  - [`recover`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L347-L353) immediately throws `CRITICAL_RECOVERY_FAILURE`.
  - **The corrupted file is strictly preserved on disk**. The engine never deletes or synthesizes state.
- **Audit Verdict**: Complies strictly with the Fail-Closed Prime Directive. Verified in Scenario 8.

---

## 6. F-04: Path Containment & External Modification Safety

### 6.1 Path Validation Implementation
[`validateCanonicalPath`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/fs-utils.ts#L38-L118) provides strong containment defenses during transaction preparation:
1. Rejects empty, whitespace, or non-string paths (`TARGET_PATH_INVALID`).
2. Rejects absolute paths, UNC paths (`\\...`, `//...`), and Windows drive letters (`C:...`).
3. Rejects path traversal tokens (`..`).
4. Resolves destination against `targetDir` and asserts containment using `startsWith(resolvedRoot + path.sep)`.
5. Climbs ancestor directories and runs `fs.realpathSync` to detect symlink escapes.

### 6.2 Critical Defect: Missing Path Validation During Recovery
While [`prepare()`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L153) calls `validateCanonicalPath`, **`recover()` completely bypasses it**:

```typescript
// tooling/playbook-cli/src/core/transaction/transaction-manager.ts:370, 414, 470
// PREPARED rollback:
const absTarget = path.resolve(this.targetDir, file.target_path);
const absTmp = path.resolve(this.targetDir, file.tmp_path);
const absBak = path.resolve(this.targetDir, file.bak_path);

// COMMITTING roll-forward:
const absTarget = path.resolve(this.targetDir, file.target_path);
const absTmp = path.resolve(this.targetDir, file.tmp_path);
const absBak = path.resolve(this.targetDir, file.bak_path);

// COMMITTED cleanup:
const absTarget = path.resolve(this.targetDir, file.target_path);
```

Furthermore, [`parseJournal`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts#L50-L67) only performs basic type assertions:
```typescript
// tooling/playbook-cli/src/core/transaction/journal.ts:54-59
typeof f.target_path !== "string" ||
f.target_path.trim().length === 0 ||
typeof f.tmp_path !== "string" ||
f.tmp_path.trim().length === 0 ||
typeof f.bak_path !== "string" ||
f.bak_path.trim().length === 0
```
It does **not** check for path traversal (`..`), absolute paths, or project containment.

### 6.3 Security & Safety Impact
If a transaction journal is crafted, tampered with, or corrupted:
- An entry with `"target_path": "../../../etc/cron.d/malicious"` or `"target_path": "C:\\Windows\\System32\\bad.dll"` will be parsed as valid.
- When `recover()` runs, `path.resolve(this.targetDir, file.target_path)` resolves outside the repository boundary.
- In `COMMITTING` recovery, the engine will write `target_content` directly to that external location.
- **Severity**: **HIGH**. `parseJournal()` and `recover()` must validate every file path against `validateCanonicalPath` before executing any filesystem operation.

### 6.4 External Modification Safety & Target Drift
Between [`prepare()`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L152-L172) and [`commit()`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts#L256-L299), external actors (such as a developer running `git checkout`, an external editor, or an IDE plugin) could modify a target file.
- The WAL engine relies on `TransactionLockManager` for mutual exclusion between CLI instances.
- However, the lock manager cannot prevent out-of-band external processes from editing files on disk.
- In `commit()`, the engine renames `absTmp` over `absTarget` **without checking if `absTarget` still matches `expected_source_hash`**.
- Any external modification occurring between `prepare` and `commit` will be silently overwritten.
- **Remediation**: Before entering `COMMITTING` phase, the engine should re-verify that all target files matching `existed_before` still match `expected_source_hash`. If drift is detected, the transaction should abort cleanly without committing.

---

## 7. F-05: Fault-Injection & Test Coverage Assessment

### 7.1 Mapping Tested Scenarios to Required Failure Points

| Failure Point | Required Crash Condition | Test Scenario | Verified Invariant | Audit Status |
| :---: | :--- | :---: | :--- | :---: |
| **1** | Crash after journal `PREPARED` | Scenario 2 | Live files untouched; staged files reverted | **Verified** |
| **2** | Crash after entering `COMMITTING` | Scenario 3 | Deterministic roll-forward to target state | **Verified** |
| **3** | Crash after first target write | Scenario 4 | Remaining files rolled forward; verified | **Verified** |
| **4** | Crash between multiple target writes | Scenario 5 | 3-file partial commit reconciles cleanly | **Verified** |
| **5** | Crash after all targets written before `COMMITTED` | Scenario 6 | Transitions journal to `COMMITTED`; cleans up | **Verified** |
| **6** | Crash after `COMMITTED` before cleanup | Scenario 7 | Targets verified; residual files purged | **Verified** |
| **7** | Corrupted / incomplete journal recovery | Scenario 8 | `CRITICAL_RECOVERY_FAILURE`; file preserved | **Verified** |
| **8** | Missing temporary files during recovery | Scenario 9 | Reconstructed from journal `target_content` | **Verified** |
| **9** | Stale lock + pending journal reclamation | Scenario 12 | Contender reclaims lock and completes recovery | **Verified** |

### 7.2 In-Process Simulation vs True Process Crash Recovery
In [`tests/transaction-manager.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/transaction-manager.test.ts), failure points are simulated using the [`faultInjection`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/types.ts#L104-L121) configuration:
```typescript
// Throws a JavaScript TransactionError during the execution loop
if (this.faultInjection.failAfterJournalPrepared) {
  throw new TransactionError("TRANSACTION_PREPARATION_FAILED", "Fault injection: crash after journal prepared.");
}
```

**Audit Assessment**:
- **Strengths**: The tests verify that durable on-disk artifacts left behind by an aborted transaction are properly recognized and reconciled by a new, independent `WriteAheadTransactionManager` instance.
- **Limitations**:
  - In-process error throwing executes normal Node.js stack unwinding and runs `finally` blocks (such as `fs.closeSync(fd)`).
  - It does not test OS-level process termination (`process.kill(pid, "SIGKILL")` or Windows `TerminateProcess`), where file descriptors are forcibly reclaimed by the kernel.
  - It does not test sudden termination occurring during an in-flight `fs.writeSync` or `fs.fsyncSync` call.
- Unlike `tests/lock-manager.test.ts` (which utilizes [`tests/fixtures/lock-worker.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/fixtures/lock-worker.ts) to verify multi-process concurrency), the transaction manager test suite currently relies exclusively on in-process exception simulation.

### 7.3 Identified Test Gaps
1. **Orphaned Journal Temp File**: No test verifies cleanup behavior when `.playbook/tx-journal.json.tmp.<txId>` is left on disk due to a crash during `writeJournalDurable`.
2. **Missing Parent Directory on Target**: No test verifies transaction execution when a target file resides in a newly created nested directory (e.g., `docs/gates/sub/`).
3. **Path Traversal Journal Injection**: No test verifies that `recover()` fails closed when presented with a journal containing malicious path traversal tokens (`..`).
4. **Out-of-Process Crash Test**: No test exercises child process termination (`SIGKILL`) during active file renaming.

---

## 8. Consolidated Findings Matrix

| ID | Severity | Area | Problem Description | Required Remediation |
| :---: | :---: | :---: | :--- | :--- |
| **F-01** | **HIGH** | Directory Durability | Target file parent directories are never synchronized via `safeFsyncDir` after renaming during `commit()` or `recover()`. Only `.playbook/` is fsync'd. | Call `safeFsyncDir(path.dirname(absTarget))` after every target file rename in `commit()` and `recover()`, and for unique target directories. |
| **F-04** | **HIGH** | Path Safety | `recover()` resolves target paths with `path.resolve` without calling `validateCanonicalPath`. `parseJournal()` does not reject path traversal (`..`) or absolute paths. | Enforce `validateCanonicalPath` in `parseJournal()` and at the start of `recover()` before any filesystem operations. |
| **F-02** | **MEDIUM** | Platform Claims | Implementation report claims Windows NTFS commits directory metadata synchronously upon rename. Node.js on Win32 cannot fsync directories; updates are deferred. | Update Section 5.1 of Task 004D.4 report to accurately state that Windows directory metadata durability is deferred to NTFS checkpointing. |
| **F-03** | **LOW** | Recovery Verification | In `PREPARED` rollback, restored files are not hashed against `expected_source_hash` before deleting the journal. | Compute `computeFileSha256(absTarget)` and assert match with `expected_source_hash` before journal cleanup in `recover()`. |
| **F-05** | **LOW** | Test Coverage | Fault-injection tests use in-process exception simulation; no child process `SIGKILL` test exists for transaction commits. | Add a multi-process worker test verifying recovery after an external `SIGKILL` during `commit()`. |

---

## 9. Required Corrective Actions (Task 004D.4.2 Specification)

Before proceeding to Stage Gate Approval & Advancement implementation in **Task 004D.5**, the following corrective actions must be implemented and verified in **Task 004D.4.2**:

### Corrective Action 1: Synchronize Target Directories on POSIX (Resolves F-01)
1. In [`transaction-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts):
   - In `commit()`: After renaming each target file, call `safeFsyncDir(path.dirname(absTarget))`.
   - In `recover()`: After restoring or roll-forward renaming each target file, call `safeFsyncDir(path.dirname(absTarget))`.
   - In `cleanupTransactionFiles()`: After unlinking temporary and backup files, call `safeFsyncDir(path.dirname(absTmp))`.
2. Deduplicate parent directory paths during multi-file operations to avoid redundant `fsync` calls on the same directory.

### Corrective Action 2: Enforce Canonical Path Containment in Recovery (Resolves F-04)
1. In [`journal.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/journal.ts):
   - In `parseJournal()`: Reject any journal where `target_path`, `tmp_path`, or `bak_path` contains `..`, absolute path tokens, UNC prefixes, or Windows drive prefixes.
2. In [`transaction-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts):
   - In `recover()`: Pass every `file.target_path`, `file.tmp_path`, and `file.bak_path` through `validateCanonicalPath(this.targetDir, path)` before performing any filesystem operations.
   - If path validation fails, abort immediately with `CRITICAL_RECOVERY_FAILURE` and preserve the journal file.
3. Add a dedicated test proving that a crafted journal with path traversal (`..`) is rejected during recovery without touching external files.

### Corrective Action 3: Verify Restored Target Hash on `PREPARED` Rollback (Resolves F-03)
1. In `recover()` under `PREPARED` phase:
   - After restoring a file that `existed_before`, verify that `computeFileSha256(absTarget) === file.expected_source_hash`.
   - If hash mismatch occurs, throw `CRITICAL_RECOVERY_FAILURE` rather than deleting the journal.

### Corrective Action 4: Correct Windows Durability Documentation (Resolves F-02)
1. Update `docs/audits/TASK-004D.4-WAL-IMPLEMENTATION-REPORT.md` Section 5.1 to accurately reflect that directory metadata updates on Windows NTFS are deferred to OS checkpointing and not synchronously committed by `MoveFileExW`.

---

## 10. Traceability & Sign-Off

- **Audit Target**: `tooling/playbook-cli/src/core/transaction/`
- **Audit Findings**: 2 High, 1 Medium, 2 Low
- **Overall Verdict**: `NOT_APPROVED`
- **Next Required Step**: Task 004D.4.2 — Critical WAL Durability & Path Safety Corrections
