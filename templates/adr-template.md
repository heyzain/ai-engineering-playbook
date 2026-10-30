# Architecture Decision Record (ADR) Template

> **Template Version**: 1.0.0  
> **Applicable Stages**: Stage 2 (Architecture & System Design), Stage 3 (when architectural shifts arise)  
> **Storage Location**: `docs/adr/ADR-YYYYMMDD-<title>.md` or project-designated architecture records directory.

---

## Operational Guidance for This Template

### 1. When to Use
- **Trigger**: Any time a significant structural choice, technology pattern, persistence paradigm, external dependency, interface contract boundary, or security model is introduced or altered.
- **Scope Rule**: ADRs must capture **meaningful architectural decisions**, not trivial implementation trivia.
  - *Belongs in an ADR*: Choice of communication protocol (REST vs. gRPC), database consistency model (eventual vs. strong), state management paradigm, introduction of a new third-party dependency, caching strategy.
  - *Does NOT belong in an ADR*: Internal function naming, variable names, folder layout tweaks, trivial code formatting.

### 2. Who Creates It
- **Author**: Software Architect, Technical Lead, or AI Agent proposing architectural patterns under direct human guidance.
- **Approver**: Designated Human Architect or Technical Lead.

### 3. Mandatory vs. Optional Sections
- **Mandatory**:
  - Section 1: ADR Metadata (ID, Title, Status, Date, Author, Approver)
  - Section 2: Context and Problem Statement
  - Section 3: Decision Drivers (Principles, Constraints, NFRs)
  - Section 4: Considered Alternatives (Minimum 2 viable alternatives analyzed)
  - Section 5: Chosen Solution & Rationale
  - Section 6: Consequences & Trade-Offs (Positive, Negative, Neutral)
  - Section 7: Reversibility & Migration Strategy
  - Section 8: Traceability (Related Requirements and ADRs)
- **Optional**:
  - Section 9: Architectural Diagram (Mermaid syntax)
  - Section 10: Proof-of-Concept / Benchmark Results

### 4. Information Sufficiency Criteria
- The problem must be articulated in terms of technical forces and requirements, not personal preference.
- Every architectural decision has a downside. An ADR that claims "zero disadvantages" or "no negative consequences" is considered **insufficient** and will be rejected at Gate 2.
- The chosen solution must demonstrably conform to the [Engineering Constitution](../core/engineering-constitution.md) (simplicity, explicit contracts, modularity, YAGNI).

### 5. Handling Missing Information
- If an ADR is proposed without evaluating viable alternatives or without assessing risks, the Controller blocks Gate 2 progression.
- The agent must halt and gather benchmark data or request human clarification via [Clarification RFC](clarification-rfc-template.md).

### 6. Validation and Quality Gate Checks
- **Gate 2 Validation**: All key technical decisions needed to implement Stage 1 requirements have accepted ADRs; zero "Proposed" ADRs left unapproved before Stage 3 begins.

---

# ADR-[YYYYMMDD]-[###]: [Decision Title in Imperative Mood, e.g., Use Event-Driven State Replication]

## 1. Document Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-YYYYMMDD-###` |
| **Title** | [Short, active phrase: e.g., Adopt Schema-Driven JSON Contracts for Internal APIs] |
| **Status** | `Proposed` \| `Accepted` \| `Rejected` \| `Deprecated` \| `Superseded by ADR-XXX` |
| **Date** | [YYYY-MM-DD] |
| **Author** | [Name / Role / AI Co-Author] |
| **Approver** | [Authorized Human Architect / Tech Lead] |
| **Traceable PRD / Requirements** | [e.g., `PRD-20261030-001`, `REQ-003`, `NFR-002`] |
| **Supersedes** | [None \| `ADR-YYYYMMDD-###`] |
| **Superseded By** | [None \| `ADR-YYYYMMDD-###`] |

---

## 2. Context & Problem Statement

[Describe the context, technical forces, and business realities driving this decision. What technical problem are we solving? What invariants must be preserved?]

*Example*:
> Our service must handle 5,000 asynchronous device telemetry updates per second while preserving order per device (`REQ-004`). Direct database polling causes connection exhaustion and violates our latency budget (`NFR-002`). We need an isolated, deterministic queueing architecture that scales horizontally.

---

## 3. Decision Drivers

The decision is constrained and guided by the following forces:
- **Driver 1 (Performance)**: Must maintain p95 end-to-end ingestion latency under 150ms.
- **Driver 2 (Constitutional Simplicity)**: Adherence to Principle 4 (YAGNI) — avoid operating distributed clustered infrastructure if an in-process or managed queue satisfies requirements.
- **Driver 3 (Reliability)**: Must guarantee at-least-once message delivery with idempotent consumer handling.
- **Driver 4 (Security)**: All payload transit must occur within private VPC boundaries with mutual TLS.

---

## 4. Considered Alternatives

### Alternative A: [Name of Alternative, e.g., Managed Kafka Event Stream]
- **Description**: [Summary of the approach and architecture].
- **Advantages / Pros**:
  - High throughput capacity exceeding 100k events/sec.
  - Native partition ordering guarantees per device ID.
- **Disadvantages / Cons**:
  - Heavy operational complexity and high idle infrastructure cost.
  - Violates simplicity principle for current scale requirements (<10k events/sec).
- **Reason for Rejection**: Over-engineered for verified Stage 1 requirements; excessive operational maintenance burden.

### Alternative B: [Name of Alternative, e.g., Lightweight Redis Streams with Consumer Groups]
- **Description**: [Summary of the approach and architecture].
- **Advantages / Pros**:
  - Already part of the verified infrastructure stack; zero new operational dependencies.
  - Deterministic consumer groups with native acknowledgment semantics.
  - Sub-millisecond latency profile satisfying `NFR-002`.
- **Disadvantages / Cons**:
  - Memory-bound storage requiring strict TTL policies.
  - Stream history truncation must be managed explicitly.

---

## 5. Chosen Solution & Architectural Rationale

### The Decision
We will adopt **Alternative B (Redis Streams with Consumer Groups)** for device telemetry ingestion.

### Architectural Justification
- Satisfies all verified performance targets (`p95 < 50ms` in preliminary benchmarks).
- Directly adheres to [Engineering Constitution Principle 4 (Radical Simplicity & Dependency Discipline)](../core/engineering-constitution.md#principle-4-radical-simplicity-and-yagni-you-arent-gonna-need-it) by avoiding the introduction of new infrastructure clusters.
- Consumers will implement idempotent deduplication using message sequence IDs (`Principle 6: Explicit Contracts`).

---

## 6. Consequences & Trade-Off Analysis

Every architectural decision introduces benefits and technical liabilities.

### Positive Consequences (Gains)
- Immediate compliance with latency and throughput requirements.
- Reuses existing connection pools and infrastructure observability dashboards.
- Simplifies local development environments using hermetic container mocks.

### Negative Consequences (Liabilities & Debt)
- Requires explicit memory budgeting and stream trimming logic to prevent Redis OOM errors.
- Consumers must handle dead-letter queueing manually if message retries fail 3 times.

### Neutral / Operational Consequences
- Requires deployment of a lightweight background stream trimmer job.

---

## 7. Reversibility & Migration Strategy

- **Reversibility Rating**: `High` \| `Medium` \| `Low` (e.g., `Medium`)
- **Isolation Mechanism**: The queue ingestion logic is isolated behind the domain interface contract `TelemetryQueueInterface`.
- **Exit Strategy**: If telemetry volume exceeds 50,000 events/sec, `TelemetryQueueInterface` can be reimplemented against a managed Kafka cluster without altering downstream worker business logic.

---

## 8. Traceability & Related Decisions

| Relation | Artifact ID | Title |
| :--- | :--- | :--- |
| **Implements Requirement** | `REQ-004` | Telemetry Ingestion Pipeline |
| **Governed by NFR** | `NFR-002` | Ingestion Latency Budget |
| **Related ADR** | `ADR-20261028-001` | Service Boundary Partitioning |

---

## 9. Review & Approval Record

| Role | Reviewer Name | Decision (`Accepted` \| `Rejected`) | Date | Sign-Off Reference |
| :--- | :--- | :--- | :--- | :--- |
| **Lead Architect** | [Human Name] | `Accepted` | YYYY-MM-DD | [Commit SHA / PR Review #XX] |
| **Technical Reviewer** | [Human Name] | `Accepted` | YYYY-MM-DD | [In-chat approval / review comment] |
