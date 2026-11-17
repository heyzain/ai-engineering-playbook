# Modular Technology Stacks Architecture (`stacks/`)

> **Architecture Module**: Task 007 (Technology Stacks Architecture & Modular Extension Model)  
> **Status**: Architectural Specification & Design (Task 007A)  
> **Applicable Subsystems**: Technology Standards, Scaffolding Rules, Domain Gate Profiles, Quality-Gate Composition  
> **Authoritative ADR**: [`docs/adr/ADR-20261104-001-modular-technology-stacks.md`](../../adr/ADR-20261104-001-modular-technology-stacks.md)

---

## 1. Executive Summary & Vision

The **Modular Technology Stacks** architecture bridges the AI Engineering Playbook's technology-agnostic core governance (Stage-Gate Rules, State Machine, Write-Ahead Logging, and Quality Gate Engine) to real-world software ecosystems.

While the foundational Playbook (`core/`, `governance/`, `schemas/`, `tooling/playbook-cli/`) is strictly 100% technology-agnostic ([Principle 5: Strict Modularity & Technology-Agnostic Core](../../core/engineering-constitution.md)), production software development requires concrete idioms, directory topologies, framework patterns, and toolchain configurations.

The Technology Stacks architecture establishes:
1. **A Modular Child Extension Hierarchy**: Technology standards reside in `stacks/<technology>/` (e.g., `stacks/nextjs/`, `stacks/react/`, `stacks/react-native/`, `stacks/expo/`). They extend the Engineering Constitution without altering or polluting core governance.
2. **Deterministic Manifest Ecosystem Binding**: A project binds to one or more technology stacks via `ecosystem` and `technology_stack` declarations in `.playbook/manifest.json`.
3. **Compositional Quality-Gate Profiles**: Stack definitions contribute domain-specific Quality Gate rules (`rules[]` in `quality-gates.json`), custom Reproducible Input Fingerprints (RIF), and linting/typechecking invariants.
4. **Scaffolding & Seed Templates**: Provides canonical project structures, configuration files (`tsconfig.json`, `eslint.config.js`, etc.), and sample implementations that pass Stage 0–6 gates out of the box.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Core Governance Layer (Technology-Agnostic)                           │
│ ├─ Engineering Constitution (core/engineering-constitution.md)         │
│ ├─ Stage-Gate Rules (governance/stage-gate-rules.md)                   │
│ ├─ State Machine & Schemas (schemas/project-state.schema.json)         │
│ └─ Playbook CLI Core Engine (tooling/playbook-cli)                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Extends (Child Hierarchy)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Modular Technology Stacks (stacks/<technology>/)                       │
│ ├─ Next.js App Router (stacks/nextjs/)                                 │
│ ├─ React Web & Accessibility (stacks/react/)                          │
│ ├─ React Native Cross-Platform (stacks/react-native/)                 │
│ └─ Expo Ecosystem & EAS (stacks/expo/)                                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Document Manifest

| Document | Purpose | Target Audience |
| :--- | :--- | :--- |
| [**gap-analysis.md**](gap-analysis.md) | Audit of technology-agnostic vs stack-specific requirements (GAPs 18–25). | Architects, Engineers, Tooling Authors |
| [**design.md**](design.md) | Universal technology stack extension specification, manifest mapping, and gate composition. | Systems Architects, CLI Authors |
| [**nextjs-stack-design.md**](nextjs-stack-design.md) | Deep architectural specification for the Next.js App Router reference stack. | Frontend Architects, Full-Stack Engineers |
| [**mobile/**](mobile/README.md) | Mobile Technology Stacks Architecture (React Native Foundation + Expo Extension). | Mobile Architects, Systems Engineers |
| [**ADR-20261104-001**](../../adr/ADR-20261104-001-modular-technology-stacks.md) | Authoritative Architectural Decision Record for modular stack extensions. | Humans & AI Agents |
| [**ADR-20261104-002**](../../adr/ADR-20261104-002-mobile-technology-stacks.md) | Authoritative ADR for Mobile Technology Stacks (React Native + Expo). | Humans & AI Agents |
| [**audit-report.md**](audit-report.md) | Architecture-freeze compliance audit and bounded scope for implementation Task 007B. | Lead Architects, Governance Leads |

---

## 3. Core Architectural Invariants

Every technology stack defined under `stacks/<technology>/` must strictly adhere to six invariants:

1. **Constitutional Primacy**:
   - Technology-specific rules are subordinate extensions of the [Engineering Constitution](../../core/engineering-constitution.md).
   - In any conflict between a framework idiom and a constitutional principle (e.g. human sovereignty, simplicity, determinism, fail-closed security), the Constitution strictly prevails.
2. **Zero Core Bleed**:
   - Core CLI commands, schemas, and governance documents must never hardcode technology-specific dependencies, keywords, or import statements.
   - Core schemas validate stack declarations through generic, schema-validated extensibility points.
3. **Pure Compositionality**:
   - Projects may compose complementary stacks (e.g. `react` + `nextjs`, or `react-native` + `expo`).
   - Stack gate rules must not conflict or redefine identical check IDs (`CONFIG_PATTERN_CONFLICT` detection).
4. **Pragmatic Production Defaults**:
   - Stacks must codify modern, long-term support (LTS) versions, official framework standards (e.g. Next.js App Router over legacy Pages Router), strict TypeScript (`strict: true`), and zero unpinned dependencies.
5. **Hermetic & Offline-First Verification**:
   - Stack quality checks must run entirely offline in local developer environments and CI containers without querying external registry APIs during verification.
6. **No AI Self-Approval**:
   - Framework-specific boilerplate or code generators do not waive mandatory human sovereign approval at stage gates.
