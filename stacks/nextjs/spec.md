# Next.js Reference Stack Specification

> **Stack Identifier**: `nextjs`  
> **Specification Version**: `1.0.0`  
> **Status**: NORMATIVE SPECIFICATION  
> **Governing ADR**: [`ADR-20261104-001`](../../docs/adr/ADR-20261104-001-modular-technology-stacks.md)

---

## 1. Scope & Framework Requirements

- **Target Versions**: Next.js `>= 14.2.0 < 16.0.0` (Recommended: Next.js 15 LTS).
- **Runtime Target**: Node.js `>= 20.9.0` LTS.
- **Routing Paradigm**: Next.js App Router (`src/app/`). The legacy Pages Router (`pages/`) is **strictly prohibited** for all projects governed by this specification.

---

## 2. Core Architectural Invariants

### 2.1 The "Leaves-Only" Client Component Policy
1. **Server Components by Default**: Every component file (`.tsx`) is executed as a React Server Component (RSC) by default.
2. **Restricted `"use client"` Directives**: The `"use client"` directive may ONLY be placed at interactive leaf components (e.g. buttons, modal dialogs, form inputs, or components that subscribe to browser DOM events / React hooks).
3. **Prohibited Directive Placements**:
   - ❌ `src/app/layout.tsx`: Root layout MUST remain a Server Component.
   - ❌ `src/app/**/page.tsx`: Route pages MUST remain Server Components to preserve server-side data fetching and metadata streaming.
   - ❌ `src/app/**/loading.tsx`: Loading fallbacks MUST remain Server Components.
   - ❌ Direct database access (Prisma, Drizzle, `pg`, etc.) inside any file containing `"use client"`.

### 2.2 Route Fault-Tolerance & Resilience Boundaries
Every user-facing route segment must provide explicit resilience boundaries:
1. `loading.tsx`: Renders instant suspense fallback UI while server promises resolve.
2. `error.tsx`: Catch-all error boundary. MUST be a Client Component (`"use client"`), receives `{ error, reset }`, and exposes an interactive reset trigger.
3. `not-found.tsx`: Renders user-friendly 404 message when `notFound()` is invoked.

### 2.3 Secret Leak Prevention (`SEC-NEXT-01`)
1. **Private Server Secrets**: Credentials, database URLs, signing keys, and private tokens must NEVER use the `NEXT_PUBLIC_` prefix.
2. **Public Client Variables**: Only non-sensitive configuration keys (e.g. `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_GA_ID`) may use the `NEXT_PUBLIC_` prefix.
3. **Automated Enforcement**: All builds and quality gates execute the `nextjs-secret-audit` check (`scripts/audit-secrets.mjs`), scanning:
   - All `.env*` files for prohibited `NEXT_PUBLIC_*` secret naming.
   - All Client Component source files (`"use client"`) for direct `process.env.<VAR>` references or server module imports (`server-only`, `node:fs`).
   - Compiled client chunks (`.next/static/chunks/`) if present.

### 2.4 Detection Boundaries & Scientific Limitations of `SEC-NEXT-01`
- **Static Heuristic Boundary**: Scanning relies on AST and token matching. It cannot detect dynamic computed property lookups (e.g. `process.env[computedVar]`) or obfuscated base64 strings.
- **False-Positive Potential**: Identifiers containing words like `KEY` or `TOKEN` in purely public contexts (e.g. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) will be flagged and require descriptive public names (e.g. `NEXT_PUBLIC_STRIPE_CLIENT_ID`) or formal exception records (`EXC-*`).
- **No Substitute for Key Vaults**: Static gate auditing provides early developer defense; it does not replace runtime secret stores (AWS Secrets Manager, HashiCorp Vault).

### 2.5 Offline Scaffolding vs. Dependency Installation Boundary
- **Offline Scaffolding**: `playbook stack apply` and `playbook init --stack` generate all starter files, configs, and `package.json` hermetically from local repository templates without network access.
- **Dependency Reproducibility**: No static `package-lock.json` is packaged in the scaffold template. When developers or CI runners execute `npm install` or `npm ci`, npm produces the project-specific lockfile, which is subsequently tracked and verified by RIF.

---

## 3. Directory Layout Standards

All Next.js code must be structured under `src/`:

```
src/
├── app/                  # Next.js App Router routes, layouts, and endpoints
│   ├── layout.tsx        # Root Server layout
│   ├── page.tsx          # Home page (Server Component)
│   ├── loading.tsx       # Root loading UI
│   ├── error.tsx         # Root error boundary (Client Component)
│   ├── not-found.tsx     # Root 404 page
│   └── api/              # Route handlers (REST / webhooks)
├── components/           # Reusable UI components
│   ├── ui/               # Primitive components (buttons, dialogs, inputs)
│   └── features/         # Domain-specific composite views
├── lib/                  # Ecosystem-neutral utility functions
│   ├── env.ts            # Safe environment variable accessor
│   └── utils.ts          # Formatting, class name merging
├── services/             # Server-only data access and integration clients
└── types/                # Domain models and TypeScript contracts
```

---

## 4. Agent Operating Instructions

When developing, refactoring, or generating code within a Next.js project:
1. **Never Mark Pages as Client Components**: If an interactive element is needed inside a page, isolate that element into a dedicated component under `src/components/` and mark *only that component* with `"use client"`.
2. **Never Bypass TypeScript Strict Mode**: All code must compile cleanly with `tsc --noEmit`. No use of `any` without an explicit exception.
3. **Verify Build Determinism**: Run `npm run build` locally before claiming task completion.
4. **Preserve RIF Isolation**: Never commit build artifacts (`.next/`, `out/`, `*.tsbuildinfo`) to Git.
