# Machine-Readable Project Schemas

> **Specification Version**: 1.0.0  
> **Playbook Alignment**: Core Governance, AI Engineering Controller, and Stage-Gate Lifecycle  
> **Status**: Canonical Governance Contract

---

## 1. Overview and Purpose

To bridge the gap between prompt-level cognitive compliance and deterministic engineering governance, the AI Engineering Playbook defines formal, technology-agnostic schemas for project metadata and lifecycle state:

1. **Project Manifest Schema (`project-manifest.schema.json`)**: Defines static and configuration properties of a project (identity, technology profile, artifact path mappings, active stage pointer, and enabled quality capabilities).
2. **Project State Schema (`project-state.schema.json`)**: Defines dynamic lifecycle progression, deliverable completion, verification evidence, outstanding RFCs, related ADRs, active exceptions, and mandatory human sign-offs.

These schemas enable both AI coding agents and automated governance tooling (linters, pre-commit hooks, CI/CD runners, and dashboard validators) to inspect, evaluate, and audit repository state deterministically.

---

## 2. Core Architectural Invariants

### 2.1 Separation of Manifest from State
- **The Manifest (`project.manifest.json`)**: Contains relatively static configuration—which tech stack is in use, which directories store PRDs and ADRs, which capabilities are enabled, and which lifecycle stage is active.
- **The State (`state.json`)**: Contains dynamic, auditable lifecycle data—granular deliverable statuses, concrete evidence blocks (test runs, schema validations, lint logs), open blocking RFCs, active exceptions, and human approval signatures.

### 2.2 Separation of Machine State from Human Documentation
Machine-readable JSON files store structured metadata, verification logs, and cryptographic or textual links. Human-readable markdown files (`docs/prd/`, `docs/adr/`, `docs/rfcs/`, `docs/gates/`, `governance/exceptions/`) preserve rich engineering context, rationale, and narrative. Automated tooling parses the JSON state and validates that all referenced markdown artifacts physically exist and conform to their template contracts.

### 2.3 Strict Status Separation: The Three-Tier Quality Invariant
In conventional development, terms like "done", "complete", and "verified" are often blurred. Under this playbook, they represent strictly distinct lifecycle phases:

```
┌──────────────┐     Authoring / Coding      ┌──────────────┐
│ in_progress  │ ─────────────────────────►  │  completed   │
└──────────────┘                             └──────────────┘
                                                    │
                                                    ▼ Dynamic / Static Verification
                                             ┌──────────────┐
                                             │   verified   │
                                             └──────────────┘
                                                    │
                                                    ▼ Human Sign-Off / Gate Review
                                             ┌──────────────┐
                                             │   approved   │
                                             └──────────────┘
```

| Status | Exact Definition | Permitted Actor | What is Required to Reach this Status |
| :--- | :--- | :--- | :--- |
| `not_started` | Stage or deliverable defined in scope but untouched. | Controller / System | Initial state allocation. |
| `in_progress` | Active authoring, system design, or code generation underway. | AI Agent / Human | Active operational step. |
| `completed` | The deliverable or code artifact has been written and committed. | AI Agent / Human | Artifact file exists at `artifact_path` and is non-empty. **Not yet verified.** |
| `verified` | Deliverable behavior, invariants, and syntax have passed automated or demonstrable verification. | AI Agent / CI Tooling | Verifiable evidence (test suite pass log, exit code 0, static analysis output) attached to `evidence` array. |
| `blocked` | Progression is halted due to a gap, failing check, or open blocking RFC. | Controller / Agent | An active blocker (e.g. `RFC-YYYYMMDD-###` in `pending_decision` or failing test). |
| `approved` | Authorized human engineer has formally reviewed the deliverable or stage exit package and signed off. | **Human Only** | Explicit human sign-off record populated (`approved_by`, `role`, `signature_reference`, `approved_at`). |

> [!CAUTION]
> **Interchangeability Prohibition**: Treating `completed`, `verified`, and `approved` as interchangeable is a constitutional violation. An AI agent claiming a deliverable is `approved` because it has been `completed` or `verified` triggers an immediate controller halt.

---

## 3. Project Manifest Specification (`project-manifest.schema.json`)

### 3.1 Schema Attributes

| Field | Type | Description | Mandatory |
| :--- | :--- | :--- | :--- |
| `$schema` | String | JSON Schema URI (`https://ai-engineering-playbook.org/schemas/project-manifest.schema.json`). | Yes |
| `schema_version` | String | Semantic version of the manifest contract (e.g., `1.0.0`). | Yes |
| `project_id` | String | Kebab-case identifier matching `^[a-z0-9]+(-[a-z0-9]+)*$`. | Yes |
| `project_name` | String | Human-readable title of the project. | Yes |
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
| `current_stage` | Integer | Integer `0` through `6`. | Yes |
| `stage_status` | Enum | `not_started` \| `in_progress` \| `completed` \| `verified` \| `blocked` \| `approved`. | Yes |
| `current_stage_detail` | Object | Detailed active stage breakdown (deliverables, evidence, RFCs, ADRs, exceptions, exit package, human approval). | Yes |
| `stage_history` | Array | Immutable audit ledger of completed stages and their human sign-offs. | Yes |
| `last_updated` | Object | Timestamp, actor ID, actor type (`human` \| `agent`), and rationale for update. | Yes |

### 4.2 Granular Deliverable Schema

Each deliverable in `current_stage_detail.deliverables` requires:
- `id`: Unique identifier (e.g. `DELIV-001`, `PRD-CORE`, `UNIT-TEST-SUITE`).
- `name`: Title of deliverable.
- `artifact_path`: Relative path to file or directory.
- `status`: One of the 6 canonical statuses.
- `validation_status`: `unvalidated` \| `passed` \| `failed` \| `waived`.
- `evidence`: Array of verifiable proof objects containing:
  - `type`: `test_execution` \| `static_analysis` \| `type_check` \| `schema_validation` \| `security_audit` \| `human_inspection`.
  - `summary`: High-level test counts or check outcomes.
  - `command`: Exact command executed (e.g. `npm test -- --ci`).
  - `exit_code`: Numeric process exit code (`0` for success).
  - `log_ref`: File path to detailed log output.
  - `verified_at`: ISO 8601 timestamp.
  - `verified_by`: Identity of verifying agent or human.

### 4.3 Human Approval Record Schema

Mandatory human sign-off block in `current_stage_detail.human_approval`:
- `status`: `not_requested` \| `pending_review` \| `approved` \| `rejected`.
- `approved_by`: Full name or identifier of human reviewer (`null` while pending).
- `role`: Role of human approver (e.g., `Lead Architect`, `Product Owner`).
- `approval_mode`: `solo` \| `team`.
- `decision`: `GATE_APPROVED` \| `REJECTED` \| `null`.
- `signature_reference`: Verifiable reference (e.g. commit hash, PR # number, explicit conversation timestamp).
- `approved_at`: ISO 8601 timestamp (`null` while pending).
- `conditions`: Optional instructions or follow-up constraints.

---

## 5. Verification Tooling Integration

Automated tools evaluate project state through deterministic rule checks:
1. **Schema Compliance**: `ajv validate -s schemas/project-state.schema.json -d .playbook/state.json`.
2. **Path Integrity**: For each deliverable, RFC, ADR, and exit package, verify that the referenced file physically exists in the file system.
3. **Evidence Rigor**: Verify that every deliverable marked `verified` has at least one valid evidence entry with `exit_code: 0`.
4. **Halt Condition Check**: Confirm that no RFC with `is_blocking: true` is in `pending_decision`, and no exception in `exceptions` is in `expired` or `revoked` status.
5. **Human Sovereignty Check**: Assert that if `stage_status` is `approved`, `human_approval.status` equals `approved`, `human_approval.approved_by` is non-null, and `last_updated.actor_type` reflects human authorization or human-supervised agent commitment.
