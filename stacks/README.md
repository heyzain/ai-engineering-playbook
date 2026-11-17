# Technology Stack Catalog (`stacks/`)

> **Repository Subsystem**: Modular Technology Stacks  
> **Status**: Active Reference Implementations  
> **Governance Authority**: [`ADR-20261104-001`](../docs/adr/ADR-20261104-001-modular-technology-stacks.md) & [`ADR-20261104-002`](../docs/adr/ADR-20261104-002-mobile-technology-stacks.md)

---

## Available Technology Stacks

| Stack ID | Name | Tier | Framework Baseline | Dependencies | Status | Documentation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `nextjs` | Nextjs | Tier 2 (Web) | Next.js >= 14.2.0 < 16.0.0 (Recommended: Next.js 15 LTS) | `[]` | Verified (Task 007B) | [`stacks/nextjs/spec.md`](nextjs/spec.md) |
| `react-native` | React-native | Tier 2A (Mobile Foundation) | React Native >= 0.74.0 < 0.78.0 (Recommended: React Native 0.76 LTS) | `[]` | Verified (Task 007D.2) | [`stacks/react-native/spec.md`](react-native/spec.md) |

---

## Architecture Principles

1. **Constitutional Primacy**: All stack-specific rules inherit and enforce the universal engineering constitution ([Principle 5: Technology-Agnostic Core](../core/engineering-constitution.md)).
2. **Deterministic Composition**: Multi-tier dependency resolution using topological DAG sorting ensures prerequisite stacks scaffold and compose prior to dependent extensions.
3. **Hermetic Offline Scaffolding**: Starter templates are generated locally without network access, and quality gates execute deterministically in headless environments.
4. **Single Source of Truth**: Stack identity and dependencies are canonically declared in each stack's `stack.json`.
