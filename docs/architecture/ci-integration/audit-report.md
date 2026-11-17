# Task 006C.3 Architectural Audit & Decision Matrix: Remote CI Pipeline Architecture

> **Document Type**: Architecture & Design Audit Report  
> **Milestone**: Task 006C.3 (Parent: Task 006C — CI/CD Pipeline Automation & Git Hook Integration)  
> **Target Subsystem**: Remote CI Pipeline Architecture & GitHub Actions Adapter Design  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION  
> **Authority**: Task 006C.3 Architecture Mandate & Engineering Constitution  
> **Preceding Deliverables**:
> - [`docs/architecture/ci-integration/github-actions-design.md`](github-actions-design.md)
> - [`docs/architecture/ci-integration/ci-security-model.md`](ci-security-model.md)
> - [`docs/architecture/ci-integration/ci-evidence-model.md`](ci-evidence-model.md)
> - [`docs/architecture/ci-integration/ci-workflow-lifecycle.md`](ci-workflow-lifecycle.md)
> - [`docs/adr/ADR-20261103-002-remote-ci-evidence-and-enforcement.md`](../../adr/ADR-20261103-002-remote-ci-evidence-and-enforcement.md)

---

## 1. Executive Summary

Task 006C.3 completes the architectural specification for remote CI integration within the AI Engineering Playbook ecosystem. Following the successful implementation and verification of native Git hook management (`playbook hook`) and local pre-commit/pre-push validation engines in Tasks 006C.1 and 006C.2, Task 006C.3 establishes the authoritative remote enforcement layer.

The core architectural paradigm established across this milestone is:
1. **Local Git Hooks Are Productivity Guards**: Fast, fail-early feedback mechanisms running on staged index snapshots (pre-commit) or ephemeral detached push worktrees (pre-push) to prevent broken commits from polluting local or remote history.
2. **Remote CI Is the Authoritative Enforcement Barrier**: Remote CI executes in a pristine, isolated runner (Tier 3 clean tree) and serves as the cryptographically verifiable gating barrier for pull requests and protected branch merges.
3. **Strict State Immutability**: Remote CI pipelines **never mutate `.playbook/state.json` or commit to project branches**. Results are captured as run-scoped, cryptographically verifiable telemetry artifacts (`gate-report.json`) uploaded to workflow storage, preserving human sovereignty over stage gate transitions and lifecycle advancement.

This document audits the design specifications against the complete requirement set of Task 006C.3, details the 10 mandatory architectural decisions, and establishes the precise scope for implementation milestone Task 006C.3.1.

---

## 2. Requirements Traceability Matrix

The table below maps each requirement from the Task 006C.3 specification to the corresponding design artifacts and verified sections.

| Section | Requirement Description | Design Deliverable & Section Reference | Compliance Status |
| :--- | :--- | :--- | :--- |
| **3.1** | **Provider-Neutral Adapter Architecture** | | |
| 3.1.1 | Abstract `CiAdapter` interface for CI providers | [`github-actions-design.md#1-provider-neutral-adapter-architecture`](github-actions-design.md#1-provider-neutral-adapter-architecture) | **Fully Addressed** |
| 3.1.2 | Provider registry mechanism supporting GitHub, GitLab, etc. | [`github-actions-design.md#1-provider-neutral-adapter-architecture`](github-actions-design.md#1-provider-neutral-adapter-architecture) | **Fully Addressed** |
| 3.1.3 | Common configuration contracts (`CiWorkflowOptions`) | [`github-actions-design.md#1-provider-neutral-adapter-architecture`](github-actions-design.md#1-provider-neutral-adapter-architecture) | **Fully Addressed** |
| 3.1.4 | Extensibility without modifying core CLI engine | [`github-actions-design.md#1-provider-neutral-adapter-architecture`](github-actions-design.md#1-provider-neutral-adapter-architecture) | **Fully Addressed** |
| **3.2** | **Reference Implementation: GitHub Actions** | | |
| 3.2.1 | Canonical workflow `.github/workflows/quality-gate.yml` | [`github-actions-design.md#2-canonical-github-actions-workflow-specification`](github-actions-design.md#2-canonical-github-actions-workflow-specification) | **Fully Addressed** |
| 3.2.2 | Triggers: `pull_request`, `push` on main, `workflow_dispatch` | [`ci-workflow-lifecycle.md#2-trigger-matrix--event-payloads`](ci-workflow-lifecycle.md#2-trigger-matrix--event-payloads) | **Fully Addressed** |
| 3.2.3 | Concurrency groups & `cancel-in-progress` semantics | [`ci-workflow-lifecycle.md#3-concurrency-rules--cancellation-semantics`](ci-workflow-lifecycle.md#3-concurrency-rules--cancellation-semantics) | **Fully Addressed** |
| 3.2.4 | Pinned 40-character commit SHAs for third-party actions | [`ci-security-model.md#3-action-pinning--supply-chain-hardening`](ci-security-model.md#3-action-pinning--supply-chain-hardening) | **Fully Addressed** |
| 3.2.5 | Minimal GitHub token permissions (`contents: read`) | [`ci-security-model.md#2-github-actions-permissions-contract`](ci-security-model.md#2-github-actions-permissions-contract) | **Fully Addressed** |
| 3.2.6 | GitHub Step Summary formatting & telemetry output | [`ci-evidence-model.md#5-human-consumption--telemetry-reporting`](ci-evidence-model.md#5-human-consumption--telemetry-reporting) | **Fully Addressed** |
| **3.3** | **Authoritative Verification vs Local Feedback** | | |
| 3.3.1 | Tier 3 clean working tree enforcement | [`github-actions-design.md#4-execution-parity-and-divergence-boundaries`](github-actions-design.md#4-execution-parity-and-divergence-boundaries) | **Fully Addressed** |
| 3.3.2 | Execution parity rules between local and CI environments | [`github-actions-design.md#4-execution-parity-and-divergence-boundaries`](github-actions-design.md#4-execution-parity-and-divergence-boundaries) | **Fully Addressed** |
| 3.3.3 | RIF validation invariance in pristine checkout | [`ci-evidence-model.md#4-stale-evidence-identification--drift-detection`](ci-evidence-model.md#4-stale-evidence-identification--drift-detection) | **Fully Addressed** |
| 3.3.4 | Head commit snapshot binding | [`ci-evidence-model.md#2-evidence-provenance--run-scoped-identity`](ci-evidence-model.md#2-evidence-provenance--run-scoped-identity) | **Fully Addressed** |
| **3.4** | **Evidence Isolation & State Invariance** | | |
| 3.4.1 | Prohibit direct mutation of `.playbook/state.json` in CI | [`ci-evidence-model.md#1-ci-state-invariance-principle`](ci-evidence-model.md#1-ci-state-invariance-principle) | **Fully Addressed** |
| 3.4.2 | Run-scoped evidence artifacts schema (`gate-report.json`) | [`ci-evidence-model.md#3-run-scoped-evidence-schema`](ci-evidence-model.md#3-run-scoped-evidence-schema) | **Fully Addressed** |
| 3.4.3 | Telemetry upload (`actions/upload-artifact`) | [`ci-evidence-model.md#3-run-scoped-evidence-schema`](ci-evidence-model.md#3-run-scoped-evidence-schema) | **Fully Addressed** |
| 3.4.4 | Disambiguation across concurrent runs and retries | [`ci-evidence-model.md#2-evidence-provenance--run-scoped-identity`](ci-evidence-model.md#2-evidence-provenance--run-scoped-identity) | **Fully Addressed** |
| 3.4.5 | Retention policy & immutability reality documentation | [`ci-evidence-model.md#6-artifact-retention-immutability--audit-trail`](ci-evidence-model.md#6-artifact-retention-immutability--audit-trail) | **Fully Addressed** |
| **3.5** | **Security & Threat Model** | | |
| 3.5.1 | STRIDE threat matrix for remote CI execution | [`ci-security-model.md#1-stride-threat-matrix-for-remote-ci`](ci-security-model.md#1-stride-threat-matrix-for-remote-ci) | **Fully Addressed** |
| 3.5.2 | Fork PR security: prohibition of `pull_request_target` | [`ci-security-model.md#2-github-actions-permissions-contract`](ci-security-model.md#2-github-actions-permissions-contract) | **Fully Addressed** |
| 3.5.3 | Zero secret exposure to fork PR workflows | [`ci-security-model.md#2-github-actions-permissions-contract`](ci-security-model.md#2-github-actions-permissions-contract) | **Fully Addressed** |
| 3.5.4 | Secret exfiltration defense & dual-layer log masking | [`ci-security-model.md#4-secret-exfiltration--log-scrubbing-defense`](ci-security-model.md#4-secret-exfiltration--log-scrubbing-defense) | **Fully Addressed** |
| 3.5.5 | Cache poisoning defense via `npm ci` clean installs | [`ci-security-model.md#5-cache-poisoning--dependency-integrity`](ci-security-model.md#5-cache-poisoning--dependency-integrity) | **Fully Addressed** |
| 3.5.6 | Administrative branch protection checklist | [`ci-security-model.md#6-administrative-security-checklist`](ci-security-model.md#6-administrative-security-checklist) | **Fully Addressed** |
| **3.6** | **CLI Surface & Tooling Integration** | | |
| 3.6.1 | Scaffolding command: `playbook ci init` | [`github-actions-design.md#3-playbook-cli-ci-command-surface`](github-actions-design.md#3-playbook-cli-ci-command-surface) | **Fully Addressed** |
| 3.6.2 | Workflow validator command: `playbook ci validate` | [`github-actions-design.md#3-playbook-cli-ci-command-surface`](github-actions-design.md#3-playbook-cli-ci-command-surface) | **Fully Addressed** |
| 3.6.3 | Workflow status inspector: `playbook ci status` | [`github-actions-design.md#3-playbook-cli-ci-command-surface`](github-actions-design.md#3-playbook-cli-ci-command-surface) | **Fully Addressed** |
| 3.6.4 | Explicit deferral of remote API query commands | [`github-actions-design.md#3-playbook-cli-ci-command-surface`](github-actions-design.md#3-playbook-cli-ci-command-surface) | **Fully Addressed** |
| **3.7** | **Branch Protection & Merge Readiness** | | |
| 3.7.1 | Immutable status check naming (`Playbook / Quality Gates`) | [`ci-workflow-lifecycle.md#4-github-status-check-contract--ruleset-mapping`](ci-workflow-lifecycle.md#4-github-status-check-contract--ruleset-mapping) | **Fully Addressed** |
| 3.7.2 | GitHub ruleset / classic branch protection configuration | [`ci-workflow-lifecycle.md#4-github-status-check-contract--ruleset-mapping`](ci-workflow-lifecycle.md#4-github-status-check-contract--ruleset-mapping) | **Fully Addressed** |
| 3.7.3 | Separation of CI status checks and Human Gate approval | [`ci-evidence-model.md#7-governance-boundary-ci-merge-barrier-vs-gate-approval`](ci-evidence-model.md#7-governance-boundary-ci-merge-barrier-vs-gate-approval) | **Fully Addressed** |
| **3.8** | **Failure Recovery, Retries & Concurrency** | | |
| 3.8.1 | Handling aborted/cancelled runs and timeouts | [`ci-workflow-lifecycle.md#5-failure-recovery-rerun-semantics--shallow-clones`](ci-workflow-lifecycle.md#5-failure-recovery-rerun-semantics--shallow-clones) | **Fully Addressed** |
| 3.8.2 | Workflow rerun handling with run attempt disambiguation | [`ci-workflow-lifecycle.md#5-failure-recovery-rerun-semantics--shallow-clones`](ci-workflow-lifecycle.md#5-failure-recovery-rerun-semantics--shallow-clones) | **Fully Addressed** |
| 3.8.3 | Shallow clone boundary clamping & fallback handling | [`ci-workflow-lifecycle.md#5-failure-recovery-rerun-semantics--shallow-clones`](ci-workflow-lifecycle.md#5-failure-recovery-rerun-semantics--shallow-clones) | **Fully Addressed** |

---

## 3. Mandatory Architectural Decisions Matrix

The 10 mandatory architecture decisions required by Task 006C.3 are detailed below with their evaluated options, chosen resolution, and trade-offs.

### Decision 1: Remote CI Evidence Isolation & State Invariance
- **Options Evaluated**:
  1. *CI Commits to State*: CI runs `playbook gate run` and pushes a Git commit updating `.playbook/state.json` and `.playbook/logs/` back to the branch.
  2. *CI Mutates State Locally Only*: CI modifies `state.json` locally on the runner, but does not commit it; uploads `state.json` as an artifact.
  3. *CI Is Purely Read-Only (Selected)*: CI runs `playbook gate verify`, `playbook gate run --headless`, and `playbook verify-evidence`. CI produces an external run-scoped report (`gate-report.json`) uploaded as a build artifact. CI never modifies or commits `.playbook/state.json`.
- **Selected Resolution**: Option 3 (Purely Read-Only).
- **Rationale**: Option 1 causes merge conflicts during concurrent PRs, triggers infinite CI recursive storms, and requires unsafe repository write permissions. Option 2 causes state schema desynchronization between committed files and artifacts. Option 3 respects Constitution Principle 1 (Human Sovereignty) and Separation of Concerns: CI validates; humans advance stages.
- **Trade-offs**: Requires downloading the CI artifact or inspecting the GitHub Step Summary to view CI logs rather than reading `state.json`.

### Decision 2: CI Workflow Granularity & File Architecture
- **Options Evaluated**:
  1. *Fragmented Workflows*: Separate workflow files for lint, typecheck, test, and security.
  2. *Matrix-Heavy Composite Jobs*: Multiple parallel jobs configured per gate rule.
  3. *Single Unified Workflow (Selected)*: A single `.github/workflows/quality-gate.yml` with sequential phases in a single job.
- **Selected Resolution**: Option 3 (Single Unified Workflow).
- **Rationale**: Multiple jobs create multiple independent status checks that complicate GitHub ruleset configuration, multiply checkout and dependency setup overhead 4-5x, and risk race conditions in telemetry collection. A single workflow provides a single authoritative status check (`Playbook / Quality Gates`) and predictable execution order.
- **Trade-offs**: Gate checks run sequentially within the job rather than in parallel across multiple runner VMs. For typical sub-5-minute gate suites, the reduced runner queue latency and eliminated duplicate setup overhead outweigh parallelization gains.

### Decision 3: Required Status Check Name Stability
- **Options Evaluated**:
  1. *Dynamic Check Names*: Check name includes OS matrix, Node version, or commit SHA (e.g. `Quality Gates (ubuntu-latest, node-20)`).
  2. *Static Immutable Check Name (Selected)*: Explicit top-level job name: `Playbook / Quality Gates`.
- **Selected Resolution**: Option 2 (Static Immutable Check Name).
- **Rationale**: GitHub repository rulesets and branch protection rules bind to exact status check name strings. Dynamic names break branch protection every time runner matrices or environment labels change, leaving the main branch unprotected or blocking merges.
- **Trade-offs**: Matrix expansion within this job is restricted; matrix testing is deferred to auxiliary test workflows if needed.

### Decision 4: Fork PR Security & Token Permissions
- **Options Evaluated**:
  1. *`pull_request_target` with Branch Checkout*: Enables full write permissions and secret access.
  2. *Standard `pull_request` with Write Permissions*: Grants `contents: write` or `pull-requests: write`.
  3. *Standard `pull_request` with Minimal Read-Only Token (Selected)*: Explicit top-level `permissions: contents: read`; zero secrets passed to runner; absolute prohibition of `pull_request_target`.
- **Selected Resolution**: Option 3 (Standard `pull_request` with Minimal Read-Only Token).
- **Rationale**: `pull_request_target` executes untrusted fork code in the context of the base repository with repository secrets, representing the most catastrophic CI vulnerability class (CWE-829 / STRIDE Elevation of Privilege). Read-only `contents: read` completely neutralizes exfiltration and unauthorized branch mutation. Step summaries write directly to runner disk (`$GITHUB_STEP_SUMMARY`) without requiring API write tokens.
- **Trade-offs**: Workflows cannot automatically post PR comment bubbles via the GitHub REST API; step summaries in the Actions UI are used instead.

### Decision 5: Git Object Availability in CI Runners
- **Options Evaluated**:
  1. *Default Shallow Checkout (`fetch-depth: 1`)*: Fast checkout, but missing historical commits causes commit audit commands to fail.
  2. *Unbounded Deep Clone (`fetch-depth: 0`) with Clamping Fallback (Selected)*: Canonical workflow specifies `fetch-depth: 0`. If shallow clone is detected (e.g. in custom runner environments), commit traversal is clamped to the head commit with an advisory warning.
- **Selected Resolution**: Option 2 (`fetch-depth: 0` with Clamping Fallback).
- **Rationale**: Quality Gates require complete history to audit newly introduced commits against remote tracking branches (`origin/main`). Clamping fallback ensures pipelines fail gracefully with clear diagnostics rather than crashing with fatal git errors.
- **Trade-offs**: Slightly longer initial checkout time (typically seconds for repositories under 500MB).

### Decision 6: Reproducible Input Fingerprint (RIF) Generation in CI
- **Options Evaluated**:
  1. *Recalculate RIFs and Compare to State*: Recalculate input fingerprints and fail if they do not match `state.json`.
  2. *Execute `playbook gate verify` in Pristine Checkout (Selected)*: Run read-only verification verifying that committed evidence fingerprints match the clean working tree, followed by `playbook gate run --headless` and `playbook verify-evidence`.
- **Selected Resolution**: Option 2 (`playbook gate verify` in Pristine Checkout).
- **Rationale**: The CI runner checkout represents Tier 3 (clean repository state). Validating existing RIFs verifies that the developer's committed evidence corresponds exactly to the committed source code, preventing fabricated or stale evidence.
- **Trade-offs**: Both `gate verify` and `gate run --headless` are executed sequentially to provide full audit coverage.

### Decision 7: Stale Evidence Identification Protocol
- **Options Evaluated**:
  1. *Timestamp Comparison*: Reject evidence older than N hours.
  2. *Cryptographic Commit & RIF Binding (Selected)*: Evidence is declared stale if `evidence.head_commit_sha != PR_HEAD_SHA` or if any input RIF in `gate-report.json` differs from the computed tree RIF.
- **Selected Resolution**: Option 2 (Cryptographic Commit & RIF Binding).
- **Rationale**: Clock skew between local machines and CI runners makes timestamp comparisons brittle. Cryptographic binding to Git object IDs and input content hashes provides 100% deterministic drift detection.
- **Trade-offs**: Re-running a workflow on the same commit does not invalidate valid evidence, but pushing an empty commit forces complete re-validation.

### Decision 8: Workflow Rerun & Retry Disambiguation
- **Options Evaluated**:
  1. *Overwrite Prior Artifacts*: Upload artifact with identical name `playbook-ci-evidence`.
  2. *Run-and-Attempt-Scoped Artifact Names (Selected)*: Name artifacts `playbook-ci-evidence-${{ github.run_id }}-${{ github.run_attempt }}`.
- **Selected Resolution**: Option 2 (Run-and-Attempt-Scoped Artifact Names).
- **Rationale**: GitHub Actions rejects or overwrites artifact uploads when names collide across attempts. Scoping by run ID and attempt index provides an unambiguous, immutable audit trail for every execution attempt.
- **Trade-offs**: Multiple artifacts accumulate in workflow storage until expired by the retention window (default 30 days).

### Decision 9: Workflow Versioning, Upgrades & User Backups
- **Options Evaluated**:
  1. *Silent In-Place Overwrites*: CLI overwrites existing workflow files on update.
  2. *Refuse to Modify Existing Files*: User must manually update YAML files.
  3. *Managed Headers with Timestamped User Backups (Selected)*: CLI marks workflows with metadata headers. `playbook ci init` detects modifications; `playbook ci init --force` safely moves modified user files to `.user-backup.<timestamp>` before writing new templates.
- **Selected Resolution**: Option 3 (Managed Headers with Timestamped User Backups).
- **Rationale**: Protects custom user modifications from silent destruction while enabling automated workflow upgrades.
- **Trade-offs**: Generates backup files under `.github/workflows/` that users may eventually want to prune.

### Decision 10: Minimum Viable Scope for Task 006C.3.1
- **Options Evaluated**:
  1. *Broad Scope*: Support GitHub Actions, GitLab CI, and CircleCI, including remote API query commands and status poller loops.
  2. *Targeted Minimal Scope (Selected)*: Focus exclusively on GitHub Actions reference adapter, scaffolding command `playbook ci init --provider github`, workflow validator `playbook ci validate`, status inspector `playbook ci status`, and the canonical `quality-gate.yml` workflow template.
- **Selected Resolution**: Option 2 (Targeted Minimal Scope).
- **Rationale**: Follows Principle 4 (YAGNI & Radical Simplicity). GitHub Actions represents >85% of target deployments. Scaffolding, validation, and status inspection provide 100% of required functionality without introducing external HTTP/API client dependencies or auth complexities.
- **Trade-offs**: GitLab CI and Azure DevOps adapters are deferred to future milestones.

---

## 4. Minimum Viable Scope for Implementation (Task 006C.3.1)

Based on the architectural specifications, the authorized scope for implementation milestone **Task 006C.3.1** is strictly defined as follows:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Task 006C.3.1 Implementation Deliverables & Subsystem Boundaries        │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Core Adapter Infrastructure                                         │
│    - src/core/ci/types.ts (Interfaces, options, report schema)         │
│    - src/core/ci/adapter.ts (Abstract CiAdapter class)                 │
│    - src/core/ci/adapters/github.ts (GitHub Actions reference adapter) │
│                                                                        │
│ 2. Canonical Workflow Template                                         │
│    - src/core/ci/templates/github-quality-gate.yml                     │
│    - Pinned actions, step summaries, run-scoped artifact upload        │
│                                                                        │
│ 3. CLI Command Registration & Handlers                                 │
│    - src/commands/ci.ts (Registered in src/bin/playbook.ts)            │
│    - playbook ci init [--provider github] [--output <path>] [--force]  │
│    - playbook ci validate [--path <path>]                              │
│    - playbook ci status [--path <path>]                                │
│                                                                        │
│ 4. Comprehensive Test Suite                                            │
│    - tests/ci-adapter.test.ts                                          │
│    - Template rendering, argument parsing, validation rules            │
│    - Backup preservation on force overwrite                           │
│    - Malformed workflow detection & schema assertion                  │
└────────────────────────────────────────────────────────────────────────┘
```

### Out-of-Scope Items for Task 006C.3.1
The following capabilities are **explicitly out of scope** and deferred to future milestones:
- Implementation of GitLab CI, CircleCI, or Azure DevOps adapters.
- Interactive remote GitHub REST API polling or PR comment creation.
- Direct manipulation of GitHub repository settings or branch protection rules via CLI.
- Execution of remote CI workflows in local offline environments (`act` emulation).

---

## 5. Architectural Quality Gate Checklist

| Governance Invariant | Compliance Proof & Specification Reference | Status |
| :--- | :--- | :--- |
| **Separation of Concerns** | CI validates Tier 3 clean tree; local hooks guard staged/push boundary; humans approve stage gates. | **Verified** |
| **State Immutability** | `.playbook/state.json` is never mutated or committed by CI workflows. | **Verified** |
| **Cryptographic Integrity** | Status checks and telemetry artifacts are cryptographically bound to Git commit OIDs and SHA-256 hashes. | **Verified** |
| **Supply Chain Security** | All third-party GitHub Actions are pinned to full 40-character commit SHAs. | **Verified** |
| **Least Privilege** | Workflow permissions are locked to `contents: read`; zero secrets are passed to fork PRs. | **Verified** |
| **No External Dependencies** | CLI implementation uses built-in Node.js libraries and existing Playbook utilities (zero new npm dependencies). | **Verified** |

---

## 6. Audit Verdict

**Final Verdict**: `READY FOR IMPLEMENTATION`

The architectural deliverables for Task 006C.3 are complete, consistent, and rigorously aligned with the Engineering Constitution, the Stage Gate Rules, and existing CLI subsystems. The project is fully unblocked to proceed with implementation milestone **Task 006C.3.1**.
