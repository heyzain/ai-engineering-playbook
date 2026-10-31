# Task 004D.3.1 — Transaction Lock Manager Code-Level Safety Audit Report

> **Audit Type**: Independent Code-Level Safety Audit  
> **Target Component**: Transaction Lock Manager (`tooling/playbook-cli/src/core/lock/`)  
> **Auditor**: AI Engineering Controller  
> **Date**: 2026-10-31  
> **Task Ref**: Task 004D.3.1  
> **Preceding Implementation**: Task 004D.3 (Commit `99a0d49`)

---

## 1. Executive Summary & Final Verdict

An exhaustive, code-level safety audit of the transaction lock manager implementation was performed across all source files, types, platform utilities, multi-process test fixtures, and automated test suites.

The implementation exhibits robust POSIX/NTFS mutual exclusion primitives (`O_CREAT | O_EXCL`), strict ownership nonce validation on release, fail-closed handling for empty or malformed locks, and verified multi-process contention exclusion under Windows.

However, the audit revealed **one Critical defect** and **one High defect** that compromise system safety under concurrent workloads and on Linux hosts:

1. **CRITICAL**: On Linux, `getLinuxProcessStartTime` inspects `fs.statSync('/proc/' + pid).mtime`. In Linux kernel `procfs`, `/proc/<pid>` is a virtual ephemeral directory whose `mtime` does not reflect process start time (it reflects inode instantiation/access time). When a contender checks an active lock, `stat.mtime` can be greater than `recordedCreatedAt` by > 2000ms. This causes the liveness checker to falsely conclude the PID was recycled (`isVerifiedDead: true`), resulting in **direct lock theft from a live process** and violating Safety Invariant 2.
2. **HIGH**: In `reclaimStaleLock`, if replacement lock creation (`fs.openSync("wx")`) encounters a race condition with a contender and throws `EEXIST`, the reclaimer drops into `catch (err)` without calling `this.safeUnlinkReclaim(reclaimNonce)`. This leaves an orphaned `reclaim.lock` owned by a live process on disk, resulting in a **permanent acquisition deadlock** across all future transactions.

### Final Verdict

```
NOT_APPROVED
```

> [!CAUTION]
> **Progression Blocker**: Implementation of Write-Ahead Logging (WAL) or approval/advancement cannot proceed on top of a lock manager that permits lock stealing under Linux and permanent deadlock during acquisition races. Two targeted, minimal code corrections (detailed in Section 6) must be applied and verified before approving WAL implementation.

---

## 2. Audit Scope & Inspected Files

| File | Lines | Purpose / Focus of Inspection |
| :--- | :---: | :--- |
| [`src/core/lock/lock-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/lock-manager.ts) | 814 | Core locking engine, dual-lock protocol, reclamation state machine, transient grace polling |
| [`src/core/lock/liveness.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/liveness.ts) | 197 | Process liveness (`kill(pid, 0)`), error handling (`ESRCH`/`EPERM`), platform start-time inspection |
| [`src/core/lock/diagnostics.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/diagnostics.ts) | 93 | Structured error mapping, remediation messages, diagnostic code compatibility |
| [`src/core/lock/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/types.ts) | 139 | TypeScript interfaces, metadata schemas, fault-injection hooks, error types |
| [`src/core/lock/index.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/index.ts) | 4 | Public API exports and interface exposure |
| [`tests/lock-manager.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/lock-manager.test.ts) | 664 | 18 unit and multi-process test scenarios |
| [`tests/fixtures/lock-worker.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/fixtures/lock-worker.ts) | 55 | Real child-process CLI executable for multi-process contention testing |

---

## 3. Detailed Audit by Area

### 3.1 Atomic Ownership & Nonce Integrity

#### Lock Creation Exclusivity
- Lock creation uses `fs.openSync(path, 'wx')` (`O_CREAT | O_WRONLY | O_EXCL`).
- On local filesystems (NTFS, ext4, APFS), this provides kernel-enforced mutual exclusion: exactly one process succeeds; all other contenders receive `EEXIST`.

#### Metadata Write Failures
- If `fs.writeSync` or `fs.fsyncSync` fails or crashes before completing metadata serialization, `fd` is closed and an error is thrown.
- The resulting file is left on disk as an empty (0-byte) or truncated file.
- **Fail-Closed Verification**: Contenders encountering an empty or corrupted lock file poll across `transientGracePeriodMs` (1000ms). If metadata remains unparseable, contenders raise `LOCK_METADATA_UNREADABLE` and **refuse to delete the file**. This prevents split-brain mutations.

#### Nonce Verification on Release
- In `release(handle)`:
  ```ts
  if (currentMeta.nonce !== handle.nonce || currentMeta.pid !== handle.pid) {
    throw new LockError("LOCK_LOST_DURING_TRANSACTION", ...);
  }
  ```
- Strict comparison of both `nonce` (UUIDv4) and `pid` ensures a process whose lock was stolen or superseded can never delete the active lock held by another process. Tested in Scenario 3.

#### Resource Ownership on Error Paths
- Every `fs.unlinkSync` in the codebase was verified:
  - Line 321 (`acquire` rollback): Verified against `currentMeta.nonce === nonce && currentMeta.pid === this.pid`.
  - Line 417 (`release`): Verified against `currentMeta.nonce === handle.nonce && currentMeta.pid === handle.pid`.
  - Line 576 (`evaluateReclaimMarker`): Verified against `currentMeta.nonce === meta.nonce && currentMeta.reclaiming_pid === meta.reclaiming_pid` after `liveness.isVerifiedDead`.
  - Line 708 (`reclaimStaleLock`): Verified against `currentTargetMeta.nonce === staleLockMeta.nonce` while holding verified `reclaim.lock`.
  - Line 773 (`safeUnlinkReclaim`): Verified against `meta.nonce === expectedNonce && meta.reclaiming_pid === this.pid`.

---

### 3.2 Reclamation Concurrency & Race Conditions

#### Interleaving Trace: Normal Acquisition Racing with Stale Lock Reclamation

Consider Process A (normal acquirer) and Process R (reclaimer targeting stale lock $T_0$):

```
Process A (Acquirer)                      Process R (Reclaimer)
───────────────────────────────────       ───────────────────────────────────
1. Inspects reclaim.lock (not present)
                                          2. openSync("reclaim.lock", "wx") -> OK
                                          3. Verifies T_0 stale target nonce
                                          4. unlinkSync("transaction.lock")
5. openSync("transaction.lock", "wx")
   -> SUCCESS! (T_0 was unlinked)
                                          6. openSync("transaction.lock", "wx")
                                             -> THROWS EEXIST!
                                          7. catch (err) executes:
                                             - closes reclaimFd
                                             - DOES NOT UNLINK reclaim.lock!
                                             - throws unhandled LockError
8. Writes payload, fsyncs
9. Post-acquisition check (line 315):
   - sees reclaim.lock exists!
   - rolls back: unlinks transaction.lock
   - backs off and retries
10. Retries acquire():
    - sees reclaim.lock on disk
    - checks R.pid (R is ALIVE!)
    - evaluateReclaimMarker returns false
    - loops forever until LOCK_TIMEOUT
```

**Outcome**: Process A safely rolls back, preventing split-brain. However, Reclaimer R abandons an orphaned `reclaim.lock` with R's live PID. All subsequent transactions block indefinitely on `reclaim.lock` until R terminates or operator intervention occurs.

#### Two Simultaneous Reclaimers
- Both call `openSync(reclaimLockPath, "wx")`. Kernel guarantees exactly one winner. The loser catches `EEXIST` and cleanly returns `null`, backing off with jitter.

#### Reclaimer Termination
- **Before unlinking target**: Dead `reclaim.lock` is detected via `liveness.isVerifiedDead` and safely unlinked by the next contender (Scenario 10).
- **After unlinking target before creating new lock**: Stale target is gone; dead `reclaim.lock` is unwound by next contender; contender acquires cleanly.
- **After creating new lock before unlinking reclaim**: Next contender cleans up dead `reclaim.lock`, then reclaims or waits for new lock.

#### Live Reclaimer Delay vs TTL
- Verified: The implementation contains **no TTL-based theft** of `reclaim.lock` or `transaction.lock`. Live reclaimers and live owners are protected indefinitely regardless of elapsed time.

---

### 3.3 Process Liveness & PID Reuse

#### Error Code Handling in `process.kill(pid, 0)`
- `ESRCH`: Correctly mapped to `isAlive: false, isVerifiedDead: true`.
- `EPERM`: Correctly mapped to `isAlive: true, isVerifiedDead: false` (process exists under another user/integrity context).
- Unrecognized errors: Correctly fail closed (`isAlive: true`).
- Invalid PIDs (`<= 0`, non-integer): Correctly fail closed (`isAlive: false, isVerifiedDead: false`).

#### Cross-Host Detection
- If `lockMetadata.hostname !== currentHostname`: local PID inspection is bypassed immediately, returning `isAlive: true, isVerifiedDead: false`. Fails closed with `CROSS_HOST_LOCK_UNVERIFIABLE`.

#### Platform Start-Time Implementations

| Platform | Command / Source | Accuracy | Safety Assessment |
| :--- | :--- | :---: | :--- |
| **Windows** | PowerShell `(Get-Process -Id <pid>).StartTime` | Millisecond UTC | **Safe**. Returns exact process start timestamp. Falls back to `null` (fails closed) if PowerShell is unavailable. |
| **macOS** | `ps -p <pid> -o lstart=` | Second-level UTC | **Safe**. 2000ms clock skew window covers sub-second truncation. Falls back to `null` on parse failure. |
| **Linux** | `fs.statSync('/proc/' + pid).mtime` | **Corrupted / Invalid** | **CRITICAL DEFECT**. `/proc/<pid>` directory `mtime` does not reflect process creation time. Inode creation or lookup time is returned. Leads to false PID recycling detection and lock stealing. |

---

### 3.4 Filesystem Guarantees & Boundaries

#### Inspection of `defaultFilesystemChecker`
```ts
export const defaultFilesystemChecker: FilesystemChecker = (dirPath: string) => {
  if (dirPath.startsWith("\\\\") || dirPath.startsWith("//")) {
    return {
      supported: false,
      reason: `Network UNC share detected: "${dirPath}". Atomic O_EXCL mutual exclusion is not guaranteed on networked storage.`,
    };
  }
  return { supported: true };
};
```

#### Reality vs Claim Analysis

| Dimension | Implementation Reality | Safety Boundary |
| :--- | :--- | :--- |
| **Filesystem Identification** | String prefix check only (`\\\\` or `//`). Does not inspect OS filesystem type or superblock. | **Limitation**: Windows mapped network drives (`Z:\...`), Linux NFS/CIFS mounts (`/mnt/nfs`), and macOS network mounts (`/Volumes/share`) are NOT detected and pass as local. |
| **Atomic Creation** | Uses `fs.openSync(..., 'wx')`. | Fully guaranteed on local NTFS, ext4, XFS, APFS. Broken on NFSv3 mounts. |
| **Durability After Crashes** | Calls `fs.fsyncSync(fd)` on file payload before closing. | Flushes file data. Directory entry durability requires containing directory `fsync` on POSIX (minor, as empty files fail closed). |
| **Cross-Host Coordination** | Compares `hostname` string in metadata. | If repository is placed on an undetected network mount, cross-host processes fail closed with `CROSS_HOST_LOCK_UNVERIFIABLE` rather than coordinating. |

---

### 3.5 Test Quality & Concurrency Verification

#### Evaluation of 18 Automated Tests

1. **Multi-Process Concurrency (Scenario 2)**:
   - Uses real Node.js child processes (`execFileAsync`) executing [`tests/fixtures/lock-worker.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/fixtures/lock-worker.ts).
   - Verifies 3 independent processes competing simultaneously with non-overlapping acquisition/release time intervals. Genuinely exercises OS scheduler and file locks.
2. **Crash & Fault-Injection Tests**:
   - Scenario 12 verifies post-acquisition rollback when `simulateConcurrentReclaimBeforePostCheck` fires.
   - Scenario 13 verifies crash between file creation and write (`failAfterLockCreatedBeforePayload`), leaving a 0-byte file, and confirms subsequent contender fails closed.
3. **Mocked Liveness Checker Usage**:
   - Scenarios 5, 6, 10, and 14 mock `livenessChecker` rather than spawning and killing real processes. While adequate for unit test deterministic state transitions, integration tests with real killed processes were omitted.
4. **Missing Fault-Injection Tests**:
   - Hooks defined in `types.ts` but never tested: `failAfterLockPayloadWrittenBeforeClose`, `failAfterReclaimCreatedBeforePayload`, `failAfterReclaimBeforeUnlinkTarget`, `failAfterUnlinkTargetBeforeNewLock`, `failAfterNewLockBeforeUnlinkReclaim`.

---

## 4. Test Suite Execution Evidence

The full test suite was executed in the workspace environment:

```powershell
npm test --prefix tooling/playbook-cli
```

### Execution Output Summary
```
> @ai-engineering-playbook/cli@1.0.0 test
> node --test dist/tests/**/*.test.js

▶ CLI Executable Integration (playbook) (5327.242ms)
▶ Governance Consistency Invariants (41.6823ms)
▶ ProjectScaffolder and Template Generation (181.2593ms)
▶ Governance State Inspection & Diagnostics (playbook inspect) (2890.1042ms)
▶ Milestone Engine (playbook milestone) (2214.3412ms)
▶ Manifest Repair Engine (playbook repair-manifest) (892.4101ms)
▶ Evidence Verification Engine (playbook verify-evidence) (1483.1212ms)
▶ TransactionLockManager & Atomic Concurrency (lock-manager.test.ts) (2941.5204ms)

ℹ tests 87
ℹ suites 8
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5839.7053
```

All 87 tests passed across all 8 suites.

---

## 5. Comprehensive Audit Findings

| ID | Severity | Category | Description |
| :---: | :---: | :--- | :--- |
| **F-01** | **CRITICAL** | Liveness Safety | Linux `/proc/<pid>` directory `mtime` does not reflect process start time; causes false PID recycling detection and lock stealing from live processes. |
| **F-02** | **HIGH** | Concurrency Safety | `reclaimStaleLock` drops into uncaught error on replacement lock race without cleaning up `reclaim.lock`, causing permanent acquisition deadlock. |
| **F-03** | **MEDIUM** | Platform Boundary | Filesystem support checker only checks UNC string prefixes; mapped network drives (`Z:\`) and Linux/macOS network mounts pass undetected. |
| **F-04** | **LOW** | Test Completeness | Tests 5, 6, 10, and 14 use mocked liveness checkers rather than real terminated OS processes. |
| **F-05** | **INFORMATIONAL** | Test Coverage | 5 fault-injection hooks defined in `FaultInjectionHooks` are implemented in code but have no test cases. |
| **F-06** | **INFORMATIONAL** | Performance | Synchronous `powershell.exe` invocation for start-time check on Windows introduces ~200ms latency during contention resolution. |

---

## 6. Deep Dive into Critical & High Findings

### Finding F-01 (CRITICAL): Linux Process Start-Time Detection via `/proc/<pid>` `mtime`

- **File**: [`tooling/playbook-cli/src/core/lock/liveness.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/liveness.ts#L141-L155)
- **Function**: `getLinuxProcessStartTime(pid: number): Date | null`

#### Failure Sequence
1. Process P (PID 10500) starts on Linux at 10:00:00.
2. Process P acquires `transaction.lock` at 10:05:00 (`created_at: "2026-10-31T10:05:00.000Z"`).
3. Process P is executing a long-running transaction (e.g. log compaction, approval).
4. Contender C starts at 10:07:00 and attempts `acquire()`.
5. Contender C sees `transaction.lock` exists and calls `evaluateContendedLock()`.
6. Contender C calls `defaultProcessLivenessChecker(10500, "2026-10-31T10:05:00.000Z")`.
7. `process.kill(10500, 0)` succeeds (`pidExists = true`).
8. Contender C calls `getLinuxProcessStartTime(10500)`.
9. `fs.statSync("/proc/10500").mtime` returns 10:07:00 (the time the dentry was instantiated/stat'd).
10. `diffMs = startTime (10:07:00) - lockCreatedDate (10:05:00) = +120,000ms (> 2000ms)`.
11. `defaultProcessLivenessChecker` returns:
    ```json
    { "isAlive": false, "isVerifiedDead": true, "isRecycled": true }
    ```
12. Contender C initiates `reclaimStaleLock()`, unlinks Process P's lock, and acquires a new lock.
13. **Result**: Both Process P and Contender C believe they hold exclusive lock! Split-brain corruption occurs.

#### Minimal Recommended Correction
In `tooling/playbook-cli/src/core/lock/liveness.ts`:
Either:
1. Use `ps -p <pid> -o lstart=` on Linux (same as macOS), which delegates to the OS `ps` utility that parses `/proc/<pid>/stat` field 22 and converts clock ticks to wall-clock time:
   ```ts
   function getLinuxProcessStartTime(pid: number): Date | null {
     try {
       const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
         encoding: "utf-8",
         timeout: 2500,
         stdio: ["ignore", "pipe", "ignore"],
       }).trim();
       const date = new Date(output);
       if (!isNaN(date.getTime())) {
         return date;
       }
     } catch {}
     return null;
   }
   ```
2. Or fall back to returning `null` on Linux if `ps` is unavailable, which causes `liveness.ts` to safely treat the process as alive (fail closed).

---

### Finding F-02 (HIGH): Unhandled Collision & Missing Reclamation Cleanup

- **File**: [`tooling/playbook-cli/src/core/lock/lock-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/lock-manager.ts#L714-L762)
- **Function**: `reclaimStaleLock(staleLockMeta: LockMetadata)`

#### Failure Sequence
1. Reclaimer R acquires `reclaim.lock`, verifies stale target, and unlinks stale `transaction.lock`.
2. Contender A (which passed Step 1 before `reclaim.lock` was written) executes `fs.openSync("transaction.lock", "wx")` and succeeds.
3. Reclaimer R reaches line 715: `fs.openSync(this.transactionLockPath, "wx")`.
4. R gets `EEXIST`.
5. R jumps to line 754 `catch (err)`.
6. In `catch (err)`, R closes `reclaimFd` but **never unlinks** `reclaim.lock`.
7. Contender A detects `reclaim.lock` at line 315 and unlinks `transaction.lock` (rolls back).
8. `reclaim.lock` is left on disk holding R's PID.
9. Because R is still alive, every future `acquire()` sees `evaluateReclaimMarker() === false` and times out.
10. **Result**: Total denial of service (unrecoverable acquisition deadlock).

#### Minimal Recommended Correction
In `tooling/playbook-cli/src/core/lock/lock-manager.ts`:
In `reclaimStaleLock`, wrap replacement lock creation in a specific handler and ensure `safeUnlinkReclaim` is always called if replacement lock acquisition fails:
```ts
      // 4. Create replacement transaction.lock
      let newFd: number | null = null;
      try {
        newFd = fs.openSync(this.transactionLockPath, "wx");
      } catch (err: unknown) {
        // Replacement lock lost to another contender; release reclamation mutex cleanly
        this.safeUnlinkReclaim(reclaimNonce);
        return null;
      }
```
And in `catch (err)` of `reclaimStaleLock`, call `this.safeUnlinkReclaim(reclaimNonce)` before throwing.

---

## 7. Implementation-Readiness Assessment & Required Next Actions

### Pre-WAL Remediation Requirements

Before Write-Ahead Logging (WAL) implementation can begin under Task 004D.4:

1. **Fix F-01**: Replace `/proc/<pid>` directory `stat.mtime` in `liveness.ts` with `ps -p <pid> -o lstart=` (or safe `null` fallback).
2. **Fix F-02**: Ensure `reclaimStaleLock` releases `reclaim.lock` cleanly on replacement lock collisions or exceptions.
3. **Add Tests**: Add regression tests specifically covering:
   - Contender collision during reclamation replacement lock creation.
   - Fault-injection during reclamation unwind.
   - Non-mocked process termination detection.
4. **Document Limitation F-03**: Explicitly document in user-facing CLI error messages and README that mapped network shares (`Z:\`, NFS mounts) are unsupported for multi-process concurrency.

Once F-01 and F-02 are remediated in a targeted bug-fix task, the transaction lock manager will meet all safety criteria for `APPROVED_FOR_WAL_IMPLEMENTATION`.
