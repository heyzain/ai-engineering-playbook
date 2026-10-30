# Stage-Gate Rules & Lifecycle Governance

## 1. Lifecycle Overview

The software engineering lifecycle governed by this playbook consists of seven sequential, technology-agnostic stages. Advancement from one stage to the next is strictly controlled by **Stage Gates**. 

```
Stage 0: Discovery & Problem Formulation
   │
   ▼ [Gate 0]
Stage 1: Requirements & Specification
   │
   ▼ [Gate 1]
Stage 2: Architecture & System Design
   │
   ▼ [Gate 2]
Stage 3: Implementation & Unit Verification
   │
   ▼ [Gate 3]
Stage 4: Integration & System Verification
   │
   ▼ [Gate 4]
Stage 5: Review, Hardening & Release Readiness
   │
   ▼ [Gate 5]
Stage 6: Deployment & Operational Monitoring
```

Skipping stages or gates is prohibited. If defects or design gaps are discovered during a later stage, the process must formally loop back to the originating stage to update upstream specifications before proceeding.

---

## 2. Detailed Stage Specifications

---

### Stage 0: Discovery & Problem Formulation

#### Purpose
Establish the fundamental business problem, user needs, strategic goals, non-goals, and boundary constraints before technical solutions are proposed.

- **Entry Criteria**:
  - A business need, feature request, or technical objective has been proposed by a stakeholder or engineer.
  - The problem is unaddressed or requires substantial evolution in the existing system.
- **Required Inputs**:
  - High-level initiative description, user request, or problem statement.
  - Relevant domain background, user feedback, or business drivers.
- **Expected Deliverables**:
  - **Problem Statement Document**: Context, target audience, core user problem, and expected business outcome.
  - **Explicit Non-Goals**: Clear definition of what will deliberately *not* be solved in this scope.
  - **Success Metrics**: Measurable indicators defining when the problem is solved.
- **Validation Criteria**:
  - Problem statement clearly separates the *problem* from any specific technical *solution*.
  - Non-goals are clearly delineated to prevent scope creep.
  - Success metrics are quantitative or unambiguously verifiable.
- **Exit Criteria**:
  - Problem Statement, Non-Goals, and Success Metrics are documented and agreed upon.
- **Approval Requirements**:
  - Product owner, lead engineer, or primary human stakeholder sign-off.

---

### Stage 1: Requirements & Specification

#### Purpose
Translate the problem statement into unambiguous, testable, and complete functional and non-functional specifications.

- **Entry Criteria**:
  - Stage 0 has received formal human approval.
  - Problem Statement, Non-Goals, and Success Metrics are available in the repository.
- **Required Inputs**:
  - Approved Stage 0 deliverables.
  - Existing system constraints, regulatory/compliance rules, and interface prerequisites.
- **Expected Deliverables**:
  - **Requirements Specification (PRD / Spec)**:
    - Unique Requirement IDs (e.g., `REQ-001`, `REQ-002`).
    - Functional user stories and use cases.
    - Explicit input/output definitions and boundary conditions.
    - Negative flows, error handling specifications, and recovery behaviors.
    - Non-functional requirements (NFRs: security, performance, latency, accessibility, internationalization).
  - **Acceptance Criteria**: Formatted as verifiable assertions or Given-When-Then criteria.
- **Validation Criteria**:
  - Zero vague terminology (e.g., "fast", "intuitive", "clean") without quantifiable bounds.
  - All identified edge cases and error states have specified outcomes.
  - Traceability: Every requirement traces directly back to a Stage 0 goal.
- **Exit Criteria**:
  - Complete requirements specification with no unresolved clarification requests.
  - All acceptance criteria are objectively testable.
- **Approval Requirements**:
  - Lead engineer or project owner approval.

---

### Stage 2: Architecture & System Design

#### Purpose
Define the technical structure, component decomposition, data models, contracts, and patterns required to implement the approved specifications.

- **Entry Criteria**:
  - Stage 1 specifications and acceptance criteria are approved and locked.
  - Target runtime constraints and technology boundaries are known.
- **Required Inputs**:
  - Approved Stage 1 Requirements Specification.
  - Applicable technology standards, security guidelines, and architectural baselines.
- **Expected Deliverables**:
  - **System Architecture Document**:
    - High-level component diagram and interaction topology.
    - Explicit module boundaries and responsibilities.
    - Data schemas, persistence models, and entity lifecycle states.
    - Formal interface contracts (APIs, function signatures, schemas, error formats).
  - **Architecture Decision Records (ADRs)**:
    - Formal ADR for any significant structural choice, new dependency, or technology pattern.
  - **Security & Threat Model**:
    - Identified trust boundaries, authentication/authorization model, and data protection plan.
- **Validation Criteria**:
  - Adherence to [Engineering Constitution](../core/engineering-constitution.md) (simplicity, modularity, explicit contracts, YAGNI).
  - Zero architectural dependencies introduced without documented rationale and human review.
  - Interface contracts specify payload schemas, validation rules, and error envelopes.
  - Every requirement in Stage 1 is accounted for in the component design (Design Traceability).
- **Exit Criteria**:
  - System architecture and interface contracts are finalized.
  - All relevant ADRs are recorded and committed.
- **Approval Requirements**:
  - Software architect, tech lead, or designated human reviewer.

---

### Stage 3: Implementation & Unit Verification

#### Purpose
Produce production-quality source code and isolated automated unit tests satisfying the architectural design and specifications.

- **Entry Criteria**:
  - Stage 2 Architecture, ADRs, and Interface Contracts are approved.
  - Development workspace is configured and verified clean.
- **Required Inputs**:
  - Approved Stage 1 Specifications and Acceptance Criteria.
  - Approved Stage 2 Architecture, Contracts, and ADRs.
- **Expected Deliverables**:
  - **Production Source Code**: Clean, modular, well-structured code adhering to project standards.
  - **Automated Unit Tests**: High-coverage, deterministic tests verifying component behaviors and edge cases.
  - **Inline Contract Documentation**: Precise comments explaining non-obvious business logic, interfaces, and boundary assumptions without redundant noise.
- **Validation Criteria**:
  - 100% of unit tests pass deterministically.
  - Zero unhandled edge cases or stubbed "TODO / NotImplemented" functions in committed paths.
  - Strict compliance with the Constitution: no speculative abstractions, no dead code, fail-fast error handling.
  - Code passes all active static type checks, linters, and formatting rules.
- **Exit Criteria**:
  - All functional requirements allocated to the current scope are fully implemented.
  - Unit test suite passes with zero failures, zero skipped tests, and zero flaky assertions.
- **Approval Requirements**:
  - Peer engineer or lead human code review approval.

---

### Stage 4: Integration & System Verification

#### Purpose
Verify that individually implemented modules interact correctly with internal subsystems, external contracts, and data persistence layers.

- **Entry Criteria**:
  - Stage 3 implementation and unit test verification are completed and green.
  - Integrated testing environment or mock harness is available.
- **Required Inputs**:
  - Stage 3 source code and unit test suites.
  - Stage 2 Interface Contracts and Data Schemas.
  - Stage 1 Acceptance Criteria.
- **Expected Deliverables**:
  - **Integration & End-to-End Test Suites**: Automated tests exercising inter-module communication, real or hermetic databases, and network contract boundaries.
  - **Contract Verification Tests**: Automated validation ensuring interface contracts remain inviolable.
  - **Verification Matrix**: Documented mapping confirming that every Stage 1 acceptance criterion passes in the integrated system.
- **Validation Criteria**:
  - All integration tests pass in a clean, reproducible environment.
  - Contract validation confirms no schema regression or unintended breaking changes.
  - Error paths (e.g., service unavailability, malformed payloads, rate limits) are verified under integrated conditions.
- **Exit Criteria**:
  - 100% pass rate across integrated and contract test suites.
  - All acceptance criteria verified with automated or demonstrable evidence.
- **Approval Requirements**:
  - Quality engineer, tech lead, or designated human verifier.

---

### Stage 5: Review, Hardening & Release Readiness

#### Purpose
Conduct thorough code audits, static security analysis, performance audits, and finalize operational documentation before release.

- **Entry Criteria**:
  - Stage 4 integration and contract verification completed and green.
  - Feature implementation is in feature freeze.
- **Required Inputs**:
  - Complete code, test suites, and stage artifacts from Stages 0 through 4.
- **Expected Deliverables**:
  - **Comprehensive Code Review Sign-Off**: Formal audit against the [Engineering Constitution](../core/engineering-constitution.md).
  - **Security & Dependency Audit**: Vulnerability scan results for third-party libraries and code patterns.
  - **Release Notes & Changelog**: Concise, accurate documentation of new features, changes, and deprecations.
  - **Operational Runbook / Deployment Checklist**: Step-by-step instructions for deployment, configuration, verification, and rollback.
- **Validation Criteria**:
  - Zero unresolved high or critical security vulnerabilities.
  - Zero compiler warnings, linter errors, or type errors.
  - Documentation accurately reflects final implementation state.
  - Rollback procedure is documented and tested/reviewed.
- **Exit Criteria**:
  - Release artifact packaged, tagged, and ready for deployment.
  - All release readiness checklist items verified.
- **Approval Requirements**:
  - Engineering lead and release authority sign-off.

---

### Stage 6: Deployment & Operational Monitoring

#### Purpose
Execute controlled deployment to the target environment and monitor operational stability, performance, and error rates.

- **Entry Criteria**:
  - Stage 5 release readiness sign-off is complete.
  - Target environment health is verified before deployment.
- **Required Inputs**:
  - Release package / artifact from Stage 5.
  - Operational Runbook and Rollback Plan.
- **Expected Deliverables**:
  - **Deployment Execution Log**: Step-by-step record of deployment actions.
  - **Post-Deployment Smoke Test Results**: Verifiable proof that the deployed system is healthy and operational in the target environment.
  - **Telemetry & Health Baseline**: Active monitoring logs showing error rates, latency, and resource metrics within acceptable parameters.
- **Validation Criteria**:
  - Post-deployment smoke tests pass 100%.
  - Zero critical alert triggers or unexpected error spikes.
  - System performance aligns with Stage 1 non-functional requirements.
- **Exit Criteria**:
  - Operational health confirmed across the designated observation window.
  - Stage gate formally closed and logged.
- **Approval Requirements**:
  - Operations lead, on-call engineer, or designated human deployment manager.

---

## 3. Cross-Stage Enforcement Classification

To maintain governance clarity, each stage gate's checks are classified by their enforcement mechanism:

| Stage Gate | Gate Check | Current Enforcement Mode | Future Target Enforcement Mode |
| :--- | :--- | :--- | :--- |
| **Gate 0** | Problem Statement & Non-Goals present | Agent cognitive compliance & Human review | PR template requirement / Spec linter |
| **Gate 1** | Acceptance criteria testability | Agent cognitive compliance & Human review | Automated Gherkin/Spec validator |
| **Gate 2** | ADR documentation & contract definitions | Agent cognitive compliance & Human review | OpenAPI/JSON Schema automated validator |
| **Gate 3** | Unit tests passing & zero linter errors | Agent tool execution & Human review | CI pre-merge test and linter enforcement |
| **Gate 4** | Integration tests & acceptance matrix pass | Agent tool execution & Human review | Automated CI/CD integration runner |
| **Gate 5** | Vulnerability scanning & changelog sync | Human code review & Agent compliance | Automated Dependabot/Snyk & semantic release |
| **Gate 6** | Smoke test execution & metric stability | Human verification & Agent reporting | Automated canary deployment & APM checks |

---

## 4. Exceptions and Gate Bypasses

Any bypass of a stage gate requirement must strictly follow the exception protocol specified in [ENGINEERING_CONTROLLER.md](ENGINEERING_CONTROLLER.md#9-exception-handling-and-recording).

1. **No Agent Self-Bypass**: Agents are forbidden from skipping or waiving gates.
2. **Mandatory Human Sign-Off**: Only authorized humans can approve a gate bypass.
3. **Formal Tracking**: An Exception Record (`EXC-YYYYMMDD-###`) must be committed before advancing.
