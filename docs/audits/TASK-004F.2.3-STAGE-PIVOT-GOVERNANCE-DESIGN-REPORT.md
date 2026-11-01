# Governance Audit & Architecture Report: Active Maintenance Milestone Stage Pivot Design

> **Document Reference**: `TASK-004F.2.3-STAGE-PIVOT-GOVERNANCE-DESIGN-REPORT.md`  
> **Status**: `DESIGN_READY_FOR_REVIEW`  
> **Task**: Task 004F.2.3 — Active Maintenance Milestone Stage Pivot Governance Design  
> **Date**: 2026-11-01  
> **Author**: AI Engineering Playbook Architecture Group  
> **Primary Deliverable**: [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) v1.1.0  
> **Referenced Standards**:
> - [`governance/state-machine.md`](../../governance/state-machine.md) v1.3.0
> - [`governance/lifecycle-reopening-design.md`](../../governance/lifecycle-reopening-design.md) v1.2.0
> - [`schemas/project-state.schema.json`](../../schemas/project-state.schema.json)
> - [`schemas/project-manifest.schema.json`](../../schemas/project-manifest.schema.json)

---

## 1. Executive Summary & Context

During Task 004F.2.2, an audit of the maintenance reopening workflow revealed a structural deadlock:
1. Under Controlled Lifecycle Reopening ([`governance/lifecycle-reopening-design.md`](../../governance/lifecycle-reopening-design.md)), a completed project can reopen at Stage 1, inheriting the foundational Problem Statement (`docs/prd/PRD-CORE.md`) from a prior milestone.
2. In Stage 1, the author and reviewer assess whether `PRD-CORE.md` remains applicable. If found to be `OUTDATED`, Gate 1 approval is blocked.
3. The previous specification suggested running `playbook reopen --stage 0` to resolve this. However, executing `reopen` on an active maintenance milestone is strictly rejected with `LIFECYCLE_ALREADY_REOPENED`.
4. Furthermore, the core state machine prohibited backward transitions, creating a state deadlock where an unapproved Stage 1 maintenance milestone with an obsolete PRD had no valid execution path forward or backward.

In Task 004F.2.3, **Option 2: `PIVOT_TO_STAGE_0`** was formally selected. This report documents the architectural design, formal state transitions, human authorization mechanics, historical preservation guarantees, transaction safety, test criteria, and scientific boundaries established in [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) v1.1.0.

**In accordance with instructions, this task is strictly DESIGN ONLY. No runtime code, CLI command implementation, schemas, or tests have been modified.**

---

## 2. Formal Transition Rules

### 2.1 State Mutation Contract
The transition `PIVOT_TO_STAGE_0` executes the following atomic mutation:

$$\Big(\text{lifecycle\_status: } \texttt{"reopened\_maintenance"},\, \text{current\_stage: } 1,\, \text{stage\_status: } \sigma\Big) \xrightarrow{\text{PIVOT\_TO\_STAGE\_0}} \Big(\text{lifecycle\_status: } \texttt{"reopened\_maintenance"},\, \text{current\_stage: } 0,\, \text{stage\_status: } \texttt{"not\_started"}\Big)$$

Where $\sigma \in \{\texttt{"not\_started"}, \texttt{"in\_progress"}, \texttt{"blocked"}, \texttt{"pending\_review"}\}$.

### 2.2 Invariant Precondition Matrix (Authoritative Validation Under Lock)

To eliminate Time-Of-Check to Time-Of-Use (TOCTOU) races, the engine validates all mandatory preconditions **exclusively under the transaction lock** against freshly read on-disk state. If any condition fails, the operation immediately aborts with zero side-effects:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Precondition Evaluation Order (Under Exclusive Lock)                   │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Lifecycle Status Guard: state.lifecycle_status === "reopened_maint" │
│ 2. Stage Boundary Guard:   state.current_stage === 1                   │
│ 3. Unapproved Stage Guard: state.stage_status !== "approved"           │
│ 4. Assessment Guard:       evaluatePrdApplicability().status == "outdated│
│ 5. Authorization Guard:    isatty(stdin) == true && exact phrase match │
│ 6. Justification Guard:    non-empty string rationale                  │
└────────────────────────────────────────────────────────────────────────┘
```

| Precondition | Target Check | Failure Diagnostic Code | Remediation / Rationale |
| :--- | :--- | :--- | :--- |
| **C1: Lifecycle Status** | Must be in `reopened_maintenance`. | `LIFECYCLE_NOT_MAINTENANCE` | Greenfield projects (`active`) start at Stage 0; closed projects (`completed_terminal`) must execute `playbook reopen --stage 0`. |
| **C2: Current Stage** | Must be exactly `1`. | `PIVOT_INVALID_STAGE` | Backward jumps from Stages 2–6 are barred. Re-pivoting from Stage 0 is invalid recursion. |
| **C3: Unapproved Stage** | Must not be `approved` or have `GATE_APPROVED` decision. | `STAGE_ALREADY_APPROVED` | Once human sign-off seals Gate 1, requirements are locked. Retroactive un-approval via pivot is prohibited. |
| **C4: PRD Applicability** | Evaluated assessment for active milestone must be `outdated`. | `PIVOT_PRD_NOT_OUTDATED` | If PRD is `applicable`, `missing`, or mismatched, pivot is unauthorized. Missing assessments must be drafted first. |
| **C5: Interactive TTY** | Active terminal session (`isatty(stdin) == true`). | `TTY_REQUIRED` | Prevents automated agents, scripts, or pipelines from executing emergency stage pivots. |
| **C6: Justification** | `--reason` must be non-empty string. | `PIVOT_REASON_REQUIRED` | Auditable governance requires an explicit rationale for discarding requirements baseline. |

---

## 3. Human Authorization & Interactive Guard

### 3.1 Proposed CLI Contract
```bash
playbook pivot --stage 0 [OPTIONS]
```

#### Required Parameters
- `--stage <N>`: Required integer, must be `0`. Target stages other than `0` fail with `PIVOT_TARGET_UNSUPPORTED`.
- `--authorized-by <NAME>`: Human operator name (e.g. `"Alice Engineer"`). Prompted interactively if omitted.
- `--role <ROLE>`: Professional role (e.g. `"Lead Architect"`). Prompted interactively if omitted.
- `--reason <REASON>`: Non-empty rationale. Prompted interactively if omitted.

### 3.2 Exact Confirmation Phrase
To eliminate inadvertent execution, the interactive prompt requires typing an exact milestone-bound phrase:

$$\texttt{"CONFIRM PIVOT TO STAGE 0 "} + \texttt{state.milestone\_id}$$

For example, when `milestone_id` is `M-1.1.0`:
```text
Confirm Stage Pivot to Stage 0:
This will archive current Stage 1 work, archive the outdated PRD-CORE.md,
and return the active milestone M-1.1.0 to Stage 0 for foundational problem reformulation.
Type exact phrase 'CONFIRM PIVOT TO STAGE 0 M-1.1.0' to proceed:
> CONFIRM PIVOT TO STAGE 0 M-1.1.0
```
Any mismatch in casing, spacing, or milestone ID terminates the execution with `PIVOT_ABORTED` and causes zero state mutations. Flags cannot bypass this interactive confirmation.

### 3.3 Asserted Identity & Trust Model
The authorization mechanism verifies interactive human agency via TTY checks and explicit typed confirmation phrases. In accordance with Playbook communication rules, this system does **not** claim cryptographic identity verification, PKI signatures, or OIDC authentication. Identity is asserted by the interactive operator and audited in repository records. Writing an audit document to `docs/pivots/` creates the file in the local working directory; it does **not** automatically commit it to Git. Committing working tree files requires explicit human Git operations (`git add` and `git commit`).

---

## 4. Historical Preservation Architecture

A foundational rule of the AI Engineering Playbook is: **no engineering work is silently discarded or erased**.

### 4.1 Unique Pivot Event Identity
Every pivot event is assigned a unique, deterministic ID: `PVT-<MILESTONE_ID>-<SEQ>` (e.g. `PVT-M-1.1.0-001`). Under the exclusive lock, sequence numbers advance monotonically without overwriting prior records. Repeated pivots within the same milestone are supported and preserved side-by-side.

### 4.2 Preservation Topology

```
.playbook/
├── pivots/
│   ├── state-PVT-M-1.1.0-001.json                    <-- OS write-protected snapshot (0o444)
│   └── state-PVT-M-1.1.0-002.json                    <-- Preserved on subsequent pivot
docs/
├── pivots/
│   ├── PVT-M-1.1.0-001.md                            <-- Markdown audit record (working tree)
│   └── PVT-M-1.1.0-002.md
└── prd/
    ├── archive/
    │   └── PRD-CORE.PVT-M-1.1.0-001.outdated.md      <-- Archived outdated PRD with warning banner
    ├── PRD-CORE.md                                   <-- REMOVED / Fresh authoring required in Stage 0
    ├── PRD-CORE-ASSESSMENT.md                        <-- Retained Stage 1 assessment record
    └── REQUIREMENTS-SPEC.md                          <-- Retained on disk & Git tracked
```

### 4.3 Preservation Guarantees
1. **Pre-Pivot State Snapshot**: The full `state` object at Stage 1 (including all deliverables, validation results, evidence hashes, and timestamps) is written to `.playbook/pivots/state-<PIVOT_ID>.json` and marked with operating system file write protection (`0o444`).
2. **Governance Audit Document**: A human-readable Markdown record is created at `docs/pivots/<PIVOT_ID>.md`, capturing authorizer identity, role, timestamp, assessment summary, explicit justification, and historical dispositions of RFCs, ADRs, and Exceptions.
3. **PRD-CORE Archival & Freshness Enforcement**: The outdated `docs/prd/PRD-CORE.md` is copied to `docs/prd/archive/PRD-CORE.<PIVOT_ID>.outdated.md` with an archival warning banner, and unlinked from the active path. Stage 0 requires authoring a genuinely fresh problem formulation.
4. **RFC, ADR, and Exception Dispositions**: Files on disk are permanent and never deleted. Stage 1 exceptions are explicitly disposed as `invalidated_by_pivot`. In `state.current_stage_detail`, arrays are initialized empty for the new Stage 0 scope.
5. **Stage History Ledger Protection**: The pivoted Stage 1 context is **strictly barred from `stage_history[]`**. 
   - `stage_history` requires `status: ["approved", "waived"]`. Stage 1 was never approved.
   - Injecting Stage 1 would break the monotonically increasing stage sequence ($[1, 0, 1 \dots]$), causing errors in tooling and downstream parsers.
   - For immediate compliance, storage is file-based (`.playbook/pivots/`, `docs/pivots/`, `docs/prd/archive/`). In the future runtime implementation task, an optional top-level `pivots: []` ledger can be added to `schemas/project-state.schema.json`.

---

## 5. Stage 0 Re-Initialization & Transaction Integrity

### 5.1 Fresh Initialization Rules
Upon successful pivot:
- `milestone_id`: Retained unchanged (e.g. `M-1.1.0`).
- `current_stage`: Set to `0`.
- `stage_status`: Set to `not_started`.
- `current_stage_detail`: Initialized with fresh `PRD-CORE` deliverable (`status: "not_started"`, `validation_status: "unvalidated"`, empty `evidence: []`).
- `exit_package`: Initialized to `not_started`.
- `human_approval`: Initialized to `not_requested`.
- Manifest pointer `active_lifecycle_stage`: Synchronized to `0`.
- Approval sidecar `.playbook/approval-fingerprint.json`: Purged.
- **Zero Evidence Inheritance**: Stage 0 deliverables **never** inherit validation evidence or approval signatures from prior milestones or the pivoted Stage 1.

### 5.2 Transaction Locking Order & Crash Recovery
The pivot engine enforces strict lock ordering:
1. **Advisory Pre-Check**: Quick read-only check before prompting.
2. **Operator Prompt**: Interactive prompt for identity, role, reason, and confirmation.
3. **Lock Acquisition**: Exclusive `.playbook/transaction.lock` acquisition.
4. **Authoritative Re-Read & Validation**: State, manifest, and PRD applicability re-read under lock. If drifted, rejects with `STATE_CONCURRENTLY_MODIFIED`.
5. **Atomic File Staging**: Snapshots and audit docs written to `.tmp.<PID>` staging files, then atomically renamed.
6. **WAL Execution**: Two-phase atomic updates for `state.json` and `manifest.json`.

#### Crash Interruption Recovery
- **Interruption during Staging**: State untouched. Stale `.tmp` files pruned during recovery. Project remains safely at Stage 1.
- **Interruption in `PREPARED` Phase**: Transaction manager detects uncommitted journal, performs rollback, cleans up. Project remains safely at Stage 1.
- **Interruption in `COMMITTING` Phase**: Transaction manager detects `COMMITTING` phase, rolls forward, ensuring both `state.json` and `manifest.json` are atomically committed to Stage 0.
- **Sidecar Cleanup Interruption**: Gate mismatch check ($1 \neq 0$) invalidates the sidecar with `APPROVAL_FINGERPRINT_MALFORMED`.

---

## 6. Comprehensive Design Test Matrix

The design defines 22 test scenarios for the future implementation phase:

| Scenario ID | Name | Objective & Invariants Tested |
| :---: | :--- | :--- |
| **T1** | Valid Stage 1-to-Stage 0 Pivot | Verifies happy path: unique event ID generated, `current_stage` becomes 0, snapshot created, audit doc created, manifest synced. |
| **T2** | Reject from Stage 2 | Verifies that pivot cannot be executed from Stage 2 (`PIVOT_INVALID_STAGE`). |
| **T3** | Reject After Gate 1 Approval | Verifies that once Stage 1 is approved, it cannot be pivoted (`STAGE_ALREADY_APPROVED`). |
| **T4** | Reject Non-Maintenance Lifecycle | Verifies that `active` or `completed_terminal` lifecycles reject pivot (`LIFECYCLE_NOT_MAINTENANCE`). |
| **T5** | Reject without OUTDATED Assessment | Verifies that `APPLICABLE`, `MISSING`, or mismatched assessments reject pivot (`PIVOT_PRD_NOT_OUTDATED`). |
| **T6** | Reject Non-TTY Invocation | Verifies that piped or scripted stdin is strictly rejected (`TTY_REQUIRED`). |
| **T7** | Reject Incorrect Confirmation Phrase | Verifies that typos or mismatched milestone IDs abort the pivot (`PIVOT_ABORTED`). |
| **T8** | Reject Missing Justification | Verifies that empty `--reason` is rejected (`PIVOT_REASON_REQUIRED`). |
| **T9** | Historical Stage 1 Preservation | Verifies snapshot integrity in `.playbook/pivots/` and preservation of disk files. |
| **T10** | Fresh Stage 0 Initialization | Verifies clean Stage 0 deliverables, empty evidence, and unvalidated status. |
| **T11** | Stale Sidecar Rejection | Verifies that Stage 1 approval sidecars cannot authorize Stage 0. |
| **T12** | Interruption and WAL Recovery | Verifies crash recovery roll-forward from `COMMITTING` phase. |
| **T13** | Normal Progression and Closure | Verifies that after pivoting, the milestone can advance 0 $\to$ 1 $\dots \to$ 6 and seal into `completed_terminal`. |
| **T14** | Concurrent Pivot Attempts (Lock Contention) | Verifies that concurrent pivot is rejected with `LOCK_HELD_BY_ACTIVE_PROCESS`. |
| **T15** | TOCTOU State Modification Under Prompt | Verifies that state drift during interactive prompt rejects with `STATE_CONCURRENTLY_MODIFIED`. |
| **T16** | Repeated Pivot Without Historical Overwrite | Verifies that second pivot produces `PVT-M-1.1.0-002` without overwriting `PVT-M-1.1.0-001`. |
| **T17** | Snapshot Staging / Write Failure | Verifies rollback to Stage 1 if snapshot write fails. |
| **T18** | Audit Document Write Failure | Verifies rollback if audit doc write fails. |
| **T19** | WAL Preparation Failure | Verifies fail-closed behavior on journal prepare error. |
| **T20** | Crash Recovery with Incomplete Artifacts | Verifies pruning of stale `.tmp` files during recovery. |
| **T21** | PRD-CORE Archival & Freshness Enforcement | Verifies old PRD archived, active PRD removed, and old PRD hash rejected for Gate 0 approval. |
| **T22** | Historical RFC, ADR, Exception Dispositions | Verifies audit dispositions and Stage 1 exception invalidation. |

---

## 7. Comparative Governance Taxonomy

| Property | `ADVANCE_STAGE` | `REJECT_GATE` | `CLOSE_LIFECYCLE` | `REOPEN_LIFECYCLE` | `PIVOT_TO_STAGE_0` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Intent** | Normal progress | Rework required | Seal milestone | Start maintenance | Emergency recovery |
| **Direction** | Forward ($N \to N+1$) | In-place ($N \to N$) | Terminal closure | Re-entry (Terminal $\to 0/1$) | Backward ($1 \to 0$) |
| **Permitted Stages** | Stages 0 to 5 | Stages 0 to 6 | Stage 6 only | Stage 6 only | Stage 1 only |
| **Lifecycle Status** | `active` / `reopened` | `active` / `reopened` | Active $\to$ Terminal | Terminal $\to$ Reopened | Reopened (Unchanged)|
| **Authority** | Automated / Human | Human Reviewer | Human Reviewer | Human Authority | Human Operator |
| **TTY Requirement** | Optional | Required | Required | Required | Strictly Required |
| **Confirmation Phrase**| None | None | `CONFIRM APPROVAL GATE 6` | `CONFIRM REOPEN <MILESTONE>` | `CONFIRM PIVOT TO STAGE 0 <MILESTONE>` |
| **Milestone ID** | Unchanged | Unchanged | Sealed in snapshot | New Milestone ID | Retained Unchanged |

---

## 8. Limitations & Unresolved Architectural Decisions

1. **Schema Extension vs. File-Based Storage**:
   - The design adopts file-based snapshot persistence under `.playbook/pivots/`, `docs/pivots/`, and `docs/prd/archive/`. This enables zero schema breaking changes in the immediate term.
   - *Future Decision*: In the implementation task, determine whether to officially add `pivots: []` to `schemas/project-state.schema.json` to make pivot records directly queryable via `playbook inspect --json`.
2. **Multi-Stage Pivot Requests**:
   - The pivot design intentionally limits backward transitions strictly from Stage 1 to Stage 0. 
   - Pivoting backward from Stage 3 (Implementation) to Stage 0 is rejected. If a project in Stage 3 discovers that the foundational business problem has dissolved, the recommended workflow is milestone cancellation/closure followed by a new milestone reopening, rather than multi-stage backward jumps.
3. **Working Tree Artifact Tracking**:
   - Snapshots and audit documents are created in the working tree. Automatic Git commits are intentionally not performed by the CLI; commits remain under explicit human developer authority.

---

## 9. Conclusion & Acceptance Status

The active maintenance milestone stage pivot architecture v1.1.0 is complete, verified against existing governance invariants, and documented across:
- [`governance/maintenance-stage-pivot-design.md`](../../governance/maintenance-stage-pivot-design.md) (v1.1.0)
- [`governance/state-machine.md`](../../governance/state-machine.md) (v1.3.0)
- [`governance/lifecycle-reopening-design.md`](../../governance/lifecycle-reopening-design.md) (v1.2.0)

**Status**: `DESIGN_READY_FOR_REVIEW`. No runtime code or schemas were modified.
