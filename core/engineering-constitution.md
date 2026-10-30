# Engineering Constitution

## 1. Preamble

The Engineering Constitution defines the non-negotiable principles, operational values, and engineering standards for all software designed, developed, or maintained under this playbook.

AI-assisted engineering fundamentally shifts how code is written, but it does not alter the laws of software engineering. Speed without discipline compounds technical debt at machine velocity. This Constitution serves as the permanent baseline for human engineers and AI coding agents alike. Every architecture decision, requirement specification, line of code, and quality gate evaluation must conform to these principles.

---

## 2. Fundamental Principles

### Principle 1: Human Sovereignty and Agent Accountability
- **Human Authority**: The human engineer retains ultimate architectural and operational authority. AI agents are autonomous executors and force multipliers, not autonomous product deciders.
- **Explicit Mandate**: AI agents must never unilaterally alter project scope, accept incomplete requirements, or waive quality standards without explicit, documented human authorization. AI agents are strictly forbidden from approving their own mandatory stage transitions.
- **Traceability and Evidence**: Every automated action, architectural shift, or code modification performed by an agent must be explainable, justifiable, and tied to a documented requirement. Stage and task completion requires verifiable evidence, not merely an unverified agent claim.

### Principle 2: Specification-First Engineering (Spec-Before-Code)
- **No Spec, No Code**: Implementation must never precede clear, approved specifications.
- **Defeating Ambiguity Upfront**: Latent assumptions are defects waiting to materialize. If a requirement lacks clear boundary conditions, error expectations, or performance constraints, the requirement is incomplete and must not be implemented until clarified.
- **Single Source of Truth**: Requirements, specifications, and architecture decision records (ADRs) are living artifacts that precede and govern the code, not retrospective documentation written after the fact.

### Principle 3: Determinism Over Heuristics
- **Predictable Behavior**: Systems must exhibit predictable, reproducible behavior. Avoid opaque, heuristic-driven logic where deterministic patterns and explicit state machines are viable.
- **Reproducible Builds and Environments**: Build processes, configuration setups, and test environments must be fully deterministic and hermetic where possible.
- **Verifiable Invariants**: System invariants (security boundaries, data consistency, authorization checks) must be explicitly asserted in code and tests, not assumed.

### Principle 4: Radical Simplicity and YAGNI (You Aren't Gonna Need It)
- **Minimal Sufficient Solution**: Always implement the simplest design that satisfies verified current requirements. Resist speculative generality, unnecessary abstraction layers, and unrequested features.
- **Dependency Discipline**: Third-party dependencies introduce security vulnerabilities, license risks, and maintenance burdens. Treat every dependency as a liability; introduce dependencies only with clear justification.
- **Anti-Gold-Plating**: AI agents must not introduce auxiliary utilities, unasked-for helpers, or elaborate design patterns unless explicitly justified by the architectural specification.

### Principle 5: Strict Modularity and Separation of Concerns
- **High Cohesion, Low Coupling**: Modules, components, and services must maintain focused responsibilities with minimal external coupling.
- **Technology-Agnostic Core**: Core business domain logic and governance mechanisms must remain decoupled from specific frameworks, delivery mechanisms, or external services.
- **Explicit Boundaries**: All interaction across domain or service boundaries must occur through well-defined, documented public interfaces.

### Principle 6: Explicit Contracts and Interface-First Design
- **Contract-Driven Development**: Public APIs, internal service boundaries, data interchange formats, and database schemas must be governed by explicit contracts and schemas.
- **Zero Hidden State**: Avoid implicit global state, side-effect-heavy routines, and ambient context that obscure data flow.
- **Fail-Fast Error Handling**: Interfaces must fail fast, loudly, and informatively when contracts are violated. Silent fallbacks and swallowed exceptions mask systemic failures and are prohibited.

### Principle 7: Verifiability and Testability as First-Class Citizens
- **Untested Code Is Incomplete Code**: Code without verifiable automated tests or explicit acceptance verification is unfinished work.
- **Test Quality and Granularity**: Tests must verify behavior and contract invariants, not internal implementation trivia.
- **Determinism in Tests**: Flaky tests undermine engineering trust. Tests must be isolated, idempotent, independent of execution order, and free of race conditions.

### Principle 8: Uncompromising Quality Gates and Defect Containment
- **Shift-Left Quality**: Quality is verified at every stage of the lifecycle, not bolted on at the end. Defects must be arrested at the earliest possible stage.
- **Zero Tolerance for Broken Windows**: Known defects, failing tests, compiler warnings, and linter errors must be resolved immediately, not deferred without formal exception tracking.
- **Gate Integrity**: Stage gates are inviolable barriers. Progression to subsequent stages is blocked until all entry and exit criteria are fulfilled.

### Principle 9: Architectural Decision Continuity
- **Decisions Are Recorded**: Significant architectural decisions, structural patterns, and technology selections must be captured in Architecture Decision Records (ADRs).
- **Rationale Preservation**: ADRs must record the context, considered alternatives, trade-offs, and reasons for rejection, ensuring future agents and engineers understand *why* a system is structured as it is.
- **Consistent Trajectory**: AI agents must respect existing ADRs. They are prohibited from introducing architectural patterns that contradict recorded decisions without a formal ADR revision.

### Principle 10: Context Preservation and Documentation Integrity
- **Preserve Existing Artifacts**: Agents must never delete, overwrite, or truncate existing comments, documentation, or code without understanding and preserving their underlying intent.
- **Living Documentation**: As system behavior changes, related documentation, interface contracts, and diagrams must be updated synchronously in the same change transaction.
- **Clarity and Precision**: Documentation must be concise, accurate, and actionable. Avoid buzzwords and vague prose.

---

## 3. Technology-Agnostic Application

The principles of this Constitution apply uniformly across all languages, runtimes, and application tiers:
- **Frontend / Client (Web, Mobile, Desktop)**: Modularity, deterministic state management, contract-driven API consumption, and accessibility standards.
- **Backend / Services (APIs, Microservices, Batch)**: Fault isolation, idempotency, data consistency, security boundaries, and observable contracts.
- **Infrastructure / Platform**: Declarative configurations, reproducible environments, immutable releases, and least-privilege security.

Specific implementation guidelines (e.g., for Next.js, React, React Native, Expo, Go, Python) are child extensions of this Constitution housed under the canonical `stacks/<technology>/` directory structure (e.g., `stacks/nextjs/`, `stacks/react/`, `stacks/react-native/`, `stacks/expo/`) and must never violate its core principles.

---

## 4. Enforcement and Compliance

1. **Agent Self-Governance**: Every AI agent operating in this repository or downstream projects must ingest and continuously evaluate its work against these 10 principles following the [AI Engineering Controller](../governance/ENGINEERING_CONTROLLER.md).
2. **Review Standard & Stage Gates**: Pull requests, commits, and stage-gate submissions will be audited against this Constitution and the [Stage-Gate Rules](../governance/stage-gate-rules.md). Violations constitute grounds for immediate stage rejection.
3. **Automated Evolution**: Where feasible, constitutional rules will be supported by automated linting, AST analysis, security scanning, and test gates. However, intellectual adherence to simplicity, architectural continuity, and specification-first engineering remains a core responsibility of both human and AI participants.
