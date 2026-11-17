# Technology Stacks & Extension Model: Gap Analysis (Task 007A)

> **Document Type**: Architecture Gap Analysis  
> **Milestone**: Task 007A — Modular Technology Stacks Architecture & Next.js Stack Specification  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION  
> **Preceding Baseline**: Tasks 001–006C.3.4 (Core Governance, CLI, WAL, Quality Gates, Git Hooks, Remote CI)

---

## 1. Executive Summary

The completion of Task 006 established the AI Engineering Playbook's end-to-end governance and automated verification pipeline:
- **Core Governance & CLI**: Schema-backed project manifests, deterministic finite state machines, Write-Ahead Logging, and human sovereign gates.
- **Local Enforcement**: Native POSIX Git hooks (`pre-commit`, `pre-push`) running on shadow index sandboxes and ephemeral detached worktrees.
- **Remote CI Enforcement**: Authoritative GitHub Actions workflows executing headless quality gates in pristine containers with run-scoped cryptographic evidence.

However, the Playbook currently stops at the repository boundary: it tells human engineers and AI coding agents *how to govern*, but does not yet prescribe *how to construct* software within specific technology ecosystems.

This gap analysis audits the architectural requirements needed to introduce modular, framework-specific engineering extensions under `stacks/<technology>/` without violating Constitutional Principle 5 (Strict Modularity & Technology-Agnostic Core).

---

## 2. Current State vs Target State Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Current State (Task 006 Baseline)                                      │
├────────────────────────────────────────────────────────────────────────┤
│ • manifest.json contains a freeform `ecosystem` string (e.g. "node")   │
│ • quality-gates.json contains generic shell commands                   │
│ • No canonical directory layout or idioms for modern frameworks        │
│ • AI agents frequently hallucinate incompatible folder structures,     │
│   legacy framework patterns (e.g. Next.js Pages router), or insecure   │
│   client-side secret exposures                                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Evolution (Task 007)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Target State (Modular Technology Stacks)                               │
├────────────────────────────────────────────────────────────────────────┤
│ • Formal specification in stacks/<technology>/                         │
│ • Manifest schema supports structured multi-stack composition          │
│ • Turnkey Quality Gate rulesets for Next.js, React, React Native, Expo │
│ • Explicit architectural rules (Server vs Client components, bundle    │
│   security, accessibility invariants, route handler fault tolerance)   │
│ • Scaffolding templates that pass all 6 lifecycle gates out of the box │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Gap Analysis by Architectural Domain

### 3.1 Domain 1: Project Topologies & Scaffolding

#### GAP-18: Absence of Canonical Framework Topologies
- **Current State**: `playbook init` scaffolds empty standard governance folders (`.playbook/`, `docs/`, `schemas/`), leaving the application code directory undefined.
- **Problem**: When left unspecified, AI coding agents produce erratic, non-standard project structures (e.g. mixing `src/pages` with `app/`, scattering utility files across arbitrary directories, or placing configuration files in non-standard locations).
- **Required Architecture**:
  - Each stack under `stacks/<technology>/` must define a canonical, normative directory topology.
  - The Next.js stack (`stacks/nextjs/`) must specify the standard App Router layout:
    - `src/app/` (File-based routing, server layouts, loading states, error boundaries)
    - `src/components/ui/` (Design system and reusable primitive components)
    - `src/components/features/` (Domain-specific feature components)
    - `src/lib/` (Ecosystem-neutral business logic and utility functions)
    - `src/services/` (Data access layers, external API clients)
    - `src/types/` (TypeScript domain definitions and schema types)
    - `public/` (Static assets)
    - Root-level configuration (`next.config.mjs`, `tsconfig.json`, `eslint.config.js`, `postcss.config.mjs`, `tailwind.config.ts`).

---

### 3.2 Domain 2: Quality Gate Profiles & Verification Rules

#### GAP-19: Unconfigured Framework-Specific Quality Gates
- **Current State**: Core quality gates evaluate generic shell commands (`npm test`, `npm run lint`).
- **Problem**: Next.js applications require specific verification disciplines that differ from generic Node libraries:
  - `next build`: Must succeed with zero type errors and zero ESLint warnings.
  - Production bundle analysis: Preventing bloat in first-load JS bundles.
  - Core Web Vitals & Accessibility: Static WCAG 2.1 AA compliance audits (`jsx-a11y`).
  - Hermetic testing: Unit and integration tests that do not attempt live network calls.
- **Required Architecture**:
  - Each stack provides a turnkey `quality-gates.partial.json` snippet.
  - Stack gates integrate cleanly into the Playbook's existing DAG runner (`playbook gate run`), respecting severity levels (`critical`, `high`, `medium`), execution timeouts, and Tier 3 clean working-tree policies.

#### GAP-20: Missing Framework-Specific RIF (Reproducible Input Fingerprint) Patterns
- **Current State**: The core RIF engine canonicalizes text/binary files using standard extensions (`.ts`, `.json`, `.md`).
- **Problem**: Next.js creates build caches and generated artifacts in `.next/` and `node_modules/`. If RIF patterns inadvertently include transient build artifacts or ignore critical framework configs, fingerprinting either becomes non-deterministic or fails to detect real code modifications.
- **Required Architecture**:
  - Stack specifications must provide explicit `text_patterns` and `binary_patterns` tailored to the framework.
  - For Next.js:
    - Explicitly include: `src/**/*.{ts,tsx,js,jsx,css,mjs}`, `public/**/*`, `next.config.{js,mjs,ts}`, `tsconfig.json`, `package.json`, `package-lock.json`.
    - Explicitly exclude: `.next/**/*`, `out/**/*`, `coverage/**/*`, `node_modules/**/*`, `*.log`.

---

### 3.3 Domain 3: Architectural Invariants & Idiom Governance

#### GAP-21: Server vs. Client Component Boundary Enforcements
- **Current State**: Core governance does not regulate React Server Component (RSC) architecture.
- **Problem**: In Next.js App Router, components default to Server Components. Developers and AI agents frequently add `"use client"` at the top of entire page layouts, defeating server-side rendering, bloating the client bundle, and creating hydration mismatches. Conversely, server-side database access or secrets placed in Client Components cause catastrophic build failures or security leaks.
- **Required Architecture**:
  - The Next.js stack architecture must formalize the **"Leaves-Only Client Component Policy"**:
    - Route pages (`page.tsx`), layouts (`layout.tsx`), and data-fetching containers must strictly remain Server Components.
    - `"use client"` directives must be confined to interactive leaf nodes (buttons, form inputs, modal dialogs).
    - Data fetching must occur on the server and pass serialized props down to client components.

#### GAP-22: Client-Side Secret Leakage Defense
- **Current State**: `quality-gates.json` checks for generic secret patterns (`ghp_*`, `aws_key`).
- **Problem**: Next.js automatically inlines environment variables prefixed with `NEXT_PUBLIC_` into client-side JS bundles. Unwary developers or AI agents sometimes prefix sensitive API keys or database tokens with `NEXT_PUBLIC_` to resolve runtime errors, leaking credentials to the public browser.
- **Required Architecture**:
  - Automated Quality Gate check `SEC-NEXT-01`: Scans all `NEXT_PUBLIC_*` declarations against sensitive secret patterns.
  - Explicit rule: `NEXT_PUBLIC_` variables must only contain public URLs, feature flags, or public identifiers (e.g. analytics tracking IDs).

---

### 3.4 Domain 4: Manifest & State Machine Integration

#### GAP-23: Manifest Multi-Stack Composition
- **Current State**: `project-manifest.schema.json` defines `ecosystem` as a single string (e.g. `"node"`).
- **Problem**: Production applications frequently combine multiple technologies (e.g. `nextjs` + `react` + `tailwind`). A single flat string cannot express composed stack dependencies.
- **Required Architecture**:
  - Add optional `technology_stacks` array to `project-manifest.schema.json`:
    ```json
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
    ```
  - Preserve backward compatibility with existing `ecosystem` field.

---

### 3.5 Domain 5: Scaffolding CLI Integration

#### GAP-24: Scaffolding Extensibility Model
- **Current State**: `playbook init` scaffolds the core governance structure only.
- **Problem**: Users want a single command to bootstrap both Playbook governance and a fully compliant stack template (e.g. `playbook init --stack nextjs`). Hardcoding Next.js files into the core CLI binary violates Principle 5 (Technology-Agnostic Core).
- **Required Architecture**:
  - Define a file-system driven template resolution protocol:
    The CLI checks `stacks/<technology>/template/` to overlay framework scaffolds upon initialization without compiling framework code into the CLI.
  - Phase 1 (Task 007A): Architecture and manual reference templates.
  - Phase 2 (Task 007B): Automated CLI `--stack` overlay execution.

---

## 4. Summary of Gaps and Implementation Tracking

| Gap ID | Functional Domain | Severity | Architecture Status | Target Milestone / Deliverable |
| :--- | :--- | :--- | :--- | :--- |
| **GAP-18** | Canonical Topologies | **High** | **Designed (Task 007A)** | `stacks/nextjs/spec.md` & `stacks/nextjs/template/` |
| **GAP-19** | Stack Quality Gates | **Critical** | **Designed (Task 007A)** | `stacks/nextjs/quality-gates.json` snippet |
| **GAP-20** | Framework RIF Rules | **High** | **Designed (Task 007A)** | `stacks/nextjs/rif-patterns.md` |
| **GAP-21** | RSC Boundary Rules | **Critical** | **Designed (Task 007A)** | `docs/architecture/technology-stacks/nextjs-stack-design.md` |
| **GAP-22** | Secret Leak Defense | **Critical** | **Designed (Task 007A)** | Custom Quality Gate rule `SEC-NEXT-01` |
| **GAP-23** | Manifest Composition| **Medium** | **Designed (Task 007A)** | `project-manifest.schema.json` v1.1 evolution |
| **GAP-24** | Scaffolding Extension| **Medium** | **Designed (Task 007A)** | CLI Template Overlay Protocol |
