# Downstream Project Storage Architecture & Convention

> **Specification Version**: 1.0.0  
> **Status**: Recommended Standard for Governed Repositories  
> **Target Audience**: Human Engineers, AI Agents, and Tooling Authors

---

## 1. Architectural Principles

When an application project adopts the AI Engineering Playbook, it must establish a predictable, auditable file topology for its governance artifacts.

The storage architecture adheres to four principles:

1. **Zero Playbook Duplication**: Downstream projects must **not** copy the core playbook repository (Constitution, Controller rules, stage specifications, or JSON Schemas) into their codebase. Instead, the project declares its conformance via the `playbook` block in `.playbook/manifest.json`.
2. **Clean Modularity & Tool Isolation**: Machine-readable state and verification logs live in `.playbook/`, isolated from application source code.
3. **Separation of Machine Data from Human Narrative**: Machine-readable state resides in `.playbook/state.json`. Human-readable documentation resides under `docs/` in standardized markdown files.
4. **Hermetic Traceability**: Every status change recorded in `state.json` points to a tangible file path under `docs/` or an evidence log under `.playbook/logs/`.

---

## 2. Recommended Downstream Directory Layout

```
<project-root>/
│
├── .playbook/                               # Machine-readable governance root
│   ├── manifest.json                        # Project identity, paths, stack & capabilities
│   ├── state.json                           # Active lifecycle state, deliverables, evidence
│   ├── milestones/                          # Governance-frozen milestone snapshots (0o444 on supported platforms)
│   │   └── state-M-1.0.0.json
│   ├── pivots/                              # Pre-pivot Stage 1 machine-readable state snapshots (0o444 on supported platforms)
│   │   └── state-PVT-M-1.1.0-001.json
│   └── logs/                                # Verifiable proof captures (raw logs, test runs)
│       ├── stage-3-unit-tests.log
│       ├── stage-3-linter-output.log
│       ├── stage-4-integration-tests.log
│       └── stage-5-security-scan.json
│
├── docs/                                    # Human-readable engineering documentation
│   ├── prd/                                 # PRDs and specifications (Stages 0 & 1)
│   │   ├── PRD-CORE.md                      # Foundational problem formulation (Stage 0)
│   │   ├── PRD-CORE-ASSESSMENT.md           # Maintenance applicability assessment (Stage 1)
│   │   └── archive/                         # Archived outdated PRDs from stage pivots
│   │       └── PRD-CORE.PVT-M-1.1.0-001.outdated.md
│   │
│   ├── adr/                                 # Architecture Decision Records (Stage 2)
│   │   ├── ADR-20261102-001-datastore-selection.md
│   │   └── ADR-20261103-002-jwt-session-contract.md
│   │
│   ├── rfcs/                                # Clarification Requests (Gap analysis halts)
│   │   ├── RFC-20261102-001-soft-delete-policy.md
│   │   └── RFC-20261104-002-rate-limit-thresholds.md
│   │
│   ├── gates/                               # Stage Gate Exit Packages (Gates 0–6)
│   │   ├── GATE-0-EXIT-PACKAGE.md
│   │   ├── GATE-1-EXIT-PACKAGE.md
│   │   └── GATE-2-EXIT-PACKAGE.md
│   │
│   ├── pivots/                              # Human-readable stage pivot audit documents
│   │   └── PVT-M-1.1.0-001.md
│   │
│   └── exceptions/                          # Authorized Gate Exceptions (EXC-YYYYMMDD-###.md)
│       └── EXC-20261103-001.md
│
├── src/                                     # Production application source code (Stage 3+)
├── tests/                                   # Automated test suites (unit, integration, e2e)
├── .gitignore
├── README.md
└── <build-manifest>                         # package.json, Cargo.toml, go.mod, pyproject.toml
```

---

## 3. Directory and File Responsibilities

### 3.1 `.playbook/` (The Governance Engine State Directory)
- **`manifest.json`**:
  - The static project manifest conforming to `schemas/project-manifest.schema.json`.
  - Tells the governance runner which playbook version is targeted (`"version": "1.0.0"`), which governance profile applies (`"strict"` | `"standard"` | `"lightweight"`), where directories are mapped, and what capabilities are active.
- **`state.json`**:
  - The dynamic lifecycle state file conforming to `schemas/project-state.schema.json`.
  - Updated by agents and tools after each operational controller step.
  - Commits to version control so the full progression history is auditable via Git.
- **`milestones/`**:
  - Stores governance-frozen milestone snapshots formatted as `state-<milestone_id>.json`.
  - Created automatically when advancing Stage 6 via `CLOSE_LIFECYCLE` (`playbook advance`).
  - Marked read-only on disk (`chmod 0o444`, best-effort on supported platforms) and protected against collision or accidental modification (`SNAPSHOT_CONFLICT`).
- **`pivots/`**:
  - Stores machine-readable pre-pivot state snapshots formatted as `state-PVT-<milestone_id>-<seq>.json`.
  - Created by `playbook pivot` before reverting an active maintenance milestone from Stage 1 to Stage 0.
  - Captures full Stage 1 state, unvalidated deliverables, and stage history. Marked read-only on disk (`chmod 0o444`, best-effort on supported platforms) and protected against collision (`TARGET_ALREADY_EXISTS`).
- **`logs/`**:
  - Stores concrete outputs from verification runs (terminal captures, test runner outputs, compiler reports).
  - Referenced in `state.json` deliverables under `evidence[].evidence_ref`.

### 3.2 `docs/prd/` (Requirements Baseline)
- Stores Product Requirements Documents formatted per `templates/prd-template.md`.
- File naming convention: `docs/prd/PRD-YYYYMMDD-<topic>.md` or `docs/prd/PRD-CORE.md`.
- Must be approved at Gate 0 (problem formulation) and Gate 1 (specifications).
- **`archive/`**:
  - Stores outdated foundational PRDs archived during stage recovery pivots, renamed to `PRD-CORE.PVT-<milestone_id>-<seq>.outdated.md`.
  - Preserves historical requirements context before fresh problem reformulation begins in Stage 0.

### 3.3 `docs/adr/` (Architectural Baseline)
- Stores Architecture Decision Records formatted per `templates/adr-template.md`.
- File naming convention: `docs/adr/ADR-YYYYMMDD-###-<title>.md`.
- Must be approved and accepted at Gate 2 before implementation begins.

### 3.4 `docs/rfcs/` (Clarification Baseline)
- Stores Clarification Requests formatted per `templates/clarification-rfc-template.md`.
- File naming convention: `docs/rfcs/RFC-YYYYMMDD-###-<topic>.md`.
- While any RFC has `is_blocking: true` and `status: "pending_decision"`, the project state is `blocked`.

### 3.5 `docs/gates/` (Stage Gate Exit Packages)
- Stores compiled exit packages for Gates 0 through 6 formatted per `templates/gate-exit-package-template.md`.
- File naming convention: `docs/gates/GATE-[0-6]-EXIT-PACKAGE.md`.
- Captures deliverable verification evidence, traceability matrix, and the mandatory human approval signature.

### 3.6 `docs/exceptions/` (Governance Exception Records)
- Stores authorized exceptions formatted per `templates/exception-record-template.md`.
- File naming convention: `docs/exceptions/EXC-YYYYMMDD-###.md`.
- Must contain an active expiration date (TTL <= 30 days) and human approver identification.

### 3.7 `docs/pivots/` (Stage Pivot Audit Documents)
- Stores human-readable governance audit documents generated by `playbook pivot` per the audit document specification in `governance/maintenance-stage-pivot-design.md`.
- File naming convention: `docs/pivots/PVT-<milestone_id>-<seq>.md` (e.g. `docs/pivots/PVT-M-1.1.0-001.md`).
- Formally documents the invalidation rationale, assessment artifact references, authorizing human justification, preserved Stage 1 artifacts, and remediation directives for Stage 0 reformulation.

---

## 4. Git and Version Control Best Practices

1. **Commit Manifest and State**: `.playbook/manifest.json` and `.playbook/state.json` **must be committed** to version control on every stage transition or deliverable update.
2. **Log Retention in `.playbook/logs/`**:
   - Small, deterministic text logs (unit test summaries, linter results) should be committed to `.playbook/logs/` for auditable proof.
   - Large binary artifacts (e.g., coverage HTML trees, raw video recordings) should be stored in CI/CD storage and referenced via permanent URLs or commit artifacts rather than bloated in git.
3. **Branch Protection Alignment**:
   - In Team Mode, branch protection rules can enforce that a PR updating `.playbook/state.json` to `stage_status: "approved"` must have an approved review from designated code owners.
