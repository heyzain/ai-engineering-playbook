# Human Gate Approval & Stage Advancement Architecture Specification

> **Specification Version**: 1.0.0  
> **Status**: Approved Architecture & Design Specification  
> **Scope**: Governance CLI (`tooling/playbook-cli/`), State Transition Machine, Gate Exit Protocols, Stages 0–6

---

## 1. Executive Summary & Core Invariants

This specification establishes the architectural contract for **Human Gate Approval** (`playbook approve --gate <N>`) and **Lifecycle Stage Advancement** (`playbook advance`) within the AI Engineering Playbook.

The system enforces three non-negotiable architectural boundaries:
1. **The Human Sovereignty Boundary**: Software lifecycle progression is governed by human judgment. AI agents may author code, execute tests, compile exit packages, and gather proof, but **AI agents are strictly forbidden from approving quality gates or signing off on lifecycle stage transitions.**
2. **Three-Phase Operation Decoupling**: Evidence Verification (`verify-evidence`), Gate Approval (`approve`), and Stage Advancement (`advance`) are strictly decoupled into independent operational disciplines. No command may implicitly execute or bypass another.
3. **Strict Stage 6 Terminal Boundary**: The software lifecycle strictly terminates at Stage 6 (Deployment & Operational Monitoring). Stage 6 approval triggers milestone sealing (`CLOSE_LIFECYCLE`); advancing to a hypothetical "Stage 7" is physically barred.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THE GOVERNANCE TRIAD                            │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│ 1. VERIFY EVIDENCE      │ 2. APPROVE GATE        │ 3. ADVANCE STAGE    │
│    (Read-Only Proof)    │    (Human Judgment)    │    (State Mutation) │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ `playbook verify-`      │ `playbook approve`     │ `playbook advance`  │
│ `evidence`              │ `--gate <N>`           │                     │
│                         │                        │                     │
│ • Verifies file presence│ • Validates eligibility│ • Verifies approved │
│ • Validates SHA-256     │ • Evaluates Exit Pkg   │   gate status       │
│ • Detects path traps    │ • Enforces interactive │ • Advances to N+1   │
│ • Read-only analysis    │   TTY human prompt     │   or seals Stage 6  │
│ • Does NOT approve      │ • Records reviewer ID  │ • Preserves ledger  │
│ • Does NOT mutate state │ • Does NOT advance     │ • Never self-       │
│                         │   stage                │   approves          │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Decoupled Responsibility Boundaries

### 2.1 Operation A: Evidence Verification (`playbook verify-evidence`)
- **Authority**: Analytical and read-only.
- **Responsibility**:
  - Traverses `current_stage_detail.deliverables[].evidence[]`.
  - Verifies file presence on disk within the repository boundary.
  - Computes actual SHA-256 hashes and compares with recorded `evidence_hash`.
  - Enforces path containment (traversal and symlink escape defenses).
- **Hard Boundaries**:
  - Never mutates `state.json`, `manifest.json`, or evidence logs.
  - Never approves a deliverable or stage gate.
  - A matching hash proves **integrity relative to recorded state**, NOT content correctness or actor authenticity.

### 2.2 Operation B: Human Gate Approval (`playbook approve --gate <N>`)
- **Authority**: Authorized Human Engineer only (Solo mode in-chat / Team mode PR review).
- **Responsibility**:
  - Validates that Gate $N$ matches `state.current_stage` and is eligible for review.
  - Evaluates the compiled Stage Gate Exit Package (`docs/gates/GATE-N-EXIT-PACKAGE.md`).
  - Audits verified deliverables, active exception waivers, and unresolved questions.
  - Requires explicit, interactive human confirmation via TTY.
  - Persists human decision, reviewer identity, timestamp, role, and signature reference into `state.json`.
- **Hard Boundaries**:
  - Rejects non-interactive or headless execution (`isatty(stdin) === false`).
  - Rejects agent identities (`actor_type: "agent"`).
  - Mutates `stage_status` to `"approved"` (or `"in_progress"` on rejection), but **does NOT increment `current_stage` or activate the next stage**.

### 2.3 Operation C: Stage Advancement (`playbook advance`)
- **Authority**: Lifecycle Orchestrator (Executed by human or agent following human gate approval).
- **Responsibility**:
  - Verifies that Gate $N$ has formal, non-stale human approval (`stage_status === "approved"` and `human_approval.status === "approved"`).
  - Verifies that zero blocking RFCs, expired exceptions, or broken evidence have emerged.
  - For Stages 0–5:
    - Appends Stage $N$ historical record to `stage_history[]`.
    - Increments `current_stage` to $N + 1$.
    - Sets `stage_status` to `"not_started"`.
    - Initializes `current_stage_detail` with next-stage baseline deliverables.
    - Synchronizes `manifest.active_lifecycle_stage` to $N + 1$.
  - For Stage 6:
    - Executes `CLOSE_LIFECYCLE`: sets `lifecycle_status` to `"completed_terminal"`.
    - Freezes milestone snapshot under `.playbook/milestones/state-<milestone_id>.json`.
    - Locks `current_stage` at `6`.
- **Hard Boundaries**:
  - Advancement **must never implicitly approve an unapproved gate**.
  - If approval is stale or preconditions fail, advancement halts immediately.

---

## 3. The Approval Contract (`playbook approve`)

### 3.1 Gate Eligibility Preconditions Matrix
A gate is eligible for human approval if and only if **100% of the following preconditions** are met:

| Precondition | Verification Rule | Diagnostic on Failure |
| :--- | :--- | :--- |
| **Gate Match** | Requested `--gate <N>` strictly equals `state.current_stage`. | `GATE_MISMATCH` (error) |
| **Stage State** | `state.stage_status` is `pending_review` or `in_progress` with all deliverables ready. | `STAGE_NOT_READY_FOR_REVIEW` (error) |
| **Deliverables Complete** | 100% of deliverables in `current_stage_detail` have `status` of `"verified"` or `"waived"`. Zero items in `not_started`, `in_progress`, `completed`, or `blocked`. | `GATE_CRITERIA_UNMET` (error) |
| **Verification Evidence** | All `"verified"` deliverables have `validation_status: "passed"` and non-empty `evidence[]`. | `DELIVERABLE_UNVERIFIED` (error) |
| **Cryptographic Evidence Proof** | Running `EvidenceVerifier` yields zero `missing`, zero `invalid_reference`, zero `integrity_failed`, and zero `unreadable` files. | `EVIDENCE_INTEGRITY_DEFECT` (error) |
| **Exit Package Present** | Exit package file exists at `current_stage_detail.exit_package.path` with `status: "submitted_for_review"`. | `EXIT_PACKAGE_MISSING` (error) |
| **Zero Blocking RFCs** | Zero RFCs in `current_stage_detail.rfcs[]` have `status: "pending_decision"` and `is_blocking: true`. | `RFC_BLOCKING_UNRESOLVED` (error) |
| **Zero Expired Exceptions** | All exceptions have `status: "active"` or `"remediated"`. Active exceptions have UTC expiration date $\ge$ today. | `EXCEPTION_EXPIRED` (error) |
| **Schema Conformance** | `state.json` and `manifest.json` strictly pass JSON Schema Draft 2020-12 validation. | `SCHEMA_VALIDATION_FAILED` (error) |
| **Lifecycle State** | `state.lifecycle_status === "active"`. Cannot approve gates when paused or terminal. | `LIFECYCLE_NOT_ACTIVE` (error) |

### 3.2 Gate Exit Package Validation
Before prompting the human, the engine inspects the markdown artifact at `current_stage_detail.exit_package.path`:
- File must exist on disk and be non-empty ($> 200$ bytes).
- Must contain mandatory sections:
  - Section 1: Package & Stage Identification
  - Section 3: Deliverables Manifest
  - Section 4: Verifiable Validation Evidence
  - Section 7: Related Governance Artifacts (ADRs, RFCs, Exceptions)
  - Section 8: AI Agent Completion Assertion (must contain agent compiler signature)
- If waived deliverables exist, Section 3 and Section 7 must explicitly list the compensating controls and reference the authorized `EXC-YYYYMMDD-###.md` exception record.

### 3.3 Interactive TTY Protocol & Human Confirmation
To ensure gate sign-off reflects active human judgment rather than automated script execution:
1. **Interactive Terminal Enforcement**:
   - The CLI checks `process.stdin.isTTY === true` and `process.stdout.isTTY === true`.
   - If non-interactive (e.g. piped stdin, CI without TTY, headless agent subprocess, `--yes`, `--force`), the command terminates immediately with exit code `1`:
     ```
     Error: [TTY_REQUIRED] Gate approval requires an interactive terminal session.
     Automated, scripted, or piped approval invocations are strictly prohibited.
     ```
2. **Interactive Presentation & Review**:
   - The CLI presents a structured terminal summary:
     - Project ID, Name, Governance Profile, Milestone ID.
     - Active Stage number and name.
     - Deliverables verified count and waived count.
     - Active exceptions list with expiration dates.
     - Evidence verification summary (all passing hashes).
     - Link to Exit Package markdown document.
3. **Human Prompts**:
   - **Reviewer Name**: Full name of human engineer (e.g., `Zain Ali`). Must not contain `agent`, `bot`, or `controller`.
   - **Professional Role**: Architectural or engineering title (e.g., `Lead Systems Architect`).
   - **Approval Mode**: `solo` or `team`.
   - **Signature / Review Reference**: Auditable reference string (e.g. `PR #42 Approval`, `Interactive Session CLI-20261031-01`, `In-chat signoff timestamp 2026-10-31T11:45:00Z`).
   - **Decision**: `approve` or `reject`.
   - **Optional Conditions**: Specific constraints or rework items.
4. **Typed Confirmation Phrase Guard**:
   - If approving, the human must explicitly type the exact phrase:
     `CONFIRM APPROVAL GATE <N>`
   - Any typo, empty input, or cancellation aborts without modifying `state.json`.

### 3.4 Persisted State Mutations (`APPROVE_GATE` vs. `REJECT_GATE`)

#### Case A: Human Approves (`decision: "GATE_APPROVED"`)
```jsonc
// In .playbook/state.json
"stage_status": "approved",
"current_stage_detail": {
  "human_approval": {
    "status": "approved",
    "approved_by": "Zain Ali",
    "role": "Lead Systems Architect",
    "approval_mode": "solo",
    "decision": "GATE_APPROVED",
    "signature_reference": "Interactive CLI Session 8dec625e-7884-4400-a257-39124763c805",
    "approved_at": "2026-10-31T11:55:00.000Z",
    "conditions": "Ensure load testing begins immediately in Stage 3."
  }
},
"last_updated": {
  "timestamp": "2026-10-31T11:55:00.000Z",
  "updated_by": "human:Zain Ali",
  "actor_type": "human",
  "reason": "Human gate approval granted for Stage 2 (Architecture & System Design)."
}
```

#### Case B: Human Rejects (`decision: "REJECTED"`)
```jsonc
// In .playbook/state.json
"stage_status": "in_progress",
"current_stage_detail": {
  "exit_package": {
    "status": "drafted"
  },
  "human_approval": {
    "status": "rejected",
    "approved_by": "Zain Ali",
    "role": "Lead Systems Architect",
    "approval_mode": "solo",
    "decision": "REJECTED",
    "signature_reference": "Interactive CLI Session 8dec625e-7884-4400-a257-39124763c805",
    "approved_at": "2026-10-31T11:55:00.000Z",
    "conditions": "ADR-002 requires revision for SQLite WAL concurrency limits before Gate 2 can clear."
  }
},
"last_updated": {
  "timestamp": "2026-10-31T11:55:00.000Z",
  "updated_by": "human:Zain Ali",
  "actor_type": "human",
  "reason": "Human gate review rejected Gate 2. Rework required: ADR-002 WAL limits."
}
```

### 3.5 Stale Approval Detection & Invalidation
An approved gate does not retain eternal validity if repository state diverges prior to advancement.

Before `playbook advance` executes, the engine verifies **approval freshness**:
1. **Deliverables Mutation Check**:
   - The engine computes a content hash of all deliverables and evidence records in `current_stage_detail`.
   - If any deliverable was added, removed, modified, or regressed to `in_progress` since `approved_at`, the approval is declared **stale**.
2. **Exception Expiration Check**:
   - If an active exception that was valid at the time of approval expires prior to advancement, the approval is declared **stale**.
3. **Evidence Integrity Check**:
   - `EvidenceVerifier` is re-run. If an evidence file was deleted or altered on disk, the approval is declared **stale**.
4. **Resolution of Stale Approval**:
   - Advancement is halted.
   - Diagnostic `APPROVAL_STALE` is emitted.
   - The human engineer must review the modifications and issue a fresh approval.

---

## 4. The Advancement Contract (`playbook advance`)

### 4.1 Advancement Preconditions
The advancement command advances the project into the subsequent stage. It executes if and only if:
1. `state.stage_status === "approved"`.
2. `state.current_stage_detail.human_approval.status === "approved"`.
3. `state.current_stage_detail.human_approval.decision === "GATE_APPROVED"`.
4. Approval is fresh and non-stale (passes Section 3.5).
5. Zero critical diagnostics exist (`DiagnosticsEngine` reports zero errors).
6. Working tree contains no uncommitted changes to `.playbook/` governance files.

### 4.2 Standard Advancement Protocol (Stages 0 through 5)
When `state.current_stage < 6`:
1. **Archive Completed Stage into `stage_history[]`**:
   Construct an immutable entry:
   ```json
   {
     "stage": 2,
     "stage_name": "Architecture & System Design",
     "status": "approved",
     "started_at": "2026-10-31T09:00:00.000Z",
     "completed_at": "2026-10-31T11:50:00.000Z",
     "approved_at": "2026-10-31T11:55:00.000Z",
     "exit_package_ref": "docs/gates/GATE-2-EXIT-PACKAGE.md",
     "human_approval": {
       "status": "approved",
       "approved_by": "Zain Ali",
       "role": "Lead Systems Architect",
       "approval_mode": "solo",
       "decision": "GATE_APPROVED",
       "signature_reference": "Interactive CLI Session 8dec625e-7884-4400-a257-39124763c805",
       "approved_at": "2026-10-31T11:55:00.000Z",
       "conditions": null
     }
   }
   ```
2. **Increment Active Stage**:
   - Set `state.current_stage = current_stage + 1`.
   - Set `state.stage_status = "not_started"`.
3. **Initialize Next-Stage Detail (`current_stage_detail`)**:
   - Populate `stage` and canonical `stage_name` from [stage-gate-rules.md](stage-gate-rules.md).
   - Set `started_at = timestamp`.
   - Pre-populate baseline deliverables for the new stage with `status: "not_started"`, `validation_status: "unvalidated"`, `evidence: []`.
   - Initialize `rfcs: []`, `adrs: []`, `exceptions: []`.
   - Initialize `exit_package`: `status: "not_drafted"`, `path: "docs/gates/GATE-<N+1>-EXIT-PACKAGE.md"`.
   - Initialize `human_approval`: `status: "not_requested"`, all fields null.
4. **Synchronize Manifest Pointer**:
   - Update `manifest.active_lifecycle_stage = current_stage + 1`.
5. **Update Audit Stamp**:
   - `last_updated`: `updated_by: "playbook:orchestrator"`, `actor_type: "human"`, `reason: "Advanced lifecycle from Stage N to Stage N+1 following human approval."`

### 4.3 Stage 6 Terminal Milestone Closure (`CLOSE_LIFECYCLE`)
When `state.current_stage === 6`:
Advancement **does not increment `current_stage` to 7**. Doing so is physically prevented by schema constraints (`maximum: 6`) and invariant guards.
Instead, the orchestrator triggers `CLOSE_LIFECYCLE`:
1. **Archive Stage 6**:
   - Appends Stage 6 record to `stage_history[]`.
2. **Freeze Milestone Snapshot**:
   - Creates directory `.playbook/milestones/` if not present.
   - Serializes a frozen, immutable copy of the state file to:
     `.playbook/milestones/state-<milestone_id>.json`
3. **Seal Lifecycle Status**:
   - Sets `state.lifecycle_status = "completed_terminal"`.
   - `state.current_stage` remains `6` (Locked).
   - `state.stage_status` remains `"approved"`.
4. **Terminal Reporting**:
   - Outputs completion verdict: Milestone is officially sealed in production.
   - Advises that future iterations require formal `REOPEN_LIFECYCLE`.

---

## 5. Security & Trust Boundaries

### 5.1 Interactive TTY Safeguard vs. Cryptographic Identity
- **Safeguard Nature**: Checking `isatty(stdin)` is an execution guardrail preventing automated background subagents, headless pipelines, and scripts from self-approving gates.
- **Honest Limitation Disclosure**: Local CLI execution **does not cryptographically authenticate human identity**. In solo developer mode, the CLI relies on the local developer workstation security perimeter.
- **Team Mode Governance**: In team mode (`approval_mode: "team"`), authority is delegated to Git forge controls (GitHub Branch Protection Rules, Required PR Reviews, CODEOWNERS, GPG signed commits). The CLI records the PR reference and human reviewer signature.

### 5.2 Strict Prohibition on Agent Self-Approval
- Schema invariants in `project-state.schema.json` enforce:
  When `stage_status === "approved"`, `last_updated.actor_type` must equal `"human"`.
- Any attempt by an AI agent to write `"actor_type": "agent"` alongside `stage_status: "approved"` fails schema validation (`STATE_SCHEMA_INVALID`), immediately blocking repository progression.

### 5.3 Co-Location Trust Boundary
- In repositories where `.playbook/state.json`, `manifest.json`, and evidence logs reside in the same Git working tree, an actor with commit authority has physical write access to all files.
- The Playbook architecture provides **verifiability and traceability**, not hardware-grade non-repudiation. External auditability is established when commits are pushed to protected upstream repositories.

---

## 6. Failure Modes & Deterministic Recovery

| Failure Scenario | Engine Detection | State Impact | Remediation Guidance |
| :--- | :--- | :--- | :--- |
| **Missing Exit Package** | `exit_package.path` missing on disk. | Block approval; state untouched. | Agent must compile exit package matching template before requesting review. |
| **Missing Evidence File** | `EvidenceVerifier` reports `status: "missing"`. | Block approval; state untouched. | Re-run verification procedure to generate missing log or report. |
| **Integrity Hash Mismatch** | `EvidenceVerifier` reports `status: "integrity_failed"`. | Block approval; state untouched. | Re-run procedure, record new passing log and updated hash in state. |
| **Expired Exception** | Active exception has `expiration_date < today`. | Block approval; state untouched. | Remediate waived deliverable or obtain authorized human renewal record. |
| **Unresolved Blocking RFC** | RFC in `pending_decision` with `is_blocking: true`. | Block approval; state untouched. | Human engineer must review RFC markdown and record formal resolution. |
| **Non-Interactive Approval Attempt** | `process.stdin.isTTY === false` on `approve`. | Immediate error exit code 1; state untouched. | Human engineer must run `playbook approve --gate N` directly in interactive terminal. |
| **Interrupted Advancement (Crash/Kill)** | Process killed during file write. | Atomic temp-file write guarantees zero file corruption. | Re-run `playbook advance`. Atomicity ensures state is either cleanly advanced or untouched. |
| **Repeated `approve` Execution** | State already has `stage_status === "approved"`. | Warns engineer gate is already approved; no-op unless state drifted. | Run `playbook advance` to advance stage. |
| **Repeated `advance` Execution** | State is in `not_started` (already advanced). | Warns stage is not approved; exit code 0/1. | Begin engineering work on current stage. |

### 6.1 Atomic Two-Phase Commit Implementation
To ensure state and manifest never diverge during advancement:
```
┌─────────────────────────────────────────────────────────────┐
│ 1. Compute new state & manifest objects in-memory           │
│ 2. Validate in-memory objects against JSON Schemas          │
│ 3. Create .playbook/state.json.bak & manifest.json.bak      │
│ 4. Write state.json.tmp and manifest.json.tmp               │
│ 5. Atomic Rename: state.json.tmp -> state.json              │
│ 6. Atomic Rename: manifest.json.tmp -> manifest.json        │
│ 7. Delete backup files (.bak)                               │
│ (On any error: restore from .bak and remove .tmp files)     │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Proposed CLI Command Specifications

### 7.1 `playbook approve --gate <N>`
```bash
# Interactive approval of Gate 2
playbook approve --gate 2

# Inspect gate approval eligibility without prompting (dry run)
playbook approve --gate 2 --dry-run

# Output machine-readable JSON status of approval check
playbook approve --gate 2 --dry-run --json
```

#### Terminal Interaction Flow
```text
┌──────────────────────────────────────────────────────────────┐
│          AI Engineering Playbook — Stage Gate Review         │
└──────────────────────────────────────────────────────────────┘

 Project:          zentrix-lms (Zentrix LMS)
 Milestone:        M-1.0.0 (MVP Platform)
 Target Gate:      Gate 2: Architecture & System Design
 Exit Package:     docs/gates/GATE-2-EXIT-PACKAGE.md [VALID]

 Deliverables Summary:
   Total:          2
   - Verified:     2 (100% Passing evidence proof)
   - Waived:       0
   - Incomplete:   0

 Evidence Verification:
   All 2 evidence files exist and matching SHA-256 integrity verified.

 Active Governance Exceptions: Zero active exceptions.
 Outstanding Clarifications:   Zero blocking RFCs.

────────────────────────────────────────────────────────────────
 Human Review Sign-Off
────────────────────────────────────────────────────────────────
? Enter Reviewer Full Name: Zain Ali
? Enter Professional Role: Lead Architect
? Select Approval Mode: solo (in-chat signoff)
? Enter Signature Reference: Session CLI-20261031-01
? Enter Decision: approve
? Type exact phrase to confirm: CONFIRM APPROVAL GATE 2

✔ Gate 2 successfully approved by Zain Ali.
  State updated: stage_status -> APPROVED.
  To advance the project into Stage 3, run:

    playbook advance
```

### 7.2 `playbook advance`
```bash
# Advance active stage following human approval
playbook advance

# Advance specific directory
playbook advance --cwd /path/to/project

# Output machine-readable JSON
playbook advance --json
```

#### Terminal Execution Flow (Stages 0–5)
```text
┌──────────────────────────────────────────────────────────────┐
│        AI Engineering Playbook — Lifecycle Advancement       │
└──────────────────────────────────────────────────────────────┘

 Target Directory: /workspace/zentrix-lms
 Current Stage:    Stage 2 (Architecture & System Design) [APPROVED]
 Approved By:      Zain Ali (Lead Architect) at 2026-10-31T11:55:00Z

 Advancing Lifecycle:
   ✔ Stage 2 recorded in stage_history[]
   ✔ Stage incremented: Stage 2 -> Stage 3 (Implementation & Unit Verification)
   ✔ Initialized 3 baseline deliverables for Stage 3 (not_started)
   ✔ Manifest active_lifecycle_stage synchronized to 3
   ✔ State written atomically

 Lifecycle successfully advanced to Stage 3.
 Active engineering work may now begin.
```

#### Terminal Execution Flow (Stage 6 — Terminal Closure)
```text
┌──────────────────────────────────────────────────────────────┐
│        AI Engineering Playbook — Lifecycle Advancement       │
└──────────────────────────────────────────────────────────────┘

 Target Directory: /workspace/zentrix-lms
 Current Stage:    Stage 6 (Deployment & Operational Monitoring) [APPROVED]
 Approved By:      Zain Ali (Engineering Lead) at 2026-11-15T18:00:00Z

 Sealing Milestone:
   ✔ Stage 6 recorded in stage_history[]
   ✔ Milestone state snapshot archived: .playbook/milestones/state-M-1.0.0.json
   ✔ Lifecycle status transitioned: ACTIVE -> COMPLETED_TERMINAL
   ✔ Stage 6 locked in production (terminal)

 [MILESTONE SEALED — PRODUCTION TERMINAL]
 Milestone 'M-1.0.0' is complete. Subsequent scope requires REOPEN_LIFECYCLE.
```

---

## 8. Schema Conformance & Compatibility Audit

### 8.1 Manifest Schema Audit (`schemas/project-manifest.schema.json`)
- `active_lifecycle_stage`: Integer `0` to `6`. Synchronized on `advance`. Fully supported.
- `active_milestone_id`: Pattern `^M-[a-zA-Z0-9.-]+$`. Fully supported.
- **Conclusion**: Zero schema modifications required for manifest.

### 8.2 State Schema Audit (`schemas/project-state.schema.json`)
- `stage_status`: Supports `"approved"`, `"in_progress"`, `"pending_review"`.
- `human_approval`: Contains `status`, `approved_by`, `role`, `approval_mode`, `decision`, `signature_reference`, `approved_at`, `conditions`.
- `last_updated`: Enforces `actor_type: "human"` when `stage_status: "approved"`.
- `stage_history[]`: Enforces array of completed stages with `human_approval`.
- `archived_milestones[]`: Preserves past milestone histories.
- **Conclusion**: The existing Draft 2020-12 state schema completely accommodates the approval and advancement architecture without requiring any breaking schema changes or version bumps.

---

## 9. Automated Test Strategy for Future Implementation

When Task 004D is implemented, the test harness must execute:

1. **Gate Eligibility Tests**:
   - Rejection when incomplete deliverable exists (`GATE_CRITERIA_UNMET`).
   - Rejection when deliverable evidence is missing (`EVIDENCE_FILE_MISSING`).
   - Rejection when evidence hash mismatches (`EVIDENCE_HASH_MISMATCH`).
   - Rejection when blocking RFC is unresolved (`RFC_BLOCKING_UNRESOLVED`).
   - Rejection when active exception has expired (`EXCEPTION_EXPIRED`).
   - Rejection when exit package markdown is missing on disk.
2. **Interactive TTY Safeguard Tests**:
   - Immediate rejection with error code 1 when `isatty` is false (headless/script/piped input).
   - Rejection when confirmation phrase does not match `CONFIRM APPROVAL GATE <N>`.
   - Rejection when reviewer name contains forbidden keywords (`agent`, `bot`, `controller`).
3. **Approval State Mutation Tests**:
   - Verified update of `stage_status: "approved"`, `human_approval`, and `actor_type: "human"`.
   - Rejection workflow: verify state transitions to `in_progress`, exit package reverts to `drafted`, conditions recorded.
   - Verification that approving a gate does **not** increment `current_stage`.
4. **Advancement Tests**:
   - Rejection when `stage_status` is not approved.
   - Rejection when approval is stale (evidence altered after approval).
   - Stages 0–5 advancement: stage incremented, `stage_history` appended, manifest synchronized, new stage deliverables initialized.
   - Stage 6 closure: `CLOSE_LIFECYCLE` triggered, milestone snapshot saved, `completed_terminal` set, no Stage 7 created.
5. **Atomic Rollback & Failure Recovery Tests**:
   - Simulated disk write failure halfway through advancement restores `.bak` files with zero state corruption.
   - Re-entrant execution safety (running `advance` twice does not double-increment).

---

## 10. Open Architectural Decisions & Governance Alignment

1. **Solo Mode Chat Quote vs. TTY Interactive Prompt**:
   - In Solo Developer Mode, human approval can occur either via the interactive CLI prompt (`playbook approve --gate N`) or via an explicit in-chat confirmation phrase. When executed via CLI, the CLI prompt records the local human reviewer. When confirmed in-chat, the human reviewer name and quote timestamp are written into `signature_reference`. Both pathways record identical schema fields.
2. **Exit Package Content Verification Depth**:
   - Initial implementation verifies file existence, non-emptiness, and mandatory heading presence. Full semantic analysis of text paragraphs is delegated to the human reviewer during gate review.
3. **Stale Approval Invalidation Threshold**:
   - Any mutation to deliverables or evidence after approval invalidates approval. Non-governance source code edits in `src/` during Stage 3 also invalidate approval if they alter files referenced in verification evidence.
