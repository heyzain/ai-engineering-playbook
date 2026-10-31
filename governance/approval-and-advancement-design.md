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
| **Verification Evidence** | All `"verified"` deliverables have `validation_status: "passed"` and non-empty `evidence[]` (`minItems: 1`). | `DELIVERABLE_UNVERIFIED` (error) |
| **Evidence Discipline & Integrity** | Automated disciplines (`automated_test`, `build_typecheck`, `static_analysis`, `schema_validation`, `security_audit`) must have valid `evidence_hash` and achieve `integrity_passed`. Manual review disciplines (`manual_functional`, `visual_review`, `accessibility_audit`, `architecture_review`) permit `existence_verified` when `evidence_hash: null`. | `EVIDENCE_HASH_MISMATCH` / `EVIDENCE_HASH_MALFORMED` (error) |
| **Zero Failing Evidence Results** | 100% of evidence items supporting verified deliverables must have recorded `result: "passed"`. Zero items with `result: "failed"` or `"inconclusive"`. | `EVIDENCE_RESULT_FAILED` (error) |
| **Zero Evidence Defects** | Running `EvidenceVerifier` yields zero `missing`, zero `invalid_reference`, zero `integrity_failed`, zero `unreadable`, and zero `unsupported` (e.g. remote URL) files. | `EVIDENCE_INTEGRITY_DEFECT` (error) |
| **Exit Package Present & Valid** | Exit package file exists at `current_stage_detail.exit_package.path` with `status: "submitted_for_review"`, non-empty, and containing all mandatory sections. | `EXIT_PACKAGE_MISSING` (error) |
| **Zero Blocking RFCs** | Zero RFCs in `current_stage_detail.rfcs[]` have `status: "pending_decision"` and `is_blocking: true`. | `RFC_BLOCKING_UNRESOLVED` (error) |
| **Zero Expired Exceptions** | All exceptions have `status: "active"` or `"remediated"`. Active exceptions have UTC calendar day expiration date $\ge$ today. Waived deliverables have valid `exception_ref`. | `EXCEPTION_EXPIRED` (error) |
| **Schema Conformance** | `state.json` and `manifest.json` strictly pass JSON Schema Draft 2020-12 validation. | `SCHEMA_VALIDATION_FAILED` (error) |
| **Lifecycle State** | `state.lifecycle_status === "active"`. Cannot approve gates when paused or terminal. | `LIFECYCLE_NOT_ACTIVE` (error) |

### 3.2 Evidence Eligibility Policy & Scientific Limitations
The governance engine strictly distinguishes between four levels of validation proof:
1. **Existence**: The referenced file exists at `evidence_ref` within project boundaries.
2. **Integrity**: The file's computed SHA-256 digest matches the recorded `evidence_hash`.
3. **Authenticity**: Proof that a specific human or system executed the check (unproven without cryptographic commit signatures or forge audit logs).
4. **Engineering Correctness**: Proof that the deliverable satisfies business logic and acceptance criteria.

> [!CAUTION]
> **Scientific Limitation**: Verifying a file's existence and matching its SHA-256 digest **does NOT prove engineering correctness or requirement satisfaction**. A test suite that asserts `expect(true).toBe(true)` achieves 100% existence and 100% integrity, but provides zero engineering proof. Automated verification confirms integrity relative to state records; **only human judgment evaluates engineering correctness during gate approval.**

- **Automated Evidence Disciplines**: Automated verification (`automated_test`, `build_typecheck`, `static_analysis`, `schema_validation`, `security_audit`) generates local logs or reports. Under strict and standard governance profiles, an `evidence_hash` (`sha256:[a-f0-9]{64}`) is mandatory. The verifier must return `integrity_passed`.
- **Manual Evidence Disciplines**: Qualitative reviews (`manual_functional`, `visual_review`, `accessibility_audit`, `architecture_review`) reference markdown checklists, walk-through logs, or screenshots. In these cases, `evidence_hash` is nullable (`null`). The verifier checks physical file presence and readability (`existence_verified`). The human reviewer must evaluate the artifact contents.
- **Failed or Inconclusive Outcomes**: If an evidence record has `result: "failed"` or `"inconclusive"`, the deliverable cannot be verified. Gate eligibility is immediately blocked.
- **Unsupported Remote URIs**: References with remote schemes (`http://`, `https://`) receive status `unsupported`. Because hermetic, offline reproducibility is required for verifiable governance, remote references strictly block gate approval.

### 3.3 Gate Exit Package Validation
Before prompting the human, the engine inspects the markdown artifact at `current_stage_detail.exit_package.path`:
- File must exist on disk and be non-empty ($> 200$ bytes).
- Must contain mandatory sections matching [templates/gate-exit-package-template.md](../templates/gate-exit-package-template.md):
  - Section 1: Package & Stage Identification
  - Section 3: Deliverables Manifest & Status Table
  - Section 4: Verifiable Validation Evidence
  - Section 7: Related Governance Artifacts (ADRs, RFCs, Exceptions)
  - Section 8: AI Agent Completion Assertion (must contain non-approving agent assertion)
  - Section 9: Human Gate Sign-Off & Approval Record
- If waived deliverables exist, Section 3 and Section 7 must explicitly list compensating controls and reference the authorized `EXC-YYYYMMDD-###.md` exception record.

### 3.4 Interactive TTY Protocol & Human Review Prompts
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
   - **Reviewer Name**: Claimed full name of human engineer (e.g., `Zain Ali`). Must not contain forbidden keywords (`agent`, `bot`, `controller`, `playbook`, `orchestrator`, `ai`).
   - **Professional Role**: Engineering title or authority (e.g., `Lead Systems Architect`).
   - **Approval Mode**: `solo` or `team`.
   - **Signature / Review Reference**: Auditable reference string (e.g. `PR #42 Approval`, `Interactive Session CLI-20261031-01`, `In-chat signoff timestamp 2026-10-31T11:45:00Z`).
   - **Decision**: `approve` or `reject`.
   - **Conditions / Rework Instructions**: Specific constraints (optional on approval; mandatory on rejection).
4. **Typed Confirmation Phrase Guard**:
   - If approving, the human must explicitly type the exact phrase:
     `CONFIRM APPROVAL GATE <N>`
   - Any typo, empty input, or cancellation aborts without modifying `state.json`.

### 3.5 Persisted State Mutations (`APPROVE_GATE` vs. `REJECT_GATE`)

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

### 3.6 Stale Approval Fingerprint & Invalidation Protocol
An approved gate does not retain eternal validity if repository state diverges prior to advancement.

To detect any post-approval drift deterministically, the governance engine defines an **Approval Fingerprint** generated at the exact moment of human approval.

#### 1. Fingerprint Representation & Inputs
The fingerprint is computed from the canonical JSON representation (lexicographically sorted keys, compact normalized formatting) of:
1. **Manifest Identifiers**: `manifest.project_id`, `manifest.active_milestone_id`.
2. **Current Stage State**: `state.current_stage`, `state.stage_status`.
3. **Deliverables List**: For each item in `current_stage_detail.deliverables[]`: `id`, `name`, `status`, `validation_status`, `artifact_path`, `exception_ref`.
4. **Evidence Records Metadata**: For each deliverable's `evidence[]`: `requirement_id`, `type`, `procedure`, `result`, `summary`, `exit_code`, `evidence_ref`, `evidence_hash`.
5. **Disk Evidence Hashes**: Real-time computed SHA-256 digest of every local evidence file referenced on disk.
6. **Active Exceptions**: For each item in `current_stage_detail.exceptions[]`: `exception_id`, `status`, `waived_requirement`, `expiration_date`.
7. **Blocking RFCs**: For each item in `current_stage_detail.rfcs[]`: `rfc_id`, `status`, `is_blocking`.
8. **Exit Package Hash**: Real-time computed SHA-256 digest of the markdown file at `current_stage_detail.exit_package.path`.

$$\text{approval\_fingerprint} = \text{"sha256:"} + \text{SHA256}(\text{CanonicalFingerprintPayload})$$

#### 2. Fingerprint Persistence
- **v1.0.0 Persistence via Dedicated Sidecar**:
  - To preserve the semantic purity of `signature_reference` (which records PR numbers, chat quotes, or commit references without overloading unrelated metadata), the approval fingerprint is persisted in a dedicated machine-readable sidecar file:
    `.playbook/approval-fingerprint.json`
  - Written by `playbook approve --gate <N>` at the conclusion of interactive sign-off.
  - Read and verified by `playbook advance` before executing state mutations.
- **Proposed v1.1.0 Schema Evolution**:
  - Add an optional native property `approval_fingerprint` to `human_approval` in `project-state.schema.json`.

#### 3. Staleness Triggers & Deterministic Invalidation
Before `playbook advance` executes, the engine recomputes the fingerprint from current repository state and compares it against `.playbook/approval-fingerprint.json`:
- **Evidence File Modified**: If any local evidence file on disk has changed its hash since approval $\rightarrow$ `APPROVAL_STALE` (`EVIDENCE_MODIFIED_SINCE_APPROVAL`).
- **New Evidence Record Added or Removed**: If deliverables or evidence array mutates $\rightarrow$ `APPROVAL_STALE` (`DELIVERABLE_MUTATED_SINCE_APPROVAL`).
- **Exception Expired**: If an active exception reaches `expiration_date < today` (UTC calendar day) prior to advancement $\rightarrow$ `APPROVAL_STALE` (`EXCEPTION_EXPIRED_SINCE_APPROVAL`).
- **Exit Package Edited**: If the compiled markdown artifact is modified $\rightarrow$ `APPROVAL_STALE` (`EXIT_PACKAGE_MUTATED_SINCE_APPROVAL`).
- **Milestone Conflict**: If `manifest.active_milestone_id !== state.milestone_id` $\rightarrow$ `MILESTONE_MISMATCH`.
- **Unavailable or Unreadable Inputs**: If any referenced evidence file or exit package is deleted, moved, or permissions revoked, the fingerprint cannot be verified. **Any unreadable or missing input immediately invalidates approval** (`APPROVAL_INVALID_UNREADABLE_INPUT`), halting advancement.

When an approval is declared stale, advancement halts immediately. The human engineer must review the repository deltas and issue a fresh approval.

### 3.7 Source-of-Truth and Manifest Drift Rules
1. **Authoritative State Machine**: `state.json` (`current_stage`) is the sole authoritative state machine for engineering lifecycle execution. `manifest.json` (`active_lifecycle_stage`) is a downstream configuration mirror.
2. **Approval Eligibility Guard**:
   - `MILESTONE_MISMATCH`: Blocks gate approval with error across all profiles.
   - `STAGE_MISMATCH`: Under `strict` and `standard` governance profiles, manifest stage drift blocks gate approval with error. The mirror must be synchronized before formal gate review. Under `lightweight` profile, a warning is emitted and review proceeds for `state.current_stage`.
3. **Advancement Drift Repair**:
   - Advancing Stage $N \rightarrow N+1$ atomically updates both `state.current_stage` and `manifest.active_lifecycle_stage` to $N+1$, repairing any previous mirror pointer drift.
   - Project identity or milestone divergence cannot be repaired automatically; any mismatch halts advancement immediately.
4. **Zero Silent Overwrite Invariant**: No operation may silently overwrite conflicting milestone or stage state without human authorization.

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
   Construct an immutable entry conforming strictly to `schemas/project-state.schema.json`:
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
       "approved_by": "Zain Ali",
       "role": "Lead Systems Architect",
       "approval_mode": "solo",
       "signature_reference": "Interactive CLI Session 8dec625e-7884-4400-a257-39124763c805"
     }
   }
   ```
   *(Note: Per schema constraints, `stage_history[].human_approval` strictly permits only `approved_by`, `role`, `approval_mode`, and `signature_reference`; `approved_at` is preserved at the parent record level).*

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

#### 1. Snapshot Creation & Integrity Protocol
- Target path: `.playbook/milestones/state-<milestone_id>.json`.
- **Pre-existing Snapshot Handling**:
  - If the snapshot file already exists on disk:
    - Compute the SHA-256 hash of the existing file and compare against the in-memory state snapshot.
    - If hashes match: Treated as an idempotent re-run; proceed safely.
    - If hashes differ: **Halt immediately** with error `SNAPSHOT_CONFLICT`. Overwriting an existing milestone snapshot is strictly prohibited to prevent data loss or silent history tampering. Re-sealing requires incrementing or modifying the milestone ID (e.g. `M-1.0.1`).
- **Recovery-Safe Snapshot Write**:
  - The snapshot is serialized to `.playbook/milestones/state-<milestone_id>.json.tmp`, flushed to disk, and atomically renamed into place as part of the write-ahead transaction journal before state is sealed.
  - The snapshot file permissions are set to read-only (`chmod 0o444`).

#### 2. Milestone Sealing
- Appends Stage 6 record to `stage_history[]`.
- Sets `state.lifecycle_status = "completed_terminal"`.
- `state.current_stage` remains `6` (Locked).
- `state.stage_status` remains `"approved"`.
- Outputs completion verdict: Milestone is officially sealed in production. Future enhancements require formal `REOPEN_LIFECYCLE`.

#### 3. Governance Immutability vs. Physical Mutability Realities
- **Governance Frozen Artifact**: The snapshot and sealed state files are *conventionally frozen* by the Playbook governance layer.
- **Physical Mutability Reality**: Files stored in a standard Git working tree remain physically mutable by any user or script with local filesystem write permissions. Technical immutability is achieved only when commits are pushed to protected Git branches with required linear histories, signed tags, and immutable remote storage (WORM/S3 Object Lock).

---

## 5. Security & Trust Boundaries

### 5.1 Claimed Reviewer Identity vs. Authenticated Identity
- **Claimed Identity**: In the local CLI prompt (`playbook approve`), the reviewer provides their name and role as strings. This represents a *claimed identity*.
- **Authorization Barrier (TTY Guardrail)**: The interactive TTY check (`process.stdin.isTTY === true`) enforces that approval is executed by an interactive user rather than an automated script or background agent subprocess. It is an **execution mode safeguard**, not a cryptographic identity verification system.
- **Upstream Identity Assurance**: True human authentication is enforced at the Git forge boundary:
  - **Solo Mode**: Relies on local workstation OS login and personal Git commit signing keys (GPG/SSH).
  - **Team Mode**: Enforced via GitHub/GitLab Branch Protection Rules, Required Pull Request Reviews, CODEOWNERS authorization, and GPG-signed merge commits. The CLI captures the authenticated PR number in `signature_reference`.

### 5.2 Strict Prohibition on Agent Self-Approval
- Schema invariants in `project-state.schema.json` enforce:
  When `stage_status === "approved"`, `last_updated.actor_type` must equal `"human"`.
- Any attempt by an AI agent to write `"actor_type": "agent"` alongside `stage_status: "approved"` fails schema validation (`STATE_SCHEMA_INVALID`), immediately blocking repository progression.
- The approval command rejects any reviewer name matching agent identifiers (`agent`, `bot`, `controller`, `playbook`, `orchestrator`, `ai`).

### 5.3 Rejection Representation and Review History Preservation
- **Rejection Protocol (`REJECT_GATE`)**:
  - If the human reviewer rejects a gate submission:
    - `state.stage_status` reverts to `"in_progress"`.
    - `current_stage_detail.exit_package.status` reverts to `"drafted"`.
    - `current_stage_detail.human_approval` records:
      - `status`: `"rejected"`
      - `approved_by`: Claimed human reviewer full name.
      - `role`: Reviewer professional authority.
      - `approval_mode`: `"solo"` or `"team"`.
      - `decision`: `"REJECTED"`.
      - `signature_reference`: Auditable reference string (PR review, session ID).
      - `approved_at`: ISO 8601 timestamp of rejection verdict.
      - `conditions`: Mandatory detailed rework items and blocking concerns.
    - Deliverables requiring changes revert to `in_progress`.
- **Preserving Rejection History Without In-State Overwriting**:
  - In schema v1.0.0, `current_stage_detail.human_approval` is a single object representing current status. Past rejection history is preserved across three immutable media:
    1. **Stage Gate Exit Package**: Section 6 (Outstanding Issues & Accepted Limitations) and Section 9 (Human Review Record) log all prior review attempts and their outcomes.
    2. **Git Commit History**: Every rejected decision and rework cycle is committed to git with full diff auditability.
    3. **Subsequent Approval Record**: When re-approval occurs, `conditions` in the new approval record documents prior rejection resolution (e.g. `"Prior rejection on 2026-10-31 resolved: ADR-002 amended with SQLite WAL limits."`).
- **Proposed Schema Evolution (v1.1.0)**:
  - To support multi-cycle review logs directly in `state.json`, we propose adding `current_stage_detail.review_history[]` in v1.1.0:
    ```jsonc
    "review_history": {
      "type": "array",
      "description": "Immutable ledger of past review decisions within the current stage.",
      "items": {
        "type": "object",
        "required": [ "reviewed_at", "reviewed_by", "role", "decision", "reasons_or_conditions", "signature_reference" ]
      }
    }
    ```
- **Repeated Approval Invocations**:
  - If `playbook approve` is run on an already approved stage whose fingerprint is unchanged, the CLI reports that the gate is already approved and advises running `playbook advance`.
  - If repository files have drifted, the CLI notifies the engineer that previous approval is stale and initiates a fresh review session.

### 5.4 Co-Location Trust Boundary
- In repositories where `.playbook/state.json`, `manifest.json`, and evidence logs reside in the same Git working tree, an actor with commit authority has physical write access to all files.
- The Playbook architecture provides **verifiability and traceability**, not hardware-grade non-repudiation. External auditability is established when commits are pushed to protected upstream repositories.

---

## 6. Multi-File Transaction Safety & Crash Recovery

### 6.1 Transaction Safety Realities
Advancement requires updating two separate files: `.playbook/state.json` and `.playbook/manifest.json` (plus `.playbook/milestones/state-<milestone_id>.json` on Stage 6 closure).

> [!WARNING]
> **No Kernel Multi-File Atomicity**: Standard operating systems (Windows NTFS, Linux ext4, macOS APFS) provide atomic renaming for a *single file*, but **no OS provides multi-file atomic rename syscalls**. A crash midway between two file renames will leave state and manifest desynchronized (`STAGE_MISMATCH`) unless governed by a write-ahead transaction journal.

### 6.2 Write-Ahead Transaction Journal & Process Lock Protocol
To guarantee deterministic recovery across all failure modes, `playbook advance` executes under an exclusive lock and write-ahead transaction journal containing **full target payloads**:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Acquire exclusive lock (.playbook/advancement.lock)      │
│ 2. Compute target state, manifest, and snapshot in-memory   │
│ 3. Validate target objects against JSON Schemas             │
│ 4. Write Transaction Journal (.playbook/tx-journal.json)    │
│    phase: "PREPARED", target file contents & hashes         │
│ 5. Write temporary files (.tmp) and backup copies (.bak)    │
│ 6. Update Transaction Journal phase: "COMMITTING"           │
│ 7. Rename state.json.tmp -> state.json                      │
│ 8. Rename manifest.json.tmp -> manifest.json                │
│ 9. (Stage 6) Rename snapshot.tmp -> snapshot.json           │
│ 10. Update Transaction Journal phase: "COMMITTED"           │
│ 11. Cleanup .bak, .tmp, delete tx-journal.json              │
│ 12. Release exclusive lock                                  │
└─────────────────────────────────────────────────────────────┘
```

#### Durable Information in Journal (`.playbook/tx-journal.json`)
The journal stores full target content strings, ensuring roll-forward can succeed even if temporary files are lost:
```json
{
  "tx_id": "tx-1730375700000-a1b2",
  "phase": "PREPARED", // PREPARED -> COMMITTING -> COMMITTED
  "created_at": "2026-10-31T12:00:00.000Z",
  "action": "ADVANCE_STAGE",
  "from_stage": 2,
  "to_stage": 3,
  "files": [
    {
      "target_path": ".playbook/state.json",
      "tmp_path": ".playbook/state.json.tmp",
      "bak_path": ".playbook/state.json.bak",
      "expected_source_hash": "sha256:1111...",
      "expected_target_hash": "sha256:2222...",
      "target_content": "{ ... full serialized state JSON ... }"
    },
    {
      "target_path": ".playbook/manifest.json",
      "tmp_path": ".playbook/manifest.json.tmp",
      "bak_path": ".playbook/manifest.json.bak",
      "expected_source_hash": "sha256:3333...",
      "expected_target_hash": "sha256:4444...",
      "target_content": "{ ... full serialized manifest JSON ... }"
    }
  ]
}
```

#### Crash Recovery Proof Matrix
Whenever any CLI command initializes, it checks for an existing `.playbook/tx-journal.json` and `.playbook/advancement.lock`:

| Crash Point / Scenario | Disk State at Crash | Recovery Action Executed by CLI | Safety Proof |
| :--- | :--- | :--- | :--- |
| **Crash in `PREPARED` with missing/corrupted `.tmp` files** | Live files untouched; journal exists; `.tmp` missing or corrupt. | **Roll Backward**: Remove `.tmp` and `.bak` files, delete `tx-journal.json`, release lock. | Target files were never touched. Rollback restores pristine Stage $N$ state. |
| **Crash in `COMMITTING` after state rename but before manifest rename** | `state.json` is at Stage $N+1$; `manifest.json` is at Stage $N$. | **Roll Forward**: Verify `state.json` matches target hash. If `manifest.json.tmp` is missing/corrupt, re-write from journal `target_content`. Rename into place. Complete advancement to Stage $N+1$. | Storing `target_content` in journal ensures roll-forward succeeds even if temporary files were destroyed. |
| **Crash during Rollback** | Process died while restoring `.bak` files. | On next invocation, journal is still in `PREPARED`. Rollback is re-executed. | Every rollback operation (file copy, unlink) is idempotent. Repeating rollback achieves identical, clean state. |
| **Missing or Corrupted Backup File** | Backup cannot be read during rollback. | If target file is untouched, no restore needed. If target file was modified and backup is corrupt: **Fail Closed**. Emit `CRITICAL_RECOVERY_FAILURE`; require human git restoration. | **Never guess authoritative state.** System prevents silent data synthesis. |
| **Crash during Journal Phase Updates** | Journal write was interrupted. | Journal writes use atomic replace (`tx-journal.json.tmp` $\rightarrow$ `tx-journal.json`). If journal is corrupt/unparseable, check lock; if lock owner dead, fail closed with inspection report. | Incomplete writes never result in malformed journal states. |
| **Stale Process Lock Discovered** | Lock exists from previous crashed session. | Check PID liveliness via `process.kill(pid, 0)`. If dead and lock age > 5m, log warning, execute journal recovery, reclaim lock. | Dead processes cannot hold locks indefinitely. Active processes are protected. |
| **Concurrent Advancement Invocations** | Two processes attempt `playbook advance` simultaneously. | First process creates `.playbook/advancement.lock` with `wx` flag (`O_CREAT \| O_EXCL`). Second process fails with `EEXIST` and halts immediately. | Operating system kernel guarantees mutual exclusion. |

> [!CAUTION]
> **Fail-Closed Recovery Invariant**: If any transaction recovery condition cannot be proven safe (e.g. source file altered by an external editor during crash, or corrupted backup during rollback), the engine **fails closed immediately**. It logs a critical diagnostic `CRITICAL_RECOVERY_FAILURE`, leaves files untouched, and prompts the human engineer for git-assisted recovery. The engine never guesses or synthesizes authoritative state.

---

## 7. Failure Modes & Diagnostic Remediation Matrix

| Failure Scenario | Engine Detection | State Impact | Remediation Guidance |
| :--- | :--- | :--- | :--- |
| **Missing Exit Package** | `exit_package.path` missing on disk. | Block approval; state untouched. | Agent must compile exit package matching template before requesting review. |
| **Missing Evidence File** | `EvidenceVerifier` reports `status: "missing"`. | Block approval; state untouched. | Re-run verification procedure to generate missing log or report. |
| **Integrity Hash Mismatch** | `EvidenceVerifier` reports `status: "integrity_failed"`. | Block approval; state untouched. | Re-run procedure, record new passing log and updated hash in state. |
| **Failed Verification Result** | Evidence record has `result: "failed"`. | Block approval; state untouched. | Fix defects, re-run test suite until passing evidence is recorded. |
| **Expired Exception** | Active exception has `expiration_date < today`. | Block approval; state untouched. | Remediate waived deliverable or obtain authorized human renewal record. |
| **Unresolved Blocking RFC** | RFC in `pending_decision` with `is_blocking: true`. | Block approval; state untouched. | Human engineer must review RFC markdown and record formal resolution. |
| **Non-Interactive Approval Attempt** | `process.stdin.isTTY === false` on `approve`. | Immediate error exit code 1; state untouched. | Human engineer must run `playbook approve --gate N` directly in interactive terminal. |
| **Interrupted Advancement (Crash/Kill)** | Unfinished transaction journal detected. | Deterministic rollback or roll-forward via journal. | CLI recovers state automatically on next invocation. |
| **Milestone Snapshot Conflict** | Milestone snapshot exists with different content hash. | Block Stage 6 closure; state untouched. | Ensure milestone ID is unique or resolve conflicting release artifact. |
| **Repeated `approve` Execution** | State already has `stage_status === "approved"`. | Warns engineer gate is already approved; no-op unless state drifted. | Run `playbook advance` to advance stage. |
| **Repeated `advance` Execution** | State is in `not_started` (already advanced). | Warns stage is not approved; exit code 0/1. | Begin engineering work on current stage. |

---

## 8. Proposed CLI Command Specifications

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

## 9. Schema Conformance & Compatibility Audit

### 9.1 Manifest Schema Conformance (`schemas/project-manifest.schema.json`)
- `active_lifecycle_stage`: Integer `0` to `6`. Synchronized on `advance`. Fully supported.
- `active_milestone_id`: Pattern `^M-[a-zA-Z0-9.-]+$`. Fully supported.
- **Verdict**: Zero schema modifications required for manifest.

### 9.2 State Schema Conformance (`schemas/project-state.schema.json`)
- `stage_status`: Supports `"approved"`, `"in_progress"`, `"pending_review"`.
- `current_stage_detail.human_approval`: Contains `status`, `approved_by`, `role`, `approval_mode`, `decision`, `signature_reference`, `approved_at`, `conditions`. Fully supported.
- `last_updated`: Enforces `actor_type: "human"` when `stage_status: "approved"`. Fully supported.
- `stage_history[].human_approval`: Strictly restricted to `"approved_by"`, `"role"`, `"approval_mode"`, and `"signature_reference"` with `additionalProperties: false`. The advancement orchestrator strictly trims `status`, `decision`, and `conditions` before appending to `stage_history[]` (`approved_at` is preserved at the record level).
- `archived_milestones[]`: Preserves past milestone histories and frozen snapshot reference. Fully supported.
- **Verdict**: Existing Draft 2020-12 state schema completely accommodates the approval and advancement architecture with zero breaking changes.

### 9.3 Minimal Proposed Schema Evolution (Non-Breaking, Future v1.1.0)
To natively preserve machine-calculated verification fingerprints and multi-cycle review logs directly within state files without modifying existing v1.0.0 contracts:

1. **Native Approval Fingerprint**:
   ```jsonc
   // Under current_stage_detail.human_approval:
   "approval_fingerprint": {
     "type": [ "string", "null" ],
     "pattern": "^sha256:[a-f0-9]{64}$",
     "description": "Deterministic SHA-256 digest of gate deliverables, evidence file hashes, and exit package contents at the time of human approval."
   }
   ```
   *(In v1.0.0, this value is persisted cleanly in `.playbook/approval-fingerprint.json` sidecar, keeping `signature_reference` unpolluted).*

2. **Immutable Review Decision History**:
   ```jsonc
   // Under current_stage_detail:
   "review_history": {
     "type": "array",
     "description": "Immutable ledger of past review decisions (rejections, conditions, prior approval attempts) within the current stage.",
     "items": {
       "type": "object",
       "required": [ "reviewed_at", "reviewed_by", "role", "decision", "reasons_or_conditions", "signature_reference" ],
       "properties": {
         "reviewed_at": { "type": "string", "format": "date-time" },
         "reviewed_by": { "type": "string" },
         "role": { "type": "string" },
         "decision": { "type": "string", "enum": [ "GATE_APPROVED", "REJECTED" ] },
         "reasons_or_conditions": { "type": "string" },
         "signature_reference": { "type": "string" }
       }
     }
   }
   ```
   *(In v1.0.0, past rejection logs are preserved in Exit Package Sections 6 & 9, git history, and subsequent approval `conditions`).*

---

## 10. Automated Test Strategy for Future Implementation (Task 004D)

When Task 004D is implemented, the test harness must execute:

1. **Gate Eligibility Tests**:
   - Rejection when incomplete deliverable exists (`GATE_CRITERIA_UNMET`).
   - Rejection when deliverable evidence is missing (`DELIVERABLE_UNVERIFIED`).
   - Rejection when automated evidence lacks hash under strict/standard profile (`EVIDENCE_HASH_MALFORMED`).
   - Rejection when evidence hash mismatches (`EVIDENCE_HASH_MISMATCH`).
   - Rejection when evidence has `result: "failed"` or `"inconclusive"` (`EVIDENCE_RESULT_FAILED`).
   - Rejection when evidence has unreadable or directory target (`EVIDENCE_UNREADABLE`).
   - Rejection when evidence is a remote URL (`EVIDENCE_UNSUPPORTED`).
   - Acceptance of manual review evidence without hash under `existence_verified`.
   - Rejection when blocking RFC is unresolved (`RFC_BLOCKING_UNRESOLVED`).
   - Rejection when active exception has expired (`EXCEPTION_EXPIRED`).
   - Rejection when exit package markdown is missing or missing mandatory headings.
2. **Interactive TTY Safeguard Tests**:
   - Immediate rejection with exit code 1 when `isatty` is false (headless/script/piped input).
   - Rejection when confirmation phrase does not match `CONFIRM APPROVAL GATE <N>`.
   - Rejection when reviewer name contains forbidden keywords (`agent`, `bot`, `controller`, `playbook`, `orchestrator`, `ai`).
3. **Approval State Mutation Tests**:
   - Verified update of `stage_status: "approved"`, `human_approval`, and `actor_type: "human"`.
   - Rejection workflow: verify state transitions to `in_progress`, exit package reverts to `drafted`, conditions recorded.
   - Verification that approving a gate does **not** increment `current_stage`.
4. **Stale Approval Invalidation Tests**:
   - Evidence file modified on disk after approval $\rightarrow$ `advance` blocked with `APPROVAL_STALE`.
   - Deliverable status mutated after approval $\rightarrow$ `advance` blocked.
   - Exception expires after approval $\rightarrow$ `advance` blocked.
   - Exit package edited after approval $\rightarrow$ `advance` blocked.
   - Unreadable evidence file after approval $\rightarrow$ `advance` blocked (`APPROVAL_INVALID_UNREADABLE_INPUT`).
5. **Advancement Protocol Tests**:
   - Rejection when `stage_status` is not approved.
   - Stages 0–5 advancement: stage incremented, `stage_history` appended with strictly schema-valid `human_approval`, manifest synchronized, next-stage baseline deliverables initialized.
   - Stage 6 closure: `CLOSE_LIFECYCLE` triggered, milestone snapshot saved to `.playbook/milestones/state-<milestone_id>.json`, permissions set read-only, `completed_terminal` set, no Stage 7 created.
   - Milestone snapshot conflict: attempting to close with differing content when snapshot already exists raises `SNAPSHOT_CONFLICT`.
6. **Transaction Safety & Crash Recovery Tests**:
   - Crash simulation in `PREPARED` phase: recovery rolls backward, restores state, removes `.tmp` and `.bak`.
   - Crash simulation in `COMMITTING` phase with missing `.tmp`: recovery rolls forward using journal `target_content`, synchronizes manifest, completes advancement.
   - Concurrent process execution blocked by exclusive lock (`advancement.lock`).
   - Stale lock detection and automatic liveliness reclamation.
   - Corrupted backup detection triggers fail-closed `CRITICAL_RECOVERY_FAILURE`.

---

## 11. Confirmed Architectural Decisions & Governance Alignment

1. **Transaction Journal & Process Lock**: Multi-file state and manifest updates are governed by a write-ahead transaction journal (`.playbook/tx-journal.json`) and process lock (`.playbook/advancement.lock`), eliminating any reliance on non-existent filesystem multi-file atomicity. Full serialized payloads in the journal guarantee recoverability across missing/corrupted temporary files.
2. **Deterministic Stale Approval Invalidation**: Approvals are bound to an 8-part canonical fingerprint digest stored in `.playbook/approval-fingerprint.json` sidecar. Any modification to evidence files, deliverables, exceptions, RFCs, or exit package markdown invalidates approval and blocks advancement.
3. **Evidence Eligibility Realities**: Existence and hash integrity do not prove engineering correctness; automated checks require `integrity_passed`, manual reviews permit `existence_verified`, and any `failed` result blocks approval.
4. **Authoritative State Machine**: `state.json` (`current_stage`) is the sole execution authority; manifest drift blocks approval under strict/standard profiles and is repaired upon stage advancement.
5. **Governance-Frozen Snapshots**: Stage 6 milestone snapshots are governance-frozen artifacts marked read-only on disk; physical immutability requires external forge and protected storage controls.
6. **Schema Fidelity**: `stage_history[].human_approval` strictly restricts properties to the 4 allowed fields, preventing any schema invalidation during lifecycle transitions. Minimal schema evolutions for native fingerprints and review histories are formally documented for future release v1.1.0.
