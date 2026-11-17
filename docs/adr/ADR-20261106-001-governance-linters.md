# Architecture Decision Record (ADR)

# ADR-20261106-001: Governance Linters Architecture: Deterministic Static Verification of Governance Documents, Schemas, Invariants, and Workflows

> **Template Version**: 1.0.0  
> **Applicable Stages**: Task 008 (Governance Linters Architecture & Subsystem Implementation)  
> **Storage Location**: `docs/adr/ADR-20261106-001-governance-linters.md`

---

## 1. ADR Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-20261106-001` |
| **Title** | Governance Linters Architecture: Deterministic Static Verification of Governance Documents, Schemas, Invariants, and Workflows |
| **Status** | `Accepted` |
| **Creation Date** | `2026-11-06` |
| **Last Updated** | `2026-11-06` |
| **Author(s)** | AI Engineering Controller & Systems Architect |
| **Lead Approver** | Zain Ali (Lead Engineer & Architect) |
| **Impacted Subsystems** | Governance Linters Engine, CLI (`playbook lint`), CI Workflows, JSON Schemas, Documentation, StackManager |

---

## 2. Context and Problem Statement

The AI Engineering Playbook defines explicit rules for lifecycle stage gates, write-ahead logging (WAL), state transitions, remote CI execution, and technology stack modularity. However, verifying compliance with these standards has historically relied on three uncoordinated mechanisms:
1. **Cognitive adherence by AI agents** following text prompts in `AGENTS.md`,
2. **Manual human code review** during pull request reviews and gate exit evaluations,
3. **Syntactic JSON Schema validation** of isolated manifest and state files.

As the repository expanded to support multiple technology stacks (`stacks/react-native`, `stacks/expo`, `stacks/nextjs`), lifecycle reopening, and remote CI workflows, relying exclusively on manual or cognitive compliance introduced severe risks:
- **Documentation Drift & Broken Linkage**: Internal links between governance documents break when files are relocated, and obsolete CLI commands or invalid stage numbers (e.g. "Stage 7") are inadvertently introduced.
- **Unchecked Semantic Invariants**: While JSON Schema ensures that files are valid JSON, it cannot verify cross-file semantic invariants, such as ensuring that quality-gate checks map to declared stage deliverables, or that unverified deliverables are not falsely marked as complete.
- **Security Vulnerabilities in CI**: GitHub Actions workflows frequently introduce unpinned third-party actions (`@v4` instead of immutable commit SHAs), grant overly broad token permissions (`write-all`), or risk secret leakage through public client environment variables (`EXPO_PUBLIC_*`).
- **Operational Pipeline Gaps**: Programmatic rules (such as mobile RIF evaluators) exist in the codebase but are not wired into an operational static analysis CLI command.

The Playbook requires a unified, deterministic, machine-checkable Governance Linter engine that validates governance integrity without modifying state or weakening human authority.

---

## 3. Decision Drivers

- **Constitutional Principle 1 (Human Sovereignty & Agent Accountability)**: AI agents cannot self-approve stage transitions or waive quality standards. The linter must report findings to humans, not automate stage approvals.
- **Constitutional Principle 3 (Determinism Over Heuristics)**: System verification must rely on deterministic AST, schema, and regex rules with predictable exit codes, avoiding opaque, heuristic LLM evaluations.
- **Constitutional Principle 6 (Explicit Contracts & Fail-Fast Error Handling)**: Violations of governance contracts must fail fast and loud in local pre-commit and remote CI status checks.
- **Constitutional Principle 8 (Uncompromising Quality Gates & Defect Containment)**: Shift quality verification left by arresting governance, documentation, and configuration defects before they reach human stage-gate review.
- **ADR-20261103-002 (Remote CI Evidence & Enforcement)**: CI must remain strictly read-only and never mutate lifecycle state or WAL journals.

---

## 4. Considered Options

### Option 1: Ad-Hoc Shell and Node Scripts
- *Approach*: Author isolated scripts (e.g. `check-links.mjs`, `check-actions.mjs`) executed individually via npm scripts.
- *Pros*: Quick to scaffold for single checks.
- *Cons*: Fractured reporting; inconsistent exit codes; duplicate file parsing; poor performance; lack of unified diagnostic codes; impossible to configure or selectively suppress centrally.

### Option 2: LLM-Based Agent Self-Prompted Linting
- *Approach*: Direct AI coding agents to review documentation and configurations using system prompt instructions during each task.
- *Pros*: Flexible interpretation of prose.
- *Cons*: Violates Constitutional Principle 3 (non-deterministic, flaky, prone to cognitive drift and hallucinations); lacks machine-checkable exit codes; costly token overhead; unable to run in lightweight pre-commit hooks or hermetic CI runners.

### Option 3: Dedicated, Provider-Neutral Governance Linter Engine (Chosen)
- *Approach*: Implement an extensible static analysis engine within `tooling/playbook-cli` exposing a standardized command (`playbook lint`), a provider-neutral `GovernanceRule` interface, 5 distinct rule categories, deterministic finding sorting, and strict separation between severity and enforcement.
- *Pros*: 100% deterministic; sub-3 second execution time; zero network requirements; read-only state guarantee; integrated into CLI and CI; provides structured JSON output for tooling.
- *Cons*: Requires upfront architectural design and phased implementation across rule categories.

---

## 5. Decision Outcome

**Chosen Option: Option 3 — Dedicated, Provider-Neutral Governance Linter Engine.**

### Key Architectural Decisions

1. **Provider-Neutral Rule Contract**:
   Every rule implements the `GovernanceRule` interface with stable ID, category, severity (`error`, `warning`, `info`), default enforcement (`blocking`, `warning`, `advisory`), evaluation method, and remediation guidance.
2. **Five Canonical Rule Categories**:
   - `Category A (RULE-DOC-*)`: Documentation and Reference Consistency (links, ADRs, stage bounds, mandatory sections).
   - `Category B (RULE-SCHEMA-* / RULE-CFG-*)`: Schema and Configuration Integrity (manifest, state, and gate JSON schemas, stack declarations and dependency DAGs).
   - `Category C (RULE-GOV-*)`: Governance Invariants (agent approval prohibition, CI WAL immutability, evidence validity).
   - `Category D (RULE-STK-*)`: Technology Stack Governance (canonical structure, acyclic DAGs, override safety).
   - `Category E (RULE-SEC-*)`: Security and Workflow Governance (workflow permissions, action pinning, secret leaks).
3. **Strict Read-Only Execution**:
   The linter executes with zero state mutations, zero write locks, and zero WAL journal creation.
4. **Separation of Severity vs. Enforcement**:
   Rule severity is intrinsic and immutable. Enforcement behavior can be configured via project rules, but project overrides can never silently downgrade an `error` without a committed human exception record (`EXC-*`).
5. **Deterministic Exit Codes**:
   - `0`: Clean / No blocking violations.
   - `1`: Blocking governance or integrity violations detected.
   - `2`: CLI usage / argument error.
   - `3`: Environment / precondition failure.
   - `4`: Engine crash / unhandled failure.

---

## 6. Consequences

### Positive Consequences
- Governance rules documented in prose are transformed into automated, machine-checked barriers.
- Inconsistencies, broken links, unpinned CI actions, and secret leaks are arrested in pre-commit and PR validation.
- Sub-3 second execution time enables frictionless inclusion in automated workflows.
- Establishes a natural, unified static analysis framework for all repository artifacts.

### Negative Consequences / Trade-offs
- Static analysis cannot assess the intellectual soundness of authored content (e.g. confirming that an ADR's reasoning is correct). Human peer review remains mandatory.
- Autofix capabilities must remain tightly bounded to avoid unintended source alterations.

---

## 7. Phased Implementation Strategy

Implementation will proceed under Task 008B across seven sequential phases:
1. **Phase 1 (Task 008B.1)**: Core Rule Engine, Diagnostic Contracts, and Test Harness.
2. **Phase 2 (Task 008B.2)**: Category A — Documentation Consistency Rules.
3. **Phase 3 (Task 008B.3)**: Category B — Schema & Configuration Integrity Rules.
4. **Phase 4 (Task 008B.4)**: Category C — Governance Invariant Rules.
5. **Phase 5 (Task 008B.5)**: Category D — Technology Stack Governance Rules.
6. **Phase 6 (Task 008B.6)**: Category E — Security & Workflow Governance Rules.
7. **Phase 7 (Task 008B.7)**: CLI Command (`playbook lint`), CI Workflow Integration, and Final Regression.
