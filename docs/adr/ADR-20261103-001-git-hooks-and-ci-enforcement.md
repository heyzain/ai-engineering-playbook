# Architecture Decision Record (ADR)

# ADR-20261103-001: Native Git Hook Lifecycle Management, Staged Shadow Extraction, and Read-Only Authoritative CI Enforcement

> **Template Version**: 1.0.0  
> **Applicable Stages**: Task 006 (CI/CD Pipeline Automation & Git Hook Integration)  
> **Storage Location**: `docs/adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md`

---

## 1. ADR Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-20261103-001` |
| **Title** | Native Git Hook Lifecycle Management, Staged Shadow Extraction, and Read-Only Authoritative CI Enforcement |
| **Status** | `Accepted` |
| **Creation Date** | `2026-11-03` |
| **Last Updated** | `2026-11-03` (Architectural Design under Task 006B) |
| **Author(s)** | AI Engineering Controller & Systems Architect |
| **Lead Approver** | Zain Ali (Lead Engineer & Architect) |
| **Impacted Subsystems** | Playbook CLI (`hook`, `ci`), Local Git Hooks (`pre-commit`, `pre-push`), GitHub Actions Workflows, CI Evidence Pipeline |

---

## 2. Context and Problem Statement

Following the completion of Task 005B, the AI Engineering Playbook possesses an automated local Quality Gate execution and verification engine (`playbook gate run`, `playbook gate verify`, `playbook verify-evidence`). However, this capability is currently an isolated local CLI utility. 

To operationalize the Playbook's Tier 3 enforcement spectrum (Automated Tool Validation), the architecture must address four core operational challenges:

1. **The Staged Index Mismatch Paradox**: `git commit` records staged changes in the Git index, but standard CLI tools execute against the working tree. Running checks against the working tree during pre-commit evaluates uncommitted edits, creating severe false positives (tests fail due to unstaged WIP code) or false negatives (tests pass due to unstaged fixes not being committed).
2. **Hook Manager Dependency Bloat**: Traditional web ecosystems rely on heavy npm packages like Husky or Lefthook. Forcing downstream repositories to install npm dependencies solely to manage shell hooks introduces dependency liabilities, maintenance friction, and alienates non-Node projects (Python, Go, Rust).
3. **Hook Coexistence & Worktree Realities**: Repositories frequently already possess custom pre-commit hooks, linked Git worktrees (`.git` as a file), or custom `core.hooksPath` configurations. Naive hook installation overwrites user scripts and breaks worktrees.
4. **CI State Mutation & Concurrency Races**: If remote CI pipelines run `playbook gate run` and attempt to commit updated `.playbook/state.json` files back to repository branches, concurrent pull requests generate severe Git merge conflicts, race conditions, require hazardous write credentials, and trigger infinite CI pipeline loops.

---

## 3. Decision Drivers

- **Constitutional Principle 1 (Human Sovereignty & Separation of Powers)**: Neither Git hooks nor CI pipelines may self-approve stages, advance milestones, or overwrite developer files without authorization.
- **Constitutional Principle 3 (Determinism Over Heuristics)**: Validation must verify exact staged or pushed content deterministically, without unreliable `git stash` operations.
- **Constitutional Principle 4 (Radical Simplicity & YAGNI)**: Eliminate unnecessary third-party package dependencies; use native Git hook mechanisms.
- **Constitutional Principle 5 (Strict Modularity & Technology-Agnostic Core)**: The hook and CI architecture must apply uniformly across any language or ecosystem.
- **Constitutional Principle 8 (Uncompromising Quality Gates)**: Remote CI status checks must serve as an inviolable, non-bypassable barrier for protected branches.
- **Intellectual Honesty**: Explicitly acknowledge that local hooks are bypassable productivity guards (`--no-verify`), whereas remote CI is the authoritative security boundary.

---

## 4. Considered Alternatives

### Alternative A: Third-Party Hook Manager (Husky/Lefthook) with `git stash` and Auto-Commit in CI
- *Description*: Mandate Husky or Lefthook in `package.json`. In `pre-commit`, execute `git stash push --keep-index`, run checks, and run `git stash pop`. In CI, have the GitHub Action commit updated `state.json` back to the PR branch using a bot PAT.
- *Rejection Rationale*:
  1. *Stash Data Loss*: If a linter fails, is terminated, or crashes midway, `git stash pop` is skipped, leaving the user's working tree in an altered state and creating potential merge conflicts.
  2. *Ecosystem Lock-In*: Mandates Node.js and npm in repositories that may be pure Python or Go.
  3. *CI Push Conflicts*: Two concurrent PR runs pushing back to `state.json` cause Git push rejections and pipeline failures.
  4. *Security Exposure*: Requiring Git write tokens in CI exposes branches to compromise from malicious fork PRs.

### Alternative B: Direct Working-Tree Execution without Staged Snapshotting
- *Description*: Pre-commit hook simply invokes `playbook gate run` on the physical working directory.
- *Rejection Rationale*:
  1. *False Security*: Validates code that is not actually being committed whenever partial staging (`git add -p`) is used.
  2. *Developer Frustration*: Fails commits because of uncommitted WIP edits in completely unrelated files.

### Alternative C: Native POSIX Shell Hooks with Ephemeral Shadow Staging, Delegation Wrappers, and Read-Only Authoritative CI (Chosen)
- *Description*:
  1. **Native Hooks & Crash-Safe Delegation Wrappers**: Zero external dependencies. Install pure POSIX shell scripts (`#!/bin/sh`) resolved via `git rev-parse --git-path hooks`. Preserve existing unmanaged user hooks in `<hook>.playbook-orig` via a crash-safe 3-phase atomic rename protocol. Execution chains through Playbook first, buffering standard input (`chmod 0600`) for `pre-push` to deliver exact args and stdin. Non-destructive `--force` archives conflicts to `.user-backup.<timestamp>`.
  2. **Delimited Managed Markers**: Wrap Playbook hook logic in unique markers (`# >>> AI ENGINEERING PLAYBOOK HOOK (MANAGED WRAPPER - DO NOT EDIT) >>>`). Malformed markers halt with `CORRUPT_HOOK_STATE`; uninstall restores the original hook byte-for-byte.
  3. **Ephemeral Staged Shadow Staging & Symlink Integrity**: For `pre-commit`, strictly separate path-metadata checks from content-reading checks. Content checks run exclusively inside ephemeral shadow sandboxes (`.playbook/.tmp/staged-<nonce>/` via `git checkout-index`). On Windows without symlink privileges, content checks fail closed (`UNSUPPORTED_PLATFORM_CAPABILITY`) rather than silently substituting plain text pointers.
  4. **Pushed-Ref Git Object Validator & Exact Range Semantics**: For `pre-push`, parse Git's native stdin stream line-by-line, dynamically detect repository hash format (`sha1` vs `sha256`), ignore branch deletions (`^0+$`), and evaluate target commit trees within ephemeral detached worktrees (`git worktree add --detach`). Use exact remote boundaries (`^remote_oid local_oid` and `--not --remotes=<remote_name>`), falling back to final pushed tree `<local_oid>^{tree}` when remote base cannot be determined. Quality Gates run strictly once per unique final pushed tree.
  5. **Ephemeral Worktree Recovery Engine**: Worktrees reside strictly in `.playbook/.tmp/worktrees/push-<oid>-<nonce>/` with `.playbook-worktree.json` ownership manifests. Stale worktrees with dead owner PIDs are safely garbage-collected; user worktrees are never touched.
  6. **Read-Only Authoritative CI**: CI runs `playbook gate verify`, `playbook gate run --headless`, and `playbook verify-evidence` in a pristine container checkout with least-privilege `contents: read` permissions. CI **NEVER** commits to `state.json`. It uploads run-scoped hash-verifiable evidence artifacts and sets the GitHub Status Check (`Playbook / Quality Gates`) to block PR merges.

---

## 5. Decision Outcome

**Accepted**: Alternative C is adopted as the authoritative architecture for Git lifecycle hooks, snapshot validation, and CI/CD integration.

### Specific Architectural Contracts:

1. **Native Shell & Delegation Wrapper Contract**:
   - Hooks must be pure `/bin/sh` scripts executable across Linux, macOS, and Windows (Git Bash).
   - Hook resolution must invoke `git rev-parse --git-path hooks` to support linked worktrees and `core.hooksPath`.
   - Existing unmanaged hooks are preserved in `<hook>.playbook-orig` via a 3-phase atomic rename protocol.
   - The primary wrapper executes Playbook validation first. If Playbook checks fail, execution aborts immediately; the original hook does not execute. If Playbook passes, the wrapper executes the original hook with preserved arguments (`"$@"`) and buffered standard input (`chmod 0600`).
   - The `--force` flag archives conflicting unmanaged hooks to `.user-backup.<timestamp>`, never deleting user content silently.
   - Re-entrancy is prevented by setting `PLAYBOOK_HOOK_ACTIVE=1`.
2. **Pre-Commit Staged Content & Symlink Integrity Contract**:
   - Physical filesystem paths expose working-tree content, not index content.
   - Content-reading checks **must only consume staged content** extracted into ephemeral shadow sandboxes (`.playbook/.tmp/staged-<nonce>/`). Direct working-tree paths are permitted solely for path-metadata checks.
   - The user's working tree and Git index are **never mutated** by hooks. No `git stash` and no automatic `git add`.
   - If `.playbook/manifest.json` or `.playbook/state.json` are staged, their schema conformance is asserted directly from the index in memory (`git show :path`).
   - **Mode-Aware Symlinks**: On Windows environments without true symlink privileges, content-reading checks fail closed (`UNSUPPORTED_PLATFORM_CAPABILITY`). Silent substitution of plain text pointer files is strictly prohibited.
3. **Pre-Push Git Object Evaluation & Exact Range Contract**:
   - Pre-push validation **never evaluates the local working tree**.
   - Parses `<local_ref> <local_oid> <remote_ref> <remote_oid>` from standard input.
   - Dynamically queries object format (`git rev-parse --show-object-format`) to identify 40-character (SHA-1) and 64-character (SHA-256) zero-OIDs.
   - Deletions (`local_oid == ZERO_OID`) are immediately skipped.
   - Exact commit selection: `<remote_oid>..<local_oid>` for fast-forward and force pushes, `git rev-list <local_oid> --not --remotes=<remote_name>` for new branch pushes.
   - **Fallback Boundary**: When target remote tracking branches are missing or stale, Quality Gate execution evaluates the **final pushed tree** `<local_oid>^{tree}` without crawling unbounded history.
   - **Granularity Split**: Heavy Quality Gates run **strictly once per unique final pushed tree** (`<local_oid>^{tree}`). Commit audits inspect each unique commit in the push range.
4. **Temporary Worktree Recovery Contract**:
   - Ephemeral worktrees reside strictly in `.playbook/.tmp/worktrees/push-<oid>-<nonce>/`.
   - Every ephemeral worktree contains `.playbook-worktree.json` recording `owner_pid` and `created_at`.
   - Signal handlers (`EXIT`, `INT`, `TERM`, `HUP`) remove temporary worktrees cleanly.
   - Garbage collection verifies PID liveness and a 30-minute staleness threshold before pruning. Unowned and user worktrees are strictly never removed or modified.
5. **CI Read-Only & Run-Scoped Evidence Contract**:
   - CI pipelines execute in **read-only / evaluation mode** under strictly `contents: read` permissions.
   - Remote CI **NEVER** mutates or commits to `.playbook/state.json`.
   - CI evaluates committed state, calculates RIF freshness, executes clean Tier 3 checks, uploads **run-scoped, hash-verifiable evidence artifacts** (`playbook-ci-evidence-<run_id>`), and reports status check results.
   - Artifact retention limits (30 days default) and deletion realities are explicitly documented; long-term auditability remains anchored to committed Git logs.
6. **Separation of Powers & Sovereignty Contract**:
   - Local hooks are bypassable via `--no-verify` (protective local convenience).
   - Remote CI status checks are authoritative and non-bypassable (mandated PR merge barrier).
   - Neither hooks nor CI may self-approve stages or advance the lifecycle.

---

## 6. Consequences & Traceability

### Positive Consequences:
- **Zero Dependency Overhead**: Projects do not need Husky, Lefthook, or npm packages to have robust Git hooks.
- **Data Safety Guaranteed**: Eliminating `git stash` from pre-commit completely prevents stash pop merge conflicts and lost uncommitted work.
- **Accurate Index Validation**: Validates what is actually being committed, eliminating working-tree vs index discrepancies.
- **Clean Execution Semantics**: Existing hooks with early `exit` cannot bypass Playbook governance, and existing hooks continue to function via the delegation wrapper.
- **Decoupled Push Safety**: Pre-push evaluates pushed Git tree objects independently of the developer's active working tree or branch.
- **Concurrency & Race Elimination**: Forbidding CI from writing to `state.json` completely eliminates Git merge conflicts between concurrent pull requests.
- **Universal Technology Fit**: Works identically for Node, Python, Go, Rust, or multi-language monorepos.

### Negative Consequences & Trade-offs:
- **Shadow Extraction Cost**: Extracting staged files into `.playbook/.tmp/staged-<nonce>/` adds minor I/O overhead on large staged sets (mitigated by checking only staged files, not the entire repository).
- **Detached Worktree Overhead**: Provisioning ephemeral detached worktrees during `pre-push` adds minor disk and Git plumbing overhead during pushes introducing many unverified commits.
- **Two Evidence Locations**: Local evidence is recorded in `state.json`; CI evidence is recorded in workflow run artifacts. (This trade-off is necessary to prevent Git push concurrency conflicts).
- **Run-Scoped Artifact Ephemerality**: CI artifacts are subject to retention expiration and admin deletion, necessitating Git commit logs for permanent auditability.

### Constitutional Traceability:
- **Principle 1 (Human Sovereignty)**: Preserved — CI cannot approve gates or advance stages.
- **Principle 3 (Determinism)**: Preserved — Exact staged bytes and pushed refs are validated deterministically.
- **Principle 4 (Radical Simplicity & YAGNI)**: Preserved — Native `/bin/sh` scripts replace bloated third-party hook managers.
- **Principle 8 (Quality Gates)**: Preserved — Protected branch status checks enforce gate compliance at the merge boundary.
