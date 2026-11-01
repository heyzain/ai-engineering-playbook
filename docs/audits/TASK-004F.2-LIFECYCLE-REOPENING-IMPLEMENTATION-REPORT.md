# Task 004F.2 — Controlled Lifecycle Reopening Implementation Report

> **Component**: Controlled Lifecycle Reopening Engine & CLI Command  
> **Package**: `@ai-engineering-playbook/cli`  
> **Approved Design Specification**: [`governance/lifecycle-reopening-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/lifecycle-reopening-design.md) (v1.1.0, commit `65b7829199e378ae7eed58d595b8163a4884a75a`)  
> **Author**: AI Engineering Controller  
> **Date**: 2026-11-01  
> **Task Ref**: Task 004F.2  
> **Status**: Implementation Completed & Verified  

---

## 1. Executive Summary & Verdict

This task implemented the approved Controlled Lifecycle Reopening architecture (`REOPEN_LIFECYCLE`) as a production-grade CLI capability in `@ai-engineering-playbook/cli`. The `playbook reopen` command enables a previously closed project lifecycle (`completed_terminal`) to safely begin a new maintenance milestone (`reopened_maintenance`) under an authorized human decision.

The implementation was strictly integrated with the existing transaction engine (`WriteAheadTransactionManager`), mutex lock manager (`TransactionLockManager`), JSON Schema validators, approval engine (`checkGateEligibility`), and read-only diagnostics (`DiagnosticsEngine`).

All 176 automated test cases (including 15 new comprehensive integration and crash-recovery scenarios dedicated to reopening) pass with zero failures.

### Final Verdict

```
IMPLEMENTATION_READY_FOR_REVIEW
```

> [!IMPORTANT]
> The AI agent's authority boundary ends here. AI agents are structurally barred from self-authorizing lifecycle reopenings (`AGENT_REOPEN_PROHIBITED`). All changes are submitted for human architectural review.

---

## 2. Inventory of Changes & Files

### A. New Implementation Files

| File Path | Purpose |
| :--- | :--- |
| [`tooling/playbook-cli/src/core/reopen.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/reopen.ts) | Core lifecycle reopening engine (`reopenLifecycle`). Performs schema validation, eligibility verification, snapshot validation, collision defense, state transformation, and atomic WAL commit. |
| [`tooling/playbook-cli/src/commands/reopen.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/reopen.ts) | Interactive CLI command handler (`runReopen`). Enforces real TTY interactive session, prompts for missing inputs without default reviewer roles, validates confirmation phrase, and formats terminal review panels. |
| [`tooling/playbook-cli/tests/fixtures/reopen-worker.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/fixtures/reopen-worker.ts) | Subprocess test fixture simulating interactive terminal input with mock prompters for end-to-end CLI integration testing. |
| [`tooling/playbook-cli/tests/reopen.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/reopen.test.ts) | 15 comprehensive automated test scenarios covering eligibility, human authorization, milestone collisions, inherited prerequisites, locking contention, multi-cycle progression, and WAL crash recoveries. |
| [`docs/audits/TASK-004F.2-LIFECYCLE-REOPENING-IMPLEMENTATION-REPORT.md`](file:///f:/workspace/ai-engineering-playbook/docs/audits/TASK-004F.2-LIFECYCLE-REOPENING-IMPLEMENTATION-REPORT.md) | This formal audit and implementation verification report. |

### B. Modified Implementation & Governance Files

| File Path | Modifications Made |
| :--- | :--- |
| [`tooling/playbook-cli/src/constants.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/constants.ts) | Added `MILESTONE_REGEX = /^M-[a-zA-Z0-9.-]+$/` for canonical milestone identifier validation. |
| [`tooling/playbook-cli/src/core/transaction/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/types.ts) | Added error failure codes: `LIFECYCLE_NOT_TERMINAL`, `LIFECYCLE_ALREADY_REOPENED`, `INVALID_MILESTONE_ID`, `MILESTONE_ID_COLLISION`, `INVALID_REOPEN_STAGE`, `AGENT_REOPEN_PROHIBITED`, `CONFIRMATION_PHRASE_MISMATCH`, `SNAPSHOT_MISSING`, `REOPEN_BLOCKED`. |
| [`tooling/playbook-cli/src/core/diagnostics/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/diagnostics/types.ts) | Added diagnostic codes: `LIFECYCLE_REOPENED_MAINTENANCE`, `PRD_CORE_MISSING`, `INHERITED_PREREQUISITE_ASSESSMENT`. |
| [`tooling/playbook-cli/src/core/diagnostics/engine.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/diagnostics/engine.ts) | Added diagnostics evaluating `reopened_maintenance` readiness and checking disk existence of `docs/prd/PRD-CORE.md` when Stage 1 is active. |
| [`tooling/playbook-cli/src/core/approval.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts) | Updated `checkGateEligibility` to verify disk existence of inherited `docs/prd/PRD-CORE.md` during Stage 1 review in `reopened_maintenance`. |
| [`tooling/playbook-cli/src/commands/approve.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts) | Added inherited prerequisite review section to interactive terminal display during Gate 1 human approval under `reopened_maintenance`. |
| [`tooling/playbook-cli/src/bin/playbook.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/bin/playbook.ts) | Registered `playbook reopen` command with argument parsing, option flags (`--milestone`, `--name`, `--stage`, `--reason`, `--authorized-by`, `--role`, `--confirmation-phrase`, `--json`, `--cwd`), and help documentation. |
| [`tooling/playbook-cli/src/index.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/index.ts) | Exported `reopenLifecycle` and `runReopen` public API members. |
| [`tooling/playbook-cli/README.md`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/README.md) | Documented `playbook reopen` synopsis, options, invariants, and corrected lock/journal documentation. |
| [`AGENTS.md`](file:///f:/workspace/ai-engineering-playbook/AGENTS.md) | Added operational guidance for AI agents regarding post-terminal maintenance, inherited Stage 0 prerequisites, fresh evidence rules, and cross-reference to reopening design. |

---

## 3. Architecture & Contract Verification

### A. Lifecycle State Transition Eligibility
- **Strict Transition Path**: The engine validates that `state.lifecycle_status === "completed_terminal"`.
- **Rejection Matrix**:
  - `active` projects: Rejected with `LIFECYCLE_NOT_TERMINAL`.
  - `paused` projects: Rejected with `LIFECYCLE_NOT_TERMINAL`.
  - `reopened_maintenance` projects: Rejected with `LIFECYCLE_ALREADY_REOPENED`.
  - Non-existent projects: Rejected with `PROJECT_UNINITIALIZED`.

### B. Interactive Human Authorization & Anti-Agent Guardrails
- **Mandatory TTY Session**: Both `runReopen` and `reopenLifecycle` enforce interactive sessions. Headless executions or automated calls without a TTY fail with exit code 1 and error code `TTY_REQUIRED`. The `--json` flag formats output only and is barred from bypassing terminal checks.
- **Confirmation Phrase Enforcement**: Requires the exact typed string `CONFIRM REOPEN MILESTONE <NEW_ID>`. Any mismatch aborts immediately with exit code 1, zero modifications, and clean journal release.
- **Prohibited Agent Names**: Authorizer names matching AI agent patterns (`AI-Agent`, `Bot-Reviewer`, `Playbook-Controller`, `Claude-Assistant`, `gpt-4`, etc.) are rejected with `AGENT_REOPEN_PROHIBITED`.
- **No Default Roles**: The interactive prompter requires an explicit authorizer name, engineering role, and business reason; default or synthetic values are never supplied.

### C. Milestone Preservation & Collision Defense
- **Snapshot Immutability**: The engine checks that `.playbook/milestones/state-<current_milestone_id>.json` exists before reopening (`SNAPSHOT_MISSING`). It is never overwritten or deleted.
- **Milestone Archival**: The current completed milestone is preserved into `archived_milestones[]` in `.playbook/state.json`, including milestone ID, name, completion timestamp, final stage (6), completed stage history, and exit package reference.
- **Collision Defense**:
  - Validates milestone identifier format against `^M-[a-zA-Z0-9.-]+$`.
  - Rejects new milestone IDs that match the active milestone ID (`MILESTONE_ID_COLLISION`).
  - Rejects new milestone IDs matching any previously archived milestone ID (`MILESTONE_ID_COLLISION`).
  - Rejects new milestone IDs where a snapshot file `.playbook/milestones/state-<new_id>.json` already exists on disk (`MILESTONE_ID_COLLISION`).

### D. Stage Designation & Inherited Prerequisite Rules
- **Permitted Reopening Stages**:
  - Default: **Stage 1 (Requirements & Specification)** for incremental maintenance milestones.
  - Explicit: **Stage 0 (Discovery & Problem Formulation)** for fundamental domain pivots or problem reformulations.
  - Stages 2–6: Strictly barred (`INVALID_REOPEN_STAGE`).
- **Inherited Stage 0 Prerequisite (`PRD-CORE`)**:
  - In Stage 1 maintenance milestones, the original problem formulation (`docs/prd/PRD-CORE.md`) is inherited.
  - `checkGateEligibility` and `DiagnosticsEngine` verify that `docs/prd/PRD-CORE.md` exists on disk.
  - If missing, `PRD_CORE_MISSING` is raised, readiness status is set to `blocked`, and Gate 1 human approval is barred (`GATE_CRITERIA_UNMET`).
  - In `playbook approve`, the Gate 1 review panel renders an explicit Inherited Prerequisite Assessment notice to prompt human evaluation of whether PRD-CORE remains valid.
- **Fresh Evidence Discipline**: Newly initialized deliverables for the maintenance milestone start in status `unvalidated`. Historical evidence from prior milestones is never carried forward to mark maintenance deliverables verified.

### E. Transaction Engine, Mutex Locking & Crash Recovery
- **Single Unified Mutex Lock**: Uses `TransactionLockManager` at `.playbook/transaction.lock` with atomic `O_CREAT | O_EXCL` semantics and PID liveness checking. Contended locks throw `LOCK_TIMEOUT` after timeout expiration.
- **Unified WAL Transaction**: State transition (`.playbook/state.json`) and manifest synchronization (`.playbook/manifest.json`) are committed atomically via `WriteAheadTransactionManager` (`.playbook/tx-journal.json`).
- **Sidecar Cleanup & Fail-Closed Security**: Lingering approval sidecars (`.playbook/approval-fingerprint.json`) are safely unlinked post-commit. In simulated crash scenarios where a sidecar persists, the sidecar specifies `gate: 6`, which mismatches the active stage (1 or 0), causing `playbook advance` to reject with `APPROVAL_FINGERPRINT_MALFORMED`. Furthermore, the sidecar fingerprint hashes the prior milestone ID, failing hash verification with `APPROVAL_STALE`.
- **Fault Injection & Crash Recovery**:
  - Crash after `PREPARED`: Journal rolls back cleanly to previous state on recovery.
  - Crash after `COMMITTING`: Journal rolls forward cleanly to committed maintenance state on recovery.

### F. Multi-Cycle Lifecycle Closure Compatibility
- Advance on Stage 6 under `reopened_maintenance` advances cleanly into `CLOSE_LIFECYCLE`.
- It creates `.playbook/milestones/state-<maintenance_id>.json`, preserves all prior `archived_milestones[]`, returns lifecycle status to `completed_terminal`, and bars advancement beyond Stage 6.
- A project can subsequently undergo additional reopening cycles (e.g., `M-1.0` -> `M-1.1` -> close -> `M-2.0`).

---

## 4. Automated Test Verification Results

The automated test suite was executed across all 13 test suites using Node.js:

```bash
cd tooling/playbook-cli
npm test
```

### Test Suite Summary

| Test Suite File | Tests | Passed | Failed | Status |
| :--- | :---: | :---: | :---: | :---: |
| `tests/reopen.test.ts` | 15 | 15 | 0 | **PASSED** |
| `tests/advancement.test.ts` | 12 | 12 | 0 | **PASSED** |
| `tests/approval.test.ts` | 27 | 27 | 0 | **PASSED** |
| `tests/cli.test.ts` | 5 | 5 | 0 | **PASSED** |
| `tests/governance-consistency.test.ts` | 5 | 5 | 0 | **PASSED** |
| `tests/init.test.ts` | 8 | 8 | 0 | **PASSED** |
| `tests/inspect.test.ts` | 17 | 17 | 0 | **PASSED** |
| `tests/lifecycle-e2e.test.ts` | 4 | 4 | 0 | **PASSED** |
| `tests/lock-manager.test.ts` | 24 | 24 | 0 | **PASSED** |
| `tests/paths.test.ts` | 4 | 4 | 0 | **PASSED** |
| `tests/transaction-manager.test.ts` | 27 | 27 | 0 | **PASSED** |
| `tests/validator.test.ts` | 10 | 10 | 0 | **PASSED** |
| `tests/verify-evidence.test.ts` | 18 | 18 | 0 | **PASSED** |
| **Total** | **176** | **176** | **0** | **PASSED** |

### Dedicated Reopening Test Scenarios (`reopen.test.ts`)

1. **Scenario 1**: Completed terminal project reopens successfully to Stage 1 (default).
2. **Scenario 2**: Explicit Stage 0 reopening for fundamental domain pivot.
3. **Scenario 3**: Active, paused, or already reopened projects cannot be reopened (`LIFECYCLE_NOT_TERMINAL`, `LIFECYCLE_ALREADY_REOPENED`).
4. **Scenario 4**: Milestone ID validations and collision defense (format regex, active ID collision, snapshot disk collision).
5. **Scenario 5**: Agent-like authorizer names are strictly prohibited (`AGENT_REOPEN_PROHIBITED`).
6. **Scenario 6**: Missing prior milestone snapshot file blocks reopening (`SNAPSHOT_MISSING`).
7. **Scenario 7**: CLI reopen requires interactive TTY; headless calls reject with `TTY_REQUIRED` (`--json` does not bypass).
8. **Scenario 8**: Confirmation phrase mismatch aborts with zero mutations.
9. **Scenario 9**: Controlled worker execution with exact confirmation phrase reopens successfully.
10. **Scenario 10**: Sidecar unlinked and lingering sidecar fails closed against new milestone.
11. **Scenario 11**: Stage 1 inherited PRD-CORE prerequisite visibility & blocking check.
12. **Scenario 12**: Lock contention during reopen throws `LOCK_TIMEOUT`.
13. **Scenario 13**: Multi-cycle lifecycle: M-1.0 -> M-1.1 -> Stage 6 close -> M-2.0.
14. **Scenario 14**: WAL crash recovery during PREPARED rolls back cleanly.
15. **Scenario 15**: WAL crash recovery during COMMITTING rolls forward cleanly.

---

## 5. Known Limitations & Non-Negotiable Boundaries

In accordance with playbook truthfulness standards:

1. **Governance-Frozen Snapshot Scope**: Archival milestone snapshots (`state-<milestone_id>.json`) are protected by file existence collision checks and schema constraints within the repository workspace. In a single git clone where an operator has filesystem write access, true cryptographic hardware immutability does not exist.
2. **Authorizer Identity Verification**: Authorizer identity checking relies on interactive TTY presence, non-empty role input, and forbidden agent name heuristics. It does not authenticate cryptographic PKI keys or enterprise SSO tokens.
3. **Inherited Prerequisite Semantic Validity**: The tooling automatically verifies that `docs/prd/PRD-CORE.md` exists on disk to satisfy Stage 1 prerequisite entry criteria; however, confirming that the PRD's problem statement remains semantically aligned with the maintenance scope is a subjective human engineering judgment exercised during Gate 1 approval.
4. **Advisory Mutex Scope**: Transaction locking operates across processes accessing the same local filesystem directory topology. It does not synchronize concurrent operations across disparate network filesystems or unshared remotes.
