# Machine-Readable Project Schemas

> **Specification Version**: 1.2.0  
> **Playbook Alignment**: Core Governance, AI Engineering Controller, and Stage-Gate Lifecycle  
> **Status**: Canonical Governance Contract

---

## 1. Overview and Purpose

To bridge the gap between prompt-level cognitive compliance and deterministic engineering governance, the AI Engineering Playbook defines formal, technology-agnostic schemas for project metadata, milestone progression, and lifecycle state:

1. **Project Manifest Schema (`project-manifest.schema.json`)**: Defines static configuration (project identity, active milestone pointer, technology profile, artifact path mappings, active stage pointer, and enabled quality capabilities).
2. **Project State Schema (`project-state.schema.json`)**: Defines dynamic lifecycle progression, deliverable completion, multi-modal verification evidence, outstanding RFCs, related ADRs, active exceptions, milestone archives, and mandatory human sign-offs.

These schemas enable AI coding agents and automated governance tooling (linters, pre-commit hooks, CI/CD runners, and dashboard validators) to inspect, evaluate, and audit repository state deterministically.

---

## 2. Core Architectural Invariants

### 2.1 Separation of Manifest from State
- **The Manifest (`project.manifest.json`)**: Contains static configuration—which tech stack is in use, which directories store PRDs and ADRs, which capabilities are enabled, active milestone ID, and which lifecycle stage is active.
- **The State (`state.json`)**: Contains dynamic, auditable lifecycle data—granular deliverable statuses, multi-modal evidence blocks (test runs, schema validations, lint logs, manual reviews), open blocking RFCs, active exceptions, milestone snapshots, and human approval signatures.

### 2.2 Separation of Machine State from Human Documentation
Machine-readable JSON files store structured metadata, verification logs, and cryptographic or textual links. Human-readable markdown files (`docs/prd/`, `docs/adr/`, `docs/rfcs/`, `docs/gates/`, `docs/exceptions/`) preserve rich engineering context, rationale, and narrative. Automated tooling parses the JSON state and validates that all referenced markdown artifacts physically exist and conform to their template contracts.

### 2.3 Strict Status Orthogonality: Stage vs. Deliverable Lifecycle
In conventional development, terms like "done", "complete", and "verified" are often blurred. Under this playbook, **Stage Status** and **Deliverable Status** are strictly distinct:

```
DELIVERABLE LIFECYCLE:
┌──────────────┐     Authoring / Coding      ┌──────────────┐
│ in_progress  │ ─────────────────────────►  │  completed   │
└──────────────┘                             └──────────────┘
       │                                            │
       │ Exception Waiver                           ▼ Multi-Modal Verification
       ▼                                     ┌──────────────┐
┌──────────────┐                             │   verified   │
│    waived    │                             └──────────────┘
└──────────────┘                                    │
       ▲                                            │
       └───────────────────┬────────────────────────┘
                           │ All Deliverables Verified / Waived
STAGE LIFECYCLE:           ▼
┌──────────────┐     Exit Package Submitted  ┌────────────────┐
│ in_progress  │ ─────────────────────────►  │ pending_review │
└──────────────┘                             └────────────────┘
                                                    │
                                                    ▼ Human Sign-Off / Gate Review
                                             ┌────────────────┐
                                             │    approved    │
                                             └────────────────┘
```

#### Stage Status Taxonomy (`stage_status`)
- `not_started`: Stage scope initialized; no work begun.
- `in_progress`: Active execution (deliverables being authored, tested, or reworked).
- `blocked`: Stage progression halted (open blocking RFC, failed prerequisite).
- `pending_review`: All required deliverables are `verified` or `waived`; Stage Exit Package compiled and submitted; awaiting human judgment.
- `approved`: Authorized human engineer has formally signed off on the gate transition.

#### Deliverable Status Taxonomy (`deliverables[].status`)
- `not_started`: Deliverable specified; file not yet created.
- `in_progress`: Deliverable file created; actively being drafted or modified.
- `completed`: Deliverable artifact committed to disk; not yet verified.
- `verified`: Verification checks (automated or manual) passed with proof recorded (`result: "passed"`).
- `waived`: Requirement formally waived by an authorized active exception record (`EXC-*`).
- `blocked`: Deliverable work halted due to an unresolved RFC or dependency.

> [!CAUTION]
> **Waiver is NOT Verification**: A deliverable marked `waived` indicates that verification was bypassed under an authorized human exception. It must never be represented as successful verification. If an exception expires or is revoked, the waiver is voided.

---

## 3. Project Manifest Specification (`project-manifest.schema.json`)

### 3.1 Schema Attributes

| Field | Type | Description | Mandatory |
| :--- | :--- | :--- | :--- |
| `$schema` | String | JSON Schema URI (`https://ai-engineering-playbook.org/schemas/project-manifest.schema.json`). | Yes |
| `schema_version` | String | Semantic version of the manifest contract (e.g., `1.0.0`). | Yes |
| `project_id` | String | Kebab-case identifier matching `^[a-z0-9]+(-[a-z0-9]+)*$`. | Yes |
| `project_name` | String | Human-readable title of the project. | Yes |
| `active_milestone_id` | String | Active milestone ID matching `^M-[a-zA-Z0-9.-]+$` (e.g. `M-1.0.0`). | Yes |
| `description` | String | Purpose and domain summary. | No |
| `playbook` | Object | Governing playbook standards (`version`, `governance_profile`, `approval_mode`). | Yes |
| `tech_stack` | Object | Technology metadata (`ecosystem`, `primary_language`, `runtimes`, `frameworks`, `package_manager`). | Yes |
| `paths` | Object | Directory mapping for governance artifacts (`docs_root`, `prd_dir`, `adr_dir`, `rfc_dir`, `gates_dir`, `exceptions_dir`, `state_file`). | Yes |
| `active_lifecycle_stage` | Integer | Integer `0` to `6` indicating current active stage. | Yes |
| `capabilities` | Array | Set of enabled quality capabilities (`automated_testing`, `ast_linting`, `security_dependency_scanning`, etc.). | Yes |

---

## 4. Project State Specification (`project-state.schema.json`)

### 4.1 Schema Attributes

| Field | Type | Description | Mandatory |
| :--- | :--- | :--- | :--- |
| `$schema` | String | JSON Schema URI (`https://ai-engineering-playbook.org/schemas/project-state.schema.json`). | Yes |
| `schema_version` | String | Semantic version of the state schema (`1.0.0`). | Yes |
| `project_id` | String | Project identifier matching manifest. | Yes |
| `playbook_version` | String | Playbook standard version. | Yes |
| `milestone_id` | String | Active milestone ID (e.g. `M-1.0.0`, `M-2026.Q4`). | Yes |
| `milestone_name` | String | Human-readable title of active milestone. | Yes |
| `lifecycle_status` | Enum | `active` \| `completed_terminal` \| `reopened_maintenance` \| `paused`. | Yes |
| `current_stage` | Integer | Integer `0` through `6` strictly bounded. | Yes |
| `stage_status` | Enum | `not_started` \| `in_progress` \| `blocked` \| `pending_review` \| `approved`. | Yes |
| `current_stage_detail` | Object | Detailed active stage breakdown (deliverables, evidence, RFCs, ADRs, exceptions, exit package, human approval). | Yes |
| `stage_history` | Array | Immutable audit ledger of completed stages for the active milestone. | Yes |
| `archived_milestones` | Array | Permanent ledger of previously completed milestones and their stage histories. | Yes |
| `last_updated` | Object | Timestamp, actor ID, actor type (`human` \| `agent`), and rationale for update. | Yes |

### 4.2 Multi-Modal Verification Evidence Model

Each deliverable in `current_stage_detail.deliverables` contains an `evidence` array accommodating automated, manual, and architectural validation:

```json
{
  "requirement_id": "REQ-002",
  "type": "automated_test",
  "procedure": "pnpm test tests/unit/telemetry_queue.test.ts",
  "result": "passed",
  "summary": "18 passing tests, 0 failures, 100% invariant coverage.",
  "exit_code": 0,
  "commit_sha": "7b3f9a1",
  "evidence_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "evidence_ref": ".playbook/logs/stage-3-telemetry-queue.log",
  "verified_at": "2026-10-31T11:00:00Z",
  "verified_by": "agent:controller",
  "actor_type": "agent"
}
```

- `requirement_id`: Optional string linking proof to `REQ-###` or deliverable.
- `type`: `automated_test`, `build_typecheck`, `static_analysis`, `schema_validation`, `security_audit`, `manual_functional`, `visual_review`, `accessibility_audit`, `architecture_review`.
- `procedure`: Executed shell command OR human review protocol.
- `result`: `passed` \| `failed` \| `inconclusive`. Only `passed` permits transition to `verified`.
- `exit_code`: Nullable integer (0 for successful command runs; null for human reviews).
- `commit_sha`: Optional 7- or 40-character Git commit hash of workspace state.
- `evidence_hash`: Optional SHA-256 hash (`sha256:<hex>`) asserting file integrity of referenced logs or reports.
- `evidence_ref`: Relative path to log, screenshot, report, or test output.
- `verified_at`: ISO 8601 timestamp.
- `verified_by`: Identity of executor or reviewer.
- `actor_type`: `agent` \| `human`.

---

## 5. The Four Levels of Evidence Assurance

To maintain intellectual honesty, automated tools evaluate evidence across four distinct assurance levels:

```
┌────────────────────────────────────────────────────────┐
│ Level 4: Validation Correctness                        │
│ (Human review & AST checks assert requirement validity)│
└────────────────────────────────────────────────────────┘
                           ▲
┌────────────────────────────────────────────────────────┐
│ Level 3: Evidence Authenticity                         │
│ (Signed Git commits, OIDC CI tokens, verified actor)   │
└────────────────────────────────────────────────────────┘
                           ▲
┌────────────────────────────────────────────────────────┐
│ Level 2: File Integrity                                │
│ (SHA-256 hash match proves file has not been altered)  │
└────────────────────────────────────────────────────────┘
                           ▲
┌────────────────────────────────────────────────────────┐
│ Level 1: File Existence                                │
│ (File physically exists at evidence_ref relative path) │
└────────────────────────────────────────────────────────┘
```

1. **Level 1: File Existence**: CLI confirms the evidence file physically exists at `evidence_ref`.
2. **Level 2: File Integrity (SHA-256 Hash)**: CLI recomputes SHA-256 and matches against `evidence_hash`. Proves file has not drifted since verification. *(Limitation: Proves immutability, not authenticity).*
3. **Level 3: Evidence Authenticity**: Proves evidence was generated in a trusted environment (signed Git commit, server-side CI attestation).
4. **Level 4: Validation Correctness**: Proves the test actually validated the business requirement (human peer review or AST semantic inspection).

---

## 6. Human Approval Security Boundary

### 6.1 Two-Phase Approval Protocol
1. **Phase 1 (Agent Handover)**: Agent verifies deliverables, compiles Stage Exit Package, and sets `stage_status = "pending_review"`. Agent authority strictly halts.
2. **Phase 2 (Human Sovereign Decision)**:
   - **Interactive CLI Guard**: `playbook approve --gate <N>` strictly requires an interactive terminal (`isatty`). Non-interactive executions, scripts, pipes, and bypass flags (`--yes`, `--force`) are rejected.
   - Prompts for reviewer name, role, approval mode, and typed confirmation phrase (`CONFIRM APPROVAL GATE <N>`).
   - Records `approved_by`, `role`, `approval_mode`, `decision: "GATE_APPROVED"`, `signature_reference`, `approved_at`.

### 6.2 Security Limits
- Local CLI interactive TTY is an **authorization guardrail** preventing headless agent loop self-approval.
- It is **not** biometric or cryptographic identity verification.
- In Team Mode, server-side Git branch protection, signed commits, and PR reviews enforce cryptographic identity.
