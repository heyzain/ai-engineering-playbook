# Next.js Reference Stack Module

> **Stack Identifier**: `nextjs`  
> **Version**: `1.0.0`  
> **Framework Target**: Next.js `>= 14.2.0 < 16.0.0` (Recommended: Next.js 15 LTS)  
> **Governing ADR**: [`ADR-20261104-001`](../../docs/adr/ADR-20261104-001-modular-technology-stacks.md)  
> **Specification**: [`spec.md`](./spec.md)

---

## 1. Overview

The **Next.js Reference Stack** provides the official, production-hardened standard for developing web applications using Next.js under the AI Engineering Playbook governance model.

This stack module encapsulates:
1. **Architectural Rules**: Mandatory App Router (`app/`), Server Components by default, and the "Leaves-Only" Client Component rule.
2. **Quality Gate Checks**: Pre-configured verification rules for TypeScript typechecking, Next.js strict linting, production build verification, and client secret audit (`SEC-NEXT-01`).
3. **Reproducible Input Fingerprints (RIF)**: Deterministic file classification rules isolating build outputs (`.next/`, `out/`) from repository input hashes.
4. **Offline Starter Template**: A minimal, self-contained project scaffold ready for immediate local development without remote network dependencies.

---

## 2. Directory Layout

```
stacks/nextjs/
├── README.md                     # This file
├── spec.md                       # Normative architectural specification and agent instructions
├── quality-gates.partial.json     # Modular Quality Gate check definitions for Stages 4 & 5
├── rif-patterns.json             # Framework file classification and exclusion globs
└── template/                     # Canonical project scaffold overlay
    ├── package.json.template     # Recommended scripts and dependencies
    ├── tsconfig.json             # Strict TypeScript compiler configuration
    ├── eslint.config.js          # ESLint flat configuration
    ├── next.config.mjs           # Next.js configuration
    └── src/
        ├── app/                  # App Router tree
        │   ├── layout.tsx        # Root Server layout
        │   ├── page.tsx          # Landing page (Server Component)
        │   ├── loading.tsx       # Route loading UI
        │   ├── error.tsx         # Client Error Boundary
        │   └── not-found.tsx     # 404 UI
        ├── components/           # UI components
        │   └── counter.tsx       # Leaves-only Client Component
        └── lib/
            └── env.ts            # Safe environment variable helper
```

---

## 3. Adoption & CLI Commands

### Listing Available Stacks
```bash
playbook stack list
```

### Applying Next.js Stack to an Existing Project
```bash
playbook stack apply nextjs
```

### Initializing a New Project with Next.js Stack
```bash
playbook init --name "My Web App" --stack nextjs
```

### Composing Quality Gates
```bash
playbook stack compose
```
