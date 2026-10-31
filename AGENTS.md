# AGENTS.md — AI Agent Operating Instructions

> **Notice to AI Agents**: This file is your primary entry point and operational contract. Whenever you operate within this repository or any project governed by this playbook, you must adhere strictly to the protocols, principles, and rules established herein.

---

## 1. Prime Directives for AI Agents

Every AI agent must follow these seven non-negotiable operating rules:

1. **Read Before Acting**: Always read the relevant playbook documents before proposing plans or modifying files. At a minimum, review:
   - [README.md](README.md) — Playbook vision, scope, and repository structure.
   - [core/engineering-constitution.md](core/engineering-constitution.md) — Core engineering principles and non-negotiables.
   - [governance/ENGINEERING_CONTROLLER.md](governance/ENGINEERING_CONTROLLER.md) — Operational governance and controller mechanics.
   - [governance/stage-gate-rules.md](governance/stage-gate-rules.md) — Stage criteria, required deliverables, and gates.
2. **Follow the Engineering Lifecycle Sequentially**: Never jump directly into implementation. Software evolves through explicit lifecycle stages (Stage 0 to Stage 6). Work within the active stage and respect its boundaries.
3. **Check Prerequisites Before Advancing**: Before beginning work in any stage, verify that all entry criteria and input artifacts from prior stages are present, approved, and valid.
4. **Never Assume an Incomplete Requirement is Complete**: If a requirement lacks acceptance criteria, error handling specifications, or boundary definitions, treat it as **incomplete**. Never hallucinate or assume unstated business logic.
5. **Ask for Clarification When Requirements are Ambiguous**: When faced with ambiguity, conflicting specifications, or unstated parameters, immediately **halt** and use the structured Clarification Request format defined in [ENGINEERING_CONTROLLER.md](governance/ENGINEERING_CONTROLLER.md#6-clarification-request-protocol).
6. **Never Bypass Mandatory Quality Gates**: Stage gates are mandatory barriers. You are strictly forbidden from waiving, bypassing, or deferring quality gates on your own authority. Any bypass requires an authorized human exception record (`EXC-YYYYMMDD-###.md`) committed under `governance/exceptions/` structured per [templates/exception-record-template.md](templates/exception-record-template.md).
7. **Validate Work Before Reporting Completion**: Never claim a task or stage is complete without verifying deliverables against acceptance criteria. Provide verifiable evidence (test outputs, static analysis results, file paths) for every completed requirement. **AI agents cannot self-approve mandatory stage transitions.**

---

## 2. Standard Agent Operational Steps (Controller Execution Loop)

> [!IMPORTANT]
> **Distinction Between Lifecycle Stages and Operational Steps**
> - **Lifecycle Stages (Stage 0 to Stage 6)**: The sequential macro stages of software evolution (Discovery, Requirements, Architecture, Implementation, Integration, Hardening, Deployment) defined in [stage-gate-rules.md](governance/stage-gate-rules.md).
> - **Operational Controller Steps (Step 1 to Step 7)**: The per-task micro execution loop executed by an AI agent on *every task* within any active lifecycle stage.

When assigned a task, every AI agent must execute this standardized operational control loop:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. INSPECT       Inspect repository state and active stage  │
│        ▼                                                    │
│ 2. VALIDATE      Verify prerequisites and input artifacts   │
│        ▼                                                    │
│ 3. ANALYZE       Detect requirement gaps / ambiguities      │
│        ▼            (If gaps exist: Halt & Request RFC)     │
│ 4. PLAN          Formulate minimal, constitution-aligned    │
│        ▼         plan                                       │
│ 5. IMPLEMENT     Execute changes with test-first discipline │
│        ▼                                                    │
│ 6. VERIFY        Run tests, check invariants, gather proof  │
│        ▼                                                    │
│ 7. HANDOVER      Assemble Exit Package & await human signoff│
└─────────────────────────────────────────────────────────────┘
```

### Step 1: Context & State Inspection
- Check current directory topology, Git status, and active branch.
- Inspect machine-readable state (`.playbook/manifest.json` and `.playbook/state.json`) where configured, per [downstream-storage-convention.md](governance/downstream-storage-convention.md).
- Locate existing specifications, ADRs, active stage deliverables, and blocking RFCs.
- Establish the current baseline without modifying any files.

### Step 2: Stage & Prerequisite Validation
- Determine the target lifecycle stage according to [stage-gate-rules.md](governance/stage-gate-rules.md) and state file.
- Verify that preceding stage artifacts exist and have been formally approved (confirmed in `stage_history`).
- If prerequisites are missing or unapproved, **halt** and notify the human operator.

### Step 3: Requirement Gap Analysis
- Analyze the incoming task or specification for:
  - Undefined edge cases or negative flows.
  - Vague or unquantifiable acceptance criteria.
  - Unstated security, performance, or accessibility expectations.
- If ambiguities or gaps exist, halt, trigger transition `TRIGGER_HALT`, and issue a **Clarification Request (RFC)** using [templates/clarification-rfc-template.md](templates/clarification-rfc-template.md). Record the RFC in `current_stage_detail.rfcs` with `status: "pending_decision"` and `is_blocking: true`.

### Step 4: Planning & Architecture Alignment
- Formulate a brief, actionable implementation plan.
- Ensure the plan adheres to the [Engineering Constitution](core/engineering-constitution.md):
  - Prioritize simplicity and YAGNI.
  - Avoid speculative abstractions and unnecessary dependencies.
  - Record architectural decisions using [templates/adr-template.md](templates/adr-template.md).
  - Follow technology-specific standards under canonical `stacks/<technology>/` where applicable.

### Step 5: Implementation & Local Verification
- Implement the minimal sufficient solution to satisfy the verified requirements.
- Record created artifacts in `.playbook/state.json` under `current_stage_detail.deliverables` with status `completed` and `validation_status: "unvalidated"`.
- Write or update automated unit tests to verify behavior and edge cases.
- Maintain documentation integrity: do not delete or overwrite existing comments or docs without intent.

### Step 6: Work Verification & Evidence Gathering
- Execute relevant validation disciplines (automated test suites, type checks, static analysis, or manual/visual reviews).
- Collect verifiable evidence (command output, test counts, linter output, or manual inspection checklist).
- Update deliverable in `.playbook/state.json`: if verification checks pass, transition status to `verified`, set `validation_status: "passed"`, and append proof to `evidence[]` with `result: "passed"`.
- If an authorized exception waives a requirement, set deliverable status to `waived`, `validation_status: "waived"`, and record `exception_ref`.
- Deliverable completion requires concrete evidence, not merely an unverified agent claim. **Never treat `completed`, `verified`, and `approved` as interchangeable states.**

### Step 7: Handover & Stage Gate Approval (Two-Phase Handshake)
- Assemble a concise Stage Exit Package formatted per [templates/gate-exit-package-template.md](templates/gate-exit-package-template.md) (deliverable summary, proof evidence, requirement traceability).
- Update `.playbook/state.json` (Phase 1): set `exit_package.status` to `submitted_for_review`, set `human_approval.status` to `pending_review`, and set `stage_status` to `pending_review`.
- **The AI agent's authority boundary ends here.** AI agents cannot self-approve stage transitions.
- Await human approval (Phase 2):
  - **Solo Developer Mode**: Explicit human confirmation in the development conversation (PR optional).
  - **Team Mode**: Formal Pull Request review sign-off.
- Advance to the subsequent stage (`ADVANCE_STAGE` for Stages 0–5, or `CLOSE_LIFECYCLE` for Stage 6) only after explicit human approval is granted. Transitioning to a non-existent Stage 7 is strictly prohibited.

---

## 3. Communication Standards for Agents

When interacting with human engineers, AI agents must:
- **Be Truthful and Evidence-Based**: Never state that tests pass or files exist without running commands or checking files.
- **Be Concise and Structured**: Use bullet points, bold highlights, and markdown tables. Avoid conversational filler.
- **Link Directly to Artifacts**: Use clickable markdown file links (`[file.md](file:///path/to/file.md)`) for referenced files and code symbols.
- **Acknowledge Governance Realities**: Be transparent about what rules are currently validated by agent cognitive compliance versus what is enforced by automated tooling.

---

## 4. Governance Cross-References

| Topic | Authoritative Document |
| :--- | :--- |
| **Engineering Values & Principles** | [core/engineering-constitution.md](core/engineering-constitution.md) |
| **Controller Architecture & Halt Rules** | [governance/ENGINEERING_CONTROLLER.md](governance/ENGINEERING_CONTROLLER.md) |
| **Stage Gates, Criteria & Deliverables** | [governance/stage-gate-rules.md](governance/stage-gate-rules.md) |
| **Deterministic State Machine & Transitions** | [governance/state-machine.md](governance/state-machine.md) |
| **Downstream Storage Architecture** | [governance/downstream-storage-convention.md](governance/downstream-storage-convention.md) |
| **Machine-Readable Schemas & Contracts** | [schemas/README.md](schemas/README.md) |
| **Standard Engineering Templates** | [templates/README.md](templates/README.md) |
| **Repository Vision & Layout** | [README.md](README.md) |
