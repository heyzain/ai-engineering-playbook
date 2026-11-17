# CI/CD Pipeline Automation & Git Hook Integration: Threat Model & Security Boundaries

> **Specification Version**: 1.0.0  
> **Status**: Accepted Threat Specification (Task 006B)  
> **Target Scope**: Local Git Hooks, Pre-commit/Pre-push Lifecycle, CI/CD Pipeline Integration, Branch Protection Boundaries  
> **Preceding ADRs**:
> - [`docs/adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md`](../../adr/ADR-20261103-001-git-hooks-and-ci-enforcement.md)  
> **Preceding Specifications**:
> - [`core/engineering-constitution.md`](../../../core/engineering-constitution.md)
> - [`docs/architecture/ci-integration/design.md`](design.md)
> - [`docs/architecture/ci-integration/gap-analysis.md`](gap-analysis.md)

---

## 1. Executive Summary & Security Philosophy

A foundational tenet of the AI Engineering Playbook is **intellectual honesty regarding security boundaries**:
1. **Local Developer Hooks Are Non-Authoritative**: Native Git client hooks (`pre-commit`, `pre-push`) run locally under the authority of the developer or AI agent. They are fundamentally bypassable via `git commit --no-verify`, GUI options, or filesystem manipulation. They serve as **protective productivity guards**, not cryptographic security boundaries.
2. **Remote CI/CD Pipelines Are Authoritative**: The remote CI server (GitHub Actions) executing in a detached, clean container environment with protected branch merge rules represents the **authoritative enforcement boundary**.
3. **Least Privilege & Zero CI State Mutation**: CI evaluates code and reports status checks. CI never possesses write credentials to source branches or lifecycle state files.

This document analyzes potential attack vectors, failure modes, and mitigation strategies across the local hook and remote CI boundaries using the STRIDE threat taxonomy.

---

## 2. STRIDE Threat Matrix

| Threat ID | Category | Threat Scenario | Impact | Severity | Mitigation Strategy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **THREAT-01** | **Repudiation / Elevation** | Local Hook Bypass via `--no-verify` or GUI client. | Unverified code or corrupted schemas committed to local branch. | **High (Local) / Low (Systemic)** | Local hooks are explicitly non-authoritative. Remote CI status checks enforce a mandatory merge barrier. |
| **THREAT-02** | **Tampering** | Malicious or compromised hook script in `.git/hooks/`. | Arbitrary command execution on developer workstation during git commands. | **Critical** | Hooks use immutable shell templates, Delimited Managed Blocks, and are not committed to Git by default. |
| **THREAT-03** | **Information Disclosure** | Secret exfiltration from fork PRs via workflow tampering. | Unauthorized access to repository deployment tokens or cloud credentials. | **Critical** | CI uses standard `pull_request` trigger with strictly `contents: read` permissions (zero secrets). `pull_request_target` is strictly barred. |
| **THREAT-04** | **Information Disclosure** | Secret leakage into check logs or `$GITHUB_STEP_SUMMARY`. | Plaintext API keys or credentials exposed in CI build logs. | **High** | Double-layer defense: Runner regex stream scrubbing + GitHub Actions `::add-mask::` + `env_allowlist`. |
| **THREAT-05** | **Tampering / Elevation** | Supply-chain compromise of third-party GitHub Actions. | Malicious action payload executing with runner permissions. | **High** | Action version pinning: Actions are pinned to full 40-character immutable commit SHAs, not mutable tags. |
| **THREAT-06** | **Denial of Service** | Long-running test suites or infinite loops in pre-commit hooks. | Developer workstation hangs; terminal freeze. | **Medium** | Pre-commit runs only fast Tier 2 checks; execution harness enforces process timeouts and tree-kill. |
| **THREAT-07** | **Tampering** | Stale evidence replay attack (submitting old logs with new code). | Deliverable marked verified without running actual checks. | **High** | RIF (Reproducible Input Fingerprint) validation. Any modification to source, lockfile, or env invalidates the RIF. |
| **THREAT-08** | **Denial of Service** | Process crash during hook install/uninstall leaves partial script or destroys user hook. | Broken Git commands; developer blocked from committing; lost user hooks. | **Medium** | Atomic temporary write and rename pattern (Phase 1–3); delegation wrapper preserves prior hook scripts in `.playbook-orig`; `--force` archives conflicting hooks to `.user-backup.<timestamp>` without data loss. |
| **THREAT-09** | **Tampering / Evasion** | Partial staging (`git add -p`) masks working-tree breakages or tests uncommitted edits; Windows plain text pointer files substitute symlinks. | False positives/negatives in pre-commit validation; AST and module resolution distortion. | **High** | Strict separation: Content-reading checks run inside ephemeral staged shadow sandboxes (`git checkout-index`), never working tree. On Windows without symlink privileges, content-reading checks fail closed (`UNSUPPORTED_PLATFORM_CAPABILITY`) rather than silently evaluating plain text pointers. |
| **THREAT-10** | **Tampering / Inconsistency** | Pre-push checks run against local working tree rather than pushed commits; naive `--not --remotes` miscalculates push range. | Validating wrong branch/dirty tree; skipped validation or unbounded history traversals. | **High** | Decoupling: Pre-push evaluates pushed Git tree snapshots in ephemeral detached worktrees. Exact commit selection uses `^remote_oid local_oid` and `--not --remotes=remote_name`. Quality Gates run strictly once per final pushed tree. |
| **THREAT-11** | **Repudiation / Inconsistency** | SHA-256 repo zero-OID mismatch (40 vs 64 hex zeros). | Branch deletions misclassified as active pushes; hook crashes. | **Medium** | Dynamic object format query (`git rev-parse --show-object-format`) and length-agnostic zero-OID regex (`^0+$`). |
| **THREAT-12** | **Tampering / Repudiation** | Assumption that CI workflow artifacts are permanent and tamper-proof. | False reliance on ephemeral CI artifacts for long-term governance. | **Medium** | Clear threat boundary: CI artifacts are run-scoped and subject to retention limits; long-term auditability relies on Git-committed hash verification. |
| **THREAT-13** | **Denial of Service / Tampering** | Process crash during pre-push leaves orphaned detached worktrees, consuming disk or removing user worktrees. | Disk exhaustion; accidental deletion of developer worktrees. | **Medium** | Strict `.playbook/.tmp/worktrees/` namespace; explicit `.playbook-worktree.json` ownership manifest; PID liveness checks; 30-min stale GC; zero touching of unowned worktrees. |

---

## 3. Deep-Dive Threat Analysis & Mitigations

### 3.1 THREAT-01: Local Hook Bypass (`--no-verify`)

#### Threat Description:
A developer or AI agent executing in the repository runs:
```bash
git commit --no-verify -m "Skip pre-commit checks"
git push --no-verify origin feature-branch
```
Alternatively, an external GUI client (e.g. VS Code, Fork, SourceTree) or third-party Git integration that does not trigger shell hooks commits directly to the branch.

#### Architectural Boundary & Reality:
- **Git Protocol Reality**: Git client hooks execute locally on the user's machine. Git explicitly provides the `--no-verify` flag to allow developers to bypass hooks during emergency hotfixes or local experimentation. It is technically impossible to prevent a local user with write access to the `.git` directory from bypassing local hooks.
- **Countermeasure (The CI Barrier)**:
  - The Playbook explicitly documents that local hooks are **protective productivity guards**, not security barriers.
  - Authoritative enforcement occurs at the **GitHub Branch Protection Boundary**:
    1. The target branch (`main`, `release/*`) requires pull request reviews.
    2. The target branch mandates the status check `Playbook / Quality Gates` to be green.
    3. Merging is strictly blocked by GitHub's API if CI verification fails, regardless of any `--no-verify` flags used locally.

---

### 3.2 THREAT-02: Malicious Hook Injection & Tampering

#### Threat Description:
A malicious dependency (e.g. in `node_modules`) or an unvetted script writes malicious commands into `.git/hooks/pre-commit`, which then execute automatically the next time the developer or AI agent runs `git commit`.

#### Architectural Mitigations:
1. **Native Shell Isolation**: Playbook hooks are pure `/bin/sh` scripts that invoke the `playbook` CLI binary directly. They do not execute external node scripts or eval arbitrary strings.
2. **Delimited Managed Blocks**: The Playbook hook installer strictly marks its code between `# >>> AI ENGINEERING PLAYBOOK HOOK` and `# <<< AI ENGINEERING PLAYBOOK HOOK`. Any uninstallation or status check validates these boundaries.
3. **Repository Directory Boundaries**: Hook scripts reside in `.git/hooks/` (or `core.hooksPath`). The Playbook does **not** commit `.git/hooks/` into source control. Downstream developers must explicitly run `playbook hook install` to activate hooks, preventing untrusted repository clones from auto-executing scripts.

---

### 3.3 THREAT-03: Fork PR Workflow Manipulation & Secret Theft

#### Threat Description:
An external contributor forks a public Playbook-governed repository, creates a malicious pull request, and attempts to steal repository secrets (e.g. npm publish tokens, deployment credentials, AWS keys) by modifying the test scripts or `.github/workflows/quality-gate.yml`.

#### Architectural Mitigations:
1. **Strict Trigger Selection (`pull_request`)**:
   - The generated workflow strictly uses the `pull_request` trigger.
   - Under GitHub Actions security rules, workflows triggered by `pull_request` from a fork:
     - Run with a **read-only `GITHUB_TOKEN`**.
     - Have **zero access to repository secrets** (secrets are completely blank).
2. **Prohibition of `pull_request_target`**:
   - The Playbook strictly prohibits scaffolding `pull_request_target` for quality gate workflows. `pull_request_target` runs in the context of the base repository and has access to secrets, creating severe code injection vulnerabilities when checking out untrusted PR branches.
3. **Minimal Workflow Permissions**:
   ```yaml
   # Strictly read-only repository contents. Zero API write scopes.
   # Step summaries write directly to $GITHUB_STEP_SUMMARY on the runner.
   # pull-requests: write is explicitly removed to prevent unauthorized comment/review modifications.
   permissions:
     contents: read
   ```

---

### 3.4 THREAT-04: Secret Leakage in Logs and CI Output

#### Threat Description:
A failing test or compiler error prints environment variables, connection strings, or authorization headers into stdout/stderr. These logs are captured in `.playbook/logs/` or printed into the GitHub Actions log and Step Summary.

#### Architectural Mitigations:
1. **Subprocess Environment Allowlisting**:
   - The Quality Gate runner (`src/core/quality-gates/runner.ts`) exposes only a minimal allowlist of benign system variables (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`) plus explicitly declared check `env` variables. Ambient secrets in the parent shell are not passed to child processes.
2. **Sensitive Pattern RIF Hashing**:
   - Sensitive environment variables declared in `global_settings.sensitive_patterns` hash only their version identifiers (`KEY:version=1.0`), never raw secret values.
3. **Best-Effort Stream Scrubbing**:
   - The runner applies regex masking for common secret token formats (JWTs, Bearer tokens, private keys) before persisting logs.
4. **CI Secret Masking**:
   - The CI adapter integrates GitHub Actions `::add-mask::` commands for any known project environment secrets, ensuring the platform's log scrubber replaces them with `***`.
5. **Intellectual Honesty Warning**:
   - The Playbook explicitly warns: *Log scrubbing is an imperfect, best-effort heuristic. Secrets, API keys, and private credentials must never be introduced into test environments.*

---

### 3.5 THREAT-05: Supply-Chain Action Pinning

#### Threat Description:
A third-party action used in the workflow (e.g. `actions/checkout@v4`) is compromised via account takeover or malicious tag mutation, injecting arbitrary code into the CI pipeline.

#### Architectural Mitigations:
1. **Full Commit SHA Pinning**:
   - The `playbook ci init` template pins official actions to immutable 40-character commit SHAs, accompanied by a comment indicating the version:
     ```yaml
     - name: Checkout Code
       uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
     - name: Setup Node.js Runtime
       uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
     ```
2. **Zero External Action Dependencies**:
   - The Playbook workflow uses only verified, official GitHub Actions (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`). It requires zero third-party community actions.

---

### 3.6 THREAT-07: Stale Evidence Replay Attack

#### Threat Description:
A developer modifies application code (e.g. introduces a bug or modifies business logic) but retains previous passing evidence logs in `.playbook/logs/` and submits the PR without re-running quality gates.

#### Architectural Mitigations:
1. **Mathematical Reproducible Input Fingerprint (RIF)**:
   - Every quality check result records the RIF digest:
     $$\text{RIF} = \text{SHA256}\Big(\text{Hash}(\text{InputFiles}) \,\|\, \text{Hash}(\text{Lockfiles}) \,\|\, \text{ToolVersion} \,\|\, \text{Hash}(\text{EnvKeys}) \,\|\, \text{CleanState}\Big)$$
   - If *any* tracked file matching the check's glob patterns is modified, added, renamed, or deleted, the computed RIF alters deterministically.
2. **Read-Only Gate Verification (`playbook gate verify`)**:
   - In CI (Step 3), `playbook gate verify` recalculates the current workspace RIF and compares it against the stored RIF in `state.json`.
   - If the code was modified after the evidence was generated, `playbook gate verify` detects the mismatch, flags `status: "stale"`, and aborts CI with exit code `1`. Stale evidence cannot pass CI.

---

### 3.7 THREAT-09: Partial Staging Evasion & False File Representation (Symlinks)

#### Threat Description:
1. **Partial Staging Evasion**: A developer partially stages modifications (`git add -p`), leaving unstaged edits in the working tree. A pre-commit hook reading physical files from disk evaluates unstaged changes, validating code that is not actually being committed.
2. **False Symlink Representation on Windows**: If a repository contains staged symlinks (mode `120000`) and the validation harness creates plain text pointer files on Windows because the host lacks symlink privileges, compilers, linters, and AST parsers evaluate plain text content instead of traversing to target modules. This validates an entirely different representation than what executes on POSIX production systems.

#### Architectural Mitigations:
1. **Strict Content-Reading vs. Path-Metadata Separation**:
   - Path-metadata checks (naming conventions, forbidden glob matches) inspect only the staged path list.
   - Content-reading checks (TypeScript compilation, ESLint, unit tests, schema validators) are strictly forbidden from reading physical working-tree files.
2. **Ephemeral Staged Shadow Sandboxes**:
   - Content-reading tools run inside an isolated sandbox (`.playbook/.tmp/staged-<nonce>/`) populated exclusively via `git checkout-index`.
   - Governance schemas (`manifest.json`, `state.json`) are read directly from the index in memory (`git show :.playbook/manifest.json`).
3. **Mode-Aware Symlink Capability Probe & Fail-Closed Behavior**:
   - The engine tests whether true symlinks can be created in the current environment (`fs.symlinkSync`).
   - If true symlinks are supported, they are extracted as real symlinks.
   - If true symlinks are NOT supported (e.g. Windows without Developer Mode), the engine **strictly refuses to substitute a text pointer file**. If any active content-reading check touches the symlink, the hook fails closed immediately (`UNSUPPORTED_PLATFORM_CAPABILITY`), alerting the operator to enable Developer Mode or use a POSIX container.
4. **No Destructive Stashing**:
   - `git stash` is completely eliminated, preventing stash conflicts, merge collisions, and uncommitted data loss.

---

### 3.8 THREAT-10: Pushed Git Objects vs Working-Tree Divergence & Remote Boundary Flaws

#### Threat Description:
1. **Working Tree Divergence**: During `git push`, the developer's working tree is dirty, midway through a rebase, or checked out to an entirely different branch than the ref being pushed. If `pre-push` validates the local working tree, it evaluates the wrong code.
2. **Improper Remote Ref Boundary**: Using generic `--not --remotes` ignores the specific target remote (`$1`), causing validation to skip commits present on other local tracking remotes but absent on the destination remote. Conversely, on brand-new remotes without tracking branches, naive traversal crawls unbounded history to the repository root commit, hanging developer workstations.

#### Architectural Mitigations:
1. **Decoupling from Working-Tree State**:
   - The pre-push hook reads ref tuples directly from standard input (`<local_ref> <local_oid> <remote_ref> <remote_oid>`).
   - Validation evaluates pushed Git tree snapshots in ephemeral detached worktrees (`git worktree add --detach .playbook/.tmp/worktrees/push-<oid>-<nonce> <target_commit_oid>`).
2. **Exact Target-Remote Boundary Calculation**:
   - Normal pushes evaluate `<remote_oid>..<local_oid>` (`git rev-list ^<remote_oid> <local_oid>`).
   - New branch pushes evaluate `git rev-list <local_oid> --not --remotes="$1"`.
   - When a remote base cannot be determined (new/empty remote), the engine enforces the **Fallback Boundary Rule**: it evaluates the **final pushed tree** `<local_oid>^{tree}`, avoiding unbounded historical crawling.
3. **Quality Gate Granularity**:
   - Heavy Quality Gates evaluate strictly **once per final pushed tree** (`<local_oid>^{tree}`). Intermediate WIP commits in a branch push do not trigger redundant or false-positive full gate executions.
   - Commit audits and RIF freshness evaluate each unique commit introduced in the push range.

---

### 3.9 THREAT-11: Repository Object Format (SHA-1 vs SHA-256) Ambiguity

#### Threat Description:
In SHA-256 repositories (`--object-format=sha256`), object IDs are 64 hexadecimal characters. If hook scripts hardcode 40-character zero-OIDs (`0000000000000000000000000000000000000000`), remote branch deletions send 64 zeros, causing hook parsers to misclassify branch deletions as active commits or crash on malformed length checks.

#### Architectural Mitigations:
1. **Dynamic Object Format Detection**:
   - The CLI queries `git rev-parse --show-object-format` dynamically to establish whether the repository operates under `sha1` or `sha256`.
2. **Universal Zero-OID Regex**:
   - Zero-OID recognition utilizes the pattern `/^0+$/` matching 40 or 64 characters, guaranteeing correct deletion detection across both legacy and modern Git repositories.

---

### 3.10 THREAT-12: CI Artifact Ephemerality and Provenance Limitations

#### Threat Description:
An engineering team assumes that workflow artifacts uploaded to GitHub Actions (`actions/upload-artifact`) are permanent, immutable ledgers of compliance, relying on them for long-term regulatory compliance.

#### Architectural Mitigations:
1. **Accurate Terminology & Scope**:
   - CI evidence is documented as **run-scoped, hash-verifiable evidence**, not immutable permanent storage.
2. **Documented Expiration & Admin Deletion Realities**:
   - GitHub Actions artifacts expire (30–90 days) and can be removed by repository administrators.
3. **Long-Term Audit Anchor**:
   - Permanent, tamper-evident auditability resides in the repository's Git commit history (`.playbook/logs/` and RIF hashes), cryptographically sealed and tracked alongside the application code.

---

### 3.11 THREAT-13: Temporary Worktree Accumulation & Directory Contention

#### Threat Description:
A forced termination (power cut, SIGKILL, terminal closed) interrupts a pre-push validation run while an ephemeral detached worktree is active. Subsequent pushes or background tools might accumulate orphaned worktrees, consume disk, or accidentally prune user feature worktrees.

#### Architectural Mitigations:
1. **Dedicated Namespace & Explicit Ownership Manifest**:
   - Temporary worktrees are strictly confined to `.playbook/.tmp/worktrees/push-<oid>-<nonce>/`.
   - Every ephemeral worktree contains `.playbook-worktree.json` recording `owner_pid`, `created_at`, and `nonce`.
2. **Liveness-Aware Garbage Collection**:
   - Cleanup scans verify whether `owner_pid` is still alive via `process.kill(pid, 0)`. Active worktrees are never disturbed.
   - Worktrees with dead owner PIDs or exceeding 30-minute staleness are pruned cleanly via `git worktree remove --force` and `git worktree prune`.
3. **Protection of User Worktrees**:
   - Worktrees lacking `.playbook-worktree.json` or residing outside `.playbook/.tmp/worktrees/` are strictly ignored.

---

## 4. Operational Boundaries Summary

```
┌────────────────────────────────────────────────────────────────────────┐
│ Operational Authority Matrix                                           │
├────────────────────────────────────────────────────────────────────────┤
│ Local Git Hook:                                                        │
│  - Authority: Local developer workstation only                         │
│  - Enforcement: Client-side advisory / productivity guard              │
│  - Bypassability: Bypassable via --no-verify                           │
│  - State Mutation: Permitted locally (WAL state.json updates)          │
│                                                                        │
│ Remote CI Pipeline:                                                    │
│  - Authority: Authoritative repository gate barrier                   │
│  - Enforcement: GitHub Protected Branch Status Check                   │
│  - Bypassability: NON-BYPASSABLE (Requires admin bypass / PR signoff)  │
│  - State Mutation: STRICTLY FORBIDDEN (Read-only evaluation)           │
│  - Human Approval: CANNOT grant stage approval or advance lifecycle    │
└────────────────────────────────────────────────────────────────────────┘
```
