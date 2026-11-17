# Next.js Reference Stack Specification (Task 007A)

> **Document Type**: Architecture & Technology Reference Specification  
> **Milestone**: Task 007A — Modular Technology Stacks Architecture & Next.js Stack Specification  
> **Target Subsystem**: Next.js App Router Architecture, Component Boundaries, Quality Gates  
> **Target Framework Version**: Next.js `>= 14.2.0 < 16.0.0` (Recommended: Next.js 15 LTS)

---

## 1. Executive Summary & Adoption Scope

The **Next.js Reference Stack** establishes the authoritative standard for web applications built using Next.js within projects governed by the AI Engineering Playbook.

Next.js is the premier full-stack web framework in modern TypeScript ecosystems. However, its App Router paradigm introduces subtle architectural boundaries (Server vs. Client Components, streaming hydration, Server Actions, and client-inlined environment variables) that frequently cause severe defects when implemented inconsistently by AI agents or human teams.

This specification prescribes non-negotiable architectural rules, canonical directory topologies, data-fetching invariants, security guardrails, and automated Quality Gate definitions for Next.js applications.

---

## 2. Framework Versioning & Core Principles

### 2.1 Supported Versions
- **Primary Target**: Next.js `15.x` (App Router, React 19 / 18).
- **Minimum Supported**: Next.js `14.2.0`.
- **Pages Router Prohibition**: The legacy Pages Router (`pages/`) is **strictly prohibited** for new projects governed by this Playbook. All routing must use the App Router (`app/`).

### 2.2 Core Architectural Invariants
1. **Server-First by Default**: Every component is a React Server Component (RSC) unless interactivity explicitly demands `"use client"`.
2. **Leaves-Only Client Components**: The `"use client"` directive is restricted to interactive leaf nodes (buttons, form controls, dropdowns, canvas). Route pages and layouts are always Server Components.
3. **Hermetic Server Actions**: Server Actions must validate all input payloads using Zod schemas and authenticate callers before performing mutations.
4. **Zero Public Secret Leakage**: `NEXT_PUBLIC_*` variables must never contain secrets, tokens, internal URLs, or credentials.
5. **Universal WCAG 2.1 AA Compliance**: All JSX markup must satisfy accessibility standards verified statically by `eslint-plugin-jsx-a11y`.

---

## 3. Canonical Directory Topology

All Next.js projects governed by this stack must organize source code under `src/` adhering strictly to this layout:

```
project-root/
├── .github/workflows/quality-gate.yml    # Playbook CI workflow
├── .playbook/                           # Playbook governance state & logs
├── public/                              # Static public assets (SVGs, favicons, fonts)
├── src/
│   ├── app/                             # Next.js App Router (Routing, layouts, routes)
│   │   ├── layout.tsx                   # Root Server layout (HTML, body, global providers)
│   │   ├── page.tsx                     # Landing page (Server Component)
│   │   ├── loading.tsx                  # Global loading skeleton
│   │   ├── error.tsx                    # Global error boundary (Client Component)
│   │   ├── not-found.tsx                # 404 page
│   │   ├── global.css                   # Global styles & Tailwind imports
│   │   ├── api/                         # Route Handlers (REST / Webhooks)
│   │   │   └── health/route.ts          # Health check endpoint
│   │   └── (routes)/                    # Feature route groups
│   │       └── dashboard/
│   │           ├── layout.tsx           # Dashboard layout
│   │           ├── page.tsx             # Dashboard page (Server Component)
│   │           ├── loading.tsx          # Dashboard loading state
│   │           └── error.tsx            # Dashboard error boundary
│   │
│   ├── components/                      # Reusable UI components
│   │   ├── ui/                          # Headless / primitive components (Button, Input, Modal)
│   │   │   ├── button.tsx
│   │   │   └── input.tsx
│   │   └── features/                    # Domain-scoped composite components
│   │       └── user-profile-card.tsx
│   │
│   ├── lib/                             # Ecosystem-neutral utility functions
│   │   ├── utils.ts                     # Class merge, formatting helpers
│   │   └── env.ts                       # Validated environment variables (Zod)
│   │
│   ├── services/                        # Data access layers & external integrations
│   │   ├── db.ts                        # Database connection / client
│   │   └── api-client.ts                # External service clients
│   │
│   └── types/                           # TypeScript types and domain schemas
│       ├── domain.ts                    # Business entities
│       └── api.ts                       # API request/response types
│
├── next.config.mjs                      # Next.js configuration
├── tsconfig.json                        # TypeScript compiler options (strict: true)
├── eslint.config.js                     # ESLint configuration
├── postcss.config.mjs                   # PostCSS configuration
├── tailwind.config.ts                   # Tailwind CSS configuration
└── package.json                         # Dependencies & scripts
```

---

## 4. Component Architecture: The Leaves-Only Rule

```
┌────────────────────────────────────────────────────────┐
│ Page Route (app/dashboard/page.tsx) [SERVER COMPONENT] │
│ ├─ Fetches data directly on server (db/services)       │
│ ├─ Renders static HTML and passes data as props        │
│ │                                                      │
│ ├─ MetricsCard (Static Presentation) [SERVER COMPONENT]│
│ │                                                      │
│ └─ DateRangePicker [CLIENT COMPONENT ("use client")]   │
│    └─ Manages local UI state and user clicks           │
└────────────────────────────────────────────────────────┘
```

### Prohibited Patterns:
- ❌ **Root Client Layout**: Placing `"use client"` at `src/app/layout.tsx`. This converts the entire application tree into a client-rendered SPA, destroys SSR benefits, and disables streaming.
- ❌ **Page-Level Client Directive**: Placing `"use client"` at `src/app/**/page.tsx`. Pages must remain Server Components so metadata and initial data fetching occur server-side.
- ❌ **Direct Database Access in Client Components**: Importing Prisma, Drizzle, or database drivers inside files with `"use client"`.

---

## 5. Security & Secret Defense (`SEC-NEXT-01`)

### 5.1 Environment Variable Classification
- **Private Variables** (Server-only): `DATABASE_URL`, `JWT_SECRET`, `API_PRIVATE_KEY`.
  - Accessible ONLY in Server Components, Route Handlers, and Server Actions.
  - Files containing private access must import `import "server-only"`.
- **Public Variables** (Client-exposed): `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_GA_ID`.
  - Inlined into client JS at build time.
  - **Zero credentials permitted**.

### 5.2 Automated Gate Check: `SEC-NEXT-01`
The Next.js stack introduces an automated quality gate check that scans:
1. All `.env*` files for sensitive variable names incorrectly prefixed with `NEXT_PUBLIC_`.
2. All Client Components (`"use client"`) for accidental references to server environment variables.

---

## 6. Route Fault Tolerance: Loading & Error Boundaries

Next.js App Router relies on nested React Suspense boundaries. Every route folder representing a user-facing view must define:
1. `loading.tsx`: Instant fallback UI rendered while server data streams.
2. `error.tsx`: Must be a Client Component (`"use client"`) that catches uncaught errors in child subtrees and exposes a `reset()` button.
3. `not-found.tsx`: Explicit 404 boundary for missing resources.

---

## 7. Next.js Quality Gate Profile (`quality-gates.partial.json`)

```json
{
  "$schema": "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
  "version": "1.0.0",
  "rules": [
    {
      "id": "TYPECHECK-NEXT-01",
      "name": "Next.js TypeScript Strict Typecheck",
      "command": "tsc --noEmit",
      "severity": "critical",
      "timeout_seconds": 60,
      "requires_clean_working_tree": false
    },
    {
      "id": "LINT-NEXT-01",
      "name": "Next.js & Accessibility Linting",
      "command": "next lint --strict",
      "severity": "critical",
      "timeout_seconds": 60,
      "requires_clean_working_tree": false
    },
    {
      "id": "BUILD-NEXT-01",
      "name": "Next.js Production Build Validation",
      "command": "next build",
      "severity": "critical",
      "timeout_seconds": 180,
      "requires_clean_working_tree": true
    },
    {
      "id": "SEC-NEXT-01",
      "name": "Client Bundle Secret Leakage Audit",
      "command": "node -e 'const fs=require(\"fs\"); const envs=Object.keys(process.env).filter(k=>k.startsWith(\"NEXT_PUBLIC_\")); const bad=envs.filter(k=>/(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i.test(k)); if(bad.length>0){console.error(\"Forbidden sensitive NEXT_PUBLIC_ variables:\", bad); process.exit(1);}'",
      "severity": "critical",
      "timeout_seconds": 15,
      "requires_clean_working_tree": false
    },
    {
      "id": "TEST-NEXT-01",
      "name": "Hermetic Unit & Component Tests",
      "command": "npm test",
      "severity": "high",
      "timeout_seconds": 120,
      "requires_clean_working_tree": false
    }
  ]
}
```

---

## 8. Reproducible Input Fingerprints (RIF) Patterns for Next.js

```json
{
  "text_patterns": [
    "src/**/*.{ts,tsx,js,jsx,css,scss,mjs}",
    "public/**/*.{svg,json,txt}",
    "next.config.{js,mjs,ts}",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
    "postcss.config.{js,mjs}",
    "tailwind.config.{js,ts,mjs}"
  ],
  "binary_patterns": [
    "public/**/*.{png,jpg,jpeg,webp,ico,woff,woff2,ttf,eot}"
  ],
  "exclude_patterns": [
    ".next/**/*",
    "out/**/*",
    "coverage/**/*",
    "node_modules/**/*",
    ".playbook/.tmp/**/*",
    "*.log"
  ]
}
```
