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

#### Active Supporting Evidence Set Rule
- For any deliverable with `status: "verified"`, the array `deliverables[].evidence[]` constitutes the **current active supporting evidence set**.
- **100% of records in this set must have `result: "passed"`**. Zero records with `result: "failed"` or `"inconclusive"` are permitted.
- Historical failed runs from earlier development iterations must not remain in `deliverables[].evidence[]`. Failure logs remain preserved on disk under `.playbook/logs/` and in Exit Package Section 4/6 for auditability, but cannot be attached to an active verified deliverable.
- Document deliverables (e.g. PRD Core, Architecture Specifications) must record verification under valid qualitative or static disciplines: `architecture_review`, `schema_validation`, `static_analysis`, or `security_audit`.

#### Disciplines and Outcomes
- **Automated Evidence Disciplines**: Automated verification (`automated_test`, `build_typecheck`, `static_analysis`, `schema_validation`, `security_audit`) generates local logs or reports. Under strict and standard governance profiles, an `evidence_hash` (`sha256:[a-f0-9]{64}`) is mandatory. The verifier must return `integrity_passed`.
- **Manual Evidence Disciplines**: Qualitative reviews (`manual_functional`, `visual_review`, `accessibility_audit`, `architecture_review`) reference markdown checklists, walk-through logs, or screenshots. In these cases, `evidence_hash` is nullable (`null`). The verifier checks physical file presence and readability (`existence_verified`). The human reviewer must evaluate the artifact contents.
- **Failed or Inconclusive Outcomes**: If an evidence record has `result: "failed"` or `"inconclusive"`, the deliverable cannot be verified. Gate eligibility is immediately blocked.
- **Unsupported Remote URIs**: References with remote schemes (`http://`, `https://`) receive status `unsupported`. Because hermetic, offline reproducibility is required for verifiable governance, remote references strictly block gate approval.

#### Five-Tier Verification Enforcement Matrix

Every verification check and governance policy is categorized into one of five authoritative enforcement tiers:
1. **Schema-Enforced**: Formally constrained by Draft 2020-12 schema rules (`schemas/project-state.schema.json` and `project-manifest.schema.json`). Any violation renders the JSON document schema-invalid.
2. **Existing CLI-Enforced**: Formally evaluated and reported by the existing Playbook CLI diagnostics and evidence verification engine (`verifier.ts`, `diagnostics/`).
3. **Future CLI-Enforced**: Programmatically evaluated and enforced by the Task 004D CLI implementation (`playbook approve`, `playbook advance`, `playbook repair-manifest`, Write-Ahead Journal).
4. **Human-Reviewed**: Substantive qualitative engineering evaluation performed by the human reviewer during interactive gate review.
5. **Agent-Instruction-Only**: Normative guidelines for AI agents specified in `AGENTS.md` and lifecycle stage definitions.

| Rule / Verification Policy | Schema-Enforced | Existing CLI-Enforced | Future CLI-Enforced | Human-Reviewed | Agent-Instruction-Only |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`evidence[]` non-empty on `verified` deliverable (`minItems: 1`)** | ✔ | ✔ | — | — | — |
| **`validation_status: "passed"` on `verified` deliverable** | ✔ | ✔ | — | — | — |
| **`evidence_hash` format matches `^sha256:[a-f0-9]{64}$` when present** | ✔ | ✔ | — | — | — |
| **Deliverable `status` enum (`not_started`, `verified`, etc.)** | ✔ | ✔ | — | — | — |
| **Evidence metadata completeness (`procedure`, `verified_by`, etc.)** | ✔ | ✔ | — | — | — |
| **Local evidence file existence on disk** | — | ✔ | — | — | — |
| **SHA-256 integrity verification (`integrity_passed`)** | — | ✔ | — | — | — |
| **Path traversal & symlink escape defenses** | — | ✔ | — | — | — |
| **Unreadable file and directory target detection** | — | ✔ | — | — | — |
| **All active supporting evidence records have `result: "passed"`** | — | — | ✔ | — | — |
| **Evidence supersession / decoupling of historical failures** | — | — | ✔ | — | ✔ |
| **Interactive TTY prompt and confirmation phrase verification** | — | — | ✔ | — | — |
| **Write-ahead transaction journal & crash recovery execution** | — | — | ✔ | — | — |
| **Approval fingerprint sidecar creation and verification** | — | — | ✔ | — | — |
| **Manifest drift repair execution and audit logging** | — | — | ✔ | — | — |
| **Acceptable document discipline (`architecture_review`, etc.)** | — | — | — | ✔ | ✔ |
| **Acceptance criteria satisfaction & business logic correctness** | — | — | — | ✔ | — |
| **Adequacy of test coverage and edge-case assertions** | — | — | — | ✔ | — |
| **Manual review checklist evaluation & visual UX sign-off** | — | — | — | ✔ | — |

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
- Must not contain unresolved template placeholders (`<!-- TODO`, `[TODO`, `[INSERT`, `[PLACEHOLDER`).
- If waived deliverables exist, Section 3 and Section 7 must explicitly list compensating controls and reference the authorized `EXC-YYYYMMDD-###.md` exception record.

> [!IMPORTANT]
> **Structural Exit Package Validation vs. Semantic Human Judgment**:
> The automated exit package validator (`validateExitPackageStructure`) inspects purely structural and syntactic properties: document length ($\ge 200$ bytes), presence of canonical markdown section headers, and the absence of unresolved template placeholders.
> This structural verification is necessary but not sufficient: automated routines cannot evaluate whether the recorded claims are truthful, whether the architectural designs are sound, or whether acceptance criteria are genuinely satisfied. Substantive engineering evaluation and semantic judgment remain the exclusive, non-delegable responsibility of the human reviewer during interactive gate review.

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
   - The CLI presents a structured terminal summary before requesting confirmation:
     - Project ID, Name, Governance Profile, Milestone ID.
     - Active Stage number and name.
     - Deliverables verified count and waived count.
     - Active exceptions list with expiration dates.
     - Evidence verification summary (all passing hashes).
     - Link to Exit Package markdown document and a content preview.
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

> [!WARNING]
> **Heuristic Anti-Scripting Safeguards vs. Cryptographic Identity Proof**:
> The interactive terminal checks (`process.stdin.isTTY`), forbidden reviewer keyword filtering (`agent`, `bot`, `ai`), and typed confirmation phrase (`CONFIRM APPROVAL GATE <N>`) are heuristic guardrails designed to prevent accidental, unattended, or piped script execution in headless environments.
> These checks do **NOT** constitute cryptographic identity proof, non-repudiation, or authenticated actor verification. In environments where cryptographic non-repudiation is required, organizations must layer external controls such as Git GPG commit/tag signing, hardware security keys (FIDO2/WebAuthn), and mandatory peer pull-request approvals on protected repository branches.

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

To detect any post-approval drift deterministically, the governance engine defines an **Approval Fingerprint** generated at the exact moment of human approval and re-verified at the moment of stage advancement.

#### 1. Fingerprint Representation & Authoritative Scope
The approval fingerprint binds **strictly to authoritative lifecycle state and approval-relevant engineering deliverables in `state.json` and real-time disk hashes**:
- `state.project_id`
- `state.milestone_id`
- `state.current_stage`
- `state.stage_status` (normalized per Section 3.6.2)
- Deliverables array (IDs, names, statuses, validation statuses, artifact paths, exception refs)
- Deliverable supporting evidence metadata
- Real-time SHA-256 hashes of referenced local evidence files on disk
- Active exceptions metadata and expiration dates
- Blocking RFCs metadata and statuses
- Real-time SHA-256 hash of the compiled Stage Gate Exit Package markdown artifact

> [!IMPORTANT]
> **Exclusion of Manifest Properties from Fingerprint**:
> - **`manifest.active_lifecycle_stage` is strictly EXCLUDED from the fingerprint payload.** The manifest stage property is a downstream configuration mirror. Synchronizing this mirror does not alter engineering deliverables or evidence.
> - **`manifest.active_milestone_id` is strictly EXCLUDED from the fingerprint payload.** Milestone consistency is verified as an independent prerequisite check (`state.milestone_id === manifest.active_milestone_id`).

$$\text{approval\_fingerprint} = \text{"sha256:"} + \text{SHA256}(\text{JCS}(\text{CanonicalPayload}))$$

#### 2. Deterministic Canonical Projection Specification (Approval & Advancement)

To resolve the state transition from `stage_status = "pending_review"` (before approval) to `stage_status = "approved"` (after approval), the governance engine defines **one deterministic canonical projection** used for both approval digest generation and post-approval advancement verification.

```
┌────────────────────────────────────────────────────────┐
│ Pre-Approval:  state.stage_status = "pending_review"  │
│                ▼ Canonical Projection                  │
│                Normalized stage_status = "approved"    │ ──┐
│                Digest: sha256:7a4c9b0e12f...           │   │
├────────────────────────────────────────────────────────┤   │ 100% Identical
│ Post-Approval: state.stage_status = "approved"        │   │ JCS Byte Stream
│                ▼ Canonical Projection                  │   │ & SHA-256 Hash
│                Normalized stage_status = "approved"    │ ──┘
│                Digest: sha256:7a4c9b0e12f...           │
└────────────────────────────────────────────────────────┘
```

##### 2.1 Field Exclusion Rules
The following fields are strictly excluded from the canonical projection:
1. **Manifest Properties**: `manifest.json` fields (`active_lifecycle_stage`, `active_milestone_id`) are excluded. Downstream mirror synchronization does not alter engineering reality.
2. **Volatile Audit Metadata**: `state.last_updated`, `state.current_stage_detail.started_at`, and `state.current_stage_detail.exit_package.submitted_at` are excluded. Timestamps record audit history rather than engineering artifact completeness.
3. **Reviewer Decision Metadata**: `state.current_stage_detail.human_approval` is excluded to eliminate circular self-dependency (the fingerprint cannot hash an object that records the signature of the fingerprint).
4. **Historical Lifecycle Records**: `state.stage_history[]` is excluded. Past stage transitions are sealed and cannot affect the current stage's gate integrity.

##### 2.2 Field Normalization Rules
1. **`stage_status` Normalization**:
   - When evaluating a gate for approval (`stage_status === "pending_review"`) or verifying an approved gate during advancement (`stage_status === "approved"`), `stage_status` is **strictly normalized to the canonical token `"approved"`**.
   - **Why this is mathematically necessary**: Before approval, `state.stage_status` is `pending_review`. After approval, `state.stage_status` is `approved`. If `stage_status` were projected verbatim, recalculating the digest after approval would produce a completely different hash, immediately causing false `APPROVAL_STALE` errors. Normalizing both states to `"approved"` ensures that the canonical projection of an unchanged approval remains 100% byte-for-byte identical.
   - **Rejection of Non-Reviewable States**: If `stage_status` is in any non-reviewable/non-approved status (`in_progress`, `blocked`, `not_started`), it does **NOT** normalize to `"approved"`; recalculation raises `APPROVAL_INVALID_STAGE_STATUS` and immediately blocks advancement. Note that per `schemas/project-state.schema.json`, `"rejected"` is not a valid `stage_status` enum; gate rejections revert `stage_status` to `"in_progress"`.
2. **File Hash Lowercasing**: All computed SHA-256 file hashes (`file_sha256`) and recorded evidence hashes (`evidence_hash`) are normalized to lowercase hexadecimal with standard `sha256:` prefix.
3. **Deterministic Array Sorting**:
   - `deliverables`: Sorted lexicographically by `id` ascending.
   - `deliverables[].evidence`: Sorted lexicographically by `evidence_ref` ascending, then `requirement_id` ascending.
   - `exceptions`: Sorted lexicographically by `exception_id` ascending.
   - `rfcs`: Sorted lexicographically by `rfc_id` ascending.
4. **Path Canonicalization**: All filesystem references (`artifact_path`, `evidence_ref`, `exit_package.path`) are stripped of leading/trailing whitespace, resolved relative to project root, and formatted strictly using POSIX forward slashes (`/`).
5. **Null Representation**: Nullable schema properties with no value are rendered as literal JSON `null` (never omitted, never empty string).
6. **Canonical Serialization**: Serialized using RFC 8785 JSON Canonicalization Scheme (JCS): UTF-8 encoding, keys sorted lexicographically by UTF-16 code units, zero whitespace between tokens.

##### 2.3 Canonical Projection Schema & Example
```json
{
  "project_id": "zentrix-lms",
  "milestone_id": "M-1.0.0",
  "current_stage": 2,
  "stage_status": "approved",
  "deliverables": [
    {
      "id": "DELIV-201",
      "name": "System Architecture Specification",
      "status": "verified",
      "validation_status": "passed",
      "artifact_path": "docs/adr/ADR-001.md",
      "exception_ref": null,
      "evidence": [
        {
          "requirement_id": "REQ-001",
          "type": "architecture_review",
          "procedure": "Manual architectural inspection against Constitution",
          "result": "passed",
          "summary": "Verified simplicity, modularity, and ADR conformance",
          "exit_code": null,
          "evidence_ref": "docs/adr/ADR-001.md",
          "evidence_hash": null,
          "file_sha256": "sha256:4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b"
        }
      ]
    }
  ],
  "exceptions": [
    {
      "exception_id": "EXC-20261031-001",
      "status": "active",
      "waived_requirement": "REQ-003 load benchmark",
      "expiration_date": "2026-11-15"
    }
  ],
  "rfcs": [
    {
      "rfc_id": "RFC-20261031-001",
      "status": "resolved",
      "is_blocking": false
    }
  ],
  "exit_package": {
    "path": "docs/gates/GATE-2-EXIT-PACKAGE.md",
    "file_sha256": "sha256:8899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677"
  }
}
```

##### 2.4 Concrete Before / After Fingerprint Projection Example
The following demonstrates that pre-approval evaluation and post-approval recalculation yield the exact same canonical input:

```
─────────────────────────────────────────────────────────────────────────────
BEFORE APPROVAL (state.json on disk):
  "current_stage": 2,
  "stage_status": "pending_review",
  "deliverables": [ ... ],
  "exit_package": { "path": "docs/gates/GATE-2-EXIT-PACKAGE.md", ... }
─────────────────────────────────────────────────────────────────────────────
▼ Normalization Function: normalize_stage_status("pending_review") -> "approved"
Canonical Projection Payload:
  { "project_id": "zentrix-lms", "current_stage": 2, "stage_status": "approved", ... }
Calculated Digest: sha256:7a4c9b0e12f3456789abcdef0123456789abcdef0123456789abcdef01234567

─────────────────────────────────────────────────────────────────────────────
AFTER APPROVAL (state.json on disk):
  "current_stage": 2,
  "stage_status": "approved",
  "deliverables": [ ... ],
  "exit_package": { "path": "docs/gates/GATE-2-EXIT-PACKAGE.md", ... }
─────────────────────────────────────────────────────────────────────────────
▼ Normalization Function: normalize_stage_status("approved") -> "approved"
Canonical Projection Payload:
  { "project_id": "zentrix-lms", "current_stage": 2, "stage_status": "approved", ... }
Calculated Digest: sha256:7a4c9b0e12f3456789abcdef0123456789abcdef0123456789abcdef01234567
─────────────────────────────────────────────────────────────────────────────
VERDICT: Canonical inputs and SHA-256 digests are 100% byte-for-byte identical.
```

##### 2.5 State Changes That Invalidate Approval
Any mutation to the underlying engineering baseline between approval and advancement alters the canonical projection and invalidates the approval (`APPROVAL_STALE`):
1. **Deliverable Modification**: Adding, removing, or altering any deliverable (`id`, `name`, `status`, `validation_status`, `artifact_path`, `exception_ref`).
2. **Evidence Metadata Mutation**: Modifying any evidence record (`requirement_id`, `type`, `procedure`, `result`, `exit_code`, `evidence_ref`, `evidence_hash`).
3. **Evidence File Modification on Disk**: Any edit to a referenced evidence file modifies its computed `file_sha256`, altering the projection digest.
4. **Exception Mutation**: Adding, deleting, or altering active exceptions (`status`, `waived_requirement`, `expiration_date`).
5. **RFC Mutation**: Adding, modifying, or changing the blocking status of any RFC.
6. **Exit Package Modification on Disk**: Any post-approval edits to the markdown file at `exit_package.path` changes `exit_package.file_sha256`.
7. **Identity Mutation**: Altering `project_id`, `milestone_id`, or `current_stage`.
8. **Reversion of Lifecycle Status**: Resetting `stage_status` to `in_progress`, `blocked`, or `not_started`.

##### 2.6 Handling Rejected Review Attempts
When a human reviewer rejects a stage (`playbook approve --reject`):
- Per canonical schema `schemas/project-state.schema.json`, `stage_status` does NOT have a `"rejected"` enum; the active stage **transitions back to `stage_status: "in_progress"`** (or `"blocked"` if blocked by an active issue).
- Rejection disposition is canonically captured in `current_stage_detail.human_approval`:
  - `human_approval.status` is set to `"rejected"`.
  - `human_approval.decision` is set to `"REJECTED"`.
  - `human_approval.conditions` records mandatory rework instructions.
- `current_stage_detail.exit_package.status` reverts to `"drafted"`.
- Any existing `.playbook/approval-fingerprint.json` sidecar is immediately **unlinked/purged**.
- A rejected stage possesses **zero valid fingerprints**.
- When engineering fixes are completed and the stage is re-submitted, `state.stage_status` returns to `"pending_review"`.
- Subsequent human approval generates a **brand-new fingerprint sidecar** bound to the new approval timestamp, signature nonce, and updated file digests. Past rejections never corrupt future valid fingerprints.

#### 3. Sidecar JSON Schema & Contract (`.playbook/approval-fingerprint.json`)
To preserve the semantic purity of `signature_reference` (which records PR numbers, chat quotes, or commit references without overloading machine verification digests), the approval fingerprint is persisted in a dedicated machine-readable sidecar file:
```json
{
  "$schema": "https://ai-engineering-playbook.org/schemas/approval-fingerprint.schema.json",
  "schema_version": "1.0.0",
  "algorithm": "sha256",
  "project_id": "zentrix-lms",
  "milestone_id": "M-1.0.0",
  "gate": 2,
  "stage_name": "Architecture & System Design",
  "approved_at": "2026-10-31T11:55:00.000Z",
  "approved_by": "Zain Ali",
  "role": "Lead Systems Architect",
  "signature_reference": "Interactive CLI Session 8dec625e-7884-4400-a257-39124763c805",
  "fingerprint": "sha256:7a4c9b0e12f3456789abcdef0123456789abcdef0123456789abcdef01234567",
  "payload_digest_inputs": {
    "deliverables_count": 2,
    "verified_deliverables": ["DELIV-201", "DELIV-202"],
    "evidence_files": [
      {
        "path": ".playbook/logs/arch-review.log",
        "hash": "sha256:110d48aec22c1112dca947986c24ea8e4328be19f821f52204e5f81c38640558"
      }
    ],
    "exit_package_path": "docs/gates/GATE-2-EXIT-PACKAGE.md",
    "exit_package_hash": "sha256:8899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677"
  }
}
```

#### 4. Unified Write-Ahead Journal Synchronization
During `playbook approve`, the engine does NOT rely on isolated sequential file renames. Instead, both `.playbook/state.json` and `.playbook/approval-fingerprint.json` are committed under the unified Write-Ahead Transaction Journal (`.playbook/tx-journal.json`) and exclusive lock (`.playbook/transaction.lock`) described in Section 6. This guarantees that a crash midway through writing or renaming cannot leave an orphaned sidecar on disk while state remains in `pending_review`.

#### 5. Interrupted Approval Recovery & Sidecar Consistency Rules

If a crash, power failure, or process termination interrupts an approval transaction, or if files on disk are modified out-of-band, the recovery engine evaluates the state using the following exhaustive recovery decision matrix:

| Recovery Scenario | State on Disk | Approval Valid? | Advancement Allowed? | Automatic Recovery Safe? | Human Re-Review Required? | Files Untouched? | Diagnostic Code Emitted | Safety Invariant & Resolution |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **Case A** | `state.json = pending_review`<br>`sidecar = new` | **NO** | **NO** | **Roll-Forward ONLY if WAL journal is valid COMMITTING**;<br>otherwise **UNSAFE** | **YES** (if journal absent) | **YES** (quarantined) | `APPROVAL_FINGERPRINT_ORPHANED` | State is authoritative. No orphaned sidecar may independently establish human approval. Sidecar purged on next review. |
| **Case B** | `state.json = approved`<br>`sidecar = missing` | **NO** | **NO** | **STRICTLY UNSAFE**<br>(Cannot fabricate signature) | **YES** | **YES** | `APPROVAL_FINGERPRINT_MISSING` | Recreating sidecar silently would bypass human cryptographic verification. Requires human re-approval or Git restore. |
| **Case C** | `state.json = approved`<br>`sidecar = malformed` | **NO** | **NO** | **STRICTLY UNSAFE** | **YES** | **YES** | `APPROVAL_FINGERPRINT_MALFORMED` | Malformed sidecar preserved for post-mortem evidence. Human must re-approve or restore from Git. |
| **Case D** | `state.json = pending_review`<br>`sidecar = missing` | **NO** | **NO** | **N/A** (Normal pre-approval state) | **YES** (Standard review) | **YES** | `GATE_PENDING_REVIEW` | Standard pre-approval state. Human runs `playbook approve --gate <N>`. |
| **Case E** | Missing/corrupt journal;<br>hashes mismatch known valid tx | **NO** | **NO** | **STRICTLY FORBIDDEN (FAIL CLOSED)** | **YES** (Human Git triage) | **STRICTLY UNTOUCHED** | `CRITICAL_RECOVERY_FAILURE`<br>`TRANSACTION_JOURNAL_CORRUPT` | Engine never guesses or synthesizes state. Halts immediately; human operator must inspect git diff. |

> [!CAUTION]
> **Core Non-Negotiable Invariant: No Orphaned Sidecar Approval**
> Under zero circumstances may an orphaned or unverified sidecar (`approval-fingerprint.json`) independently establish human approval. If `state.json` does not record `stage_status === "approved"`, the gate is **categorically unapproved**, regardless of sidecar contents.

### 3.7 Source-of-Truth & Manifest Drift Recovery (Deadlock Prevention)

#### The Deadlock Problem
Under `strict` and `standard` governance profiles, manifest stage drift (`manifest.active_lifecycle_stage !== state.current_stage`) blocks gate approval. Because advancement requires valid approval, and advancement is the operation that synchronizes the manifest, the system would deadlock if drift occurs prior to review:
$$\text{Cannot Approve (Manifest Drifted)} \longleftrightarrow \text{Cannot Advance (Not Approved)}$$

#### Explicit Recovery Procedure (`playbook repair-manifest`)
To resolve this deadlock deterministically without bypassing quality gates:
1. **Authoritative State Rule**: `state.json` (`current_stage`) is strictly authoritative for lifecycle execution. `manifest.json` (`active_lifecycle_stage`) is a downstream configuration mirror.
2. **Dedicated Repair Procedure**:
   - The human engineer runs `playbook repair-manifest` (or confirms repair when prompted by `playbook approve`).
   - Requires explicit interactive confirmation:
     ```text
     Manifest active_lifecycle_stage is currently 1, but authoritative state.current_stage is 2.
     Synchronize manifest.active_lifecycle_stage to 2? [y/N]: y
     ```
3. **Pre-Repair Validation Preconditions**:
   - Both `manifest.json` and `state.json` must pass JSON syntax and schema validation.
   - `manifest.project_id` must strictly match `state.project_id`.
   - `manifest.active_milestone_id` must **strictly match** `state.milestone_id`. If milestone IDs differ (`MILESTONE_MISMATCH`), repair is **strictly barred**. Milestone conflicts represent scope divergence, not simple mirror drift.
4. **Audit Trail**:
   - Manifest update synchronizes `active_lifecycle_stage` to match `state.current_stage`.
   - `state.last_updated` records `reason: "Repaired manifest stage pointer to match authoritative state.current_stage"` with `actor_type: "human"`.
5. **Approval & Fingerprint Preservation (Authoritative Decisions)**:
   - **Does manifest repair invalidate an existing approval?**: **NO.** Synchronizing `manifest.active_lifecycle_stage` does not alter any deliverable, evidence file, or gate exit package. Because manifest properties are excluded from the fingerprint, the fingerprint remains 100% valid.
   - **Can repair occur after approval?**: **YES.** If manifest drift occurs or is detected after approval but before advancement, `playbook repair-manifest` can be executed to synchronize the mirror.
   - **Does repair require new human approval?**: **NO.** Repair synchronizes the configuration mirror to reflect the stage that was already approved by the human engineer. (However, if milestone identifiers conflict, repair is refused; milestone divergence requires human scope re-planning, not mirror synchronization).
6. **Zero Silent Overwrite Invariant**: No CLI operation may silently overwrite conflicting milestone or stage state without human authorization.

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
- **Governance-Frozen Artifact**: The milestone snapshot (`.playbook/milestones/state-<milestone_id>.json`) and sealed state history are *conventionally frozen* by the Playbook governance layer. The CLI strictly blocks modification or overwriting of terminal milestones (`ADVANCEMENT_BLOCKED`, `SNAPSHOT_CONFLICT`) and sets filesystem permissions to read-only (`0o444`).
- **Technical/Hardware Mutability Realities**: Files stored in a standard operating system directory and Git working tree are **NOT** hardware-immutable (such as WORM optical media, hardware security modules, or cloud storage buckets with compliance-mode Object Lock). Any process or administrative user with filesystem write access can modify or delete files out-of-band. Technical non-repudiation and permanent tamper resistance require pushing commits to protected Git branches with required linear history, enforced peer reviews, cryptographic GPG-signed tags, and immutable remote archive backups.

---

## 5. Security & Trust Boundaries

### 5.1 Claimed Reviewer Identity vs. Authenticated Cryptographic Identity
- **Claimed Identity**: In the local CLI prompt (`playbook approve`), the reviewer provides their name and role as strings. This represents a *claimed identity*, not a cryptographically proven credential.
- **Authorization Barrier (TTY & Anti-Scripting Guardrails)**: The interactive TTY check (`process.stdin.isTTY === true`) and forbidden name filtering (`isForbiddenAgentName`) enforce that approval is executed in an interactive terminal session rather than an automated script or background agent subprocess. They are **heuristic operational execution safeguards**, not cryptographic identity proofs or digital signature verifications.
- **Upstream Cryptographic Identity Assurance**: True human authentication and non-repudiation are enforced at the Git forge and cryptographic identity boundaries:
  - **Solo Mode**: Relies on local workstation OS login, GPG/SSH commit and tag signing, and cryptographic hardware tokens (e.g. YubiKey).
  - **Team Mode**: Enforced via GitHub/GitLab Branch Protection Rules, Required Pull Request Reviews, CODEOWNERS authorization, multi-factor authentication (MFA), and GPG-signed merge commits. The CLI captures the authenticated PR number or cryptographic commit reference in `signature_reference`.

### 5.2 Strict Prohibition on Agent Self-Approval
- Schema invariants in `project-state.schema.json` enforce:
  When `stage_status === "approved"`, `last_updated.actor_type` must equal `"human"`.
- Any attempt by an AI agent to write `"actor_type": "agent"` alongside `stage_status: "approved"` fails schema validation (`STATE_SCHEMA_INVALID`), immediately blocking repository progression.
- The approval command rejects any reviewer name matching agent identifiers (`agent`, `bot`, `controller`, `playbook`, `orchestrator`, `ai`).

### 5.3 Rejection Representation and Review History Semantics

#### 1. Semantic Review States in v1.0.0
The engine strictly differentiates four review states:
1. **Current Pending Review**: `stage_status === "pending_review"` and `human_approval.status === "pending_review"`. Deliverables are verified/waived, exit package is submitted, awaiting human decision.
2. **Current Active Approval**: `stage_status === "approved"` and `human_approval.status === "approved"`. Reviewer has signed off; stage is ready for advancement.
3. **Current Active Rejection**: `stage_status === "in_progress"` and `human_approval.status === "rejected"`. Human rejected gate submission; deliverables requiring rework revert to `in_progress`; exit package reverts to `drafted`.
4. **Historical Rejection (Multi-Cycle Review)**: A previous review cycle that ended in rejection, followed by rework and a subsequent approval.

#### 2. Rejection State Mutation Protocol (`REJECT_GATE`)
When the human reviewer rejects a submission:
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
}
```

#### 3. Documented Architectural Limitation (v1.0.0)
- In schema v1.0.0, `current_stage_detail.human_approval` is a single object representing current disposition. When a rejected stage is subsequently approved, `human_approval` transitions to `approved`, overwriting the in-state rejection fields.
- **Explicit Limitation**: Git commit history and Stage Gate Exit Package markdown (Sections 6 & 9) preserve human-readable auditability of past rejections, but **v1.0.0 state.json does NOT maintain a structured, machine-queryable array of historical rejections**.
- **Proposed Schema Evolution (v1.1.0)**: To support queryable review ledgers directly in state, we propose adding `current_stage_detail.review_history[]` in schema version 1.1.0.

### 5.4 Locking Guarantees, PID Reuse & Cross-Platform Realities

Mutual exclusion across all write transactions (`APPROVE_GATE`, `ADVANCE_STAGE`, `CLOSE_LIFECYCLE`, `REPAIR_MANIFEST`) is governed by an atomic dual-lock protocol utilizing `.playbook/transaction.lock` (the primary transaction mutex) and `.playbook/reclaim.lock` (the stale-lock reclamation mutex).

#### 1. Complete Lock Lifecycle & Shared Protocol Specification

To prevent race conditions, stale lock deadlocks, or lock overtaking during reclamation, **all participating processes adhere to one unified, coherent protocol**:

```
[ Process Enters ]
        │
        ▼
┌───────────────────────────────────────┐
│ 1. Pre-Acquisition Guard Check        │
│    Is reclaim.lock present & active?  │── YES ──► Back off with randomized
└───────────────────────────────────────┘           exponential jitter (50-200ms)
        │ NO (or proven dead reclaimer cleared)
        ▼
┌───────────────────────────────────────┐
│ 2. Attempt Exclusive Lock Creation   │
│    fs.openSync('transaction.lock','wx')│── FAILED (EEXIST) ──► Go to 4. Staleness
└───────────────────────────────────────┘                        & Contention Check
        │ SUCCEEDED
        ▼
┌───────────────────────────────────────┐
│ 3. Write & Flush Payload              │
│    Write PID, host, created_at, nonce │
│    fs.fsyncSync(fd); fs.closeSync(fd) │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ 4. Post-Acquisition Invariant Check   │
│    Did reclaim.lock appear in-flight? │── YES ──► Roll back: unlink my lock
└───────────────────────────────────────┘           if nonce matches; back off
        │ NO
        ▼
[ ACQUISITION SUCCESSFUL — Execute Transaction ]
        │
        ▼
┌───────────────────────────────────────┐
│ 7. Safe Lock Release                  │
│    Assert nonce === myNonce           │── NONCE MISMATCH ──► DO NOT UNLINK!
│    fs.unlinkSync('transaction.lock')  │                      Emit LOCK_LOST_DURING_TX
└───────────────────────────────────────┘
```

##### Step 1: Pre-Acquisition Guard Inspection (`reclaim.lock`)
- Before attempting to create `transaction.lock`, any process (e.g. Process C) must check for the presence of `.playbook/reclaim.lock`.
- If `reclaim.lock` exists:
  - The process inspects its payload: `{ reclaiming_pid, hostname, target_nonce, created_at, nonce }`.
  - **Ownership Invariant**: A live reclaimer holds absolute ownership of `reclaim.lock`. A live reclaimer **never loses ownership solely because its marker exceeded an elapsed time**.
  - If `reclaim.lock` is **unreadable, empty, or truncated**:
    - Process C **must not delete or steal the marker**.
    - Process C **fails closed** with diagnostic `RECLAIM_MARKER_UNVERIFIABLE`.
  - If `reclaim.lock` is **active** (process `reclaiming_pid` is alive on the local OS with process start-time $\le$ `created_at`):
    - **Reclamation is actively in progress.** Process C **must never attempt acquisition** of `transaction.lock` while reclamation is active.
    - Process C backs off with randomized exponential jitter (50ms–200ms) and retries Step 1.
  - If `reclaim.lock` is **proven dead** (PID does not exist via `ESRCH` or start-time is recycled):
    - Process C safely unlinks the dead `reclaim.lock` per Section 5.4.5 before proceeding.

##### Step 2: Primary Lock Creation (`transaction.lock`)
- The process attempts atomic creation: `fs.openSync('.playbook/transaction.lock', 'wx')` (`O_CREAT | O_EXCL`).
- **If creation succeeds (file descriptor returned)**:
  - Generate cryptographically secure UUIDv4 `nonce`.
  - Serialize and write payload:
    ```json
    {
      "pid": 14208,
      "hostname": "workstation-01",
      "created_at": "2026-10-31T12:00:00.000Z",
      "nonce": "d8f1e2c3-4b5a-6789-0123-abcdef456789"
    }
    ```
  - Flush to physical storage via `fs.fsyncSync(fd)` and close `fd`.
- **If creation fails (`EEXIST`)**:
  - `transaction.lock` already exists on disk.
  - Enter **Staleness & Contention Evaluation** (Section 5.4.3 & 5.4.4).

##### Step 3: Post-Acquisition Invariant Re-Check
- To close the microsecond race window between checking `reclaim.lock` (Step 1) and creating `transaction.lock` (Step 2):
  - Immediately after creating `transaction.lock`, the process checks if `.playbook/reclaim.lock` exists.
  - If `reclaim.lock` was created concurrently:
    - The acquiring process must not enter the transaction.
    - It reads `transaction.lock`. If `data.nonce === myNonce`, it unlinks `transaction.lock`.
    - It backs off with jitter and returns to Step 1.
  - If `reclaim.lock` does not exist: **Lock acquisition is verified and exclusive.**

#### 2. Empty, Truncated, and Malformed Lock Defenses

A critical concurrency defect in naive lock designs is assuming that elapsed time (e.g. 10 seconds) proves a lock creator is dead. **Age alone must NEVER establish that a lock owner is dead.** A running process undergoing memory paging, heavy CPU throttling, or long garbage collection pauses remains alive; unilaterally deleting its lock permits concurrent split-brain state mutations.

##### Safe Behavior When Metadata is Absent or Unreadable:
1. **Transient Write-In-Flight Polling**:
   - File creation and payload flushing (`openSync` to `fsyncSync`) normally completes within microseconds.
   - An inspecting process encountering a 0-byte or unparseable lock file polls with exponential backoff for up to **1000ms (1 second)** to accommodate transient local file-buffer flushing.
2. **Fail-Closed on Unverifiable Ownership**:
   - If after 1 second the lock file remains empty, truncated, or unparseable JSON:
   - Because no PID, hostname, or nonce exists, **process ownership cannot be cryptographically or reliably established**.
   - Automated CLI commands (including `playbook approve` and `playbook advance`) **cannot prove the creator is dead**.
   - Therefore, the governance engine **FAILS CLOSED IMMEDIATELY** with diagnostic code `LOCK_METADATA_UNREADABLE`.
   - Automated commands **strictly halt without modifying or deleting the lock file**.
3. **Safe Operator Recovery Protocol (`playbook repair-lock`)**:
   How can a crashed process that left an empty lock be recovered without allowing concurrent transactions?
   - Recovery is barred for unattended background agents.
   - Recovery requires an explicit interactive human session via `playbook repair-lock`:
     1. The operator executes `playbook repair-lock` in an interactive terminal.
     2. The tool inspects the host operating system process table (`ps -ef` / Win32 `Get-Process`) for any running `playbook` CLI instances in the current repository tree.
     3. **Active Process Found**: If any `playbook` CLI process is running, the tool halts immediately, displays the PID, and refuses to touch the lock.
     4. **Zero Active Processes Proven**: If and only if the tool confirms **0 active playbook processes** exist on the host, it displays the lock path, size, and timestamp, and prompts for explicit operator confirmation:
        ```text
        Found empty/corrupt lock file with unreadable metadata: .playbook/transaction.lock
        Audited local process tree: 0 active playbook CLI processes found.
        Confirm removal of unowned lock file to restore repository operations? [y/N]:
        ```
     5. Upon operator confirmation (`y`), the tool unlinks the file and records an audit entry in `state.last_updated`.

#### 3. PID Reuse & Cross-Platform Start-Time Verification

Operating systems recycle PIDs over time. When valid JSON metadata exists in `transaction.lock` or `reclaim.lock`, the engine establishes genuine process death through verifiable operating system evidence:
1. **Host Boundary Check**:
   - If `lock.hostname !== os.hostname()`, local PID checks are invalid across physical machines. The CLI cannot verify death over network mounts and fails closed with `CROSS_HOST_LOCK_UNVERIFIABLE`.
2. **Process Liveliness Check**:
   - On the same host, call `process.kill(pid, 0)` (supported on POSIX and Windows in Node.js).
   - If `ESRCH`: The PID definitively does not exist in the OS process table; the process is **dead**.
3. **Cross-Platform Start-Time Verification (PID Recycling Defense)**:
   - If `process.kill(pid, 0)` indicates the PID is alive, the OS may have assigned that PID to an unrelated new application.
   - **POSIX (Linux/macOS)**: Query `/proc/<pid>/stat` (field 22 `starttime`) or execute `ps -p <pid> -o lstart=`. If the process start time is *after* `lock.created_at`, the PID was recycled; the original locking process is dead.
   - **Windows (NTFS)**: Query Win32 process creation time via `GetProcessTimes` or PowerShell `(Get-Process -Id <pid>).StartTime`. If the process creation time is *after* `lock.created_at`, the PID was recycled; the original locking process is dead.
   - **Liveness Invariant**: If the process is alive and start time $\le$ `lock.created_at`, the process is **genuinely alive**. A live process **NEVER loses its lock due to time elapsed**. Other processes must wait or fail closed.
4. **Fallback Rule**: If operating system security policies prevent querying process start times, the engine requires verified dead PID (`ESRCH`) before declaring a lock stale.

#### 4. Atomic Stale-Lock Reclamation Protocol (`reclaim.lock`)

When multiple processes simultaneously detect that `transaction.lock` is stale due to a **proven dead process** (`STALE_DEAD_PROCESS` or `STALE_PID_RECYCLED`):
1. **Reclamation Mutex Competition**:
   - Neither process may directly unlink `transaction.lock`.
   - Each process attempts to acquire the atomic reclamation mutex:
     `fs.openSync('.playbook/reclaim.lock', 'wx')`
   - **Winning Process**: Succeeded in acquiring `reclaim.lock`.
     - Writes payload: `{ "reclaiming_pid": process.pid, "hostname": os.hostname(), "target_nonce": staleNonce, "created_at": new Date().toISOString(), "nonce": reclaimNonce }`.
     - Flushes via `fsync` and closes.
   - **Losing Processes**: Fail with `EEXIST`. They back off with exponential jitter and return to Step 1.
2. **Stale Target Invariant Verification**:
   - The winning process re-reads `transaction.lock`.
   - If `transaction.lock` is missing or its `nonce !== staleNonce`:
     - Another process already reclaimed or renewed the lock.
     - The winner safely unlinks `reclaim.lock` (verifying `reclaimNonce`) and aborts reclamation.
3. **Unlink & Re-Acquire**:
   - The winner unlinks the stale `transaction.lock`.
   - The winner immediately creates a new `transaction.lock` via `openSync(..., 'wx')` with a fresh nonce and its own PID.
   - The winner unlinks `reclaim.lock` (verifying `reclaimNonce`).
   - The winning process now exclusively owns `transaction.lock` and proceeds with the transaction.

#### 5. Reclaimer Crash Scenarios & Self-Healing Matrix

If the winning reclaimer process crashes at any point during reclamation, subsequent processes evaluate the state using strict OS proof of death:

| Reclaimer Crash Point | State on Disk | Verification of Death | Recovery Action by Subsequent Process | Invariant Preserved |
| :--- | :--- | :--- | :--- | :--- |
| **Crash after acquiring `reclaim.lock`, before unlinking `transaction.lock` (with metadata)** | `reclaim.lock` exists (PID B); `transaction.lock` exists (stale A). | Next process reads PID B; OS returns `ESRCH` or start-time recycled. | Next process safely unlinks verified dead `reclaim.lock`, then re-evaluates `transaction.lock`. | No deadlock; dead reclaimer cleared via verified OS proof. |
| **Crash after acquiring `reclaim.lock` before flush (0-byte marker)** | `reclaim.lock` exists (0 bytes); `transaction.lock` exists (stale A). | Unreadable metadata; PID cannot be verified. | **Fails closed immediately** (`RECLAIM_MARKER_UNVERIFIABLE`). Halts; requires `playbook repair-lock`. | Prevents lock stealing when creator cannot be proven dead. |
| **Crash after unlinking `transaction.lock`, before creating new lock** | `reclaim.lock` exists (PID B); `transaction.lock` is missing. | Next process reads PID B; OS confirms PID B is dead. | Next process safely unlinks dead `reclaim.lock`; proceeds with standard normal acquisition of `transaction.lock`. | Self-heals cleanly; unlinking requires dead PID proof. |
| **Crash after creating new `transaction.lock`, before unlinking `reclaim.lock`** | Both locks exist (held by PID B, dead). | Next process confirms PID B is dead. | Next process safely unlinks dead `reclaim.lock`, then initiates standard reclamation on dead `transaction.lock`. | Clean sequential unwinding of abandoned locks. |

#### 6. Before / After Comparison of Corrected Lock Recovery Behavior

| Dimension | Previous Flawed Heuristic | Corrected Fail-Closed Protocol |
| :--- | :--- | :--- |
| **0-byte / Truncated Lock File** | Lock declared dead automatically if age $\ge 10$s. | 1s transient backoff; if still empty, **fails closed** (`LOCK_METADATA_UNREADABLE`). Requires interactive `playbook repair-lock` with process-tree auditing. |
| **Reclamation Marker TTL** | `reclaim.lock` declared dead automatically if age $\ge 15$s. | Marker owner **never loses lock due to age**. Reclaimer must be proven dead via OS process table (`ESRCH` / start-time). If unreadable, fails closed. |
| **Cross-Host Locks** | Unverifiable PIDs assumed dead after timeout. | If `lock.hostname !== os.hostname()`, PID checks are barred. Fails closed (`CROSS_HOST_LOCK_UNVERIFIABLE`). |
| **Living Slow Process** | Lock could be stolen by competing process after TTL. | A living process with valid PID and matching start-time retains ownership. Competing processes must back off or fail closed. |
| **Operator Recovery Tool** | None (required ad-hoc manual file deletion). | Dedicated interactive command `playbook repair-lock` that audits active processes before permitting lock unlinking. |

#### 7. Ownership Verification on Lock Release & Race Prevention
When a transaction finishes and the process prepares to release `transaction.lock`:
1. Read `.playbook/transaction.lock` from disk.
2. Parse JSON and verify ownership:
   $$\text{lock.nonce} === \text{myNonce} \quad \land \quad \text{lock.pid} === \text{process.pid}$$
3. **If ownership matches**: Unlink `.playbook/transaction.lock`.
4. **If nonce mismatches**:
   - **DO NOT UNLINK.**
   - The process lost ownership (e.g. following operator intervention or crash recovery).
   - Emit diagnostic `LOCK_LOST_DURING_TRANSACTION`.
   - This invariant strictly prevents a slow or resurrected process from deleting another process's active lock.

#### 8. Supported Filesystems Boundary & OS-Specific Requirements
- **Supported Local Filesystems**: NTFS (Windows), ext4/btrfs/XFS (Linux), APFS (macOS). These filesystems guarantee:
  1. Atomic single directory entry creation with `O_CREAT | O_EXCL` (`openSync` with `'wx'`).
  2. Single-file atomic replace via `rename(2)` / `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`.
  3. Immediate consistency of local directory metadata following `fsync`.
- **Unsupported Filesystems (Documented Limitation)**:
  - Network filesystems (NFSv2, NFSv3, SMB/CIFS shares). NFSv3 does not guarantee atomic `O_EXCL` across clients and suffers from close-to-open attribute caching lag.
  - Virtualized bind mounts (e.g. Docker shared desktop mounts on Windows/macOS using 9P or virtiofs) where host-guest inode mapping or oplocks delay file existence visibility.
  - **Operational Constraint**: Multi-process Playbook execution on unsupported network filesystems is strictly unsupported. The CLI emits a diagnostic warning if a network filesystem is detected.
- **Supported Local Filesystems**: NTFS (Windows), ext4/btrfs/XFS (Linux), APFS (macOS). These filesystems guarantee:
  1. Atomic single directory entry creation with `O_CREAT | O_EXCL` (`openSync` with `'wx'`).
  2. Single-file atomic replace via `rename(2)` / `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`.
  3. Immediate consistency of local directory metadata following `fsync`.
- **Unsupported Filesystems (Documented Limitation)**:
  - Network filesystems (NFSv2, NFSv3, SMB/CIFS shares). NFSv3 does not guarantee atomic `O_EXCL` across clients and suffers from close-to-open attribute caching lag.
  - Virtualized bind mounts (e.g. Docker shared desktop mounts on Windows/macOS using 9P or virtiofs) where host-guest inode mapping or oplocks delay file existence visibility.
  - **Operational Constraint**: Multi-process Playbook execution on unsupported network filesystems is strictly unsupported. The CLI emits a diagnostic warning if a network filesystem is detected.

### 5.5 Snapshot Preservation & Immutability Realities

#### 1. Snapshot Guarantees vs. Physical Mutability
- **Governance-Frozen Status**: Conventional status enforced by the Playbook state machine.
- **Accidental Edit Defense**: The snapshot file (`.playbook/milestones/state-<milestone_id>.json`) is marked read-only on disk (`chmod 0o444`).
- **Explicit Limitation**: **`chmod 0o444` is NOT hardware WORM or cryptographic immutability.** Any user with file ownership can execute `chmod 0o644` and edit the file locally.
- **True Storage Immutability**: Requires upstream Git forge controls: branch protection rules, required linear histories, signed tags (`git tag -s`), and compliance object storage (e.g. AWS S3 Object Lock, GCS Bucket Lock).

#### 2. Snapshot Collision Defense
If `.playbook/milestones/state-<milestone_id>.json` already exists:
- If SHA-256 matches target state snapshot: Idempotent re-run. Proceed safely.
- If SHA-256 differs: **Halt immediately with `SNAPSHOT_CONFLICT`**. Overwriting existing milestone snapshots is strictly prohibited to prevent data loss or silent history tampering.

### 5.6 Co-Location Trust Boundary
- In repositories where `.playbook/state.json`, `manifest.json`, and evidence logs reside in the same Git working tree, an actor with commit authority has physical write access to all files.
- The Playbook architecture provides **verifiability and traceability**, not hardware-grade non-repudiation. External auditability is established when commits are pushed to protected upstream repositories.

---

## 6. Unified Multi-File Transaction Safety & Crash Recovery

### 6.1 Transaction Safety Realities & Operating System Assumptions
Lifecycle operations require updating multiple files:
- **Gate Approval (`APPROVE_GATE`)**: Updates `.playbook/state.json` and creates `.playbook/approval-fingerprint.json`.
- **Lifecycle Advancement (`ADVANCE_STAGE`)**: Updates `.playbook/state.json` and `.playbook/manifest.json`.
- **Lifecycle Closure (`CLOSE_LIFECYCLE`)**: Updates `.playbook/state.json`, `.playbook/manifest.json`, and creates `.playbook/milestones/state-<milestone_id>.json`.
- **Manifest Repair (`REPAIR_MANIFEST`)**: Updates `.playbook/manifest.json` and updates `state.json` audit trail.

> [!WARNING]
> **No Kernel Multi-File Atomicity**: Standard operating systems (Windows NTFS, Linux ext4, macOS APFS) provide atomic renaming for a *single file*, but **no OS provides multi-file atomic rename syscalls**. A crash midway between two file renames will leave state, manifest, or sidecars desynchronized unless governed by a unified write-ahead transaction journal.

#### Filesystem & Operating System Assumptions
1. **Single-File Rename Atomicity**: Assumes POSIX `rename(2)` and Windows NTFS `SetFileInformationByHandle` / `MoveFileExW` replace a directory entry atomically within the same filesystem volume.
2. **Durability via fsync**:
   - Temporary file data must be flushed to disk via `fs.fsyncSync(fd)` before renaming.
   - On POSIX, the containing directory (`.playbook/`) must be flushed (`fs.fsyncSync(dirFd)`) after renaming to commit directory metadata to disk.
3. **Windows Open-Handle Defenses**: On Windows, file renames fail with `EBUSY` or `EPERM` if another process (e.g. anti-virus, indexing service) holds an open handle. The transaction engine incorporates exponential backoff retries (up to 5 retries over 500ms) for rename operations.
4. **Fail-Closed Safety Invariant**: If a journal is corrupt/unparseable, or if live files differ from both expected source and target hashes, the CLI **fails closed immediately** (`CRITICAL_RECOVERY_FAILURE`), leaving files untouched and prompting for human git restoration. The engine never guesses or synthesizes state.

### 6.2 Write-Ahead Transaction Journal Protocol
All multi-file operations (`APPROVE_GATE`, `ADVANCE_STAGE`, `CLOSE_LIFECYCLE`, `REPAIR_MANIFEST`) execute under the unified process lock (`.playbook/transaction.lock`) and Write-Ahead Transaction Journal (`.playbook/tx-journal.json`) containing **full serialized target payloads**:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Acquire exclusive lock (.playbook/transaction.lock)      │
│ 2. Compute target payloads in-memory & validate schemas     │
│ 3. Write Transaction Journal (.playbook/tx-journal.json)    │
│    phase: "PREPARED", target file contents & hashes         │
│ 4. Write temporary files (.tmp) and backup copies (.bak)    │
│ 5. Update Transaction Journal phase: "COMMITTING"           │
│ 6. Sequentially rename .tmp files to live target paths      │
│ 7. Update Transaction Journal phase: "COMMITTED"            │
│ 8. Cleanup .bak, .tmp, delete tx-journal.json               │
│ 9. Release exclusive lock (.playbook/transaction.lock)      │
└─────────────────────────────────────────────────────────────┘
```

#### Durable Information in Journal (`.playbook/tx-journal.json`)
The journal stores full target content strings, ensuring roll-forward can succeed even if temporary files are lost:
```json
{
  "tx_id": "tx-1730375700000-a1b2",
  "phase": "PREPARED", // PREPARED -> COMMITTING -> COMMITTED
  "created_at": "2026-10-31T12:00:00.000Z",
  "action": "ADVANCE_STAGE", // APPROVE_GATE | ADVANCE_STAGE | CLOSE_LIFECYCLE | REPAIR_MANIFEST
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

#### 1. Approval Crash Recovery Decision Matrix (`APPROVE_GATE`)
During `playbook approve`, the journal records targets for `.playbook/state.json` and `.playbook/approval-fingerprint.json`:

| Crash Point During Approval | State on Disk | Recovery Action Executed by CLI | Safety Invariant |
| :--- | :--- | :--- | :--- |
| **Crash in `PREPARED`** | Live files untouched; journal exists; `.tmp` may exist. | **Roll Backward**: Remove `.tmp` and `.bak` files, delete journal, release lock. State remains in `pending_review`. | Zero approval state committed. |
| **Crash in `COMMITTING` before either rename** | Live files untouched; journal in `COMMITTING`. | **Roll Forward**: Read `target_content` from journal. Write and rename both `state.json` and `approval-fingerprint.json`. Transition to `COMMITTED`, cleanup. | Approval completes deterministically from WAL payload. |
| **Crash in `COMMITTING` after state rename but before sidecar rename** | `state.json` has `approved`; sidecar missing or old. | **Roll Forward**: Verify `state.json` matches target hash. Write `approval-fingerprint.json` from journal `target_content` and rename into place. Complete commit. | State and sidecar are brought into perfect synchronization. |
| **Crash in `COMMITTING` after sidecar rename but before state rename** | Sidecar has new fingerprint; `state.json` is `pending_review`. | **Roll Forward**: Write `state.json` from journal `target_content` and rename into place. Complete commit. | Prevents orphaned sidecars. |
| **Crash in `COMMITTED`** | Both files replaced; cleanup pending. | **Finalize Cleanup**: Remove `.bak` and `.tmp`, delete journal, release lock. | Completely idempotent. |
| **Missing / Corrupt Journal with Mismatched Sidecar** | No journal on disk; sidecar exists but `state.stage_status !== "approved"`. | **Fail-Safe Invalidation**: State is authoritative. If `state.stage_status !== "approved"`, the gate is **not approved**. The sidecar is flagged `APPROVAL_FINGERPRINT_ORPHANED` and ignored/purged on subsequent review. | The system **never interprets an orphaned sidecar as valid approval**. |

#### 2. Advancement Crash Recovery Durability Matrix (`ADVANCE_STAGE` & `CLOSE_LIFECYCLE`)
Whenever any CLI command initializes, it checks for an existing `.playbook/tx-journal.json` and `.playbook/transaction.lock`:

| Transaction Boundary | Files Mutated / Created | Durable State After Crash | Recovery Decision | Action Executed by Recovery |
| :--- | :--- | :--- | :--- | :--- |
| **1. Lock Acquisition** | `.playbook/transaction.lock` | Lock file exists with PID, host, nonce. | Abort / Clean | If no journal exists, remove lock. State untouched. |
| **2. Journal Creation** | `tx-journal.json.tmp` $\rightarrow$ `tx-journal.json` | Journal exists in `PREPARED` containing target payloads. | **Roll Backward** | Discard journal, remove lock. State untouched. |
| **3. Temporary File Writes** | `state.json.tmp`, `manifest.json.tmp` | Live files untouched; `.tmp` files exist on disk. | **Roll Backward** | Delete `.tmp` files, delete journal, remove lock. State untouched. |
| **4. Backup File Writes** | `state.json.bak`, `manifest.json.bak` | Live files untouched; `.bak` files exist on disk. | **Roll Backward** | Delete `.bak` and `.tmp`, delete journal, remove lock. |
| **5. Transition to `COMMITTING`** | `tx-journal.json` updated to `COMMITTING` | Journal in `COMMITTING`. Live files still untouched. | **Roll Forward** | Target payloads are verified in journal; CLI proceeds to replace files. |
| **6. State File Replacement** | `state.json.tmp` $\rightarrow$ `state.json` | `state.json` at Stage $N+1$; `manifest.json` at Stage $N$. | **Roll Forward** | Inspect hashes: `state.json` matches target. Re-write `manifest.json` from journal `target_content`, complete commit. |
| **7. Manifest Replacement** | `manifest.json.tmp` $\rightarrow$ `manifest.json` | Both files at Stage $N+1$. | **Roll Forward** | Transition journal to `COMMITTED`. Finalize cleanup. |
| **8. Cleanup & Release** | Unlink `.bak`, `.tmp`, journal, lock | Transaction complete. | Idempotent | If cleanup was interrupted, remaining `.bak`/`.tmp` files are cleaned on startup. |

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

### 8.1 `playbook approve --gate <N>`
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

### 8.2 `playbook advance`
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

### 8.3 `playbook repair-manifest`
```bash
# Interactively synchronize drifted manifest pointer with authoritative state
playbook repair-manifest

# Output dry-run inspection
playbook repair-manifest --dry-run
```

#### Terminal Execution Flow
```text
┌──────────────────────────────────────────────────────────────┐
│      AI Engineering Playbook — Manifest Drift Repair         │
└──────────────────────────────────────────────────────────────┘

 Target Directory: /workspace/zentrix-lms
 Milestone:        M-1.0.0 [MATCHES]
 State Stage:      Stage 2 (Architecture & System Design) [AUTHORITATIVE]
 Manifest Stage:   Stage 1 (Requirements & Specification) [DRIFTED]

 ? Manifest active_lifecycle_stage is currently 1, but authoritative state.current_stage is 2.
   Synchronize manifest.active_lifecycle_stage to 2? [y/N]: y

 ✔ manifest.json updated: active_lifecycle_stage -> 2.
 ✔ state.json audit log updated: reason recorded.
 Drift successfully resolved. Gate approval may now proceed.
```

---

## 9. Schema Conformance & Compatibility Audit

### 9.1 Manifest Schema Conformance (`schemas/project-manifest.schema.json`)
- `active_lifecycle_stage`: Integer `0` to `6`. Synchronized on `advance`. Fully supported.
- `active_milestone_id`: Pattern `^M-[a-zA-Z0-9.-]+$`. Fully supported.
- **Verdict**: Zero schema modifications required for manifest.

### 9.2 State Schema Conformance (`schemas/project-state.schema.json`)

To prevent silent introduction of unsupported enum values or schema violations, all lifecycle states, review statuses, and human decisions are strictly mapped against canonical schema definitions:

#### Schema Compatibility & Lifecycle State Mapping Table

| State Entity / Field | Canonical Schema Path | Allowed Enums in Canonical v1.0.0 Schema | Representation on Human Approval | Representation on Human Rejection (`REJECT_GATE`) | Proposed Future Evolution (v1.1.0) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Active Stage Macro Status** | `state.stage_status` | `"not_started"`, `"in_progress"`, `"blocked"`, `"pending_review"`, `"approved"` | `"approved"` | `"in_progress"` *(Note: `"rejected"` is NOT a valid `stage_status` enum)* | Expand enum to include `"rejected"` if dedicated macro status is required |
| **Human Review Status** | `state.current_stage_detail.human_approval.status` | `"not_requested"`, `"pending_review"`, `"approved"`, `"rejected"` | `"approved"` | `"rejected"` | Unchanged |
| **Human Verdict / Decision** | `state.current_stage_detail.human_approval.decision` | `"GATE_APPROVED"`, `"REJECTED"`, `null` | `"GATE_APPROVED"` | `"REJECTED"` *(Note: `"GATE_REJECTED"` is invalid)* | Unchanged |
| **Review Conditions / Rework** | `state.current_stage_detail.human_approval.conditions` | `string`, `null` | Optional approval conditions | Mandatory rework instructions / defect references | Unchanged |
| **Exit Package Status** | `state.current_stage_detail.exit_package.status` | `"not_drafted"`, `"drafted"`, `"submitted_for_review"`, `"approved"` | `"approved"` | Reverts to `"drafted"` | Unchanged |
| **Audit Actor Type** | `state.last_updated.actor_type` | `"human"`, `"agent"` | `"human"` (Mandatory) | `"human"` (Mandatory) | Unchanged |
| **Audit Reason** | `state.last_updated.reason` | `string` (`maxLength: 500`) | Approval record & signer reference | Rejection reason & required rework summary | Unchanged |
| **Historical Stage Summary** | `state.stage_history[].human_approval` | Strictly restricted to: `approved_by`, `role`, `approval_mode`, `signature_reference` (`additionalProperties: false`) | Archived upon `advance` | N/A (rejections remain in active stage) | Preserve queryable `review_history[]` ledger |

- `stage_status`: Supports `"approved"`, `"in_progress"`, `"blocked"`, `"pending_review"`, `"not_started"`. Rejection canonically maps to `"in_progress"`.
- `current_stage_detail.human_approval`: Contains `status`, `approved_by`, `role`, `approval_mode`, `decision`, `signature_reference`, `approved_at`, `conditions`. Fully supported.
- `last_updated`: Enforces `actor_type: "human"` when `stage_status: "approved"`. Fully supported.
- `stage_history[].human_approval`: Strictly restricted to `"approved_by"`, `"role"`, `"approval_mode"`, and `"signature_reference"` with `additionalProperties: false`. The advancement orchestrator strictly trims `status`, `decision`, and `conditions` before appending to `stage_history[]` (`approved_at` is preserved at the record level).
- `archived_milestones[]`: Preserves past milestone histories and frozen snapshot reference. Fully supported.
- **Verdict**: Existing Draft 2020-12 state schema completely accommodates the approval and advancement architecture with zero breaking changes and zero unsupported enum values.

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
   - Concurrent process execution blocked by exclusive lock (`transaction.lock`).
   - Stale lock detection and automatic liveliness reclamation.
   - Corrupted backup detection triggers fail-closed `CRITICAL_RECOVERY_FAILURE`.

---

## 11. Implementation-Readiness Audit & Classification of Claims

To preserve scientific rigor and intellectual honesty, all governance, locking, transaction, and verification claims within this architecture specification are rigorously categorized into five distinct tiers.

### 11.1 Categorized Claims Matrix

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Architecturally Specified                                                │
│    Fully designed, structurally resolved, mathematically sound, ready for   │
│    implementation, but not yet implemented in executable CLI code.          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. Existing Implementation & Tested                                         │
│    Implemented in TypeScript and verified by the existing 69 CLI tests.     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. Future Implementation Requirement                                        │
│    Mandatory deliverable for Task 004D CLI implementation, including         │
│    automated fault injection and multi-process test suites.                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Filesystem-Dependent Assumption                                          │
│    Relies on specific operating system and filesystem kernel primitives     │
│    (NTFS, ext4, APFS single-file atomic rename and O_EXCL creation).        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. Documented Limitation                                                    │
│    Known architectural boundary, environmental restriction, or scope cap.   │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Architectural Subsystem / Requirement | Classification Tier | Technical Status & Verification Boundary |
| :--- | :--- | :--- |
| **Project Initialization & Scaffolding (`playbook init`)** | `existing_implementation_tested` | Implemented and verified by unit/integration tests (69 passing tests). |
| **Schema Validation Engine (`playbook validate`)** | `existing_implementation_tested` | Manifest and state validated against Draft 2020-12 schemas. |
| **Governance Diagnostics & Inspection (`playbook inspect`)** | `existing_implementation_tested` | Diagnostics evaluate blockers, readiness, UTC exception expirations, and source-of-truth priority. |
| **Read-Only Evidence Verification (`playbook verify-evidence`)** | `existing_implementation_tested` | File existence, SHA-256 hashes, symlink/path traversal defenses verified read-only. |
| **Scaffolding Rollback on Error** | `existing_implementation_tested` | File creation failures trigger clean directory and file rollback. |
| **Human Gate Approval Command (`playbook approve`)** | `architecturally_specified` | Full workflow, TTY prompts, confirmation phrases, and decision logic fully designed. |
| **Lifecycle Advancement Command (`playbook advance`)** | `architecturally_specified` | Stage 0–5 advancement, manifest synchronization, and Stage 6 terminal closure fully designed. |
| **Manifest Drift Repair Command (`playbook repair-manifest`)** | `architecturally_specified` | Pre-repair checks, interactive confirmation, and state audit stamp fully designed. |
| **Deterministic Canonical Projection (`stage_status` normalized)** | `architecturally_specified` | RFC 8785 JCS projection resolving pre/post approval digest stability mathematically proven. |
| **Approval Fingerprint Sidecar (`approval-fingerprint.json`)** | `architecturally_specified` | Sidecar schema, serialization format, and input inputs specified. |
| **Write-Ahead Transaction Journal (`tx-journal.json`)** | `architecturally_specified` | 3-phase WAL (`PREPARED`, `COMMITTING`, `COMMITTED`) with full target payloads specified. |
| **Dual-Lock Concurrency Protocol (`transaction.lock` & `reclaim.lock`)** | `architecturally_specified` | Two-way pre/post acquisition checks, atomic reclamation, and crash self-healing specified. |
| **Interrupted Approval Recovery (Cases A through E)** | `architecturally_specified` | Exhaustive 6-criterion decision matrix resolving all crash and orphan scenarios specified. |
| **Multi-Process Lock Fault-Injection Tests** | `future_implementation_requirement` | Must be implemented during Task 004D to test concurrent lock contention, crashes, and PID reuse. |
| **WAL Journal Crash Recovery Tests** | `future_implementation_requirement` | Must be implemented during Task 004D to test process death during `PREPARED` and `COMMITTING`. |
| **Interactive TTY Enforcement Test Harness** | `future_implementation_requirement` | Must be implemented during Task 004D to verify rejection of headless/piped inputs (`isatty`). |
| **Single-File Rename Atomicity** | `filesystem_dependent_assumption` | Assumes POSIX `rename(2)` and Windows NTFS `MoveFileExW` atomically replace directory entries. |
| **`O_CREAT | O_EXCL` Creation Atomicity** | `filesystem_dependent_assumption` | Assumes local filesystems guarantee mutual exclusion on `open(..., 'wx')`. |
| **Operating System `fsync` Durability** | `filesystem_dependent_assumption` | Assumes OS flushes file buffers to disk upon `fsyncSync` before renaming. |
| **Windows Open-Handle Sharing Mitigation** | `filesystem_dependent_assumption` | Assumes exponential backoff retries overcome transient AV/indexer handle locks on Windows. |
| **Unsupported Networked Filesystems (NFS/SMB)** | `documented_limitation` | NFS/SMB shares lacking atomic `O_EXCL` or atomic renames are unsupported for multi-process locking. |
| **v1.0.0 Rejection Ledger Storage in State** | `documented_limitation` | State holds current disposition; queryable rejection array (`review_history[]`) deferred to v1.1.0. |
| **Client-Side File Permissions (`chmod 0o444`)** | `documented_limitation` | `chmod 0o444` is accidental-edit protection; cryptographic immutability requires Git forge controls. |
| **Cross-Platform PID Start-Time Permissions** | `documented_limitation` | Windows StartTime or POSIX `/proc` queries may fail in restricted sandboxes; fallback requires age > TTL. |

### 11.2 Invariant Regarding Test Suite Guarantees

> [!CAUTION]
> **Scientific Integrity Invariant: Existing Tests Do Not Prove Future Protocols**
> The passing status of the existing **69 CLI unit and integration tests** confirms that existing v1.0.0 read-only verification, inspection, and scaffolding logic function correctly.
> 
> **The existing test suite does NOT prove the correctness of future multi-process locking, write-ahead crash recovery, or approval sidecar synchronization.** Calling future locking or recovery mechanisms "proven by existing tests" is scientifically false. Concurrency and crash resilience can only be proven through dedicated multi-process fault-injection tests executed during Task 004D implementation.

---

## 12. Confirmed Architectural Decisions & Governance Alignment

1. **Deterministic Canonical Fingerprint Projection**: Approvals are bound to an RFC 8785 canonical projection where `stage_status` normalizes to `"approved"` for both `pending_review` (pre-approval) and `approved` (post-approval). Recalculating the fingerprint after approval yields the exact same digest as long as engineering deliverables and file contents remain unchanged.
2. **Atomic Dual-Lock Protocol & Fail-Closed Metadata Defenses**: Normal acquisition actively inspects `.playbook/reclaim.lock` and re-verifies invariant absence post-acquisition, preventing any process from entering a transaction while another is reclaiming or owning the lock. Age alone never establishes process death; unreadable, empty, or truncated lock metadata strictly fails closed (`LOCK_METADATA_UNREADABLE` / `RECLAIM_MARKER_UNVERIFIABLE`). Stale locks can only be reclaimed with operating system proof of process death (`ESRCH` or start-time recycling), and unowned empty locks are safely recovered through interactive operator process auditing (`playbook repair-lock`).
3. **Fail-Safe Crash Recovery (Cases A–E)**: An orphaned sidecar (`state.json` not approved) never establishes approval. Missing or malformed sidecars strictly block advancement and require human re-review or Git restoration. Missing or corrupt journals fail closed immediately (`CRITICAL_RECOVERY_FAILURE`) leaving files untouched.
4. **Transaction Journal & Process Lock**: Multi-file state and manifest updates are governed by a write-ahead transaction journal (`.playbook/tx-journal.json`) and process lock (`.playbook/transaction.lock`), eliminating any reliance on non-existent filesystem multi-file atomicity. Full serialized payloads in the journal guarantee recoverability across missing/corrupted temporary files.
5. **Authoritative State Machine**: `state.json` (`current_stage`) is the sole execution authority; manifest drift blocks approval under strict/standard profiles and is repaired upon stage advancement or via interactive `playbook repair-manifest`.
6. **Governance-Frozen Snapshots**: Stage 6 milestone snapshots are governance-frozen artifacts marked read-only on disk; physical immutability requires external forge and protected storage controls.
7. **Zero Code / Schema Mutation Boundary**: The design is 100% compliant with existing canonical schemas (`project-manifest.schema.json` and `project-state.schema.json`), requiring zero schema changes for v1.0.0. Minimal schema evolutions for native fingerprints and review histories are formally documented for future release v1.1.0.
