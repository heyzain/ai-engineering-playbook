# Machine-Readable Project Schemas

> **Specification Version**: 1.1.0  
> **Playbook Alignment**: Core Governance, AI Engineering Controller, and Stage-Gate Lifecycle  
> **Status**: Canonical Governance Contract

---

## 1. Overview and Purpose

To bridge the gap between prompt-level cognitive compliance and deterministic engineering governance, the AI Engineering Playbook defines formal, technology-agnostic schemas for project metadata and lifecycle state:

1. **Project Manifest Schema (`project-manifest.schema.json`)**: Defines static and configuration properties of a project (identity, technology profile, artifact path mappings, active stage pointer, and enabled quality capabilities).
2. **Project State Schema (`project-state.schema.json`)**: Defines dynamic lifecycle progression, deliverable completion, multi-modal verification evidence, outstanding RFCs, related ADRs, active exceptions, and mandatory human sign-offs.

These schemas enable AI coding agents and automated governance tooling (linters, pre-commit hooks, CI/CD runners, and dashboard validators) to inspect, evaluate, and audit repository state deterministically.

---

## 2. Core Architectural Invariants

### 2.1 Separation of Manifest from State
- **The Manifest (`project.manifest.json`)**: Contains static configuration—which tech stack is in use, which directories store PRDs and ADRs, which capabilities are enabled, and which lifecycle stage is active.
- **The State (`state.json`)**: Contains dynamic, auditable lifecycle data—granular deliverable statuses, multi-modal evidence blocks (test runs, schema validations, lint logs, manual reviews), open blocking RFCs, active exceptions, and human approval signatures.

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
| `lifecycle_status` | Enum | `active` \| `completed_terminal` \| `reopened_maintenance` \| `paused`. | Yes |
| `current_stage` | Integer | Integer `0` through `6` strictly bounded. | Yes |
| `stage_status` | Enum | `not_started` \| `in_progress` \| `blocked` \| `pending_review` \| `approved`. | Yes |
| `current_stage_detail` | Object | Detailed active stage breakdown (deliverables, evidence, RFCs, ADRs, exceptions, exit package, human approval). | Yes |
| `stage_history` | Array | Immutable audit ledger of completed stages and their human sign-offs. | Yes |
| `last_updated` | Object | Timestamp, actor ID, actor type (`human` \| `agent`), and rationale for update. | Yes |

### 4.2 Multi-Modal Verification Evidence Model

Each deliverable in `current_stage_detail.deliverables` contains an `evidence` array accommodating automated, manual, and architectural validation:

```json
{
  "requirement_id": "REQ-002",
  "type": "visual_review",
  "procedure": "Inspected dashboard layout at 375px, 768px, and 1440px viewport widths in dark and light modes.",
  "result": "passed",
  "summary": "Verified zero layout overflow and contrast ratio exceeding 4.5:1.",
  "exit_code": null,
  "evidence_ref": "docs/qa/visual-responsive-audit.png",
  "verified_at": "2026-10-31T11:00:00Z",
  "verified_by": "human:zain",
  "actor_type": "human"
}
```

- `requirement_id`: Optional string linking proof to `REQ-###` or deliverable.
- `type`: Enum:
  - `automated_test`: Unit, integration, or e2e test execution.
  - `build_typecheck`: TypeScript compiler, build bundles.
  - `static_analysis`: ESLint, Prettier, AST analyzers.
  - `schema_validation`: Ajv, OpenAPI validator.
  - `security_audit`: Snyk, Dependabot, threat model audit.
  - `manual_functional`: Human user story execution.
  - `visual_review`: UI layout, dark mode, responsive styling.
  - `accessibility_audit`: WCAG contrast, screen reader testing.
  - `architecture_review`: Constitutional compliance and design review.
- `procedure`: Executed shell command OR human review protocol.
- `result`: `passed` \| `failed` \| `inconclusive`. Only `passed` permits transition to `verified`.
- `exit_code`: Nullable integer (0 for successful command runs; null for human reviews).
- `evidence_ref`: Relative path to log, screenshot, report, or test output.
- `verified_at`: ISO 8601 timestamp.
- `verified_by`: Identity of executor or reviewer.
- `actor_type`: `agent` \| `human`.

### 4.3 Human Approval Record Schema

Mandatory human sign-off block in `current_stage_detail.human_approval`:
- `status`: `not_requested` \| `pending_review` \| `approved` \| `rejected`.
- `approved_by`: Full name or identifier of human reviewer (`null` while pending).
- `role`: Role of human approver (e.g., `Lead Architect`, `Product Owner`).
- `approval_mode`: `solo` \| `team`.
- `decision`: `GATE_APPROVED` \| `REJECTED` \| `null`.
- `signature_reference`: Verifiable reference (e.g. PR # number, commit SHA, chat quote with timestamp).
- `approved_at`: ISO 8601 timestamp (`null` while pending).
- `conditions`: Optional instructions or follow-up constraints.

---

## 5. Five Tiers of Governance Verification

To maintain intellectual honesty, automated tools and agents evaluate rules according to five distinct validation tiers:

| Tier | Validation Level | Capabilities | Limitations |
| :--- | :--- | :--- | :--- |
| **Tier 1** | **JSON Schema Validation** | Validates structural shape, mandatory keys, data types, and enum values. | Cannot verify semantic truth, file existence, or human identity. |
| **Tier 2** | **Deterministic CLI Checks** | Verifies physical file existence, non-empty files, git working tree state, RFC blocking flags, and exception expiration dates. | Cannot verify the quality of prose or whether tests provide real coverage. |
| **Tier 3** | **External Evidence Checks** | Verifies tool exit codes, parses test runner summaries, inspects CI artifact hashes. | Cannot prevent local mock tampering unless run in an isolated hermetic CI runner. |
| **Tier 4** | **Human Review & Authority** | Verifies business problem alignment, architecture trade-offs, UX acceptability, exception necessity, and gate sign-off. | Dependent on human diligence and domain review; not real-time. |
| **Tier 5** | **AI Semantic Reasoning** | Detects unstated assumptions, ambiguous requirements, constitutional misalignments, and drafting gaps. | Non-deterministic; prone to completion bias if unconstrained; strictly forbidden from self-approving gates. |
