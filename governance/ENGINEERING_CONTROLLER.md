# AI Engineering Controller

## 1. Overview and Operational Model

The **AI Engineering Controller** is the governance mechanism that oversees and regulates AI agent activity within the software engineering lifecycle. Its primary mission is to guarantee that speed does not compromise engineering rigor, architectural integrity, or constitutional compliance.

### The Enforcement Spectrum

In software engineering, governance mechanisms exist on a spectrum between cognitive self-governance and deterministic automated enforcement:

```
[Agent Cognitive Compliance] <-----------------------> [Automated Tool Validation]
(Instruction-following, prompt-level               (Linters, pre-commit hooks, CI/CD,
self-checks, review checklists)                     type checkers, automated test suites)
```

> [!IMPORTANT]
> **Enforcement Reality Notice**
> Markdown instruction files and prompt directives **do not** provide technically guaranteed enforcement. In the foundational phase of this playbook, the Controller operates via **structured agent self-governance under direct human supervision**. As projects mature, critical gates will be progressively transitioned to deterministic automated tooling (CI checks, pre-commit hooks, AST linters, policy-as-code engines).

---

## 2. Project State Inspection

Before an AI agent proposes any plan or executes any code, the Controller requires a systematic inspection of the current project state.

### Inspection Procedure
1. **Repository Topology**:
   - Inspect top-level files and directories to understand directory layout and module distribution.
   - Detect configuration manifests (e.g., package manifests, build scripts, workspace configurations) without executing untrusted scripts.
2. **Version Control State**:
   - Check current branch, active working tree status (clean vs. modified), and recent commit history to establish context.
3. **Documentation and Specification Baseline**:
   - Inspect existing playbook files, Architecture Decision Records (ADRs), Product Requirement Documents (PRDs), and stage artifacts.
   - Determine what decisions have already been codified.
4. **Active Stage Identification**:
   - Correlate current repository artifacts against the [Stage-Gate Rules](stage-gate-rules.md) to establish the currently active lifecycle stage.

Agents must not guess project state based on training priors. If a file is not read or a command is not executed, its state is considered unverified.

---

## 3. Stage and Prerequisite Validation

Work within any lifecycle stage cannot begin until the Controller validates that the stage's prerequisites and entry criteria are completely satisfied.

### Validation Sequence
1. **Identify Target Stage**: Determine the stage corresponding to the requested task.
2. **Prerequisite Check**: Consult [stage-gate-rules.md](stage-gate-rules.md) for the target stage.
3. **Artifact Verification**:
   - Verify that all required input artifacts from preceding stages exist, are non-empty, and are committed or officially approved.
   - Confirm that preceding stage gates have been formally approved and not skipped.
4. **Invariant Assertion**:
   - If a prerequisite artifact is missing, outdated, or incomplete, the Controller enters a **blocked state**.

---

## 4. Missing Requirements Detection

AI agents frequently suffer from "completion bias"—assuming missing information or hallucinating reasonable defaults to maintain momentum. The Controller strictly prohibits this behavior.

### Gap Analysis Heuristics
The Controller scans inputs for the following gap categories:
- **Undefined Edge Cases**: Inputs that address only the "happy path" without defining error handling, null states, timeouts, or invalid payloads.
- **Ambiguous Acceptance Criteria**: Requirements stated with qualitative phrases (e.g., "fast", "user-friendly", "robust", "scalable") lacking measurable thresholds.
- **Unstated Non-Functional Requirements**: Missing specifications regarding security boundaries, authentication, authorization, latency targets, and accessibility.
- **Unresolved Dependencies**: Dependencies on external APIs, database schemas, or third-party libraries that are not yet specified or verified.
- **Conflicting Requirements**: Inconsistencies between new feature requests and existing specifications or ADRs.

If any gap is identified, the requirement is classified as **Incomplete**.

---

## 5. Progression Blocking (The Halt Mechanism)

When a validation failure, prerequisite violation, or requirement gap is discovered, the Controller mandates an immediate **Halt**.

### Halt Conditions
An agent must immediately halt execution when:
1. Entry criteria for the requested stage are unmet.
2. A required input artifact is missing or unapproved.
3. A requirement is ambiguous, incomplete, or internally contradictory.
4. A quality gate validation check fails.
5. The requested task would violate a principle of the [Engineering Constitution](../core/engineering-constitution.md).
6. An unapproved architectural shift or out-of-scope dependency is requested.

### Halt Execution
When halted, the agent must:
- Cease all file modifications and command executions.
- Preserve the existing repository state without destructive rollback.
- Issue a clear diagnostic report detailing the specific halt condition.
- Request human clarification or intervention.

---

## 6. Clarification Request Protocol

When blocked by missing or ambiguous requirements, the agent must not ask unstructured, vague questions. It must issue a structured **Clarification Request (RFC)** using the standard template:

### Clarification Request Format

```markdown
### ⚠️ Controller Clarification Request

- **Current Stage**: [e.g., Stage 1: Requirements & Specification]
- **Blocked Action**: [Describe the exact task or transition blocked]
- **Identified Gap / Ambiguity**: [Clear description of missing requirement or contradiction]

#### Options Analyzed
1. **Option A**: [Description]
   - *Pros*: [...]
   - *Cons / Risks*: [...]
2. **Option B**: [Description]
   - *Pros*: [...]
   - *Cons / Risks*: [...]

#### Agent Assessment / Recommendation
[Agent's technical recommendation grounded in the Constitution, with rationale]

#### Required Human Decision
[Specific, actionable question requiring human input or approval]
```

The agent must remain suspended until the human provides explicit resolution.

---

## 7. Verification of Completed Work

Before any stage is marked as complete, the Controller performs multi-layered verification:

1. **Acceptance Criteria Verification**:
   - Walk through every requirement item in the stage specification.
   - Provide concrete evidence (command output, test result, file link) for each satisfied criterion.
2. **Dynamic Verification (Testing)**:
   - Run relevant unit, integration, or contract test suites.
   - Confirm that tests pass deterministically without flaky failures or test skips.
3. **Static Quality Verification**:
   - Inspect code for adherence to simplicity, absence of dead code, absence of speculative helpers, and clean separation of concerns.
   - Run available linters, type checks, and formatters where configured.
4. **Documentation and Contract Synchronization**:
   - Confirm that changes to interfaces, schemas, or behaviors are reflected in accompanying documentation, specifications, or ADRs.
5. **Regression Verification**:
   - Confirm that existing test baselines remain green and unchanged unless the change was explicitly intended and approved.

---

## 8. Stage Transition Approval

Stage transitions represent irreversible or high-cost milestones. Transitions must never be assumed or automatically granted by the agent.

### Approval Sequence
1. **Exit Package Assembly**:
   The agent compiles a concise **Stage Exit Package** containing:
   - Summary of completed deliverables.
   - Verification evidence (test runs, audit logs, artifact links).
   - Traceability matrix linking deliverables to requirements.
   - Known limitations or deferred items (if any).
2. **Human Review and Sign-Off**:
   - The human engineer reviews the Stage Exit Package.
   - The human issues formal approval (e.g., verbal confirmation, PR approval, issue label, or stage checklist checkoff).
3. **Transition Milestone**:
   - Upon human approval, the repository advances to the subsequent stage.
   - The state transition is committed to version control or logged.

---

## 9. Exception Handling and Recording

In exceptional engineering situations (e.g., critical hotfixes, spike prototypes, temporary external dependency outages), a stage-gate requirement may need to be waived or conditionally bypassed.

### Exception Rules
- **No Self-Granted Exceptions**: AI agents are strictly forbidden from waiving, bypassing, or deferring any stage gate rule independently.
- **Human Authority**: Only an authorized human engineer may grant an exception.
- **Mandatory Exception Record**: Every exception must be explicitly recorded in the project's governance records (e.g., `governance/exceptions.md` or the relevant ticket/PR) before progression proceeds.

### Exception Record Format

```markdown
### 📋 Gate Exception Record: [EXC-YYYYMMDD-###]
- **Date**: [YYYY-MM-DD]
- **Active Stage**: [e.g., Stage 3: Implementation]
- **Bypassed Gate / Requirement**: [Specific rule being waived]
- **Authorized Human Approver**: [Name / Role / ID]
- **Justification**: [Why this exception is necessary and cannot be resolved immediately]
- **Risk Assessment**: [Potential technical debt, security impact, or instability]
- **Compensating Controls**: [Temporary measures mitigating the risk]
- **Remediation Plan & Deadline**: [How and when the waived requirement will be satisfied]
```

---

## 10. Governance Enforcement Classification

To maintain intellectual honesty, the table below documents the current enforcement mechanism versus the future target mechanism for each Controller responsibility:

| Controller Responsibility | Current Enforcement Method | Target Future Enforcement Method |
| :--- | :--- | :--- |
| **Project State Inspection** | Agent compliance via prompt directives | Automated agent runner with read-only sandbox inspection |
| **Prerequisite Validation** | Agent compliance & human verification | Pre-stage automated checklist runner / GitHub Actions |
| **Missing Requirement Detection** | Agent compliance (gap heuristics) | Spec-linter / Schema validation / Automated PR reviewer |
| **Progression Blocking** | Agent cognitive halt | Branch protection rules / Required status checks |
| **Clarification Protocol** | Agent compliance (RFC template) | Interactive agent CLI / Structured UI modal prompt |
| **Work Verification** | Agent test runs + Human review | Automated CI test pipelines, static analysis, type checks |
| **Stage Transition Approval** | Explicit human prompt sign-off | Formal GitHub PR approval / Signed release gates |
| **Exception Recording** | Agent documentation + Human sign-off | Policy-as-code exception registry with TTL expiration |
