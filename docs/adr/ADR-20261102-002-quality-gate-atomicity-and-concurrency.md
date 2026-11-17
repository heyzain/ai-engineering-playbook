# Architecture Decision Record (ADR)

# ADR-20261102-002: Quality Gate Execution Isolation, Atomic Log-State WAL Transactions, and Non-Circular Evidence Hashing

> **Template Version**: 1.0.0  
> **Applicable Stages**: Quality Gates Architecture & CI Integration (Task 005A.4)  
> **Storage Location**: `docs/adr/ADR-20261102-002-quality-gate-atomicity-and-concurrency.md`

---

## 1. ADR Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-20261102-002` |
| **Title** | Quality Gate Execution Isolation, Atomic Log-State WAL Transactions, and Non-Circular Evidence Hashing |
| **Status** | `Accepted` |
| **Creation Date** | `2026-11-02` |
| **Last Updated** | `2026-11-02` (Adversarially Refined under Task 005A.4) |
| **Author(s)** | AI Engineering Controller & Systems Architect |
| **Lead Approver** | Zain Ali (Lead Engineer & Architect) |
| **Impacted Subsystems** | Playbook CLI Quality Runner, Write-Ahead Log (WAL), Lock Manager, JSON Schemas, Evidence Verifier |

---

## 2. Context and Problem Statement

Task 005A designed an automated Quality Gate execution engine for the AI Engineering Playbook. Adversarial reviews (Task 005A.2 and Task 005A.4) identified five critical architectural correctness requirements:
1. **Evidence Hash Circularity**: Storing a file's own calculated SHA-256 hash inside its own header or footer creates a circular dependency. The hashing contract must be non-circular, mathematically reproducible, and match the existing `EvidenceVerifier` implementation.
2. **Schema Incompatibility**: `schemas/project-state.schema.json` strictly enforces `"additionalProperties": false` on `deliverables[].evidence[]`. Undeclared fields (`rif`, `dirty_tree`) cannot be written directly to `state.json`.
3. **Transaction API Alignment**: The design must strictly conform to `WriteAheadTransactionManager.executeTransaction()` in `src/core/transaction/transaction-manager.ts`, which accepts an array of `(FileWriteSpec | FileOperationSpec)[]`.
4. **Lock Duration & Concurrency**: Holding `.playbook/transaction.lock` during external test execution exceeds the default 10-second lock timeout (`lockTimeoutMs = 10000`). Phase 4 command execution must run unlocked; lock acquisition is strictly confined to Phase 5.
5. **Multi-File Crash Recovery & Visibility**: On POSIX and Windows filesystems, multiple file renames cannot occur simultaneously in a single atomic syscall. The design must define exact operation ordering (`files[0]` = canonical log, `files[1]` = `state.json`) and distinguish logical crash recoverability from external reader visibility.

---

## 3. Decision Drivers

- **Constitutional Principle 3 (Determinism Over Heuristics)**: System invariants (lock timeouts, state consistency, hash reproduction) must be asserted deterministically without heuristic race conditions.
- **Constitutional Principle 4 (Simplicity & YAGNI)**: Reuse the existing `WriteAheadTransactionManager` and `TransactionLockManager` without creating new parallel locking or journaling subsystems.
- **Constitutional Principle 6 (Explicit Contracts)**: Respect existing JSON schema boundaries (`additionalProperties: false`) without writing illegal properties to disk.
- **Constitutional Principle 8 (Fail-Closed Governance)**: A committed state must never reference an incomplete, corrupted, or missing evidence log.
- **Intellectual Honesty**: Do not claim atomicity beyond what the filesystem implementation physically provides. Distinguish logical crash-recovery from concurrent read visibility.

---

## 4. Considered Alternatives

### Alternative A: Self-Referential Log Hashes with Parser Stripping
- *Description*: Include `Log SHA-256: <hash>` inside the log footer, and have verifiers strip that line before hashing.
- *Rejection Rationale*: Brittle, non-standard, and directly conflicts with `EvidenceVerifier` (`src/core/evidence/verifier.ts`), which reads the raw buffer of the file on disk (`crypto.createHash("sha256").update(buffer).digest("hex")`). Changing the verifier would break existing Stage 0–2 evidence verification.

### Alternative B: File-System Promotion Outside WAL with Post-Commit Callbacks
- *Description*: Stream logs directly to canonical names under `.playbook/logs/` and update `state.json` via WAL. Use assumed post-commit callbacks to finalize logs.
- *Rejection Rationale*: `WriteAheadTransactionManager` has no post-commit callback. Filesystem operations outside the WAL journal boundary introduce unjournaled side effects. If a crash occurs between log promotion and state commit, `state.json` does not reference the log, and WAL rollback cannot revert the filesystem write.

### Alternative C: Multi-File WAL Commit with Log-First Ordering & Non-Circular Byte Hashing (Chosen)
- *Description*:
  1. **Phase 4 Execution (Unlocked)**: Subprocesses stream output to an isolated staging file in `.playbook/.tmp/proc-<pid>-<nonce>.log`. Execution is completely unlocked.
  2. **Non-Circular Hash Assembly**: Assemble the finalized canonical log content in memory (Header + Captured Body + Footer). The log contains the RIF digest, but does **NOT** contain a self-referential file hash. Compute `canonical_log_sha256 = SHA256(finalizedLogBytes)`.
  3. **Strict Schema Compatibility**: Register `canonical_log_sha256` in `state.json` under `deliverables[].evidence[].evidence_hash`. No undeclared fields (`rif`, `dirty_tree`) are written to `state.json`.
  4. **Multi-File Atomic Transaction**: Pass two operations to `WriteAheadTransactionManager.executeTransaction()`:
     - `files[0]`: Canonical log `.playbook/logs/gate-stage-<N>-<check_id>-<timestamp>.log` (`createOnly: true`, `content: finalizedLogBytes`).
     - `files[1]`: `.playbook/state.json` (`content: serializedStateJson`, `expectedPreviousSha256`).
  5. **Ordered Visibility**: By committing `files[0]` (the log) before `files[1]` (`state.json`), external readers of `state.json` can never observe a dangling reference to a missing log, even during an interrupted commit.

---

## 5. Decision Outcome

**Accepted**: Alternative C is adopted as the authoritative architecture for Quality Gate execution, locking, evidence persistence, and hashing.

### Specific Architectural Contracts:

1. **Non-Circular Hashing Contract**:
   - The canonical evidence log on disk does **not** contain a self-referential log hash field.
   - The authoritative evidence hash is stored in `state.json` as `evidence_hash: "sha256:<64 hex>"`.
   - `evidence_hash` covers the **entire canonical log file byte-for-byte** in UTF-8 encoding.
   - The log header includes `RIF: sha256:<rif_digest>`. Thus, `evidence_hash` cryptographically seals the RIF metadata without circularity.
   - Verification via `EvidenceVerifier` reproduces the hash by reading the raw file buffer on disk without parser stripping.
2. **Ordered Multi-File WAL Operation**:
   - Operations in `executeTransaction()` are ordered:
     - `files[0]`: Canonical log file (`createOnly: true`).
     - `files[1]`: `.playbook/state.json` (`expectedPreviousSha256`).
   - If a crash occurs during `COMMITTING` after `files[0]` is written but before `files[1]` is written:
     - External readers of `state.json` observe the pre-transaction state (which does not reference the new log).
     - Upon subsequent CLI invocation, `recover()` rolls forward `files[1]`, bringing `state.json` into synchronization.
3. **External Reader Visibility Boundary (Intellectual Honesty)**:
   - On commodity filesystems, two separate file renames cannot be made visible simultaneously to uncoordinated readers.
   - External processes reading `state.json` without acquiring `.playbook/transaction.lock` may observe pre-transaction state while the log is already on disk.
   - To guarantee point-in-time consistency, concurrent tools must inspect `.playbook/tx-journal.json` or acquire `.playbook/transaction.lock`.
4. **Log Size-Capping & Journal Durability**:
   - To prevent journal bloat in `tx-journal.json`, logs exceeding 2 MB (`max_journaled_log_bytes`) are middle-truncated with an explicit notice, preserving head (metadata) and tail (results/failures).
   - `evidence_hash` is computed over the final, persisted, truncated byte representation.
5. **PID-Based Staging File Reaping**:
   - Staging files `.playbook/.tmp/proc-<pid>-<nonce>.log` and `.playbook/.tmp/proc-<pid>-<nonce>.meta.json` record process metadata (`pid`, `nonce`, `hostname`, `created_at`).
   - Cleanup is executed using `defaultProcessLivenessChecker` (`src/core/lock/liveness.ts`).
   - Staging files are reaped **only if `isVerifiedDead === true`**. Indeterminate, cross-host, or live processes are never touched.
   - Wildcard deletion (`rm -rf *.log`) across `.playbook/logs/` is strictly prohibited.

---

## 6. Compliance and Verification Notes

- **Verification Method**: Verified against `tooling/playbook-cli/src/core/transaction/transaction-manager.ts`, `src/core/lock/liveness.ts`, and `src/core/evidence/verifier.ts`.
- **Audit Traceability**: Formally resolves Priority 1 (Circularity), Priority 2 (Crash-State Matrix), Priority 3 (RIF Canonicalization), Priority 4 (Staging Reaping), and Priority 5 (Evidence Retention) of Task 005A.4.
