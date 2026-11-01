# Task 004F.1.1 — Lifecycle Reopening Architecture Review Corrections Report

> **Component**: Controlled Lifecycle Reopening Governance Architecture  
> **Package**: `@ai-engineering-playbook/cli`  
> **Author**: AI Engineering Controller  
> **Date**: 2026-11-01  
> **Task Ref**: Task 004F.1.1 (Revising Task 004F.1)  
> **Revised Specification**: [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) (v1.1.0)  
> **Status**: Completed Architectural Specification Review & Corrections Report  

---

## 1. Executive Summary & Verdict

Following architecture review feedback on Task 004F.1, this task revised [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) to eliminate all architectural discrepancies, align locking and transaction descriptions with real implemented code, formalize inherited Stage 0 prerequisite rules, verify multi-milestone closure compatibility against existing runtime code, and refine terminology.

In accordance with task constraints, **no runtime code was changed, no schemas were altered, and no new CLI commands were implemented**.

### Final Verdict

```
DESIGN_READY_FOR_REVIEW
```

> [!NOTE]
> All seven required correction areas have been fully addressed in the design document. The revised architecture adheres strictly to the existing codebase ground truths, preserves the immutability guarantees of completed milestone snapshots, and prevents AI agent self-reopening.

---

## 2. Source Files Inspected

To ensure absolute fidelity to the actual implementation, the following codebase components were audited:

| Source File | Subsystem / Area | Key Ground Truth Verified |
| :--- | :--- | :--- |
| [`tooling/playbook-cli/src/core/lock/lock-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/lock-manager.ts) | Transaction Lock Manager | Lock file is `.playbook/transaction.lock` (not `.playbook/playbook.lock`). Uses `O_CREAT \| O_EXCL` (`wx` flag) with JSON `LockMetadata`. Uses `.playbook/reclaim.lock` for safe stale lock reclamation. No OS `flock` syscall. |
| [`tooling/playbook-cli/src/core/lock/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/types.ts) | Lock Data Models & Errors | Error codes: `LOCK_HELD_BY_ACTIVE_PROCESS`, `CROSS_HOST_LOCK_UNVERIFIABLE`, `LOCK_TIMEOUT`. |
| [`tooling/playbook-cli/src/core/lock/liveness.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/lock/liveness.ts) | Process Liveness Detection | `process.kill(pid, 0)` on POSIX / `tasklist` on Windows, start-time verification to detect recycled PIDs. |
| [`tooling/playbook-cli/src/core/transaction/transaction-manager.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/transaction-manager.ts) | WAL Transaction Engine | WAL engine only supports `FileWriteSpec` (`targetPath`, `content`). Does not support atomic file deletion entries in journal. |
| [`tooling/playbook-cli/src/core/advancement.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/advancement.ts) | Advancement & Closure Engine | `advancement.ts` line 101 only blocks `completed_terminal`. Permits `reopened_maintenance` through Stages 1–6 without code changes. Stage 6 `CLOSE_LIFECYCLE` creates snapshot `state-${state.milestone_id}.json` and returns to `completed_terminal`. |
| [`tooling/playbook-cli/src/commands/approve.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts) | Interactive CLI Approval | Enforces `TTY_REQUIRED` on non-TTY calls. Rejects AI names (`AGENT_APPROVAL_PROHIBITED`). Prompts for confirmation phrase and real engineering roles without inventing defaults. |
| [`schemas/project-state.schema.json`](file:///f:/workspace/ai-engineering-playbook/schemas/project-state.schema.json) | State Contract | `lifecycle_status: "reopened_maintenance"`. `archived_milestones[]` schema fields. |

---

## 3. Correction-by-Correction Explanation

### Correction 1: Existing Lock Manager Integration
- **Previous Discrepancy**: The initial design incorrectly referenced `flock` and `.playbook/playbook.lock`.
- **Revision Applied**:
  - Corrected lock file to canonical `.playbook/transaction.lock` (defined in `DEFAULT_PATHS.lockFile`).
  - Documented actual mechanism: atomic file creation using `fs.openSync` with `O_CREAT | O_EXCL` flags, writing structured `LockMetadata` (`pid`, `hostname`, `created_at`, `nonce`).
  - Documented contention behavior: exponential backoff with jitter up to `lockTimeoutMs` (default 10,000 ms), failing with `LOCK_HELD_BY_ACTIVE_PROCESS`.
  - Documented stale lock reclamation: serialized through `.playbook/reclaim.lock`, verifying process liveness and start-time to detect PID recycling.
  - Documented genuine limitations: cross-host locks fail closed with `CROSS_HOST_LOCK_UNVERIFIABLE`; non-POSIX network filesystems (NFS/CIFS) with non-atomic exclusive creation require caution.

### Correction 2: Stage 1 Inherited Prerequisite
- **Previous Discrepancy**: The role of Stage 0 `PRD-CORE` in a Stage 1 maintenance milestone was vaguely stated as "linked".
- **Revision Applied**:
  - **Artifact Reference**: The baseline `PRD-CORE.md` remains under `docs/prd/PRD-CORE.md`. Stage 1 active baseline deliverables are `REQ-SPEC` and `TEST-STRATEGY`.
  - **Applicability Assessment**: In Stage 1, the author of `REQ-SPEC` and the human reviewer at Gate 1 must explicitly assess whether the problem formulation in `PRD-CORE` remains valid for the maintenance milestone.
  - **Blocking Outdated Prerequisites**: If `PRD-CORE` is outdated or a fundamental problem pivot has occurred, Stage 1 progression is **BLOCKED**. The milestone must be reopened at **Stage 0** (`playbook reopen --stage 0`) with formal problem discovery and human sign-off.
  - **Recording Modifications**: Minor scope refinements are captured as an amendment section in `PRD-CORE.md` or via a Clarification RFC.
  - **Separation of Deliverables**: Inherited material is **never automatically marked verified**. Stage 1 deliverables are freshly initialized with `status: "not_started"`, `validation_status: "unvalidated"`, and empty `evidence: []`.

### Correction 3: Reopened Lifecycle Closure
- **Previous Discrepancy**: Did not fully articulate how multiple iterative reopening cycles transition to completion.
- **Revision Applied**:
  - Mapped the complete multi-milestone progression: $\text{M-1.0.0} \rightarrow \text{M-1.1.0} \rightarrow \text{M-2.0.0}$.
  - Verified that [`core/advancement.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/advancement.ts) allows `reopened_maintenance` to advance through Stages 1–5 without blocking.
  - Verified that advancing Stage 6 under `reopened_maintenance` cleanly executes `CLOSE_LIFECYCLE`, returning `lifecycle_status` to `completed_terminal`, preserving prior `archived_milestones`, and creating a new snapshot at `.playbook/milestones/state-M-1.1.0.json`.
  - Documented that subsequent reopening appends `M-1.1.0` to `archived_milestones[]` (which now holds both `M-1.0.0` and `M-1.1.0`), re-initializing `stage_history = []`.

### Correction 4: Approval Sidecar and WAL Recovery
- **Previous Discrepancy**: Implied sidecar deletion could be recorded as a journaled WAL entry.
- **Revision Applied**:
  - Inspected WAL engine: `WriteAheadTransactionManager` only supports file write specifications (`FileWriteSpec`). It does not have a native atomic file deletion journal entry type.
  - Defined idempotent post-commit cleanup: `safeUnlink` is executed during transaction finalization.
  - Formulated **fail-closed defense**:
    - If a crash occurs after `state.json` and `manifest.json` are committed but before sidecar deletion:
      1. `state.stage_status` is `"not_started"`, so `playbook advance` rejects with `ADVANCEMENT_BLOCKED`.
      2. The lingering sidecar has `gate: 6`, which mismatches active stage `1` (or `0`), rejecting with `APPROVAL_FINGERPRINT_MALFORMED`.
      3. The sidecar fingerprint does not match the new milestone ID, new stage deliverables, or empty evidence, rejecting with `APPROVAL_STALE`.
    - When `playbook approve` is eventually called for the new stage gate, it atomically overwrites the sidecar.
  - Concluded that no secondary transaction mechanism is required.

### Correction 5: Historical Record Accessibility
- **Previous Discrepancy**: Did not clearly delineate where RFCs, exceptions, and non-terminal exit packages from prior milestones reside.
- **Revision Applied**:
  - Defined the three complementary historical layers:
    1. `archived_milestones[]` in `state.json`: Summary metadata, completed timestamp, final stage (6), exit package reference, and the full 7-stage history array.
    2. **Governance-Frozen Snapshot (`.playbook/milestones/state-<milestone_id>.json`)**: The authoritative, complete machine-readable source of truth for all granular records (deliverables, evidence hashes, test summaries, approval conditions, RFC decisions, exception records).
    3. **Filesystem & Git History**: Markdown artifacts in `docs/` and logs in `.playbook/logs/` physically remain in place; Git commits provide permanent cryptographic audit logs.

### Correction 6: Snapshot Preservation Terminology
- **Previous Discrepancy**: Used phrases like "permanent immutability" and "hardware-immutable".
- **Revision Applied**:
  - Standardized terminology across the entire document:
    - **Governance-frozen snapshot** (conventionally sealed by Playbook tooling).
    - **Historical preservation**.
    - **Integrity verification** (SHA-256 collision detection).
    - **Git-backed history where available**.
  - Explicitly acknowledged that filesystem read-only permissions (`0o444`) provide local advisory write protection against accidental overwrites, but do not provide technical non-repudiation or physical immutability against intentional out-of-band manipulation. Permanent tamper-resistance relies on Git-backed history, signed commits, and protected repository branches.

### Correction 7: CLI Contract Consistency
- **Previous Discrepancy**: Proposed CLI flags that could bypass interactive human confirmation or invent default roles.
- **Revision Applied**:
  - Aligned strictly with `playbook approve`:
    - Mandatory interactive terminal session (`process.stdin.isTTY === true`); headless invocations reject with `TTY_REQUIRED`.
    - Reviewer name, role, reason, and milestone ID are prompted interactively in TTY if omitted.
    - No invented default organizational roles (e.g. `"Lead Architect"` removed as an automatic default; real title must be entered).
    - Confirmation phrase (`CONFIRM REOPEN MILESTONE <NEW_ID>`) must be interactively typed. Flags do not provide a non-TTY bypass.
    - `--json` formats terminal output into machine-readable JSON at conclusion, but still requires interactive human confirmation.

---

## 4. Test Matrix Recheck

The test matrix in Section 10 was expanded to 18 scenarios, explicitly covering:
- Lock contention and stale reclamation on `.playbook/transaction.lock` (**TEST-REOPEN-16**).
- WAL write-only capabilities and crash recovery (**TEST-REOPEN-14**, **TEST-REOPEN-15**).
- Approval sidecar fail-closed defense on lingering sidecars (**TEST-REOPEN-10**).
- Inherited prerequisite applicability verification (**TEST-REOPEN-17**).
- Multi-cycle sequential reopening and closure (**TEST-REOPEN-13**).

---

## 5. Remaining Limitations

1. **Local Mutability Boundary**: The milestone snapshot `.playbook/milestones/state-<milestone_id>.json` is conventionally protected by the CLI and local `0o444` permissions, but is stored within the mutable repository filesystem. Absolute non-repudiation requires pushing Git commits with GPG-signed tags to protected remote repositories.
2. **Reviewer Identity**: TTY checks and confirmation phrases prevent automated AI agent self-triggering, but rely on claimed human names. Cryptographic identity proof is enforced at the version control and git forge boundaries.
3. **Inherited Deliverables Traceability**: In Stage 1 maintenance, the link between new requirements (`REQ-SPEC`) and the inherited `PRD-CORE` is established through documentation references and human gate review, rather than an automated AST cross-compiler.

---

## 6. Conclusion & Recommendation

The revised architectural specification [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) (v1.1.0) is complete, truthful, and fully aligned with the codebase implementation.

**Final Verdict**: `DESIGN_READY_FOR_REVIEW`  
The design is ready for review and subsequent implementation under Task 004F.2.
