# Architecture Decision Record (ADR)

# ADR-20261031-001: State Model Taxonomy Refinement, Multi-Modal Evidence, and Two-Phase Approval Handshake

> **Template Version**: 1.0.0  
> **Applicable Stages**: Core Governance & State Architecture (Task 003.1)  
> **Storage Location**: `docs/adr/ADR-20261031-001-state-model-refinements.md`

---

## 1. ADR Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-20261031-001` |
| **Title** | State Model Taxonomy Refinement, Multi-Modal Evidence, and Two-Phase Approval Handshake |
| **Status** | `Accepted` |
| **Creation Date** | `2026-10-31` |
| **Last Updated** | `2026-10-31` |
| **Author(s)** | AI Engineering Controller & Human Lead |
| **Lead Approver** | Zain Ali (Lead Engineer & Architect) |
| **Impacted Subsystems** | Governance Schemas, Finite State Machine, Engineering Controller |

---

## 2. Context and Problem Statement

Task 003 introduced machine-readable governance via `schemas/project-manifest.schema.json`, `schemas/project-state.schema.json`, and `governance/state-machine.md`. However, an architectural audit (Task 003.1) revealed three critical inconsistencies:
1. **Taxonomy Conflation**: Macro stage progress (`stage_status`) conflated deliverable-level states (`completed`, `verified`), while the state machine diagram introduced `pending_review` without schema representation. `waived` was used in `stage_history` without a clean position in the status taxonomy.
2. **Superficial Human Approval**: Treating string fields (`approved_by: "Zain Ali"`) as proof of human sign-off ignored the reality that AI agents running in workspaces can write any string to disk.
3. **Restrictive Evidence Model**: Mandating process `exit_code: 0` and shell commands made manual functional testing, accessibility reviews, responsive layout reviews, and architectural audits impossible to represent legitimately.
4. **Unspecified Terminal Boundaries**: Stage 6 lacked a defined closure state (`CLOSE_LIFECYCLE`) and milestone reopening protocol, leaving the lifecycle vulnerable to accidental advancement to an invalid "Stage 7".

---

## 3. Decision Drivers

- **Constitutional Principle 1 (Human Sovereignty & Agent Accountability)**: AI agents cannot self-approve; human approval boundaries must be auditable and honest.
- **Constitutional Principle 3 (Determinism Over Heuristics)**: Clean, deterministic Finite State Machine without ambiguous, overlapping states.
- **Constitutional Principle 6 (Explicit Contracts)**: JSON Schemas must strictly mirror state machine transitions without schema/spec drift.
- **Constitutional Principle 7 (Verifiability as First-Class Deliverables)**: Both automated test commands and human inspection protocols must be verifiable without forcing artificial CLI exit codes onto manual reviews.
- **Intellectual Honesty**: Clear classification of what is enforced by schema syntax vs. CLI checks vs. external Git/CI environments vs. human judgment.

---

## 4. Considered Alternatives

### Alternative A: Retain Uniform Six-Status Model for Both Stages and Deliverables
- *Description*: Keep `stage_status` and `deliverable.status` identical using `["not_started", "in_progress", "completed", "verified", "blocked", "approved"]`, and keep `pending_review` purely inside `human_approval.status`.
- *Pros*: Fewer enum types across schemas.
- *Cons*: Highly ambiguous. A stage being `completed` does not clarify whether deliverables are verified or awaiting review. Deliverables do not individually receive human approval (stages do), leading to state confusion.

### Alternative B: Strict Orthogonal Status Separation with Two-Phase Handshake (Chosen)
- *Description*:
  - **Stage Status** represents aggregated lifecycle milestones: `not_started`, `in_progress`, `blocked`, `pending_review`, `approved`.
  - **Deliverable Status** represents physical artifact lifecycle: `not_started`, `in_progress`, `completed`, `verified`, `waived`, `blocked`.
  - **Multi-Modal Evidence** supports automated test results (`exit_code`) and human review procedures (`exit_code: null`).
  - **Two-Phase Approval Handshake**: Agent submits exit package and halts at `pending_review`; human approves and seals transition to `approved`.
  - **Terminal Boundary**: Stage 6 approval triggers `CLOSE_LIFECYCLE` (`lifecycle_status: completed_terminal`). `ADVANCE_STAGE` is blocked at Stage 6.
- *Pros*: Mathematically clean, deterministic, matches actual engineering workflow, enables manual and visual testing, completely prevents accidental Stage 7 transitions.
- *Cons*: Requires updating state schema and test fixtures.

---

## 5. Chosen Solution & Rationale

We chose **Alternative B**.

1. **Orthogonal Taxonomy**: A stage is `in_progress` while its deliverables are being authored (`completed`) and tested (`verified` or `waived`). Once all deliverables are verified/waived and the Exit Package is submitted, the stage transitions to `pending_review`.
2. **Multi-Modal Evidence**: The `evidence[]` block now captures `type` (automated, manual, visual, accessibility, architecture), `procedure` (command or inspection protocol), `result` (`passed` | `failed`), `exit_code` (nullable), and `evidence_ref`.
3. **Two-Phase Handshake**: The agent's authority boundary strictly terminates upon setting `pending_review`. Human approval is required to transition to `approved`.
4. **Lifecycle Boundaries**: `lifecycle_status` added to state schema (`active`, `completed_terminal`, `reopened_maintenance`, `paused`). Stage 6 approved triggers `CLOSE_LIFECYCLE`.

---

## 6. Consequences & Trade-Offs

### Positive Consequences
- Schema and state machine specifications are 100% harmonized.
- Manual verification (e.g. accessibility, UI contrast, responsive design) is first-class and verifiable.
- Accidental progression to non-existent Stage 7 is physically blocked.
- Honest, practical human approval boundary for both Solo Developer Mode and Team Mode.

### Negative Consequences
- Existing Task 003 examples required refactoring to align with the refined schema.
- Automated tooling must handle nullable `exit_code` when inspecting non-automated evidence.

---

## 7. Reversibility & Migration Strategy

- **Reversibility**: High. The state model remains pure JSON Schema Draft 2020-12 without external library coupling.
- **Migration**: Update `.playbook/state.json` files by adding `lifecycle_status: "active"`, replacing deliverable `status: "approved"` with `status: "verified"` or `status: "waived"`, and replacing stage `completed` with `pending_review` when awaiting human review.

---

## 8. Traceability

- **Resolves**: Task 003.1 Audit Findings (Inconsistent taxonomy, restrictive evidence, ambiguous human approval, Stage 6 boundary).
- **Related Playbook Documents**:
  - [`schemas/project-state.schema.json`](../../schemas/project-state.schema.json)
  - [`governance/state-machine.md`](../../governance/state-machine.md)
  - [`schemas/README.md`](../../schemas/README.md)
  - [`core/engineering-constitution.md`](../../core/engineering-constitution.md)
