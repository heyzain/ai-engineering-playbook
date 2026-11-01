# @ai-engineering-playbook/cli

> Foundational, cross-platform governance CLI for the AI Engineering Playbook.

---

## 1. Overview

`@ai-engineering-playbook/cli` is the executable tooling layer for the AI Engineering Playbook. It operationalizes machine-readable project governance by establishing a deterministic, verifiable workflow for bootstrapping, validating, and governing software repositories co-authored by human engineers and AI coding agents.

### Core Capabilities
- **Project Inspection & Governance Diagnostics (`playbook inspect`)**: Read-only evaluation of downstream project manifest and state against JSON schemas and governance invariants, computing an actionable readiness assessment (`blocked`, `needs_attention`, `ready_for_human_review`, `approved`, `completed_terminal`).
- **Evidence Verification Engine (`playbook verify-evidence`)**: Read-only verification of evidence files against `.playbook/state.json`, checking file existence, path safety, and SHA-256 cryptographic integrity without modifying disk or state.
- **Project Bootstrapping (`playbook init`)**: Scaffolds standard downstream repository directories (`.playbook/`, `docs/prd/`, `docs/adr/`, `docs/rfcs/`, `docs/gates/`, `docs/exceptions/`, `.playbook/logs/`) and generates schema-conforming `manifest.json` and Stage 0 `state.json`.
- **Accidental State Overwrite Protection**: Refuses to overwrite existing governance manifests or lifecycle state files without explicit human confirmation or the `--force` flag.
- **Real JSON Schema Validation**: Compiles and verifies JSON Schema Draft 2020-12 specifications (`schemas/project-manifest.schema.json` and `schemas/project-state.schema.json`) with detailed JSON-pointer diagnostics.
- **Cross-Platform Path Normalization**: Enforces canonical POSIX forward slashes (`/`) for relative paths across Windows, macOS, and Linux, preventing git diff churn.
- **Programmatic & Headless APIs**: Fully supports interactive terminal prompts (TTY) as well as headless CI/automation execution.

---

## 2. Installation & Setup

### Requirements
- **Node.js**: `>= 18.0.0` (Tested on Node 20 and Node 24)
- **Platforms**: Windows, macOS, Linux

### Development Setup
```bash
# Navigate to CLI workspace
cd tooling/playbook-cli

# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Run automated test suite
npm test
```

### Local Linking
To make the `playbook` binary globally available on your workstation:
```bash
cd tooling/playbook-cli
npm link
```

---

## 3. CLI Command Reference

### `playbook inspect`
Read-only inspection and diagnostics of project governance state, deliverables, and readiness.

```bash
# Human-readable diagnostic inspection of current project
playbook inspect

# Inspect a specific project directory
playbook inspect --cwd /path/to/project

# Machine-readable JSON output for CI/CD or tooling integration
playbook inspect --json
```

#### Diagnostic Severity Definitions
- **`error`**: Critical governance violation or blocker (e.g. uninitialized project, malformed JSON, schema violation, blocking unresolved RFC, deliverable blocked, expired exception). Causes readiness to be marked `blocked` and returns exit code `1`.
- **`warning`**: Work in progress, incomplete deliverable, or configuration discrepancy (e.g. deliverable not started or unverified, empty deliverables list, lifecycle paused). Causes readiness to be `needs_attention`.
- **`info`**: Informational milestone progress, active waivers, or approved status (e.g. deliverable waived under active exception, pending human review, terminal milestone).

#### Preliminary Readiness Assessment Definitions
- **`blocked`**: Critical blockers exist (errors, schema violations, blocking RFCs, expired exceptions). Stage progression is barred.
- **`needs_attention`**: No critical blockers, but deliverables are incomplete (`not_started`, `in_progress`) or unverified (`completed`).
- **`ready_for_human_review`**: 100% of stage deliverables are `verified` or `waived` with active exceptions, zero blocking RFCs, exit package is submitted; awaiting human judgment.
- **`approved`**: Active stage is formally signed off by human reviewer (`decision: "GATE_APPROVED"`). Ready to advance.
- **`completed_terminal`**: Terminal lifecycle state (`completed_terminal`). Stage 6 approved and milestone sealed in production.

#### Read-Only Guarantees & Safeguards
- **Zero Modifications**: `playbook inspect` never writes, deletes, or modifies files.
- **No Self-Transitions**: Inspection is purely analytical. It never marks deliverables verified, never grants human approval, and never advances lifecycle stages.

#### Example Terminal Output
```
┌──────────────────────────────────────────────────────────┐
│       AI Engineering Playbook — Project Inspection       │
└──────────────────────────────────────────────────────────┘

 Target Directory: /workspace/my-project
 Initialized:      YES
 Manifest File:    VALID
 State File:       VALID

────────────────────────────────────────────────────────────
 Project Identity & Standards
────────────────────────────────────────────────────────────
  ID / Name:        zentrix-lms — Zentrix Learning Management System
  Tech Stack:       node (typescript)
  Governance Profile: STANDARD profile
  Approval Mode:    SOLO mode

────────────────────────────────────────────────────────────
 Milestone & Lifecycle Status
────────────────────────────────────────────────────────────
  Active Milestone: M-1.0.0 ("MVP Course Platform")
  Lifecycle Status: ACTIVE

────────────────────────────────────────────────────────────
 Active Lifecycle Stage
────────────────────────────────────────────────────────────
  Current Stage:    Stage 1: Requirements & Specification
  Stage Status:     PENDING_REVIEW
  Stage Started At: 2026-10-31T08:00:00Z

  Deliverables Breakdown:
    Total Configured: 2
    - Verified:       2
    - Waived:         0
    - Completed:      0 (unverified)
    - In Progress:    0
    - Not Started:    0
    - Blocked:        0

────────────────────────────────────────────────────────────
 Preliminary Readiness Assessment
────────────────────────────────────────────────────────────
  Readiness: [READY FOR HUMAN REVIEW]
  Summary:   Stage 1 Exit Package is submitted. Awaiting human judgment and sign-off.

  * Notice: This is a read-only diagnostic assessment, not a state transition.
    Only an authorized human engineer may sign off on stage gate transitions.
────────────────────────────────────────────────────────────
```

#### Example Machine-Readable JSON Output (`--json`)
```json
{
  "schema_version": "1.0.0",
  "timestamp": "2026-10-31T11:00:00.000Z",
  "target_dir": "/workspace/my-project",
  "initialized": true,
  "manifest_present": true,
  "state_present": true,
  "manifest_valid": true,
  "state_valid": true,
  "project": {
    "id": "zentrix-lms",
    "name": "Zentrix Learning Management System",
    "ecosystem": "node",
    "language": "typescript",
    "profile": "standard",
    "approval_mode": "solo"
  },
  "milestone": {
    "id": "M-1.0.0",
    "name": "MVP Course Platform",
    "lifecycle_status": "active"
  },
  "stage": {
    "number": 1,
    "name": "Requirements & Specification",
    "status": "pending_review",
    "started_at": "2026-10-31T08:00:00Z"
  },
  "deliverables_summary": {
    "total": 2,
    "not_started": 0,
    "in_progress": 0,
    "completed": 0,
    "verified": 2,
    "waived": 0,
    "blocked": 0
  },
  "rfcs_summary": {
    "total": 0,
    "pending_decision": 0,
    "blocking_unresolved": 0,
    "resolved": 0,
    "rejected": 0
  },
  "exceptions_summary": {
    "total": 0,
    "active": 0,
    "expired": 0,
    "revoked": 0,
    "remediated": 0
  },
  "approval_summary": {
    "status": "not_requested",
    "approver": null,
    "role": null,
    "decision": null,
    "approved_at": null,
    "mode": "solo"
  },
  "readiness": {
    "status": "ready_for_human_review",
    "summary": "Stage 1 Exit Package is submitted. Awaiting human judgment and sign-off.",
    "blockers": [],
    "warnings": []
  },
  "diagnostics": [
    {
      "code": "STAGE_PENDING_REVIEW",
      "severity": "info",
      "message": "Stage 1 Exit Package is submitted for human review; awaiting human sign-off.",
      "path": "docs/gates/GATE-1-EXIT-PACKAGE.md",
      "remediation": "Human engineer must review exit package and execute approval."
    }
  ]
}
```

---

### `playbook verify-evidence`
Read-only cryptographic integrity and existence verification of evidence files recorded in `.playbook/state.json`.

```bash
# Verify all evidence files in current project
playbook verify-evidence

# Verify evidence for a specific project directory
playbook verify-evidence --cwd /path/to/project

# Output machine-readable JSON report
playbook verify-evidence --json
```

#### What the Verifier Checks
1. **Path Resolution & Security**: Safely resolves relative evidence paths (e.g. `.playbook/logs/...`, `docs/exceptions/...`) against project root, rejecting path traversal attempts (`../`) and symlink boundary escapes.
2. **File Existence**: Verifies that referenced log files, benchmark outputs, or markdown checklists physically exist on disk.
3. **Cryptographic Integrity**: Reads existing files and computes their actual SHA-256 digest, comparing it case-insensitively with the recorded `evidence_hash` (`sha256:<hex>`).
4. **Hermetic Non-Network Execution**: Detects remote URLs (e.g. `http://`, `https://`) and safely classifies them as `unsupported` without accessing the network.

#### Verification Outcomes & Semantics
- **`integrity_passed`**: Referenced file exists on disk and its calculated SHA-256 matches the recorded `evidence_hash`.
- **`existence_verified`**: Referenced file exists on disk, but no `evidence_hash` was recorded in state (existence confirmed, integrity unverified).
- **`integrity_failed`**: Referenced file exists, but its calculated SHA-256 does NOT match the recorded hash, or the file is unreadable (directory target or permission error).
- **`missing`**: Referenced file does not exist on disk at the resolved path.
- **`invalid_reference`**: Reference is malformed, contains null bytes, or attempts path traversal outside the project directory.
- **`unsupported`**: Reference uses a remote URL or unsupported URI scheme.

#### Non-Negotiable Boundaries & Scientific Limitations
- **Hash Integrity != Authenticity**: A matching SHA-256 hash confirms the file has not been modified since the hash was recorded in `state.json`. It does **not** prove that the test runner was authentic or untampered with.
- **Integrity != Correctness**: A matching hash does **not** prove that the content satisfies business requirements or that tests were comprehensive.
- **Existence != Validity**: Confirming a file exists on disk does **not** validate its internal claims.
- **Strictly Read-Only**: The verification engine never mutates project state or modifies evidence files on disk.

#### Exit Codes
- `0`: All evidence files exist and any recorded hashes match (`all_passed: true`).
- `1`: One or more evidence records are `missing`, `invalid_reference`, or have `integrity_failed`.

---

### `playbook init`
Bootstraps a repository into an AI Engineering Playbook governed project.

```bash
# Interactive mode (guides you through project identity, tech stack, and profile)
playbook init

# Non-interactive / headless mode with custom options
playbook init --non-interactive \
  --project-id payment-service \
  --name "Payment Processing Service" \
  --ecosystem node \
  --language typescript \
  --profile strict \
  --mode solo \
  --milestone M-1.0.0

# Overwrite existing governance files
playbook init --force
```

#### Flags & Options
| Flag | Short | Description | Default |
| :--- | :--- | :--- | :--- |
| `--project-id <id>` | | Unique kebab-case project identifier (e.g. `zentrix-lms`). | Derived from directory name |
| `--name <name>` | | Human-readable display name. | Title Case of directory |
| `--description <desc>` | | Project summary and scope. | Generated summary |
| `--ecosystem <eco>` | | Software ecosystem (`node`, `python`, `go`, `rust`, `java`, `agnostic`). | Inferred or `agnostic` |
| `--language <lang>` | | Primary programming language (`typescript`, `python`, `go`, `rust`, etc.). | Inferred or `agnostic` |
| `--profile <profile>` | | Governance profile (`strict`, `standard`, `lightweight`). | `standard` |
| `--mode <mode>` | | Stage gate human approval mode (`solo`, `team`). | `solo` |
| `--milestone <id>` | | Initial milestone identifier (`^M-[a-zA-Z0-9.-]+$`). | `M-1.0.0` |
| `--force` | `-f` | Overwrite existing governance state. | `false` |
| `--non-interactive` | | Run without terminal prompt questions. | `false` |
| `--cwd <path>` | | Target project directory path. | `process.cwd()` |
| `--help` | `-h` | Display help screen. | |
| `--version` | `-v` | Display CLI and Playbook versions. | |

---

### `playbook validate`
Validates existing project governance files against official JSON Schemas.

```bash
# Validate both manifest.json and state.json
playbook validate

# Validate manifest only
playbook validate manifest

# Validate state only
playbook validate state

# Validate a specific project directory
playbook validate --cwd /path/to/project
```

Returns exit code `0` on success and non-zero exit code (`1`) with clear, field-level error diagnostics on validation failures.

---

### `playbook approve`
Interactive, human-only stage gate review and sign-off engine.

```bash
# Interactively review and approve the active stage gate
playbook approve

# Review a specific gate number
playbook approve --gate 1

# Provide reviewer name and title via flags (confirmation phrase prompted in TTY)
playbook approve --gate 1 --reviewer "Jane Doe" --role "Principal Architect"

# Formally reject a gate with mandatory rework conditions
playbook approve --gate 1 --reviewer "Jane Doe" --role "Principal Architect" --reject --conditions "Missing negative test edge cases in REQ-SPEC"
```

#### Human Review & Anti-Self-Approval Protections
- **Mandatory Interactive TTY**: Automated, scripted, or piped invocations without an interactive terminal are strictly rejected with `TTY_REQUIRED` (exit code `1`).
- **AI Agent Prohibition**: Reviewer names matching known AI or synthetic agent patterns (e.g. `AI-Agent`, `Bot`, `Assistant`, `Claude`, `GPT`, `Gemini`, `Copilot`) are immediately rejected with `AGENT_APPROVAL_PROHIBITED`.
- **Pre-Approval Gate Eligibility Validation**:
  - 100% of stage deliverables must be `verified` (or `waived` under an active, unexpired exception).
  - Zero blocking unresolved RFCs (`is_blocking: true`).
  - Zero expired exceptions.
  - Exit package markdown must exist, be structurally complete (minimum sections), and contain zero unresolved placeholders.
- **Typed Confirmation Phrase**: Approver must type the explicit confirmation phrase (e.g. `CONFIRM APPROVAL GATE 1`) to prevent accidental keystroke approvals.
- **Cryptographic State & Evidence Fingerprinting**: Upon approval, a cryptographic SHA-256 fingerprint of the entire state and all referenced evidence files is calculated and committed to `.playbook/approval-fingerprint.json` via a write-ahead log (WAL) transaction.

---

### `playbook advance`
Atomically advances the lifecycle to the next stage (or closes the lifecycle at Stage 6) following formal human gate approval.

```bash
# Advance current approved stage to the next stage
playbook advance

# Advance with machine-readable JSON output
playbook advance --json

# Advance in a specific project directory
playbook advance --cwd /path/to/project
```

#### Advancement Rules & Invariants
- **Approval Precondition**: Active stage must have `stage_status: "approved"` and formal human sign-off recorded.
- **Stale Approval Invalidation (`APPROVAL_STALE`)**: Re-verifies all evidence files and state payloads against `.playbook/approval-fingerprint.json`. If any deliverable or evidence file was tampered with or modified after human approval, advancement is blocked and requires re-approval.
- **Atomic Two-Phase Commit**: State updates (`state.json`), manifest synchronization (`manifest.json`), and approval sidecar removal are committed atomically using Write-Ahead Logging (`.playbook/journal.json`) and advisory flock locking (`.playbook/playbook.lock`).
- **History Archival**: The completed stage detail is moved into `stage_history[]` with approval metadata and timestamp.
- **Baseline Deliverable Initialization**: Next stage baseline deliverables are populated into `current_stage_detail.deliverables[]`.
- **Stage 6 Terminal Closure (`CLOSE_LIFECYCLE`)**:
  - Advancing Stage 6 sets `lifecycle_status: "completed_terminal"` and seals the milestone.
  - The current stage remains `6` (Stage 7 is strictly prohibited and never created).
  - Creates a frozen, read-only milestone snapshot at `.playbook/milestones/state-<milestone_id>.json`.
  - Collision defense (`SNAPSHOT_CONFLICT`): Existing snapshots cannot be overwritten.
  - Subsequent calls to `playbook advance` throw `ADVANCEMENT_BLOCKED`.

---

## 4. Downstream Directory Layout Created

Running `playbook init` creates the canonical downstream layout defined in [governance/downstream-storage-convention.md](../../governance/downstream-storage-convention.md):

```
<project-root>/
├── .playbook/
│   ├── manifest.json       # Project identity, tech stack, governance profile & paths
│   ├── state.json          # Active lifecycle stage (Stage 0: not_started), deliverables & audit log
│   └── logs/               # Verifiable test runner and static analysis proof outputs
│       └── .gitkeep
└── docs/
    ├── prd/                # Product Requirements Documents (Stage 0 & 1)
    │   └── .gitkeep
    ├── adr/                # Architecture Decision Records (Stage 2)
    │   └── .gitkeep
    ├── rfcs/               # Clarification Requests (Gap analysis halts)
    │   └── .gitkeep
    ├── gates/              # Stage Gate Exit Packages (Gates 0–6)
    │   └── .gitkeep
    └── exceptions/         # Authorized Gate Exceptions (EXC-YYYYMMDD-###.md)
        └── .gitkeep
```

---

## 5. Programmatic TypeScript API

The CLI exports clean, strongly-typed components for use in custom scripts or downstream automation tools:

```typescript
import {
  SchemaValidator,
  ProjectScaffolder,
  createInitialManifest,
  createInitialState,
  runInit,
  runValidate
} from "@ai-engineering-playbook/cli";

// 1. JSON Schema Validator
const validator = new SchemaValidator();
const manifestValidation = validator.validateManifest(someManifestObject);
if (!manifestValidation.valid) {
  console.error(manifestValidation.formattedErrors);
}

// 2. Generate canonical templates
const manifest = createInitialManifest({
  projectId: "core-platform",
  projectName: "Core Platform",
  ecosystem: "node",
  primaryLanguage: "typescript",
});

const state = createInitialState({
  projectId: "core-platform",
  approvalMode: "solo",
});

// 3. Programmatic Scaffolder
const scaffolder = new ProjectScaffolder(validator);
scaffolder.scaffold({
  targetDir: "./my-project",
  manifest,
  state,
  force: false,
});
```

---

## 6. Automated Testing

The CLI includes comprehensive tests running on Node's native test runner (`node:test`):

- **Validator Unit Tests (`tests/validator.test.ts`)**:
  - Compiles Draft 2020-12 schemas.
  - Verifies bundled schemas match repository root schemas.
  - Tests canonical fixtures (`valid-manifest.json`, `valid-state-stage1-verified.json`, `valid-state-stage2-approved.json`).
  - Asserts detection of missing fields, malformed milestone patterns, invalid enums, and out-of-range stage numbers.
- **Scaffolder Unit Tests (`tests/init.test.ts`)**:
  - Tests end-to-end directory creation in temporary sandboxes.
  - Tests collision rejection and `--force` overwrite behavior.
  - Tests fail-fast schema validation before filesystem mutations.
- **Path Utilities Tests (`tests/paths.test.ts`)**:
  - Tests Windows backslash to POSIX slash conversion.
- **Inspection & Diagnostics Tests (`tests/inspect.test.ts`)**:
  - Tests read-only evaluation of uninitialized, partially initialized, and corrupted project structures.
  - Tests non-destructive recovery remediation guidance (asserts no unsafe `--force` recommendations).
  - Tests schema invalid manifest and state diagnostics.
  - Tests deterministic UTC-inclusive exception expiration boundary handling.
  - Tests remediated exception retirement (not flagged as expired).
  - Tests gate criteria invariants (`pending_review` or `approved` with incomplete deliverables triggers `GATE_CRITERIA_UNMET`).
  - Tests terminal lifecycle consistency (`completed_terminal` requires Stage 6 approval).
  - Tests blocker precedence over positive readiness states.
  - Tests Stage 6 approved readiness summary (`CLOSE_LIFECYCLE` rather than advancing).
  - Tests source-of-truth consistency (`state.current_stage` is authoritative over manifest pointer).
  - Tests read-only immutability (zero file modifications).
- **Evidence Verification Tests (`tests/verify-evidence.test.ts`)**:
  - Tests existing evidence files without hash (`existence_verified`).
  - Tests matching SHA-256 integrity check (`integrity_passed`).
  - Tests mismatched SHA-256 hash detection (`integrity_failed`).
  - Tests missing evidence file detection (`missing`).
  - Tests malformed reference paths and null byte injection (`invalid_reference`).
  - Tests path traversal and symlink boundary escape rejection (`invalid_reference`).
  - Tests unreadable files and directory targets.
  - Tests multiple evidence records with mixed verification outcomes.
  - Tests unsupported remote URI schemes (`unsupported`).
  - Tests read-only immutability (zero file modifications).
  - Tests CLI executable output formatting and machine-readable JSON.
- **CLI Executable Integration Tests (`tests/cli.test.ts`)**:
  - Tests command dispatch, exit codes, version flags, and end-to-end `init` and `validate` executions.
- **Gate Approval Engine Tests (`tests/approve.test.ts`)**:
  - Tests TTY enforcement, confirmation phrase validation, agent anti-self-approval rejection, gate eligibility checks, and WAL-backed sidecar generation.
- **Advancement Engine Tests (`tests/advance.test.ts`)**:
  - Tests stage progression, manifest synchronization, stale approval invalidation, Stage 6 terminal closure, milestone snapshots, crash recovery, and lock cleanup.
- **End-to-End Lifecycle Integration Tests (`tests/lifecycle-e2e.test.ts`)**:
  - Validates full end-to-end downstream projects across Scenarios A through F (init, Stage 0, approval & advancement, multi-stage progressions, rejections, blocking RFCs, active/expired waivers, and Stage 6 terminal closure).

Run tests:
```bash
npm test
```
