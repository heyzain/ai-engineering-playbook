# CI/CD Pipeline Automation & Git Hook Integration: Gap Analysis

> **Specification Version**: 1.0.0  
> **Status**: Accepted Architectural Specification (Task 006B)  
> **Target Scope**: Local Git Hooks, Pre-commit/Pre-push Lifecycle, CI/CD Pipeline Integration, Branch Protection Boundaries  
> **Preceding ADRs**:
> - [`docs/adr/ADR-20261031-001-state-model-refinements.md`](../../adr/ADR-20261031-001-state-model-refinements.md)
> - [`docs/adr/ADR-20261102-002-quality-gate-atomicity-and-concurrency.md`](../../adr/ADR-20261102-002-quality-gate-atomicity-and-concurrency.md)
> - [`docs/adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md`](../../adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md)  
> **Preceding Governance**:
> - [`core/engineering-constitution.md`](../../../core/engineering-constitution.md)
> - [`governance/ENGINEERING_CONTROLLER.md`](../../../governance/ENGINEERING_CONTROLLER.md)
> - [`governance/stage-gate-rules.md`](../../../governance/stage-gate-rules.md)
> - [`governance/state-machine.md`](../../../governance/state-machine.md)
> - [`docs/architecture/quality-gates/design.md`](../quality-gates/design.md)
> - [`docs/architecture/quality-gates/implementation-audit.md`](../quality-gates/implementation-audit.md)

---

## 1. Executive Summary & Context

Task 005B delivered the foundational Quality Gate execution and verification engine (`@ai-engineering-playbook/cli`):
- Topological DAG dependency scheduler (`src/core/quality-gates/dag.ts`).
- Reproducible Input Fingerprint (RIF) engine with CRLF/LF normalization and safe secret hashing (`src/core/quality-gates/rif.ts`).
- Unlocked process execution harness with staged streaming and log middle-truncation (`src/core/quality-gates/runner.ts`).
- Multi-file atomic Write-Ahead Logging integration committing canonical logs and state updates together (`src/core/transaction/transaction-manager.ts`).
- Read-only verification engine (`src/core/quality-gates/verifier.ts` and `src/core/evidence/verifier.ts`).
- Controlled operator-attested recovery from blocked halts (`src/core/quality-gates/recovery.ts`).

However, **these capabilities currently exist purely as manual CLI commands** (`playbook gate run`, `playbook gate verify`, `playbook verify-evidence`). 

In real-world engineering workflows involving human developers and autonomous AI agents:
1. **Manual Invocations Are Frequently Skipped**: Developers and AI agents forget or bypass running quality checks before committing or pushing code.
2. **The Git Boundary Is Unprotected**: Broken code, unformatted files, and unvalidated schemas enter the local commit history.
3. **The Remote Repository Is Vulnerable**: Pull requests can be merged into protected branches with failing checks, missing exit packages, or stale evidence because remote CI systems lack authoritative, automated Playbook validation gates.
4. **Local Execution Contexts Differ From Staged Content**: Standard local CLI checks evaluate the current *working tree*, whereas Git commits record the *staged index*, creating the "it passed on my machine but failed in Git" paradox.

This gap analysis systematically audits the missing capabilities, risks, and architectural requirements needed to connect the Task 005B engine to Git lifecycle hooks and remote CI/CD automation pipelines.

---

## 2. Capability Audit: Existing Ground Truth vs. Required Lifecycle State

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ The Enforcement Spectrum & Integration Boundaries                                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   DEVELOPER WORKSPACE (Local Boundary) — IMPLEMENTED & VERIFIED (Tasks 006C.1 & 006C.2)│
│   ┌──────────────────────────────────────────────────────────────────────────────┐     │
│   │ [x] Manual Gate Execution       │ playbook gate run                          │     │
│   │ [x] Read-Only Gate Verification │ playbook gate verify                       │     │
│   │ [x] Evidence File Verification  │ playbook verify-evidence                   │     │
│   │ [x] Blocked Stage Recovery      │ playbook gate recover                      │     │
│   │ [x] Automated Pre-Commit Hook   │ IMPLEMENTED: Shadow index sandbox (006C.2) │     │
│   │ [x] Automated Pre-Push Hook     │ IMPLEMENTED: Ephemeral detached worktree   │     │
│   │ [x] Native Hook Manager         │ IMPLEMENTED: Wrapper delegation (006C.1)   │     │
│   └──────────────────────────────────────────────────────────────────────────────┘     │
│                                           │                                            │
│                                           ▼ git push                                   │
│   REMOTE CI/CD PIPELINE (Authoritative Boundary) — DESIGNED (Task 006C.3; Impl 006C.3.1│
│   ┌──────────────────────────────────────────────────────────────────────────────┐     │
│   │ [ ] Automated PR Quality Gate   │ DESIGNED: GitHub Actions quality-gate.yml  │     │
│   │ [ ] Tier 3 Clean Tree Check     │ DESIGNED: Automated CI runner adapter      │     │
│   │ [ ] Remote Status Check Barrier │ DESIGNED: Stable check name ruleset        │     │
│   │ [ ] CI Evidence Isolation       │ DESIGNED: Run-scoped artifact model        │     │
│   │ [ ] Fork PR Security Policy     │ DESIGNED: contents: read, zero secrets     │     │
│   │ [ ] Scaffolding CLI Subsystem   │ DESIGNED: playbook ci init / validate / stat│    │
│   └──────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Gap Analysis by Architectural Domain

### 3.1 Domain 1: Local Git Hook Management (`playbook hook`)

#### GAP-10: Absence of Native Git Hook Management
- **Current State**: The Playbook CLI has commands for `init`, `validate`, `inspect`, `gate`, `approve`, `advance`, `reopen`, and `pivot`. There are no commands to install, inspect, or remove Git hooks.
- **Problem**: Setting up hooks currently requires manual shell scripting or adopting third-party npm packages (e.g. Husky, Lefthook, simple-git-hooks). This introduces external dependencies, violating **Principle 4 (Radical Simplicity & YAGNI)**, and creates friction for non-Node ecosystems (Python, Go, Rust).
- **Required Capability**:
  - `playbook hook install`: Turnkey installation of native shell hooks (`pre-commit`, `pre-push`).
  - `playbook hook uninstall`: Clean removal of Playbook-managed hook logic.
  - `playbook hook status`: Diagnostic inspection of hook installation status and integrity.
- **Architectural Requirement**: Hooks must be implemented as **zero-dependency, native POSIX shell scripts** compatible with Windows (Git Bash / MinGW), macOS, and Linux.

---

### 3.2 Domain 2: Pre-Commit Snapshot & Index Semantics

#### GAP-11: Working Tree vs. Staged Index Validation Mismatch
- **Current State**: `playbook gate run` inspects files located physically on the filesystem working tree.
- **Problem**: In Git, `git commit` commits the **staging area (the index)**, not the working tree. A developer frequently stages a subset of changes (`git add -p` or selective files) while leaving unstaged edits in the working tree.
  - *False Positive Risk*: Working tree has code that fixes a test, but the fix is not staged. The pre-commit hook runs against the working tree, tests pass, but the committed code is broken.
  - *False Negative Risk*: Working tree has incomplete experimental edits. Staged code is pristine. The pre-commit hook fails because of unstaged edits.
  - *Physical Path Risk*: Direct filesystem paths in `process.cwd()` unconditionally expose working-tree content, not staged index content.
- **Evaluated Solutions & Rejections**:
  - *Rejection of `git stash --keep-index`*: Commonly used by tools like `lint-staged`. If the process is terminated (SIGINT/SIGTERM, crash, timeout), the stash pop fails, causing merge conflicts or leaving the working tree in a dirty stashed state. This violates **Principle 3 (Determinism)** and risks data loss.
  - *Rejection of Modifying User Index*: Tools must **never** run `git add` behind the user's back (e.g. auto-formatting and re-staging). This silently commits code the user has not reviewed, violating **Principle 1 (Human Sovereignty)**.
- **Required Architecture (Tier 2 Snapshot)**:
  - For `pre-commit`, checks are strictly bifurcated:
    1. **Path-Metadata Checks**: May consume staged path lists directly for metadata validation (naming, forbidden path patterns) without reading working-tree bytes.
    2. **Content-Reading Checks**: Linters, compilers, syntax validators, and tests **must only consume staged content**. Physical files are extracted from the index into an ephemeral shadow sandbox (`.playbook/.tmp/staged-<nonce>/` via `git checkout-index`) protected by signal cleanup traps.
  - If `.playbook/manifest.json` or `.playbook/state.json` are staged, their schema validity is strictly asserted from index memory (`git show :path`).
  - **Mode-Aware Symlink Handling (Mode `120000`)**: The engine probes for true symlink capability (`fs.symlinkSync`). On Windows without symlink privileges, content-reading checks fail closed (`UNSUPPORTED_PLATFORM_CAPABILITY`) rather than silently evaluating plain text pointer files, which distort ASTs and module resolution. Path-metadata checks validate mode `120000` directly from the index.
  - Staged deletions (`D`), renames (`R`), submodules (`160000`), and filenames with whitespace/newlines (`-z` plumbing) are deterministically handled.
  - The user's active working tree and index remain completely untouched.

---

### 3.3 Domain 3: Pre-Push Ref-Range & Protocol Semantics

#### GAP-12: Disconnect Between Working Tree and Pushed Commit Range
- **Current State**: No pre-push validation capability exists.
- **Problem**: When a developer executes `git push`, Git invokes `.git/hooks/pre-push` and passes pushed reference specifications via standard input:
  ```
  <local_ref> <local_oid> <remote_ref> <remote_oid>
  ```
  Evaluating the *current working tree* during `pre-push` is fundamentally invalid:
  - The developer may be pushing an older branch or a specific commit while the working tree is on another branch.
  - The working tree may contain uncommitted dirty changes while pushing a clean commit.
  - Multiple refs may be pushed in a single command (`git push --all`).
  - Branch deletion commands (`git push origin --delete branch`) pass a null OID.
  - In modern repositories with SHA-256 object format, zero-OIDs are 64 hex characters, not 40.
  - Generic `--not --remotes` checks all remotes rather than the specific destination remote (`$1`), or crawls unbounded history if remote tracking branches are missing.
- **Required Architecture**:
  - The pre-push hook must **never evaluate the local working tree**.
  - It parses the standard pre-push stdin stream line-by-line and dynamically queries repository object format (`git rev-parse --show-object-format`) to correctly match SHA-1 (40 hex chars) or SHA-256 (64 hex chars) zero-OIDs.
  - Deleted refs (`local_oid == ZERO_OID`) are skipped immediately.
  - Normal fast-forward and force pushes evaluate the exact range: `git rev-list ^<remote_oid> <local_oid>`.
  - New branch pushes query `git rev-list <local_oid> --not --remotes="$1"`.
  - **Fallback Boundary Rule**: If tracking branches for the target remote are missing/stale, traversal strictly avoids crawling back to root. Quality Gates evaluate the **final pushed tree** `<local_oid>^{tree}`.
  - **Shallow Repositories**: Clamps range traversal at shallow boundary points and evaluates the final pushed tree `<local_oid>`.
  - **Granularity Split**: Heavy Quality Gates run **strictly once per unique final pushed tree** (`<local_oid>^{tree}`). Commit audits inspect each unique commit in the push range.
  - Tag pushes peel annotations to commit objects (`<local_oid>^{commit}`).
  - Pushed commits are deduplicated across refs.
  - Target commit trees are validated inside **ephemeral detached worktrees** (`git worktree add --detach .playbook/.tmp/worktrees/push-<oid>-<nonce> <oid>`) and safely pruned upon exit.

---

### 3.4 Domain 4: Hook Ownership, Coexistence & Tampering

#### GAP-13: Overwrite and Coexistence with Existing Hooks
- **Current State**: Overwriting existing files during CLI operations (`init`, `scaffold`) is protected by `--force`, but hook installation has no defined coexistence protocol.
- **Problem**: Downstream repositories may already have custom hooks (e.g., enterprise commit linters, internal compliance checkers, or Husky configurations).
  - Simply appending a managed block fails if an existing hook has an early `exit 0` or `exit 1`.
  - Prepending without proper separation can break existing environment variables or standard input pipelines.
  - In `pre-push`, hooks consume standard input; if one tool consumes stdin, subsequent tools receive EOF.
  - If a process crash occurs during hook replacement, unmanaged hooks could be lost or corrupted.
- **Required Architecture**:
  - **Delegation Wrapper Strategy**:
    - Unmanaged existing hooks are safely renamed to `<hook>.playbook-orig` (preserving original bytes and execution mode).
    - A primary wrapper script is installed that executes the Playbook hook first.
    - If Playbook checks fail, execution aborts with the failing exit code; the original hook does not run.
    - If Playbook checks pass, the wrapper seamlessly `exec`s the original `<hook>.playbook-orig` script with original arguments (`"$@"`) and preserved standard input.
  - **Crash-Safe Ordering (Phase 1–3)**: Staging file written $\rightarrow$ backup committed via atomic rename $\rightarrow$ primary wrapper committed via atomic rename. Interrupted runs detect identical SHA-256 backup and complete safely.
  - **Non-Destructive `--force`**: Conflicting unmanaged hooks are moved to `.user-backup.<timestamp>`, never overwritten or deleted silently.
  - **Standard Input Buffering**: `pre-push` stdin is buffered to a temporary file (`chmod 0600`) and piped to both Playbook and the original hook.
  - **Ownership Markers & Parsing**: Managed wrappers are delimited by `# >>> AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT) >>>` and `# <<< ... <<<`. Malformed markers halt with `CORRUPT_HOOK_STATE` unless `--force` is passed.
  - **Byte-for-Byte Restoration**: `playbook hook uninstall` renames `<hook>.playbook-orig` back to `<hook>`, restoring the user's prior file byte-for-byte. If no prior hook existed, the wrapper is cleanly unlinked.

#### GAP-14: Git Worktree Resolution & Temporary Worktree Recovery
- **Current State**: Tooling assumes `.git/` is a directory in `process.cwd()` and lacks temporary worktree lifecycle management.
- **Problem**:
  - In **linked Git worktrees** (`git worktree add`), `.git` is a text file containing `gitdir: /path/to/main/.git/worktrees/<name>`. Standard hooks reside in the common parent repository (`/path/to/main/.git/hooks`), not the worktree.
  - Repositories configuring `core.hooksPath` (e.g. `git config core.hooksPath .githooks`) store hooks in a custom directory.
  - Ephemeral detached worktrees provisioned for pre-push evaluation risk accumulating if crashed, or pruning user worktrees if cleaned up via unrestrained wildcards.
- **Required Architecture**:
  - Hook path resolution invokes `git rev-parse --git-path hooks` via subprocess, correctly resolving physical paths across standard repos, worktrees, and custom configurations.
  - Ephemeral worktrees are isolated under `.playbook/.tmp/worktrees/push-<oid>-<nonce>/`.
  - Every ephemeral worktree writes `.playbook-worktree.json` containing `owner_pid` and `created_at`.
  - Garbage collection prunes worktrees whose `owner_pid` is dead or older than 30 minutes, and strictly never touches unowned or user worktrees.

---

### 3.5 Domain 5: Remote CI/CD Automation & Status Check Barriers

#### GAP-15: Absence of Turnkey CI/CD Workflow Generation (`playbook ci init`)
- **Current State**: No CI workflow files or GitHub Actions definitions exist in the repository. Downstream projects must manually write GitHub Actions YAML files.
- **Problem**: Without standardized, turnkey CI workflows, downstream teams configure ad-hoc, brittle CI pipelines that fail to enforce the Three-Tier Working Tree Policy or fail to capture cryptographic evidence correctly.
- **Required Architecture**:
  - `playbook ci init`: Generates standard, minimal, production-ready CI workflows (initially targeting **GitHub Actions** as the primary enterprise standard).
  - Flags: `--provider github` (default), `--output .github/workflows/quality-gate.yml`, `--force`.

#### GAP-16: CI State Mutation & Concurrency Collisions
- **Current State**: Locally, `playbook gate run` commits changes to `.playbook/state.json` via Write-Ahead Logging (`WriteAheadTransactionManager`).
- **Problem**: If remote CI pipelines attempt to run `playbook gate run` and commit the updated `state.json` back to the Git branch:
  1. **Merge Conflicts**: Multiple concurrent PR runs or rapid developer pushes produce Git push rejections and merge conflicts on `state.json`.
  2. **Security Escalation**: CI would require write/push permissions to repository branches, exposing branches to compromise from malicious PR code.
  3. **CI Infinite Loops**: A CI commit triggers another CI run, creating recursive pipeline storms.
  4. **Violation of Separation of Powers**: CI is an independent *evaluator*, not a state author or human approver.
- **Required Architecture (No State Mutation in CI)**:
  - Remote CI runs in **read-only / verification mode**:
    - Executes `playbook gate verify` (verifying RIF freshness of committed evidence).
    - Executes `playbook gate run --headless` (evaluating checks in a clean, isolated environment).
    - Executes `playbook verify-evidence` (verifying SHA-256 byte hashes).
  - **CI NEVER commits to `.playbook/state.json`.**
  - CI captures results in **run-scoped, hash-verifiable evidence artifacts** (`playbook-ci-evidence-<run_id>`) uploaded to workflow runs, and reports status checks to GitHub.
  - Retention windows and expiration realities (30-day default) are explicitly documented; long-term governance remains anchored to Git-committed logs.

---

### 3.6 Domain 6: Threat Model & Security Boundaries

#### GAP-17: Fork PR Security & Secret Exfiltration Boundary
- **Current State**: `quality-gates.json` specifies `global_settings.sensitive_patterns` and `env_allowlist`.
- **Problem**: Pull requests submitted from public repository forks run untrusted contributor code.
  - If CI runs workflows with repository write tokens or production secrets, malicious PRs can exfiltrate secrets or tamper with release artifacts.
- **Required Architecture**:
  - CI workflows must use standard `pull_request` triggers (read-only token, zero repository secrets), **never `pull_request_target`** for untrusted code execution.
  - Minimal workflow permissions: strictly `contents: read`. `pull-requests: write` and external API write scopes are barred. Workflow step summaries write directly to runner environment files (`$GITHUB_STEP_SUMMARY`) without elevated permissions.

---

## 4. Summary of Gaps and Implementation Status

| Gap ID | Functional Domain | Severity | Implementation Status | Target Milestone / Deliverable |
| :--- | :--- | :--- | :--- | :--- |
| **GAP-10** | Hook Management | **High** | **Completed & Verified** | Task 006C.1 (`playbook hook install / uninstall / status`) |
| **GAP-11** | Pre-Commit Semantics | **Critical** | **Completed & Verified** | Task 006C.2 (Shadow staged index sandbox `PreCommitEngine`) |
| **GAP-12** | Pre-Push Semantics | **High** | **Completed & Verified** | Task 006C.2 & 006C.2.1 (Detached worktree validator & commit audit) |
| **GAP-13** | Hook Coexistence | **High** | **Completed & Verified** | Task 006C.1 & 006C.1.2 (Delegation wrapper pattern & `.playbook-orig`) |
| **GAP-14** | Worktree & Recovery | **Medium** | **Completed & Verified** | Task 006C.2.1 (Process-liveness worktree GC engine) |
| **GAP-15** | CI Workflow Scaffolding | **High** | **Architecture Frozen** | Task 006C.3 (Design); Task 006C.3.1 (`playbook ci init / validate / status`) |
| **GAP-16** | CI State Concurrency | **Critical** | **Architecture Frozen** | Task 006C.3 (Design); Read-only execution & run-scoped artifact model |
| **GAP-17** | Fork PR Security | **Critical** | **Architecture Frozen** | Task 006C.3 (Design); Least-privilege contract (`contents: read`, zero secrets) |
