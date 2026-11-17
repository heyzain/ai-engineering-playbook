# Phase 1 — Scope and baseline inventory

Date: 2026-11-17. Baseline: `bc5c4d3ce463f323f3649da038e98cc5ee2c8c1e`. Both local HEAD and local `origin/main` reference this checkpoint; no remote fetch was performed. Working tree was clean at Phase 1 entry. All earlier changes are preserved in that commit.

## Inventory and disposition

| Area | Files | Observed baseline | Completion disposition |
| --- | --- | --- | --- |
| Engineering methodology | README, AGENTS, core, governance, templates | Existing principles, stages, state machine, storage rules | Retain; reconcile stale claims during completion |
| Governance state | `.playbook/manifest.json`, `state.json` | Schema-valid Stage 0, not started, empty history | Start and submit through existing core APIs; no fabricated history |
| Lifecycle tooling | `src/commands`, `src/core/transaction` | Init, inspect, validation, approval, advance, reopen, pivot | Verify against release requirements |
| Operational controller | `src/core/controller` | Stage/deliverable APIs and AST validators exist | CLI integration and exception safety remain unfinished |
| Quality gates | `src/core/quality-gates`, schemas | Configuration, fingerprints, runner, verifier, recovery | Retain; verify failure and transaction behavior |
| Hooks and CI | `src/core/hooks`, `src/core/ci` | Snapshot engines, workflow assets, evidence machinery | Retain; installed and remote behavior require evidence |
| Stack modules | `stacks/nextjs`, `react-native`, `expo` | Specifications, templates, partial gates | Retain; define exact support/test claims in Stage 1 |
| Linters | `src/core/linters` | Documentation, schema, governance, stack, security rules | Retain; verify enforcement statements |
| Test source | `tooling/playbook-cli/tests` | 48 TypeScript test files | Fresh full suite remains outstanding |
| Previous review | `baseline-checkpoint-20261117.md` and referenced logs | Build and 17 limited tests passed; full suite blocked by `spawn EPERM` | Preserve as historical evidence, not fresh release acceptance |
| Architecture records | `docs/adr`, `docs/architecture` | Historical designs/audits; two-phase exception amendment proposed | Reconcile authority/status before implementation |

## Decision boundaries

ADR-20261110-001 still requires formal human ratification. Deliverable invalidation remains fenced unless explicitly authorized. No new production features, schema changes, dependency changes, or exception authorizations are part of Phase 1.

## Bootstrap route

The missing command router does not require a manual JSON workaround. Invoke the existing compiled `startStage`, `recordDeliverable`, `recordEvidence`, and `submitStage` core APIs with `targetDir` set explicitly to this repository, `actor: agent:codex`, and `actorType: agent`. They use the existing schema checks, locking, and write-ahead transaction manager. This route exercises current functionality without implementing a new CLI or crossing a human-only boundary.

Record only baseline `PRD-CORE` in the stage ledger. Inventory and validation logs support it rather than adding custom deliverables without declarative verification disciplines. Hash evidence through `recordEvidence`; validate the exit package strictly and run `verify-evidence`. Preserve approval as pending. The standard-profile baseline resolver imposes no additional required disciplines for document stages; document review must still be performed and recorded, and this limitation is not equivalent to automated semantic validation.

For approval, the human operator uses `playbook approve --gate 0` in an interactive terminal. No agent supplies a human identity or types confirmation on the operator's behalf. Advance only after genuine approval and a Phase 1 commit. The environment previously denied Git index writes; if still denied, report the exact blocker and leave files intact for the operator to commit.

## Review package

[PRD core](../prd/PRD-CORE.md) defines scope, users, non-goals, success measures, Stage 0 criteria, and Stage 1 proposals. [Gate 0 package](../gates/GATE-0-EXIT-PACKAGE.md) records evidence and the human decision boundary. Scope choices such as the pilot/runtime matrix are proposed for review, not invented implementation requirements.
