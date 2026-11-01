# Task 004F.2.1 — Lifecycle Reopening Implementation Integrity Audit Report

> **Audited Component**: Controlled Lifecycle Reopening Engine & CLI Command  
> **Package**: `@ai-engineering-playbook/cli`  
> **Audited Implementation Commit**: `6dd681274fbe431525a74656ca89787ffc9bb0a8`  
> **Authoritative Specification**: [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) (v1.1.0)  
> **Auditor**: AI Engineering Controller  
> **Audit Date**: 2026-11-01  
> **Status**: `APPROVED_WITH_DOCUMENTED_LIMITATIONS`  

---

## 1. Executive Summary & Verdict

This audit conducted an independent, code-level integrity audit of the Task 004F.2 implementation of Controlled Lifecycle Reopening (`REOPEN_LIFECYCLE`, `playbook reopen`).

The audit verified transaction safety, process mutex locking, milestone archival immutability, sidecar cleanup mechanics, and anti-agent authorization guardrails. 

Crucially, the audit identified and resolved a **Stage 1 Prerequisite Applicability Gap**: the initial implementation in commit `6dd6812` enforced only a raw disk existence check for `docs/prd/PRD-CORE.md`, but lacked a mechanism for the author to declare whether the inherited PRD remained semantically applicable, lacked human reviewer visibility of that assessment, and failed to block progression when a problem formulation was obsolete or invalidated.

A targeted, narrow correction was implemented in [`src/core/prd-applicability.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/prd-applicability.ts), integrated into [`checkGateEligibility`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts), [`runApprove`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts), and [`DiagnosticsEngine`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/diagnostics/engine.ts). Eight dedicated audit tests were added in [`tests/prd-applicability.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/prd-applicability.test.ts).

### Final Audit Verdict

```
APPROVED_WITH_DOCUMENTED_LIMITATIONS
```

All 184 automated tests across all 14 test suites pass with zero failures.

---

## 2. Audit Findings & Corrections

### Finding F-1 (Severity: MEDIUM-HIGH) — Stage 1 Prerequisite Applicability Assessment Gap

- **Source Locations**:
  - `tooling/playbook-cli/src/core/approval.ts` (lines 252–265)
  - `tooling/playbook-cli/src/commands/approve.ts` (lines 165–175)
  - `tooling/playbook-cli/src/core/diagnostics/engine.ts` (lines 215–235)
- **Design Requirement**:
  - [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) Section 4.3 mandates:
    1. The author of `REQ-SPEC` must assess whether `docs/prd/PRD-CORE.md` remains applicable to the new maintenance milestone.
    2. The assessment must be recorded in an explicitly reviewable deliverable.
    3. The Gate 1 reviewer must see and evaluate the author's determination.
    4. Stage 1 progression must be BLOCKED if the original problem formulation is no longer valid.
    5. A fundamental problem pivot requires reopening at Stage 0 (`playbook reopen --stage 0`).
- **Audit Observation**:
  - In commit `6dd6812`, `checkGateEligibility` only checked `fs.existsSync(prdCorePath)`.
  - If `PRD-CORE.md` existed on disk, Gate 1 eligibility passed unconditionally, even if the problem statement was completely obsolete or invalidated by domain expansion.
  - The human reviewer in `playbook approve` was only shown static text instructing them to confirm validity, with zero visibility into whether the author had evaluated the PRD or recorded a determination.
- **Targeted Correction Made**:
  1. Created [`src/core/prd-applicability.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/prd-applicability.ts) with `evaluatePrdApplicability(targetDir, stageDetail)`.
     - Supports explicit assessment in `docs/prd/PRD-CORE-ASSESSMENT.md` (or a deliverable named `PRD-ASSESSMENT`), OR within an assessment section of `docs/prd/REQUIREMENTS-SPEC.md` (`REQ-SPEC`).
     - Parses machine-readable determination keywords:
       - `Applicability: APPLICABLE` / `VALID` / `CONFIRMED` -> `applicable`
       - `Applicability: OUTDATED` / `INVALID` / `PIVOT_REQUIRED` / `INAPPLICABLE` -> `outdated`
       - Missing determination keyword -> `ambiguous`
       - Neither artifact found -> `missing`
  2. Updated `checkGateEligibility` in [`src/core/approval.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts):
     - If assessment is `missing`: raises `GATE_CRITERIA_UNMET` ("Inherited PRD applicability assessment is missing...").
     - If assessment is `outdated`: raises `GATE_CRITERIA_UNMET` ("Inherited foundational Problem Statement in 'docs/prd/PRD-CORE.md' is marked OUTDATED. Stage 1 progression is BLOCKED. A fundamental domain pivot requires re-opening at Stage 0.").
     - If assessment is `ambiguous`: raises `GATE_CRITERIA_UNMET` requiring an explicit `APPLICABLE` or `OUTDATED` determination.
  3. Updated `runApprove` in [`src/commands/approve.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts):
     - The Gate 1 review panel extracts and displays the author's determination, artifact location, summary, and invalidation reason.
  4. Updated `DiagnosticsEngine` in [`src/core/diagnostics/engine.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/diagnostics/engine.ts):
     - Added `PRD_ASSESSMENT_OUTDATED` (severity: `error`, readiness: `blocked`) and `PRD_ASSESSMENT_MISSING`.

---

## 3. Subsystem Audit & Verification

### A. Transaction & Sidecar Mechanics
- **State & Manifest Consistency**: `reopenLifecycle` uses `WriteAheadTransactionManager` (`.playbook/tx-journal.json`) to commit `.playbook/state.json` and `.playbook/manifest.json` under atomic two-phase write.
- **Lock Management**: Uses `TransactionLockManager` (`.playbook/transaction.lock`) with atomic `wx` flag and process liveness checks. Contended locks throw `LOCK_TIMEOUT` on expiration.
- **WAL Crash Recovery**:
  - Crash after `PREPARED`: Journal rolls back cleanly to preceding state on recovery (verified in `tests/reopen.test.ts` Scenario 14).
  - Crash after `COMMITTING`: Journal rolls forward cleanly to committed maintenance state on recovery (verified in `tests/reopen.test.ts` Scenario 15).
- **Post-Commit Sidecar Unlinking**: Approval sidecar (`.playbook/approval-fingerprint.json`) is unlinked post-commit via `safeUnlink()`.
- **Fail-Closed Stale Sidecar Security**: If an unhandled crash or race leaves the old sidecar on disk:
  - The sidecar specifies `gate: 6`, while active stage is `1` (or `0`). Advancing fails with `APPROVAL_FINGERPRINT_MALFORMED`.
  - The sidecar fingerprint hashes the prior milestone ID (`M-1.0.0`), failing hash verification against new milestone ID (`M-1.1.0`) with `APPROVAL_STALE`.
- **Subsequent Valid Approval**: When Gate 1 approval succeeds, `approveGate` overwrites the sidecar with the new Gate 1 fingerprint and new milestone ID (verified in `tests/prd-applicability.test.ts` Scenario 7).
- **Multiple Reopening Cycles**: Advancing Stage 6 under `reopened_maintenance` seals a new snapshot (`state-<milestone_id>.json`), preserves prior `archived_milestones[]`, and returns to `completed_terminal`, enabling subsequent reopening cycles (`M-1.0` -> `M-1.1` -> close -> `M-2.0`).

### B. Lifecycle & Historical Integrity
- **Eligibility Preconditions**: Only `completed_terminal` is accepted. `active`, `paused`, and `reopened_maintenance` are strictly rejected (`LIFECYCLE_NOT_TERMINAL`, `LIFECYCLE_ALREADY_REOPENED`).
- **Milestone Snapshot Verification**: Verifies `.playbook/milestones/state-<current_id>.json` exists before reopening (`SNAPSHOT_MISSING`).
- **Milestone Archival**: The preceding milestone is appended to `archived_milestones[]`, preserving milestone ID, name, completion timestamp, final stage (6), completed stage history, and exit package reference.
- **Milestone ID Collision Defense**:
  - Rejects new milestone IDs matching active milestone (`MILESTONE_ID_COLLISION`).
  - Rejects new milestone IDs matching previously archived milestones (`MILESTONE_ID_COLLISION`).
  - Rejects new milestone IDs whose snapshot file already exists on disk (`MILESTONE_ID_COLLISION`).
- **Fresh Evidence Invariant**: Deliverables in the reopened milestone start in status `unvalidated` with empty `evidence: []`. Historical evidence is never reused to claim maintenance completion.

### C. Human Authorization & Anti-Agent Guardrails
- **Mandatory TTY Session**: Both `runReopen` and `reopenLifecycle` enforce interactive terminal sessions. Automated or piped calls reject with `TTY_REQUIRED` (`exit code 1`). The `--json` flag formats output only; it never bypasses interactive confirmation.
- **Exact Confirmation Phrase**: Authorizer must type the exact phrase `CONFIRM REOPEN MILESTONE <NEW_ID>`.
- **Prohibited Agent Names**: Authorizer names matching AI agent substrings (`AI-Agent`, `Bot-Reviewer`, `Playbook-Controller`, etc.) are rejected with `AGENT_REOPEN_PROHIBITED`.
- **Honest Reviewer Identity**: Prompts require explicit authorizer name and role without synthetic or default values.

---

## 4. Test Verification Matrix

### Suite Summary

```
✔ tests: 184 passed, 0 failed (14 suites)
```

| Test Suite File | Tests | Status | Key Coverage |
| :--- | :---: | :---: | :--- |
| [`tests/prd-applicability.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/prd-applicability.test.ts) | 8 | **PASSED** | Applicable PRD, Outdated PRD, Missing assessment, Human reviewer visibility, Stage 0 pivot path, Attempted Gate 1 approval rejection, Sidecar replacement |
| [`tests/reopen.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/reopen.test.ts) | 15 | **PASSED** | Reopen eligibility, TTY enforcement, confirmation phrase, agent rejection, collision defense, WAL crashes, multi-cycle closure |
| [`tests/advancement.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/advancement.test.ts) | 12 | **PASSED** | Stage advancement, drift detection, fingerprint validation, closure snapshot |
| [`tests/approval.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/approval.test.ts) | 27 | **PASSED** | Gate approval, TTY check, phrase confirmation, baseline deliverable checks, exception waivers |
| [`tests/cli.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/cli.test.ts) | 5 | **PASSED** | CLI binary execution, `--version`, `--help`, init, validate |
| [`tests/governance-consistency.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/governance-consistency.test.ts) | 5 | **PASSED** | Schema and constitution consistency |
| [`tests/init.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/init.test.ts) | 8 | **PASSED** | Project bootstrapping, scaffold directories, collision defense |
| [`tests/inspect.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/inspect.test.ts) | 17 | **PASSED** | Read-only inspection, diagnostic codes, readiness assessment |
| [`tests/lifecycle-e2e.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/lifecycle-e2e.test.ts) | 4 | **PASSED** | End-to-end lifecycle progression (Stages 0–6) |
| [`tests/lock-manager.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/lock-manager.test.ts) | 24 | **PASSED** | Mutex locking, PID liveness, stale reclaim, fault injection |
| [`tests/paths.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/paths.test.ts) | 4 | **PASSED** | Cross-platform POSIX path normalization |
| [`tests/transaction-manager.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/transaction-manager.test.ts) | 27 | **PASSED** | WAL journal, atomic commits, rollback/forward recovery |
| [`tests/validator.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/validator.test.ts) | 10 | **PASSED** | Schema validation, JSON pointers, Draft 2020-12 |
| [`tests/verify-evidence.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/verify-evidence.test.ts) | 18 | **PASSED** | Evidence verification, SHA-256 hashes, path traversal defense |
| **Total** | **184** | **PASSED** | **14 Suites, 184 Tests, 0 Failures** |

---

## 5. Build & Typecheck Verification Evidence

### TypeScript Type Checking & Production Build
```bash
cd tooling/playbook-cli
npm run build
```
- **Exit Code**: `0`
- **Output**:
  ```
  > @ai-engineering-playbook/cli@1.0.0 build
  > npm run sync-schemas && tsc && node -e "const fs = require('fs'); fs.cpSync('src/schemas', 'dist/src/schemas', {recursive: true});"
  ```
- **Diagnostics**: `0 errors, 0 warnings`

### Full Test Suite Execution
```bash
cd tooling/playbook-cli
npm test
```
- **Exit Code**: `0`
- **Total Test Suites**: `14`
- **Total Tests Passed**: `184`
- **Total Tests Failed**: `0`
- **Execution Duration**: `~28.1s`

---

## 6. Documented Limitations & Operational Boundaries

In adherence to constitutional truthfulness standards:

1. **Semantic Validity vs Syntax**: The tooling verifies that an applicability assessment artifact exists, parses machine-readable determination keywords (`APPLICABLE` vs `OUTDATED`), and surfaces the rationale to the reviewer. The semantic correctness of the assessment remains the exclusive responsibility of the human Gate 1 reviewer.
2. **Local Mutex Boundary**: Locking protects concurrent processes operating within the same repository workspace filesystem. It does not synchronize concurrent processes across distributed git clones or unmounted remote environments.
3. **Identity Verification Scope**: Authorizer identity enforcement relies on TTY interactive session heuristics and forbidden agent name matching. It does not perform cryptographic digital signature verification or integrate with an external identity provider (IdP).
4. **Governance-Frozen Snapshots**: Archival snapshots (`state-<milestone_id>.json`) are protected from accidental modification by CLI collision checks and read-only flags; however, an operator with write privileges on the filesystem can technically alter local files out-of-band.
