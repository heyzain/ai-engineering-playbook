# Operational Controller Gap Analysis & Baseline Audit

> **Specification Version**: 1.0.0  
> **Milestone**: Task 009A — Operational Controller CLI Architecture & Design  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION  
> **Governing Standards**: [`core/engineering-constitution.md`](../../../core/engineering-constitution.md), [`governance/state-machine.md`](../../../governance/state-machine.md), [`governance/ENGINEERING_CONTROLLER.md`](../../../governance/ENGINEERING_CONTROLLER.md)

---

## 1. Context & Problem Statement

The AI Engineering Playbook has successfully established a high-assurance governance framework for software co-authored by human engineers and AI coding agents. Prior milestones (Tasks 001 through 008B) implemented:
- Deterministic project schemas (`project-manifest.schema.json`, `project-state.schema.json`, `quality-gates.schema.json`).
- Write-Ahead Transaction Logging (`WriteAheadTransactionManager`) with exclusive process locking and crash recovery.
- Quality Gate execution engine with Reproducible Input Fingerprints (RIF).
- Native Git hook integration (pre-commit shadow staging, pre-push divergence checks).
- Remote CI/CD pipeline automation and GitHub Actions adapters.
- Modular technology stacks (`nextjs`, `react-native`, `expo`).
- Comprehensive Governance Linter Engine with 21 static rules across Categories A through E.

Despite these advanced capabilities, an **operational disconnect** exists between macro lifecycle governance and intra-stage task execution. While the governance state machine ([`governance/state-machine.md`](../../../governance/state-machine.md)) specifies 14 distinct transitions, CLI tooling exists **exclusively for macro lifecycle gates and emergency pivots**.

No CLI tooling exists for the day-to-day micro-operations that AI agents and human engineers must execute *within* a stage. As a result, agents and engineers are forced to directly edit `.playbook/state.json` via ad-hoc filesystem writes, introducing significant integrity risks.

---

## 2. Forensic State Machine Transition Inventory

The table below audits all 14 transitions defined in `governance/state-machine.md` against the existing CLI implementation in `tooling/playbook-cli/src/bin/playbook.ts`:

| Transition Event | Specification Section | Description | Current CLI Command | Transactional Protection | Operational Status |
| :--- | :---: | :--- | :--- | :---: | :---: |
| `INIT_PROJECT` | §3.1 | Initialize manifest and Stage 0 state | `playbook init` | Atomicity Guard | **Implemented** |
| **`START_STAGE`** | **§3.2** | **Commence active work in target stage** | **NONE** | **None** | ❌ **UNIMPLEMENTED GAP** |
| **`RECORD_DELIVERABLE`** | **§3.3** | **Record authored deliverable artifact** | **NONE** | **None** | ❌ **UNIMPLEMENTED GAP** |
| **`RECORD_EVIDENCE`** | **§3.4** | **Record verification proof & SHA-256** | **NONE** | **None** | ❌ **UNIMPLEMENTED GAP** |
| **`RECORD_EXCEPTION`** | **§3.5** | **Record authorized human waiver** | **NONE** | **None** | ❌ **UNIMPLEMENTED GAP** |
| `TRIGGER_HALT` | §3.6 | Halt progression upon blocker/gap | Evaluated in-memory | N/A (Agent Halt) | **Implemented** |
| `RESOLVE_HALT` | §3.7 | Controlled operator-attested recovery | `playbook gate recover` | WAL + Mutex Lock | **Implemented** |
| **`REQUEST_HUMAN_APPROVAL`** | **§3.8** | **Two-Phase Handshake Phase 1 Handover** | **NONE** | **None** | ❌ **UNIMPLEMENTED GAP** |
| `APPROVE_GATE` | §3.9 | Phase 2 Interactive Human Gate Sign-Off | `playbook approve --gate N` | WAL + Sidecar | **Implemented** |
| `REJECT_GATE` | §3.10 | Human gate rejection with rework | `playbook approve --reject` | WAL + Mutex Lock | **Implemented** |
| `ADVANCE_STAGE` | §3.11 | Advance lifecycle to next stage | `playbook advance` | WAL + Mutex Lock | **Implemented** |
| `CLOSE_LIFECYCLE` | §3.12 | Seal Stage 6 and archive milestone | `playbook advance` (Stage 6) | WAL + Snapshot | **Implemented** |
| `REOPEN_LIFECYCLE` | §3.13 | Reopen completed milestone for maint | `playbook reopen` | WAL + Mutex Lock | **Implemented** |
| `PIVOT_TO_STAGE_0` | §3.14 | Maintenance Stage 1 to 0 recovery pivot | `playbook pivot --stage 0` | WAL + Pre-Pivot Snap | **Implemented** |
| **`INVALIDATE_DELIVERABLE`** | **§3.15 (Candidate)** | **Explicit revocation of verified deliverable** | **NONE** | **None** | ❌ **PROPOSED GOVERNANCE EXTENSION** (Requires human approval of `state-machine.md` before 009B implementation) |

---

## 3. Direct State Manipulation Hazards & Failure Modes

Because Transitions 3.2, 3.3, 3.4, 3.5, and 3.8 lack dedicated CLI commands, AI agents currently execute these operations by directly reading, parsing, mutating, and writing `.playbook/state.json`. This ad-hoc practice creates seven critical hazards:

### Hazard 1: Complete Bypass of Write-Ahead Transaction Logging
`WriteAheadTransactionManager` guarantees that multi-file mutations are preceded by a durable journal (`tx-journal.json`), staged safely in temporary files (`.playbook-tmp.*`), and atomically renamed into place with recovery rollbacks upon crash. Direct filesystem writes bypass this entire subsystem. A power loss, process termination, or disk write interruption leaves `.playbook/state.json` truncated or corrupted, with zero recovery journal.

### Hazard 2: Concurrency Collisions & Lost Updates
Direct filesystem writes do not acquire `TransactionLockManager` (`.playbook/.lock`). If an agent background subagent, a CI quality gate check, or a human engineer modifies project state concurrently, writes race against each other. The last process to serialize in-memory JSON overwrites and discards concurrent updates without warning.

### Hazard 3: Lack of Immediate Schema Conformance Assertion
When an agent edits `state.json` directly, no JSON Schema validation occurs at write time. Minor errors (e.g. invalid date formats, missing required fields like `actor_type`, invalid enum values like `status: "done"` instead of `"completed"`, or missing `evidence_hash`) are silently committed. These errors only surface later during `playbook validate` or `playbook inspect`, blocking subsequent workflow steps.

### Hazard 4: Manual Evidence Hash Drift and Omission
In `state-machine.md` §3.4 and `project-state.schema.json`, evidence records require an immutable `evidence_hash` formatted as `sha256:<64 hex chars>`. Currently, agents must manually execute `sha256sum`, format the string, and inject it into JSON. This manual process frequently results in:
- Unhashed evidence (`evidence_hash: null`), which downgrades verification status in `playbook verify-evidence`.
- Mismatched hashes caused by copying stale hashes from other documents.
- Truncated or uppercase hex strings violating schema regex `^sha256:[a-f0-9]{64}$`.

### Hazard 5: Unvalidated Stage Handover & Authority Drift
In `state-machine.md` §3.8, transitioning to `pending_review` requires:
- 100% of required deliverables verified or validly waived.
- Zero deliverables in `not_started`, `in_progress`, `completed`, or `blocked`.
- Zero open blocking RFCs.
- Zero expired exceptions.
- A compiled, structurally sound Stage Gate Exit Package.

When an agent manually updates `stage_status` to `pending_review` in `state.json`, none of these preconditions are programmatically asserted. An agent can set `pending_review` while deliverables are still unverified or while blocking RFCs remain unresolved.

### Hazard 6: Unverified Exception Waivers & Expired TTL Slippage
When manually marking a deliverable `status: "waived"`, agents must reference an exception record (`EXC-YYYYMMDD-###`). Direct JSON editing does not verify:
- Whether the exception file physically exists on disk.
- Whether the exception was authorized by a human rather than an AI agent.
- Whether the mandatory expiration date (`expiration_date`) has already passed.
- Whether the exception's scope actually covers the waived deliverable.

### Hazard 7: Conflation of Evidence History and Deliverable Status (Silent Downgrades vs. Contention)
When automated tests fail during development, agents frequently either corrupt append-only evidence history or execute silent, uncoordinated state demotions. Without an explicit invalidation transition and an authoritative verification resolution engine, agents either mask defects or introduce non-deterministic state oscillations.

---

## 4. Gap Identification & Traceability Matrix

To address these failure modes, Task 009 formulates eight specific architectural gaps (GAPs 35 through 42):

| Gap ID | Problem Category | Architectural Deficiency | Resolving Command / Subsystem |
| :--- | :--- | :--- | :--- |
| **GAP-35** | Stage Lifecycle Initiation | Lack of atomic CLI command to start active stage work and initialize deliverables (`START_STAGE`). | `playbook stage start` |
| **GAP-36** | Deliverable Authoring Registration | Lack of CLI command to register authored deliverable artifacts with disk verification (`RECORD_DELIVERABLE`). | `playbook deliverable record` |
| **GAP-37** | Evidence Recording & Cryptographic Hashing | Lack of CLI command to automatically hash proof files, bind Git metadata, and record append-only evidence (`RECORD_EVIDENCE`). | `playbook deliverable evidence` |
| **GAP-38** | Exception Waiver Binding & TTL Verification | Lack of CLI command to validate exception records, assert human attribution, and verify UTC boundaries before waiving (`RECORD_EXCEPTION`). | `playbook deliverable waive` |
| **GAP-39** | Phase 1 Handover Submission Protocol | Lack of automated pre-handover validation asserting 100% deliverable verification, authoritative verification results, and exit package integrity. | `playbook stage submit` |
| **GAP-40** | Exit Package Structural Verification | No programmatic AST validation checking that `GATE-N-EXIT-PACKAGE.md` contains required sections, evidence, and sign-offs. | `ExitPackageVerifier` core engine |
| **GAP-41** | Defect Regression & Non-Demoting Evidence Semantics | No formal specification distinguishing append-only evidence from deliverable lifecycle status and explicit invalidation. | Authoritative Verification Resolver & `playbook deliverable invalidate` |
| **GAP-42** | Evidence Path & Symlink Escapes (TOCTOU) | Risk of evidence commands accepting path traversals (`..`), symlink escapes, or TOCTOU file replacement between check and hash. | Kernel FD Streaming Hasher & Path Containment Guard |

---

## 5. Existing Reusable Subsystems & Non-Duplication Analysis

In strict accordance with the Engineering Constitution (Principle 4: Radical Simplicity & YAGNI) and linter rules (`RULE-INV-SUBSYSTEM-REUSE`), the Operational Controller CLI must **reuse existing verified repository components** rather than inventing redundant abstractions:

```
┌────────────────────────────────┬────────────────────────────────────────────────────────┐
│ Existing Subsystem             │ Reused Capabilities for Task 009                       │
├────────────────────────────────┼────────────────────────────────────────────────────────┤
│ WriteAheadTransactionManager   │ Multi-file atomic writes, staging directory, recovery  │
│                                │ rollbacks, expected previous SHA checks, journal sync. │
├────────────────────────────────┼────────────────────────────────────────────────────────┤
│ TransactionLockManager         │ Cross-platform process mutex locking (`.playbook/.lock`)│
│                                │ with stale lock detection and configurable timeouts.   │
├────────────────────────────────┼────────────────────────────────────────────────────────┤
│ SchemaValidator (Ajv)          │ Compiles and validates `project-manifest.schema.json`   │
│                                │ and `project-state.schema.json` (Draft 2020-12).       │
├────────────────────────────────┼────────────────────────────────────────────────────────┤
│ EvidenceVerifier               │ Path boundary checks, canonical hash patterns, and     │
│                                │ relative POSIX path normalization algorithms.          │
├────────────────────────────────┼────────────────────────────────────────────────────────┤
│ Git Utilities (`git-utils.ts`) │ Commit SHA resolution, working tree clean assertion,   │
│                                │ and tracking branch inspection.                        │
├────────────────────────────────┼────────────────────────────────────────────────────────┤
│ Stage Defaults Engine          │ Retrieval of canonical baseline deliverables per stage │
│ (`stage-defaults.ts`)          │ from `stage-gate-rules.md`.                            │
└────────────────────────────────┴────────────────────────────────────────────────────────┘
```

By leveraging these existing subsystems, Task 009 introduces zero new third-party npm dependencies and preserves complete behavioral continuity across the Playbook CLI.
