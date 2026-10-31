# Schema Examples Catalog

> **Directory Purpose**: Canonical test fixtures and reference implementations demonstrating valid and invalid project states and manifests.

---

## Example Catalog

| File Name | Schema Target | Validity | Primary Governance Concept Demonstrated |
| :--- | :--- | :--- | :--- |
| [`valid-manifest.json`](valid-manifest.json) | `project-manifest.schema.json` | **Valid** | Complete project manifest with standard paths, tech stack, and enabled capabilities. |
| [`invalid-manifest.json`](invalid-manifest.json) | `project-manifest.schema.json` | **Invalid** | Invalid project ID format, invalid governance profile enum, invalid capability, and out-of-range lifecycle stage (`9`). |
| [`valid-state-stage1-verified.json`](valid-state-stage1-verified.json) | `project-state.schema.json` | **Valid** | Stage 1 with verified deliverables, passing multi-modal validation evidence (`result: "passed"`), resolved RFC, and pending human review (`stage_status: "pending_review"`). |
| [`valid-state-stage2-approved.json`](valid-state-stage2-approved.json) | `project-state.schema.json` | **Valid** | Stage 2 approved with historical stage audit ledger (`stage_history`), accepted ADR, authorized exception waiver, and explicit human sign-off. |
| [`invalid-state-agent-self-approval.json`](invalid-state-agent-self-approval.json) | `project-state.schema.json` | **Invalid** (Rule Violation) | Violation of **Principle 1**: AI agent attempted to approve its own gate transition without human sign-off. |
| [`invalid-state-unverified-advance.json`](invalid-state-unverified-advance.json) | `project-state.schema.json` | **Invalid** (Rule Violation) | Violation of **Principle 7**: Deliverable marked `verified` without verification evidence and with `validation_status: "unvalidated"`. |
| [`invalid-state-unresolved-rfc.json`](invalid-state-unresolved-rfc.json) | `project-state.schema.json` | **Invalid** (Rule Violation) | Violation of **Stage Gate Rules**: Stage exit submitted while blocking `RFC-20261031-002` is in `pending_decision`. |
| [`invalid-state-expired-exception.json`](invalid-state-expired-exception.json) | `project-state.schema.json` | **Invalid** (Rule Violation) | Violation of **Exception Rules**: Gate approval attempted with an exception record that has expired (`status: "expired"`). |

---

## Validation Assertions for Tooling

1. `valid-manifest.json` passes schema validation against `schemas/project-manifest.schema.json`.
2. `valid-state-stage1-verified.json` and `valid-state-stage2-approved.json` pass schema validation against `schemas/project-state.schema.json` and pass all semantic state machine rules.
3. `invalid-manifest.json` fails JSON schema validation.
4. `invalid-state-*.json` files illustrate logical and governance violations that automated governance linters (e.g., `playbook-validate`) must detect and block.
