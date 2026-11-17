# Quality Gates & CI Integration: Comprehensive Gap Analysis

> **Document Version**: 2.2.0  
> **Status**: Accepted Architectural Specification (Frozen Gap Analysis for Task 005B)  
> **Target Scope**: CLI Execution Engine, Governance State Invariants, CI/CD Integration  
> **Audit Reference**: [`docs/architecture/quality-gates/audit-report.md`](audit-report.md)  
> **Authoritative ADR**: [`docs/adr/ADR-20261102-002-quality-gate-atomicity-and-concurrency.md`](../../adr/ADR-20261102-002-quality-gate-atomicity-and-concurrency.md)  
> **Preceding Specifications**:
> - [`core/engineering-constitution.md`](../../core/engineering-constitution.md)
> - [`governance/ENGINEERING_CONTROLLER.md`](../../governance/ENGINEERING_CONTROLLER.md)
> - [`governance/stage-gate-rules.md`](../../governance/stage-gate-rules.md)
> - [`governance/state-machine.md`](../../governance/state-machine.md)
> - [`schemas/project-manifest.schema.json`](../../schemas/project-manifest.schema.json)
> - [`schemas/project-state.schema.json`](../../schemas/project-state.schema.json)
> - [`tooling/playbook-cli/src/core/transaction/transaction-manager.ts`](../../tooling/playbook-cli/src/core/transaction/transaction-manager.ts)
> - [`tooling/playbook-cli/src/core/evidence/verifier.ts`](../../tooling/playbook-cli/src/core/evidence/verifier.ts)
> - [`tooling/playbook-cli/src/core/lock/liveness.ts`](../../tooling/playbook-cli/src/core/lock/liveness.ts)

---

## 1. Executive Summary & Context

The AI Engineering Playbook has established a robust machine-readable state model ([`project-state.schema.json`](../../schemas/project-state.schema.json)), strict finite state machine transitions ([`state-machine.md`](../../governance/state-machine.md)), and an operational command-line interface (`@ai-engineering-playbook/cli`). 

However, a comprehensive architectural audit reveals a **critical enforcement gap**:
- The Playbook CLI currently acts as a **passive state validator and evidence verifier**, not an **active execution harness**.
- The CLI can verify that an evidence file exists on disk and matches a recorded SHA-256 hash (`playbook verify-evidence`).
- The CLI can inspect whether deliverable items are marked `verified` and whether RFCs are blocking (`playbook inspect`).
- But the CLI **cannot execute quality checks, cannot orchestrate test runners, cannot capture live command output into evidence logs, cannot prevent stale evidence reuse, and cannot automatically synchronize execution outcomes into `state.json`**.

Consequently, running tests, linting code, compiling builds, scanning for vulnerabilities, capturing logs, calculating hashes, and updating `.playbook/state.json` currently requires manual shell execution and ad-hoc JSON modification. For human developers, this introduces friction; for AI agents, it creates hallucination risks, state corruption hazards, and inconsistent evidence formatting.

Furthermore, an independent architectural audit ([`audit-report.md`](audit-report.md)) and resulting Architecture Decision Record ([ADR-20261102-002](../../adr/ADR-20261102-002-quality-gate-atomicity-and-concurrency.md)) established that the execution harness must reconcile with strict ground-truth constraints:
1. **Deterministic RIF Classification**: Heuristic null-byte probes fail on small binary fragments and valid UTF-8 binary streams. The system must use an explicit classification hierarchy (`text_patterns`, known extensions, raw byte default) and **never silently normalize an unclassified file**.
2. **Non-Circular Byte Hashing**: The canonical log cannot contain its own SHA-256 hash inside its body. `evidence_hash` in `state.json` hashes the raw canonical log file byte-for-byte on disk, matching `EvidenceVerifier`.
3. **Zero Schema Collisions**: `project-state.schema.json` strictly enforces `"additionalProperties": false` on evidence items; undeclared fields (`rif`, `dirty_tree`) cannot be written directly to `state.json`.
4. **Real WAL Transaction Contracts**: Operations must use the existing `WriteAheadTransactionManager.executeTransaction()` multi-file API to atomically commit canonical logs (`files[0]`) and state updates (`files[1]`) together.
5. **Unlocked Concurrency**: Long-running tests must execute unlocked, acquiring `.playbook/transaction.lock` only for final state synchronization to respect the 10-second mutex timeout.
6. **Conservative Staging Ownership**: Staging files must pair `.log` and `.meta.json` records; cleanup requires verifiable process death via `defaultProcessLivenessChecker`; unverifiable metadata results in conservative retention.

---

## 2. Audit of Existing Capabilities & Reusable Foundations

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Existing CLI Ground Truth & Reusable Capabilities                                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Schema Validation (validator.ts)                                                    │
│    - Fully compiled Draft 2020-12 Ajv validator with ajv-formats.                      │
│    - Reusable for new quality-gate configuration schemas.                              │
│                                                                                        │
│ 2. Evidence Verification (verifier.ts)                                                 │
│    - Reads entire raw file buffer, verifies SHA-256, prevents symlink escapes.         │
│    - Direct verification engine for quality-gate evidence logs.                        │
│                                                                                        │
│ 3. Write-Ahead Log Transaction Engine (transaction-manager.ts)                         │
│    - Two-phase commit WAL (.playbook/tx-journal.json) via executeTransaction().        │
│    - Reusable for atomic multi-file commits (canonical log + state.json).              │
│                                                                                        │
│ 4. Concurrency Mutex (lock-manager.ts) & Liveness Verifier (liveness.ts)               │
│    - Process lock with PID liveness & start-time recycling verification.               │
│    - Reusable for sub-second locking and safe staging-file orphan reaping.             │
│                                                                                        │
│ 5. Diagnostics Engine (engine.ts & inspector.ts)                                       │
│    - Diagnostic issue taxonomy (error, warning, info) with codes and remediation.     │
│    - Reusable for surface reporting of failing checks and gate blockers.               │
│                                                                                        │
│ 6. Cryptographic State Projection (fingerprint.ts)                                     │
│    - RFC 8785 JSON Canonicalization Scheme (JCS) and SHA-256 state hashing.            │
│    - Reusable for binding quality-gate results to exact workspace states.              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Gap Analysis by Functional Area

### 3.1 Local Quality Checks & Working-Tree Policy Gaps
- **Current State**: The CLI provides read-only inspection and verification.
- **Identified Gaps**:
  - Enforcing a universally clean working tree breaks local development during red-green refactoring.
  - Allowing dirty trees in CI or Stage Handover breaks deterministic releases.
  - **Reconciled Solution**: A Three-Tier Working-Tree Policy allowing dirty trees in local dev (Tier 1), mandating clean deliverable paths and manifests at handover (Tier 2), and mandating 100% clean repos in CI (Tier 3).

### 3.2 Evidence Hash & RIF Circularity Gap
- **Current State**: `EvidenceVerifier` computes `sha256` over the raw file buffer on disk.
- **Identified Gap**: Including `Log SHA-256: <hash>` inside the log file creates a self-referential paradox.
- **Reconciled Solution (ADR-20261102-002)**: The log file contains the RIF digest and metadata, but does **not** contain a self-hash field. `state.json` stores `evidence_hash: "sha256:<hex>"`, which covers the full finalized log file on disk byte-for-byte.

### 3.3 RIF Classification & Text Normalization Gaps
- **Current State**: File hashing previously assumed naive byte hashing or unreliable 8KB null-byte sniffing.
- **Identified Gap**: 
  - Null-byte sniffing fails on small binary blobs or valid UTF-8 binary streams, risking silent corruption via newline conversion.
  - Unnormalized text causes Windows CRLF vs Linux LF hash divergence.
  - Ambiguous precedence when patterns overlap creates non-deterministic fingerprinting.
- **Reconciled Solution**: Strict classification hierarchy:
  1. **Pattern Conflict Rejection**: If a file path matches both `text_patterns` and `binary_patterns`, configuration validation immediately fails closed with `CONFIG_PATTERN_CONFLICT`.
  2. **Three-Tier Evaluation Hierarchy**:
     - **Tier 1 (Explicit Pattern Overrides)**: User-defined glob in `quality-gates.json` (`text_patterns` / `binary_patterns`). Overrides known extension defaults.
     - **Tier 2 (Canonical Known Extensions)**: Built-in registry of unambiguous extensions (e.g. `.ts`, `.json`, `.png`).
     - **Tier 3 (Raw-Byte Binary Default)**: Any file without a Tier 1 or Tier 2 match defaults to raw-byte binary hashing.
  3. **No Content Heuristics & No Silent Normalization**: Content sniffing is strictly eliminated. Unclassified files are **never silently normalized**.
  4. **Strict Text Normalization**: Text files decode strictly as valid UTF-8 (rejecting invalid sequences with `INVALID_UTF8_ENCODING`), strip UTF-8 BOM (`0xEF, 0xBB, 0xBF`), and normalize CRLF and lone CR to LF before SHA-256 hashing.

### 3.4 Transaction Multi-File Atomicity & Crash Recovery
- **Current State**: `WriteAheadTransactionManager` executes multi-file atomic transactions.
- **Identified Gap**: External processes cannot roll back. Promoting logs outside WAL introduces unjournaled side effects.
- **Reconciled Solution**: Phase 4 streams output unlocked to staging files. Phase 5 passes both the canonical log (`files[0]`) and `state.json` (`files[1]`) into `executeTransaction()`. The ordering guarantees external readers never observe a dangling reference.

### 3.5 Process Staging-File Ownership & Reaping
- **Current State**: `defaultProcessLivenessChecker` in `src/core/lock/liveness.ts` safely verifies PID liveness and start-time recycling.
- **Identified Gap**: PID reuse races or malformed metadata could result in deleting active runner files or orphaned logs polluting disk.
- **Reconciled Solution**: Staging files pair `.log` and `.meta.json` containing `{ pid, run_nonce, hostname, created_at }`. Reaping occurs strictly if `isVerifiedDead === true` via `defaultProcessLivenessChecker`. Unverifiable metadata results in **conservative retention**. Zero wildcard deletion.
  - *Crash Window A (Log exists, `.meta.json` missing)*: File is retained indefinitely until manual operator remediation. Never deleted automatically.
  - *Crash Window B (`.meta.json` exists, log missing)*: Metadata is retained until liveness checker verifies runner is dead, then metadata is pruned safely.

### 3.6 Evidence Retention & Journal Durability
- **Current State**: Logs are serialized into `tx-journal.json`.
- **Identified Gap**: Large logs (> 5 MB) cause WAL journal bloat and memory exhaustion.
- **Reconciled Solution**: Logs exceeding 2 MB (`max_journaled_log_bytes`) are middle-truncated with an explicit notice, preserving diagnostic head and tail traces. Hashing is performed over the final truncated representation.

### 3.7 Schema Evolution & Compatibility Boundary
- **Current State**: `project-state.schema.json` v1.0.0 enforces `"additionalProperties": false` on `evidence[]`.
- **Identified Gap**: Writing extended quality-gate fields directly into `evidence[]` in state v1.0.0 causes schema validation failure.
- **Reconciled Solution**: 
  - Dual-phase schema evolution: Task 005A defines standard log-header encapsulation requiring zero schema changes to v1.0.0 (`path`, `evidence_hash`, `description` storing run summary).
  - Task 005B introduces `quality-gates.schema.json` and evolves `project-state.schema.json` to v1.1.0 with optional top-level `quality_gate` properties.
  - CLIs adhering to v1.0.0 cannot parse v1.1.0 state if new fields are present, but log headers remain 100% backwards-compatible across all CLI versions.

---

## 4. Check Taxonomy: Mandatory Universal vs. Stack-Specific Pluggable

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Quality Gate Check Taxonomy                                                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ MANDATORY UNIVERSAL CHECKS (Built-in, Platform-Agnostic, Non-Configurable)         │ │
│ │  - Schema Conformance (manifest.json & state.json)                                 │ │
│ │  - Governance Invariants (No active RFC blockers, no expired exceptions)          │ │
│ │  - Non-Circular Evidence Byte Hash Integrity                                       │ │
│ │  - Reproducible Input Fingerprint Freshness (CRLF/LF Normalized)                   │ │
│ │  - Working Tree Policy Conformance (Local / Handover / CI)                         │ │
│ │  - Exit Package Structural Completeness                                            │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                           │                                            │
│                                           ▼                                            │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ PLUGGABLE STACK-SPECIFIC CHECKS (Configurable, Declarative, Ecosystem-Specific)    │ │
│ │  - Code Formatting (Prettier, Black, Rustfmt, Goimports)                            │ │
│ │  - AST / Static Linting (ESLint, Ruff, Clippy, GolangCI-Lint)                       │ │
│ │  - Static Type Checking (TypeScript tsc, Pyright/Mypy, Rustc)                      │ │
│ │  - Automated Unit Testing (Jest, Vitest, Pytest, Go test, Cargo test)              │ │
│ │  - Contract & Integration Testing (Supertest, Pact, Testcontainers)                │ │
│ │  - Hermetic Build Compilation (Vite, Next build, Cargo build, Go build)            │ │
│ │  - Dependency Vulnerability Scanning (npm audit, pip-audit, cargo audit, Snyk)     │ │
│ │  - Secret Detection (Gitleaks, TruffleHog)                                         │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Summary of Architectural Gaps & Implementation Priorities

| Gap ID | Functional Domain | Severity | Impact on Governance | Target Component |
| :--- | :--- | :--- | :--- | :--- |
| **GAP-01** | Local Quality Runner | **Critical** | Prevents automated execution; requires ad-hoc manual scripts. | `playbook gate run` CLI command |
| **GAP-02** | Configuration Contract | **Critical** | No machine-readable definition of what commands execute for each gate. | `schemas/quality-gates.schema.json` |
| **GAP-03** | Multi-File WAL Evidence Registration | **Critical** | Log promotion outside WAL risks state-log desynchronization. | `WriteAheadTransactionManager.executeTransaction` |
| **GAP-04** | Non-Circular Hashing & LF RIF | **Critical** | Circular self-hashes or CRLF drift breaks cryptographic verification.| RIF Engine with LF Normalization |
| **GAP-05** | Three-Tier Working-Tree Policy | **High** | Rigid clean tree breaks local dev; loose dirty tree breaks CI determinism.| Working Tree Policy Manager |
| **GAP-06** | Process Tree Termination & Escalation | **High** | Abandoned child processes on Windows/POSIX cause port/file locks. | Process Group Tree-Killer |
| **GAP-07** | Subprocess Security & Secret Reality| **High** | Arbitrary script risks & false claims of secret redaction guarantee. | Env Allowlist & Trusted Workspace Model |
| **GAP-08** | Staging Reaping via Liveness | **High** | PID reuse and uncontrolled deletion risk deleting active files. | `defaultProcessLivenessChecker` Reaping |
| **GAP-09** | Log Truncation Policy (2 MB Cap) | **Medium** | Uncapped logs bloat WAL journal and degrade transaction recovery. | Middle-Truncation Log Assembler |
