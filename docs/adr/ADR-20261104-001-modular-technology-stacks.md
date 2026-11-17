# Architecture Decision Record (ADR)

# ADR-20261104-001: Modular Technology Stacks Architecture and Next.js Reference Stack Specification

> **Template Version**: 1.0.0  
> **Applicable Stages**: Task 007 (Technology Stacks Architecture & Modular Extension Model)  
> **Storage Location**: `docs/adr/ADR-20261104-001-modular-technology-stacks.md`

---

## 1. ADR Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-20261104-001` |
| **Title** | Modular Technology Stacks Architecture and Next.js Reference Stack Specification |
| **Status** | `Accepted` |
| **Creation Date** | `2026-11-04` |
| **Last Updated** | `2026-11-04` (Architectural Design under Task 007A) |
| **Author(s)** | AI Engineering Controller & Systems Architect |
| **Lead Approver** | Zain Ali (Lead Engineer & Architect) |
| **Impacted Subsystems** | `stacks/`, Project Manifest (`.playbook/manifest.json`), Quality Gate Engine, RIF Classifier, Scaffolding (`playbook init`) |

---

## 2. Context and Problem Statement

The AI Engineering Playbook has established a technology-agnostic core governance model:
1. Stage-Gate lifecycle (Stage 0 to Stage 6) with explicit entry and exit gates.
2. Deterministic state machine backed by Write-Ahead Logging (`WriteAheadTransactionManager`).
3. Pluggable Quality Gate verification engine (`playbook gate run`), native Git hooks (`playbook hook`), and hermetic remote CI workflows (`playbook ci`).

However, real-world software engineering takes place within concrete technology ecosystems (e.g., Next.js, React, React Native, Expo, Node.js). In the absence of strict, framework-specific engineering conventions and automated quality gate profiles, AI coding agents and development teams encounter severe failure modes:
1. **Server/Client Boundary Pollution**: In Next.js App Router projects, AI agents routinely mark top-level layout and page files with `"use client"`, disabling React Server Components (RSC), degrading server-side rendering, breaking SEO metadata generation, and bloating client bundles.
2. **Missing Resilience Primitives**: AI agents frequently omit required Next.js route boundaries (`loading.tsx`, `error.tsx`, `not-found.tsx`), causing uncaught client runtime errors to crash entire route trees.
3. **Secret Leakage to Client Bundles**: Agents inadvertently import server-side environment secrets or database utilities into Client Components, leaking credentials through browser bundles.
4. **Architectural Drift & Ad-Hoc Folder Topologies**: Inconsistent folder structures across projects (e.g., mixing `pages/` and `app/`, scattering data fetching logic into UI components) impair maintainability.
5. **Quality Gate Blindness**: Without framework-specific quality gate checks, the technology-agnostic core cannot automatically verify that `next build`, `next lint`, or bundle size budgets pass before approving gates.

The Playbook requires an architectural extension mechanism that provides opinionated, production-grade technology guidance while preserving the purity, neutrality, and non-negotiable rules of the Engineering Constitution.

---

## 3. Decision Drivers

- **Constitutional Principle 1 (Human Sovereignty & Separation of Powers)**: Framework tools or automated scaffolds cannot waive, relax, or self-approve governance stage gates.
- **Constitutional Principle 2 (Architectural Clarity & Explicit Boundaries)**: Server/client component boundaries, data access patterns, and route topologies must be explicitly defined and strictly enforced.
- **Constitutional Principle 3 (Determinism Over Heuristics)**: Framework verification must rely on deterministic check commands (linters, typecheckers, build outputs), never probabilistic heuristics.
- **Constitutional Principle 4 (Radical Simplicity & YAGNI)**: Minimal production-tested dependencies. Reject unneeded abstractions, speculative state management libraries, and heavyweight frameworks.
- **Constitutional Principle 5 (Strict Modularity & Technology-Agnostic Core)**: The core Playbook engine (`core/`, `governance/`, `schemas/`, `tooling/playbook-cli/`) must remain 100% agnostic. Framework-specific conventions must be completely contained within modular stack definitions.
- **Constitutional Principle 8 (Uncompromising Quality Gates)**: Stack-specific checks must compose cleanly with core quality gates and fail closed on any violation.

---

## 4. Considered Alternatives

### Alternative A: Monolithic Core with Hardcoded Framework Generators
- *Description*: Embed framework scaffolding generators (e.g., Next.js, Expo) directly into the core Playbook CLI binary, with hardcoded TypeScript logic for each framework.
- *Rejection Rationale*:
  - Directly violates **Principle 5 (Strict Modularity)**: Core CLI would carry framework-specific dependencies and rapid obsolescence churn.
  - Requires continuous CLI version releases whenever a framework updates minor conventions.
  - Prevents adding custom or proprietary technology stacks without modifying core governance code.

### Alternative B: Unstructured Markdown Guidelines Only
- *Description*: Provide non-normative markdown guides in a `docs/guides/` folder without machine-readable configuration, schemas, or quality gate definitions.
- *Rejection Rationale*:
  - Highly susceptible to agent hallucination: LLM coding agents routinely ignore informal guidelines unless coupled with automated tooling and gate rejection.
  - Lacks machine-verifiable Quality Gate rules (`quality-gates.partial.json`) and RIF classification patterns (`rif-patterns.json`).
  - Does not enable programmatic scaffolding via `playbook init --stack <name>`.

### Alternative C: Modular Two-Tier Hierarchy with Composable Stack Packages (Selected)
- *Description*: Implement a two-tier inheritance model where core governance remains Tier 1 (immutable & universal) and technology stacks reside under `stacks/<technology>/` as Tier 2 modular child packages containing:
  - `spec.md`: Normative architectural rules, directory topologies, and agent instructions.
  - `quality-gates.partial.json`: Stack-specific quality checks composed into project gates.
  - `rif-patterns.json`: Repository Inspection Filter globs for framework artifacts.
  - `template/`: Minimal, production-hardened starter project overlay.
- *Justification*:
  - Fully isolates framework specifics from core governance logic.
  - Enables clean, deterministic composition of quality gates and RIF rules.
  - Provides AI agents with precise, normative specifications and automated verification commands.

---

## 5. Decision Outcome

We adopt **Alternative C (Modular Two-Tier Hierarchy with Composable Stack Packages)** and establish the **Next.js Reference Stack** as the initial implementation.

### 5.1 Two-Tier Inheritance and Inviolable Precedence Rule
- **Tier 1 (Core Governance)**: [core/engineering-constitution.md](../../core/engineering-constitution.md), [governance/stage-gate-rules.md](../../governance/stage-gate-rules.md), and [governance/state-machine.md](../../governance/state-machine.md) are universal and non-negotiable.
- **Tier 2 (Technology Stacks)**: Modular extensions residing under `stacks/<technology>/`.
- **Precedence Rule**: If any framework convention, library recommendation, or community idiom conflicts with a principle of the Engineering Constitution, **the Constitution strictly prevails**. No stack may waive quality gates, bypass human sign-off, or permit speculative dependencies.

### 5.2 Canonical Stack Directory Structure
Every stack must conform to the standard layout:
```
stacks/<technology>/
├── README.md                     # Overview, supported versions, and adoption guide
├── spec.md                       # Normative architectural rules, idioms, and directory layouts
├── quality-gates.partial.json     # Modular Quality Gate check definitions for this stack
├── rif-patterns.json             # Framework-specific text/binary inclusion & exclusion globs
└── template/                     # Canonical project scaffold overlay
    ├── package.json.template     # Recommended dependencies and scripts
    ├── tsconfig.json             # Strict TypeScript compiler options
    ├── eslint.config.js          # ESLint flat config with framework plugins
    └── src/                      # Starter source tree adhering strictly to spec.md
```

### 5.3 Next.js Reference Stack Architectural Invariants
1. **App Router Required**: Page Router (`pages/`) is strictly prohibited for new projects.
2. **Leaves-Only Client Component Policy**:
   - `"use client"` is forbidden in root layouts (`app/layout.tsx`), route pages (`app/**/page.tsx`), and data-fetching server containers.
   - Client components are strictly restricted to leaf nodes requiring user interaction (buttons, forms, modals) or browser APIs.
3. **Route Fault-Tolerance**: Every route segment must define `loading.tsx` and `error.tsx` (or utilize root fallbacks).
4. **Secret Leak Prevention (`SEC-NEXT-01`)**:
   - Server secrets and private keys must never use the `NEXT_PUBLIC_` prefix.
   - Client components cannot import server-only modules; automated checks scan bundles for private environment variable leakage.
5. **Hermetic Quality Gate Composition**:
   - Next.js projects compose checks: `next-build` (`next build`), `next-lint` (`next lint`), and strict TypeScript typechecking into Gate 4 (Implementation) and Gate 5 (Integration).

### 5.4 Project Manifest Evolution
The project manifest schema (`schemas/manifest.schema.json`) is extended to declare active stacks:
```json
{
  "$schema": "https://raw.githubusercontent.com/ai-engineering-playbook/main/schemas/manifest.schema.json",
  "project_name": "my-next-app",
  "technology_stacks": ["nextjs"],
  "created_at": "2026-11-04T12:00:00.000Z"
}
```

### 5.5 Quality Gate Composition Semantics
When a stack is initialized or applied:
- Checks defined in `quality-gates.partial.json` are merged into the target stage of `.playbook/quality-gates.json`.
- Merging follows deterministic union semantics: checks with distinct IDs are appended; duplicate IDs trigger validation errors unless explicitly declared as stage overrides.
- Core universal checks (constitution audit, clean git status) cannot be replaced or deleted by stack partials.

---

## 6. Consequences and Trade-offs

### Positive Consequences
- **Architectural Uniformity**: AI agents generate predictable, idiomatic, and robust code matching exact framework standards.
- **Zero Core Contamination**: Core Playbook CLI remains lightweight, hermetic, and independent of specific JavaScript or mobile frameworks.
- **Composable Extensibility**: Future stacks (e.g., `react-native`, `expo`, `fastapi`) can be added by authoring self-contained directory packages under `stacks/<stack-name>/` without altering core state machine or CLI engine code.
- **Automated Verification**: Framework mistakes (leaked client keys, missing loading boundaries, build errors) are caught deterministically by quality gates before code reaches review.

### Negative Consequences and Trade-offs
- **Stack Maintenance Overhead**: Each stack must maintain its own `spec.md`, partial configs, and template files in sync with upstream framework version releases.
- **Multi-Stack Conflicts**: In projects utilizing multiple stacks simultaneously (e.g. `nextjs` web + `expo` mobile in a monorepo), gate naming and script paths must be namespaced to avoid collision.

---

## 7. Constitutional Traceability Matrix

| Principle | Architectural Enforcement |
| :--- | :--- |
| **Principle 1: Human Sovereignty** | Stacks define checks; only human operators can approve gate exits or waive rules via formal exception records (`EXC-*`). |
| **Principle 2: Architectural Clarity** | Strict separation of Server vs Client Components; explicit route boundaries; defined directory topologies. |
| **Principle 3: Determinism** | Framework checks execute via explicit CLI commands (`next build`, `tsc --noEmit`) with deterministic exit codes. |
| **Principle 4: Radical Simplicity** | Zero unnecessary third-party libraries; utilize native React 19 / Next.js primitives without boilerplate state managers. |
| **Principle 5: Strict Modularity** | Two-tier hierarchy guarantees core governance contains zero framework dependencies. |
| **Principle 8: Quality Gates** | Next.js partial gate definitions automatically integrated into Stages 4 and 5 gate enforcement. |

---

## 8. Implementation Roadmap (Task 007B)

Upon approval of this architecture record, Task 007B will implement:
1. Canonical directory structure under `stacks/nextjs/` (`README.md`, `spec.md`, `quality-gates.partial.json`, `rif-patterns.json`).
2. Production-hardened template files under `stacks/nextjs/template/` (`package.json.template`, `tsconfig.json`, `eslint.config.js`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/loading.tsx`, `src/app/error.tsx`).
3. Manifest schema update in `schemas/manifest.schema.json` to formally support `technology_stacks`.
4. Playbook CLI stack initialization and composition engine updates in `tooling/playbook-cli/`.
