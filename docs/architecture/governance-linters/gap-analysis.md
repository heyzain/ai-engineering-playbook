# Governance Linters Gap Analysis

> **Specification Version**: 1.0.0  
> **Milestone**: Task 008A — Governance Linters Architecture & Design  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION  
> **Parent Document**: [`README.md`](README.md)  
> **Governing Constitution**: [`core/engineering-constitution.md`](../../../core/engineering-constitution.md)

---

## 1. Context & Motivation

The AI Engineering Playbook has evolved from a conceptual set of engineering instructions into a multi-tiered, machine-governed software engineering lifecycle. As the codebase expanded to include write-ahead logging (WAL), cryptographic evidence verification, git hooks, remote CI adapters, and modular technology stacks (`stacks/react-native`, `stacks/expo`, `stacks/nextjs`), governance complexity increased exponentially.

Currently, the Playbook relies on disparate, siloed verification systems:
1. **JSON Schema Validator (`validator.ts`)**: Validates that `.playbook/manifest.json`, `.playbook/state.json`, and `.playbook/quality-gates.json` adhere to syntactic structural schemas.
2. **Stack Manager (`stack-manager.ts`)**: Validates stack discovery, dependency ordering, package overrides, and template composition.
3. **Quality Gate Runner (`runner.ts`)**: Executes configured child processes (`node scripts/audit-*.mjs`, `npx tsc`) and captures logs.
4. **Reproducible Input Fingerprinter (`rif.ts`)**: Hashes input file blobs to detect working tree drift.
5. **Mobile Rule Evaluators (`rif-rules.ts`)**: Programmatic AST checkers for React Native and Expo rules.

### The Operational Problem
Despite these individual components, **there is currently no holistic governance linter** that validates semantic cross-system consistency across documentation, architecture records, schema configurations, governance invariants, stack extensions, and CI security perimeters. 

Critical governance rules remain documented only in prose (`AGENTS.md`, `core/engineering-constitution.md`, `governance/stage-gate-rules.md`). When AI agents or human contributors modify repository files, inconsistencies slip past schema checks and unit tests.

---

## 2. Comprehensive Subsystem Audit & Matrix

The following table inventories existing validation mechanisms and identifies what is checked versus what remains unchecked:

| Subsystem / Area | Existing Validation Tool | What Is Currently Checked | What Remains Unchecked (The Governance Gap) |
| :--- | :--- | :--- | :--- |
| **Documentation & ADRs** | Manual review only | None (Markdown files are treated as raw prose). | Broken relative links between docs; references to non-existent ADRs; hallucinated stage numbers (e.g., "Stage 7"); missing mandatory template sections; deprecated command references (`playbook run` vs `playbook gate run`). |
| **JSON Schemas & State** | AJV Schema Validator (`validator.ts`) | Basic JSON property types, required fields, and regex pattern matching. | Semantic cross-file consistency; state deliverable references pointing to non-existent quality gates; duplicate check IDs across stages; state deliverables declared as `verified` without matching evidence in `evidence[]`. |
| **Governance Invariants** | Hardcoded logic in `commands/approve.ts`, `advancement.ts` | TTY check; basic agent keyword matching in interactive session; snapshot creation on Stage 6. | AI agent self-approval committed via PR or CI; CI workflows attempting state mutation; unverified deliverables advancing without gate proof; expired exception records clearing gates. |
| **Technology Stacks** | `StackManager` (`stack-manager.ts`) | Stack schema validation; acyclic dependency resolution; duplicate check ID collision on different commands. | Stack templates attempting to override Core Governance files; stack documentation contradicting `stack.json`; invalid RIF rule references; conflicting package overrides between sibling stacks. |
| **CI Workflows & Security** | `ci validate` (`commands/ci.ts`) | Syntactic YAML validation of generated GitHub Actions workflow. | Unpinned third-party actions (`actions/checkout@v4` vs commit SHA); dangerous `pull_request_target` usage; excessive runner token permissions (`permissions: write-all`); `EXPO_PUBLIC_*` secret leaks in `.env`. |
| **Mobile RIF Rules** | Programmatic Evaluator (`rif-rules.ts`) | AST evaluation of companion files, accessibility, storage, config plugins, and routes via unit tests. | **Operational disconnect**: Evaluators are NOT invoked during `playbook gate run` or CLI workflows; rule evaluations rely on direct test calls rather than integrated runtime pipelines. |

---

## 3. Detailed Category Gap Analysis

### Category A: Documentation & Reference Consistency
- **Gap A.1: Broken Internal Cross-References**: Governance documents frequently reference companion specifications (e.g., `[stage-gate-rules.md](stage-gate-rules.md)`). When files are renamed or relocated, links break silently without compiler or test failure.
- **Gap A.2: Outdated Stage Numbering & Invariants**: The Playbook strictly enforces Stages 0 through 6 (`state-machine.md`). However, documentation drafts or AI-generated plans occasionally reference "Stage 7" (post-deployment), creating cognitive confusion.
- **Gap A.3: Missing Mandatory Template Sections**: Templates under `templates/` define mandatory sections (e.g. "Security Impact", "Acceptance Criteria", "Rollback Plan"). When exit packages or ADRs omit these sections, current tooling does not catch the omission until late human review.
- **Gap A.4: Unresolvable ADR References**: Documents reference historical architecture records (e.g. `ADR-20261104-002`). There is no automated checker asserting that every referenced ADR actually exists under `docs/adr/`.

### Category B: Schema & Configuration Integrity
- **Gap B.1: Structural Conformance vs. Semantic Integrity**: JSON Schema asserts that `deliverables` is an array of objects. It cannot assert that a deliverable's `id` in `state.json` matches a declared deliverable in `current_stage_detail.stage_number` baseline.
- **Gap B.2: Quality Gate Deliverable Disconnect**: In `.playbook/quality-gates.json`, checks specify `deliverable_id`. If an author typos the ID (e.g., `CODE-IMPL` vs `CODE_IMPL`), the gate executes, but the evidence is never mapped to the state deliverable, leaving it permanently `unvalidated`.
- **Gap B.3: Schema Version Drift**: As schemas evolve across `1.0.0` to future versions, manifests or state files can declare mismatched `$schema` or `schema_version` strings that escape validation if schema caching is inconsistent.

### Category C: Governance Invariants
- **Gap C.1: Automated Verification Conflated with Human Approval**: Principle 1 states that AI agents cannot approve mandatory stage transitions. While `playbook approve` enforces a TTY check and blocks known agent keywords interactively, there is no automated linter that inspects Git commits or PR metadata to ensure approval sidecars were signed by authenticated humans.
- **Gap C.2: Remote CI Lifecycle Mutation Prevention**: ADR-20261103-002 establishes that Remote CI must never mutate project lifecycle state or write-ahead logs. Currently, this rule is documented only in policy. There is no automated linter that analyzes CI workflow definitions to ensure `playbook advance` or state-modifying flags are barred from CI execution.
- **Gap C.3: Evidence Integrity vs. Authenticity Assumption**: Principle 1 and ADR-20261102-002 establish that SHA-256 evidence matching proves file integrity, not authenticity or semantic correctness. Currently, no automated rule detects when downstream scripts improperly equate evidence presence with architectural approval.

### Category D: Technology Stack Governance
- **Gap D.1: Stack Sovereignty Weakening**: Core Governance (`core/engineering-constitution.md`) dictates that modular technology stacks can extend, but never weaken, Core Governance. Currently, nothing prevents a stack template from providing a `quality-gates.partial.json` with a permissive `max-warnings=999` or attempting to overwrite `.playbook/` core configuration files.
- **Gap D.2: Subordinate Dependency Proliferation**: Stack specifications mandate that only `stack.json` may declare dependencies (`ADR-20261104-001`). While `StackManager` checks this on load, there is no static repository linter that flags violations during routine developer edits.
- **Gap D.3: Compatibility Matrix Drift**: Stack specifications (`spec.md`) describe supported versions, while `stack.json` declares machine-readable semver constraints. Without linting, documentation prose drifts from machine-readable metadata.

### Category E: Security & Workflow Governance
- **Gap E.1: Unpinned Third-Party Actions**: GitHub Actions workflows in `.github/workflows/` often reference actions by tag (`actions/checkout@v4`) instead of immutable commit SHAs, creating supply-chain tampering vulnerability.
- **Gap E.2: Dangerous Event Triggers (`pull_request_target`)**: Workflows triggered by `pull_request_target` with checkout of fork code grant repository secret access to untrusted PRs. A linter is required to fail closed if `pull_request_target` is detected.
- **Gap E.3: Secret Leakage in Environment Configurations**: Mobile bundles compile all `EXPO_PUBLIC_*` variables into public Hermes bytecode. No linter currently inspects `.env*` files to flag sensitive variable names (e.g. `EXPO_PUBLIC_DB_PASSWORD`, `EXPO_PUBLIC_SECRET_KEY`).

---

## 4. Analysis of the Mobile RIF Operational Disconnect

A specific, high-priority finding identified during Task 007D.5.1 reconciliation is the **operational boundary between the programmatic mobile RIF evaluators and the runtime quality gate pipeline**:

1. **The Current Implementation**:
   - Programmatic AST evaluators (`evaluateRuleRnCompanion`, `evaluateRuleRnAccessibility`, `evaluateRuleMobSecStorage`, `evaluateRuleExpoPlugins`, `evaluateRuleExpoRouter`) reside in `tooling/playbook-cli/src/core/mobile/rif-rules.ts`.
   - These evaluators are verified through comprehensive unit tests (`mobile-rif-rules.test.ts`) and end-to-end integration tests (`mobile-stack-integration.test.ts`).
2. **The Disconnect**:
   - `QualityGateRunner` (`runner.ts`) only executes child processes defined in `quality-gates.partial.json` (such as `node scripts/audit-accessibility.mjs`).
   - The compiled CLI binary (`playbook`) has no native command or internal hook that executes `evaluateMobileRifRules()` during `playbook gate run`.
   - The CLI uses `rif.ts` purely as a file hashing engine (`computeRif`), not as a semantic rule evaluation runner.
3. **Architectural Implication for Governance Linters**:
   - The Governance Linter subsystem must recognize this boundary clearly.
   - The Governance Linter should provide the natural, unified static analysis framework where structural, semantic, and invariant rules—including mobile and technology-stack rules—are executed deterministically under a standardized CLI entry point (`playbook lint`).

---

## 5. Strategic Value of the Governance Linter

By closing these gaps, the Governance Linter transitions the Playbook from:
- **Heuristic compliance** (hoping AI agents read `AGENTS.md` and adhere to prose), to
- **Automated, deterministic verification** (machine-checked rules with stable diagnostic codes, automated error reporting, and CI gating).

This fulfills Constitutional Principle 3 ("Determinism Over Heuristics") and Principle 8 ("Uncompromising Quality Gates and Defect Containment").
