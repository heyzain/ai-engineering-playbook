# CI/CD Pipeline Automation & Git Hook Integration Architecture

> **Architecture Module**: Task 006 (CI/CD Pipeline Automation & Git Hook Integration)  
> **Status**: Accepted Architectural Specification (Task 006B)  
> **Applicable Subsystems**: Local Git Lifecycle Hooks, Pre-commit/Pre-push Execution, CI Workflow Adapters, Status Check Governance  
> **Authoritative ADR**: [`docs/adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md`](../../adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md)

---

## 1. Overview & Vision

The **CI/CD Pipeline Automation & Git Hook Integration** architecture operationalizes the third tier of the AI Engineering Playbook's enforcement spectrum: **Automated Tool Validation**.

While Task 005B delivered the core local execution and verification engine (`playbook gate run`, `playbook gate verify`, `playbook verify-evidence`), Task 006 bridges these capabilities to:
1. **The Local Git Lifecycle Boundary**: Native Git client hooks (`pre-commit`, `pre-push`) that validate staged index content, prevent unverified code from being committed, and block broken refs before leaving the workstation.
2. **The Remote CI/CD Enforcement Boundary**: Turnkey, least-privilege GitHub Actions workflows that execute headless quality gates in pristine container checkouts, verify cryptographic evidence, and act as authoritative pull request merge barriers.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ The Quality Enforcement Pipeline                                                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   1. Local Dev:   playbook gate run (Iterative, dirty working-tree allowed)            │
│          ▼                                                                             │
│   2. Git Commit:  pre-commit hook (Shadow index extraction, schema sanity)             │
│          ▼                                                                             │
│   3. Git Push:    pre-push hook (Pushed ref-range evaluation, stage-gate readiness)    │
│          ▼                                                                             │
│   4. Remote CI:   GitHub Actions workflow (Clean checkout, Tier 3 headless run)       │
│          ▼                                                                             │
│   5. Merge Gate:  Protected branch status check blocks PR merge on gate failure        │
│          ▼                                                                             │
│   6. Handover:    playbook approve --gate <N> (Mandatory human sovereign sign-off)     │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Document Manifest

| Document | Purpose | Target Audience |
| :--- | :--- | :--- |
| [**gap-analysis.md**](gap-analysis.md) | Comprehensive audit of existing capabilities vs missing Git and CI lifecycle requirements (GAPs 10–17). | Architects, Engineers, Tooling Authors |
| [**design.md**](design.md) | Baseline architectural specification for `playbook hook` and `playbook ci init`, snapshot semantics, and CI evidence models. | Engineers, CI Authors, AI Agents |
| [**threat-model.md**](threat-model.md) | Baseline STRIDE-based security analysis, hook bypass reality, fork PR protection, and secret leakage boundaries. | Security Engineers, Systems Architects |
| [**github-actions-design.md**](github-actions-design.md) | Detailed provider-neutral adapter architecture, canonical `quality-gate.yml` workflow, CLI commands, and execution parity rules. | CI Engineers, CLI Implementers |
| [**ci-security-model.md**](ci-security-model.md) | Comprehensive remote CI STRIDE threat model, fork PR security contract, action SHA pinning, and log masking defenses. | Security Architects, DevOps |
| [**ci-evidence-model.md**](ci-evidence-model.md) | Run-scoped evidence artifact schema (`gate-report.json`), state invariance, drift detection, and telemetry reporting. | Governance Leads, Tooling Authors |
| [**ci-workflow-lifecycle.md**](ci-workflow-lifecycle.md) | End-to-end CI lifecycle flowchart, event triggers, concurrency rules, status check naming, and failure recovery. | DevOps, Release Engineers |
| [**audit-report.md**](audit-report.md) | Task 006C.3 compliance matrix against all requirements, 10 mandatory architecture decisions, and implementation scope. | Systems Architects, Governance Leads |
| [**ADR-20261103-001**](../../adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md) | Architectural Decision Record for native hooks, shadow staging, and read-only CI. | Humans & AI Agents |
| [**ADR-20261103-002**](../../adr/ADR-20261103-002-remote-ci-evidence-and-enforcement.md) | Architectural Decision Record for remote CI evidence isolation, provider adapters, and status check enforcement. | Humans & AI Agents |

---

## 3. Core Architectural Invariants

Every component implementing this architecture must strictly adhere to seven non-negotiable invariants:

1. **Zero Third-Party Hook Dependencies**:
   - Hooks must be pure, native POSIX shell scripts (`#!/bin/sh`) executed by Git's built-in shell.
   - Strictly avoid mandatory wrapping of Husky, Lefthook, or other external npm packages.
2. **Preservation of Existing Hook Semantics (Crash-Safe Delegation Wrapper)**:
   - Existing unmanaged hooks are preserved byte-for-byte in `<hook>.playbook-orig` via a crash-safe 3-phase atomic rename protocol.
   - The primary wrapper executes Playbook validation first. On Playbook failure, the push/commit aborts immediately; the original hook does not execute. On success, it chains to the original user hook with preserved arguments (`"$@"`) and buffered standard input (`chmod 0600`).
   - The `--force` flag **never silently destroys unmanaged content**; conflicting files are archived to `.user-backup.<timestamp>`.
   - Uninstall restores the original hook file byte-for-byte.
3. **Index-Accurate Pre-Commit Snapshotting & Mode-Aware Symlinks**:
   - Direct physical paths expose working-tree content, not index content.
   - Content-reading checks (TypeScript build, linters, tests, schemas) **must only consume staged content** extracted into ephemeral shadow sandboxes (`.playbook/.tmp/staged-<nonce>/` via `git checkout-index`). Direct paths are permitted solely for path-metadata checks.
   - **Mode-Aware Symlink Integrity**: On Windows environments lacking true symlink privileges, content-reading checks fail closed (`UNSUPPORTED_PLATFORM_CAPABILITY`). The engine **never** silently substitutes plain text pointer files, which distort ASTs and module resolution.
   - The hook **NEVER** mutates the user's working tree or index, and **NEVER** runs destructive `git stash`.
4. **Targeting Pushed Git Objects & Exact Range Semantics**:
   - Pre-push validation **never evaluates the local working tree**.
   - Exact commit selection evaluates `<remote_oid>..<local_oid>` or `git rev-list <local_oid> --not --remotes=<remote_name>`. The engine never uses generic `--not --remotes` as an unverified proxy.
   - When remote tracking refs are absent, the engine applies the **Fallback Boundary Rule**, evaluating the final pushed tree `<local_oid>^{tree}` without crawling unbounded history.
   - **Granularity Split**: Heavy Quality Gates run **strictly once per unique final pushed tree** (`<local_oid>^{tree}`). Commit audits inspect each unique commit in the push range.
5. **Temporary Worktree Recovery & Namespace Isolation**:
   - Detached worktrees are restricted to `.playbook/.tmp/worktrees/push-<oid>-<nonce>/`.
   - Every worktree contains `.playbook-worktree.json` recording `owner_pid` and `created_at`.
   - In-process signal traps (`EXIT`, `SIGINT`, `SIGTERM`, `SIGHUP`) remove worktrees cleanly.
   - Stale worktrees with dead owner PIDs or exceeding 30 minutes are garbage-collected automatically. Unowned and user worktrees are strictly never touched.
6. **No State Mutation & Run-Scoped Evidence in CI**:
   - Remote CI pipelines execute in **read-only / evaluation mode** with least-privilege `contents: read` permissions.
   - CI **NEVER** modifies or commits back to `.playbook/state.json`.
   - CI generates **run-scoped, hash-verifiable evidence artifacts** (`playbook-ci-evidence-<run_id>`) and reports status check results to GitHub. Retention and expiration limits are explicitly documented.
7. **Separation of Powers & Human Sovereignty**:
   - Neither Git hooks nor CI workflows possess authority to grant stage approval (`stage_status: "approved"`) or advance lifecycle stages.
   - Local hooks are bypassable productivity guards; remote CI status checks are the authoritative merge barrier; human engineers retain sovereign approval authority.

---

## 4. CLI Command Reference (Tasks 006C.1, 006C.2 & 006C.3)

```bash
# 1. Native Git Hook Management (Implemented & Verified in Tasks 006C.1 & 006C.2)
playbook hook install          # Install managed pre-commit and pre-push hooks
playbook hook uninstall        # Safely restore original hooks byte-for-byte
playbook hook status           # Inspect hook installation and wrapper integrity
playbook hook run <type>       # Internal execution dispatcher for Git hooks

# 2. CI Workflow Scaffolding & Validation (Designed in Task 006C.3; Impl 006C.3.1)
playbook ci init               # Generate canonical GitHub Actions quality-gate workflow
playbook ci init --provider github [--output <path>] [--force] [--dry-run]
playbook ci validate           # Statically assert workflow permissions, SHA pinning, and syntax
playbook ci status             # Inspect configured CI workflows and status check mappings
```
