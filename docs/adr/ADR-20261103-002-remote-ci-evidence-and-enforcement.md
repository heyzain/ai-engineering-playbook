# Architecture Decision Record (ADR)

# ADR-20261103-002: Remote CI Evidence Isolation, Provider Adapters, and Status Check Enforcement

> **Template Version**: 1.0.0  
> **Applicable Stages**: Task 006 (CI/CD Pipeline Automation & Git Hook Integration)  
> **Storage Location**: `docs/adr/ADR-20261103-002-remote-ci-evidence-and-enforcement.md`

---

## 1. ADR Metadata

| Field | Value |
| :--- | :--- |
| **ADR ID** | `ADR-20261103-002` |
| **Title** | Remote CI Evidence Isolation, Provider Adapters, and Status Check Enforcement |
| **Status** | `Accepted` |
| **Creation Date** | `2026-11-03` |
| **Last Updated** | `2026-11-03` (Architectural Design under Task 006C.3) |
| **Author(s)** | AI Engineering Controller & Systems Architect |
| **Lead Approver** | Zain Ali (Lead Engineer & Architect) |
| **Impacted Subsystems** | Playbook CLI (`ci`), Remote CI/CD Workflows (`.github/workflows/`), Quality Gate Verifier, Evidence Subsystem |

---

## 2. Context and Problem Statement

In Tasks 006C.1 and 006C.2, the Playbook established native Git hook management (`playbook hook`) and local pre-commit and pre-push validation engines. These local controls provide rapid, early-feedback developer guards. However, local hooks can be bypassed via `--no-verify`, altered locally, or omitted entirely in web-based PR editing workflows.

To enforce the Playbook's governance guarantees across distributed teams and automated agent workflows, **remote CI must serve as the authoritative, non-bypassable verification layer**.

Integrating Playbook Quality Gates into remote CI systems introduces three critical architectural challenges:

1. **State Mutation & Concurrency Collision Risk**: Local gate execution (`playbook gate run`) writes execution logs to `.playbook/logs/` and updates `.playbook/state.json` via Write-Ahead Logging (`WriteAheadTransactionManager`). If remote CI workflows attempt to execute the standard local flow and commit `state.json` back to project branches:
   - Concurrent pull requests produce Git merge conflicts on `state.json`.
   - CI workflows require broad repository write permissions (`contents: write`), exposing repository branches to supply-chain attacks.
   - Pushing commits from CI can trigger recursive workflow loops.
   - It violates **Principle 1 (Human Sovereignty & Separation of Powers)**: CI is an independent validator, not an authorized governor or stage approver.
2. **Untrusted Code Execution & Fork PR Vulnerabilities**: Public open-source and enterprise repositories accept pull requests from forks. Executing untrusted PR code within workflows that hold secrets or elevated API permissions creates severe secret exfiltration and remote code execution vulnerabilities (STRIDE Elevation of Privilege).
3. **Provider Fragmentation vs CLI Simplicity**: Teams utilize varied CI providers (GitHub Actions, GitLab CI, CircleCI). Hardcoding provider-specific logic into the core quality gate engine creates bloat and violates **Principle 5 (Strict Modularity & Technology-Agnostic Core)**.

---

## 3. Decision Drivers

- **Constitutional Principle 1 (Human Sovereignty & Separation of Powers)**: Automated CI systems cannot advance lifecycle stages, self-approve stage gates, or overwrite human governance decisions.
- **Constitutional Principle 3 (Determinism Over Heuristics)**: CI must evaluate clean, pristine repository checkouts (Tier 3 Clean Tree) and produce deterministic, reproducible pass/fail verdicts.
- **Constitutional Principle 4 (Radical Simplicity & YAGNI)**: Zero unnecessary npm or binary dependencies; leverage standard provider runner primitives (e.g. `$GITHUB_STEP_SUMMARY`, GitHub artifact storage).
- **Constitutional Principle 5 (Strict Modularity & Technology-Agnostic Core)**: Decouple CI provider formatting from the core gate execution engine via an abstract `CiAdapter` interface.
- **Constitutional Principle 8 (Uncompromising Quality Gates)**: Remote status checks must serve as an inviolable branch protection barrier before merge.

---

## 4. Considered Alternatives

### Alternative A: CI Commits State and Evidence to Git Branch
- *Description*: Remote CI runs `playbook gate run`, commits the updated `.playbook/state.json` and `.playbook/logs/` back to the branch via a bot PAT or GitHub App.
- *Rejection Rationale*:
  - Severe merge conflicts across concurrent PRs.
  - Requires `contents: write` permissions, destroying fork security.
  - Pushes from CI risk infinite recursive workflow loops.
  - Conflates automated verification telemetry with human-approved state transitions.

### Alternative B: Centralized Remote Database / Telemetry Backend
- *Description*: CI pushes run metrics and gate outputs to an external SaaS or database (e.g. Supabase, AWS S3).
- *Rejection Rationale*:
  - Violates **Principle 4 (Radical Simplicity)** by introducing external cloud infrastructure dependencies, network egress requirements, authentication keys, and operational costs for basic quality gate validation.

### Alternative C: Multi-Job Matrix Workflow with Dynamic Check Names
- *Description*: Separate jobs for each gate rule (lint, typecheck, test) reporting individual status checks with dynamic runner names (e.g. `gate (ubuntu, node-20)`).
- *Rejection Rationale*:
  - Breaks GitHub rulesets whenever OS or Node matrices are updated.
  - Multiplies dependency installation and checkout overhead 4-5x.
  - Race conditions in aggregating overall gate pass/fail status.

---

## 5. Architectural Decision

We adopt a **Read-Only, Run-Scoped Telemetry Architecture** with a **Provider-Neutral Adapter Interface** and **GitHub Actions Reference Implementation**:

### 1. The CI State Invariance Principle
- Remote CI workflows **never modify `.playbook/state.json` or commit to Git branches**.
- CI runs in strict read-only / verification mode:
  1. `playbook gate verify` (verifies RIF freshness against committed evidence).
  2. `playbook gate run --headless` (evaluates rules in clean Tier 3 checkout without mutating project state).
  3. `playbook verify-evidence` (cryptographically validates SHA-256 evidence hashes).

### 2. Run-Scoped Evidence Telemetry (`gate-report.json`)
- CI execution captures full rule diagnostics, stdout/stderr, execution timings, and head commit SHA into a machine-readable JSON telemetry artifact: `gate-report.json`.
- Uploaded via `actions/upload-artifact` with run-attempt scoping:
  `name: playbook-ci-evidence-${{ github.run_id }}-${{ github.run_attempt }}`
- Disambiguates concurrent PR runs and workflow retries without collisions.

### 3. Provider-Neutral Adapter Subsystem
- Core CLI defines an abstract `CiAdapter` interface (`src/core/ci/adapter.ts`):
  ```typescript
  export interface CiAdapter {
    readonly provider: 'github' | 'gitlab' | 'circleci' | string;
    generateWorkflow(options: CiWorkflowOptions): string;
    validateWorkflow(content: string): CiWorkflowValidationResult;
    formatSummary(report: PlaybookCiRunEvidence): string;
    maskSecret(secret: string): string;
  }
  ```
- Subcommands registered under `playbook ci`:
  - `playbook ci init [--provider github] [--output <path>] [--force]`: Turnkey workflow generation.
  - `playbook ci validate [--path <path>]`: Static schema and security validation.
  - `playbook ci status [--path <path>]`: Local inspection of configured CI workflows.

### 4. Canonical GitHub Actions Reference Implementation (`quality-gate.yml`)
- **Single Unified Workflow**: Sequential execution within a single job producing a single authoritative status check.
- **Immutable Check Name**: Explicit top-level job name `Playbook / Quality Gates` ensuring GitHub rulesets and branch protection rules remain permanently stable.
- **Least-Privilege Security Contract**:
  - Explicit top-level `permissions: contents: read`.
  - Zero repository secrets passed to untrusted code.
  - Strictly `on: pull_request` (absolute prohibition of `pull_request_target`).
  - All third-party actions pinned to immutable 40-character commit SHAs.
  - Step summaries write directly to `$GITHUB_STEP_SUMMARY` without requiring API write tokens.

### 5. Separation of Concerns: Merge Barrier vs Stage Gate Advancement
- **CI Status Check**: Authoritative barrier for merging PRs into protected branches.
- **Stage Gate Advancement**: Strictly reserved for human lead engineers executing `playbook approve --gate <N>` in accordance with the Two-Phase Handshake. CI results provide verifiable evidence for human review, but CI never self-approves stage transitions.

---

## 6. Consequences and Invariants

### Positive Consequences
- **Zero CI Merge Conflicts**: PRs never collide over `state.json` edits.
- **Immunity to Fork Exfiltration**: Untrusted pull requests cannot access repository secrets or tamper with base branches.
- **Deterministic Status Checks**: Stable check naming eliminates brittle ruleset maintenance.
- **Zero Dependency Overhead**: Native Node.js CLI implementation with no external runtime dependencies.
- **Audit Traceability**: Every workflow run and retry produces a permanent, cryptographically verifiable telemetry artifact.

### Negative Consequences & Trade-offs
- **Artifact Retention Limits**: CI run artifacts expire per provider retention policies (default 30 days on GitHub). Permanent audit records rely on Git-committed logs and RIF hashes.
- **No Direct PR Comments**: Without write tokens, workflows cannot post automated PR comments; reviewers inspect the GitHub Step Summary tab in the Actions run UI.
- **Sequential Job Execution**: Quality gate rules run sequentially within the unified job rather than in parallel VMs.

---

## 7. Compliance and Verification Rules

1. **State Cleanliness Check**: CI workflows must include a post-execution step asserting that `git status --porcelain` is empty, confirming zero state mutation.
2. **Action SHA Pinning Assertion**: `playbook ci validate` must reject any workflow file referencing third-party actions with mutable tags (e.g. `@v4`) rather than 40-character commit hashes.
3. **Permission Lockdown Assertion**: `playbook ci validate` must reject any workflow that does not explicitly specify `permissions: contents: read` or equivalent read-only scopes.
