# Technology Stacks Modular Architecture Specification (Task 007A)

> **Document Type**: Architecture & System Design  
> **Milestone**: Task 007A — Modular Technology Stacks Architecture & Next.js Stack Specification  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION  
> **Authority**: Engineering Constitution & Stage-Gate Rules

---

## 1. Architectural Role & Inheritance Model

The AI Engineering Playbook operates on a strict **two-tier inheritance hierarchy**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Core Governance (Universal & Immutable)                       │
│ ├─ Engineering Constitution (Non-negotiables: Sovereignty, Simplicity) │
│ ├─ Lifecycle Stages 0 to 6 & Mandatory Gate Transition Rules           │
│ ├─ State Machine Contracts & Write-Ahead Logging Immutability          │
│ └─ Technology-Agnostic Quality Gate Engine                             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Specialized By
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2: Technology Stacks (Modular Child Extensions)                   │
│ ├─ Canonical Directory Topologies & Framework File Conventions         │
│ ├─ Framework-Specific Idioms & Architectural Boundaries                │
│ ├─ Domain Quality Gate Rules (Builds, Linters, Accessibility, Budgets) │
│ └─ Reference Starter Scaffolds & Templates                             │
└────────────────────────────────────────────────────────────────────────┘
```

### The Inviolable Hierarchy Rule
- **Constitutional Supremacy**: No technology stack may waive, relax, or contradict any principle of the Engineering Constitution.
- **Fail-Closed Precedence**: In any scenario where a framework convention suggests bypassing strict typing, automated verification, or human sign-off, the Core Governance rules strictly prevail.

---

## 2. Canonical Stack Directory Structure

Every technology stack defined within the AI Engineering Playbook must reside under `stacks/<technology>/` with the following standard internal topology:

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

### Component Responsibilities:
1. **`spec.md`**: The authoritative specification for AI coding agents and human engineers. It details:
   - Target framework versions (e.g. Next.js `>= 14.2.0 < 16.0.0`).
   - Normative directory topology.
   - Component architecture (e.g. Server vs. Client component placement).
   - State management and data-fetching contracts.
   - Security invariants (secret exposure prevention).
   - Accessibility and performance budgets.
2. **`quality-gates.partial.json`**: An importable JSON snippet containing Quality Gate definitions tailored to the stack. These rules define commands, severity levels, working-tree requirements, and timeouts.
3. **`rif-patterns.json`**: Defines input glob patterns for the Reproducible Input Fingerprint (RIF) engine to ensure build caches (`.next/`, `node_modules/`, `dist/`) are excluded while framework configs and source files are hashed deterministically.
4. **`template/`**: A pristine, runnable starter scaffold that passes all Quality Gate checks out of the box upon project initialization.

---

## 3. Manifest Integration & Stack Composition

To bind downstream projects to technology stacks, `project-manifest.schema.json` evolves from single-ecosystem string representation to support structured multi-stack composition:

### Manifest Schema Extension:
```json
{
  "ecosystem": "node",
  "technology_stacks": [
    {
      "name": "nextjs",
      "version": "^15.0.0",
      "role": "framework",
      "spec_version": "1.0.0"
    },
    {
      "name": "react",
      "version": "^19.0.0",
      "role": "ui_library",
      "spec_version": "1.0.0"
    }
  ]
}
```

### Backward Compatibility Contract:
- Existing projects specifying only `"ecosystem": "node"` remain 100% valid.
- The `technology_stacks` array is optional. If absent, the CLI operates in purely technology-agnostic mode.

---

## 4. Quality Gate Composition Engine

Downstream projects compose Quality Gate checks from declared technology stacks.

```
┌────────────────────────────────────────────────────────┐
│ Project Base Gates (quality-gates.json)                │
│   (e.g. SCHEMA-01, BLK-01, VERIFY-01)                  │
└───────────────────────────┬────────────────────────────┘
                            │ + Compose
                            ▼
┌────────────────────────────────────────────────────────┐
│ Stack Partial Gates (stacks/nextjs/quality-gates.json) │
│   (e.g. BUILD-NEXT-01, LINT-NEXT-01, SEC-NEXT-01)      │
└───────────────────────────┬────────────────────────────┘
                            │ = Combined DAG
                            ▼
┌────────────────────────────────────────────────────────┐
│ Evaluated Quality Gate DAG (playbook gate run)         │
└────────────────────────────────────────────────────────┘
```

### Composition Invariants:
1. **Unique Check ID Namespace**:
   - Stack check IDs must be prefixed with their stack name (e.g. `BUILD-NEXT-01`, `LINT-REACT-01`, `A11Y-WEB-01`).
   - Duplicate check IDs trigger `CONFIG_PATTERN_CONFLICT` during gate configuration validation.
2. **DAG Dependency Preservation**:
   - Stack checks participate in the execution DAG via `depends_on`.
   - Core governance checks (`SCHEMA-01`, `RIF-01`) always precede stack build and test checks.
3. **Fail-Closed Execution**:
   - If a stack gate command fails, execution aborts according to its configured `severity` level (`critical` halts immediately; `high` records failure; `medium` flags warning).

---

## 5. Security & Threat Mitigation for Stacks

| Threat Class | Vector | Stack Architectural Mitigation |
| :--- | :--- | :--- |
| **Client Secret Leakage** | `NEXT_PUBLIC_*` or client bundle embedding | Automated Quality Gate check `SEC-NEXT-01` scans all client code and environment variables for sensitive key patterns. |
| **Dependency Hijacking** | Unpinned or floating dependencies | Scaffolds mandate pinned exact versions and lockfile commit; CI enforces `npm ci` clean installs. |
| **Prototype Pollution / SSR Injection** | Unsafe deserialization in Server Actions | Specification mandates strict Zod / schema validation for all Server Action payloads. |
| **Bypass of Core Quality Gates** | Custom framework scripts bypassing Playbook hooks | Hooks wrap native Git lifecycle; stack validation runs inside Playbook-controlled shadow index sandboxes. |

---

## 6. Implementation Rollout Phases

- **Task 007A (Current Milestone)**:
  - Architecture and modular extension framework specification.
  - Complete Next.js reference stack specification (`stacks/nextjs/spec.md`).
  - Architecture Decision Record (`ADR-20261104-001`).
  - Compliance audit report.
- **Task 007B (Future Implementation Milestone)**:
  - Implementation of reference starter templates under `stacks/nextjs/template/`.
  - Quality gate partial configuration (`stacks/nextjs/quality-gates.partial.json`).
  - Scaffolding engine extension (`playbook init --stack nextjs`).
  - Comprehensive automated unit and integration tests.
