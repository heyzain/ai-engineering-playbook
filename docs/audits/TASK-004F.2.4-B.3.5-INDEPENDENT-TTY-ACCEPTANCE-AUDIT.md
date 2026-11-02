# Task 004F.2.4-B.3.5 — Independent TTY Alignment Acceptance Audit Report

**Date**: 2026-11-02  
**Target Audited**: Task 004F.2.4-B.3.4 Implementation (`cc5d036`)  
**Objective**: Independently verify whether programmatic TTY default alignment correctly resolves limitation L1 from B.3.3 (`TASK-004F.2.4-B.3.3-FINAL-ACCEPTANCE-AUDIT.md`)  
**Governing Design**: [`governance/maintenance-stage-pivot-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/maintenance-stage-pivot-design.md) v1.3.0  
**Overall Acceptance Verdict**: **PARTIAL — ACCEPTED WITH DOCUMENTED LIMITATIONS**  
**Repository Working Tree Status**: Clean (committed under final closure).  

---

## 1. Executive Summary & Audit Mandate

In Task B.3.3, limitation **L1** documented an architectural asymmetry: `executeStagePivot()` only checked `if (options.isTTY === false)`, permitting headless programmatic callers that omitted `isTTY` (`undefined`) to bypass interactive terminal enforcement. Task B.3.4 (`cc5d036`) aligned `executeStagePivot()` with `approveGate()` by deriving standard stream interactivity (`Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)`) when `options.isTTY` is omitted.

This independent audit reconciles the findings and verifies:
1. Whether default TTY behavior is strictly fail-closed across both stdin and stdout.
2. Whether rejection occurs prior to any persistent or transient filesystem mutations.
3. The exact accessibility, semantics, and security boundary of programmatic `isTTY: true` parameters across public library exports.
4. CLI command integration and consistency across `pivot`, `approve`, and `reopen`.
5. Full regression safety across all 286 automated tests.

---

## 2. Category Audit & Findings

### 2.1 Category A: Default TTY Behavior

#### Verification Items & Findings

1. **Explicit `isTTY: false` Rejection**:
   - Source: [`pivot.ts#L422-L432`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/pivot.ts#L422-L432)
   - When `options.isTTY === false`, `options.isTTY !== undefined` evaluates to true, binding `isInteractive = false`.
   - The engine throws `TransactionError("TTY_REQUIRED", "Stage pivot requires an interactive terminal session with human attestation...")`.
   - Verified in `programmatic-tty-alignment.test.ts` (Scenario 2).

2. **Omitted `isTTY` Derivation & Fail-Closed Fallback**:
   - Source: [`pivot.ts#L422-L426`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/pivot.ts#L422-L426)
   - When `options.isTTY === undefined`, `isInteractive` evaluates `Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)`.
   - If either stream is non-interactive (e.g. redirected pipe, headless script, automated CI environment, child process), `isInteractive` evaluates to `false` and execution is rejected with `TTY_REQUIRED`.
   - Verified in `programmatic-tty-alignment.test.ts` (Scenario 3 via isolated child process, Scenario 4 via direct programmatic invocation).

3. **Dual Stream Requirement (stdin AND stdout)**:
   - Source: [`pivot.ts#L425`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/pivot.ts#L425) and [`approval.ts#L666`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts#L666)
   - Interactivity requires **both** `process.stdin.isTTY` and `process.stdout.isTTY`.
   - An execution piped to a file (`playbook pivot > log.txt`) or receiving piped input (`echo phrase | playbook pivot`) fails closed.

4. **Mutation Safety Prior to Rejection**:
   - In `executeStagePivot()`, the TTY check executes at line 427, immediately after target stage verification (line 414).
   - The check occurs **prior** to:
     - Baseline preflight evaluation (line 439).
     - Lock acquisition (line 468).
     - Staging directory validation (line 458).
     - Transaction preparation / journal creation (line 769).
   - In `approveGate()`, the check executes at line 669, **prior** to eligibility evaluation (line 694) and transaction preparation (line 757).
   - Zero lock files, zero journal entries, zero state modifications, and zero staged files are created upon TTY rejection.

#### Category A Verdict: **PASS**

---

### 2.2 Category B: Programmatic Authorization Boundary & Public Interface Exposure

#### Inspection of Public Library Exports & Calling Capability

1. **Public Interface Status of `executeStagePivot()` and `approveGate()`**:
   - **Inspection**: [`tooling/playbook-cli/src/index.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/index.ts) explicitly exports these functions:
     - Line 26: `export * from "./core/approval.js";` (exports `approveGate`)
     - Line 30: `export * from "./core/pivot.js";` (exports `executeStagePivot`)
   - [`package.json`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/package.json#L10-L11) defines:
     - `"main": "./dist/src/index.js"`
     - `"types": "./dist/src/index.d.ts"`
   - **Finding**: These functions are **public programmatic interfaces** of the package `@ai-engineering-playbook/cli`. Any external JavaScript/TypeScript program can import and invoke them directly. They are **not** internal private routines restricted to the CLI binary.

2. **Can an External Programmatic Caller Supply `isTTY: true` Without a Terminal?**:
   - **Finding**: **YES**. Any external script or programmatic consumer calling `executeStagePivot(targetDir, { ..., isTTY: true })` or `approveGate(targetDir, { ..., isTTY: true })` bypasses the process stream check:
     ```ts
     const isInteractive =
       options.isTTY !== undefined
         ? options.isTTY
         : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
     ```
   - When `options.isTTY` is `true`, `isInteractive` is `true`, even if `process.stdin.isTTY` and `process.stdout.isTTY` are both `false` (e.g. running headlessly in background workers, pipes, or unmonitored scripts).

3. **Technical Enforcement vs. Caller Assertion**:
   - A caller-supplied boolean `isTTY: true` **cannot and does not authenticate a human**, nor does it prove that an interactive terminal is present.
   - In Node.js, there is no technical enforcement or cryptographic boundary between in-process callers and library functions. A caller claiming `isTTY: true` is merely asserting interactivity without technical verification.
   - While secondary safeguards exist (`isForbiddenAgentName`, confirmation phrase validation, and state reason labeling as `(human-attested)`), an unlisted AI agent script can construct an invocation passing a human name, a valid role, the required confirmation phrase, and `{ isTTY: true }`, thereby executing the state transition headlessly.
   - Because the trust boundary between external programmatic callers and the core state-transition functions is not technically enforced, this category cannot be evaluated as PASS.

4. **Crucial Distinction: Terminal Interactivity vs. Authenticated Human Identity**:
   - **Terminal Interactivity (`isTTY`)**: Verifies that standard I/O streams are attached to a character device. At the CLI layer (`runPivot`, `runApprove`), this is physically checked before prompting the operator.
   - **Human Attestation**: In Solo Developer mode, authorization is established by a claimed name, role, and confirmation phrase. It is an **unauthenticated attestation**.
   - **Authenticated Identity**: Genuine human identity authentication requires cryptographic signatures (GPG/SSH keys) or trusted third-party assertions (Team Mode PR approvals).
   - Sidecars and audit documents explicitly disclaim authentication:
     `"Caller identity is human-asserted and unauthenticated cryptographically."`

#### Category B Verdict: **PARTIAL**
- **CLI Terminal Attestation**: **PASS** (CLI entry points strictly enforce TTY requirements; however, TTY presence verifies terminal stream interactivity and does not authenticate human identity).
- **Programmatic Trust Boundary**: **PARTIAL** (`executeStagePivot` and `approveGate` are public library exports where `isTTY: true` is an unverified caller-supplied assertion, allowing programmatic bypass of stream checks).

---

### 2.3 Category C: CLI Integration & Consistency

#### Entry Points Audited

| Entry Point | File & Line | TTY Check Implementation | Core Forwarding |
| :--- | :--- | :--- | :--- |
| **`playbook pivot` (`runPivot`)** | [`src/commands/pivot.ts#L40-L64`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/pivot.ts#L40-L64) | `if (options.nonInteractive \|\| !isTTY)` -> Exit 1 (`TTY_REQUIRED`) | Passes `isTTY: true` at line 178 |
| **`playbook approve` (`runApprove`)** | [`src/commands/approve.ts#L43-L55`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts#L43-L55) | `if (options.nonInteractive \|\| !isTTY)` -> Exit 1 (`TTY_REQUIRED`) | Passes `isTTY: true` at line 305 |
| **`playbook reopen` (`runReopen`)** | [`src/commands/reopen.ts#L44-L58`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/reopen.ts#L44-L58) | `if (options.nonInteractive \|\| !isTTY)` -> Exit 1 (`TTY_REQUIRED`) | Core `reopenLifecycle` relies on CLI boundary |

#### Observations
- CLI interactive workflows (`runPivot` and `runApprove`) prompt the operator interactively, verify the exact confirmation phrase, and then forward the verified `isTTY: true` context to the core function.
- CLI headless or piped invocations (`--non-interactive` or `isTTY: false`) fail closed at the CLI boundary with exit code 1 without invoking core routines.
- Core functions (`executeStagePivot` and `approveGate`) enforce identical `isInteractive` fallback logic when `isTTY` is omitted.

#### Category C Verdict: **PASS**

---

### 2.4 Category D: Independent Regression & Verification

#### Commands Executed & Verified

1. **TypeScript Build**:
   ```
   Command: npm run build --prefix tooling/playbook-cli
   Exit Code: 0
   Result: 0 type errors, schemas synchronized.
   ```

2. **Dedicated B.3.4 Test Suite**:
   ```
   Command: node --test tooling/playbook-cli/dist/tests/programmatic-tty-alignment.test.js
   Exit Code: 0
   Suites: 1
   Tests: 8 passed, 0 failed, 0 skipped
   Duration: 1.803s
   ```
   - Scenario 1: Explicit `isTTY: true` succeeds and records `human_attestation`.
   - Scenario 2: Explicit `isTTY: false` rejects with `TTY_REQUIRED` and zero mutations.
   - Scenario 3: Real spawned child process with pipe rejects fail-closed with code `42`.
   - Scenario 4: Omitted `isTTY` in programmatic call derives process TTY and fails closed.
   - Scenario 5: CLI interactive approval succeeds when `isTTY` is true.
   - Scenario 6: CLI piped/headless rejection enforces `TTY_REQUIRED`.
   - Scenario 7: Programmatic bypass attempts blocked by TTY and agent identity guards.
   - Scenario 8: Valid pivot, deliverable verification, gate approval, and advance end-to-end.

3. **Complete Playbook CLI Test Suite**:
   ```
   Command: npm test --prefix tooling/playbook-cli
   Exit Code: 0
   Suites: 26
   Tests: 286 passed, 0 failed, 0 skipped
   Duration: 24.691s
   ```

#### Test Authenticity Audit
- Tests in `programmatic-tty-alignment.test.ts` genuinely exercise the actual system:
  - Scenario 3 spawns a real Node.js child process executing an external script under standard OS pipe conditions (`stdio: "pipe"`), proving that headless subprocesses omitting `isTTY` fail closed with `TTY_REQUIRED`.
  - Assertions check file presence, directory listings, JSON schema validity, transaction journal states, and state transition reasons.
  - Zero test mocks are used for the transaction manager or filesystem operations.

#### Category D Verdict: **PASS**

---

### 2.5 Category E: Mutation Safety Audit

#### Verification Under Failures

When `executeStagePivot()` or `runPivot()` rejects an invocation due to `TTY_REQUIRED`:
1. **State File (`.playbook/state.json`)**: Unaltered. `current_stage` remains 1; `stage_status` remains `in_progress`.
2. **Manifest File (`.playbook/manifest.json`)**: Unaltered. `active_lifecycle_stage` remains 1.
3. **Transaction Journal (`.playbook/tx-journal.json`)**: Never created. Verified via `fs.existsSync() === false`.
4. **Pivot Snapshots (`.playbook/pivots/`)**: Zero files created. Directory remains empty.
5. **PRD Core (`docs/prd/PRD-CORE.md`)**: Content unchanged. Original problem statement is preserved.
6. **PRD Archive (`docs/prd/archive/`)**: Zero archive documents created.
7. **Transaction Lock (`.playbook/playbook.lock`)**: Released or never acquired.

#### Category E Verdict: **PASS**

---

## 3. Severity Classification of Audit Findings

| ID | Severity | Category | Description | Status |
| :--- | :--- | :--- | :--- | :---: |
| **F-01** | **Medium** | Architecture | `executeStagePivot()` and `approveGate()` are public library exports in `index.ts`. External programmatic callers can supply `{ isTTY: true }` without an actual interactive terminal attached to standard I/O, allowing headless programmatic bypass of stream checks if the caller supplies a valid non-blacklisted human name and role. | Documented Limitation |
| **F-02** | **Informational** | Scope | `reopenLifecycle` core API relies on `runReopen` CLI for TTY enforcement rather than enforcing an internal `isInteractive` check. Not part of the stage pivot scope, but recommended for future consistency. | Documented Limitation |

---

## 4. Final Verdict & Acceptance Decision

| Category | Requirement / Invariant | Verdict | Notes |
| :--- | :--- | :---: | :--- |
| **A. Default TTY Behavior** | Fail-closed on omitted or unavailable TTY | **PASS** | Evaluates both stdin and stdout before any mutation. |
| **B. Authorization Boundary** | Programmatic public interface enforcement | **PARTIAL** | Core functions are public exports; `isTTY: true` is an unverified caller-supplied boolean. |
| **C. CLI Integration** | Strict TTY enforcement on CLI entry points | **PASS** | CLI wrappers verify TTY and pass verified context to core. |
| **D. Regression Safety** | Complete test suite execution | **PASS** | 286/286 tests pass across 26 suites (0 failures). |
| **E. Mutation Safety** | Zero mutations on TTY rejection | **PASS** | State, manifest, PRD, and journal remain untouched. |

### Overall Verdict: **PARTIAL — ACCEPTED WITH DOCUMENTED LIMITATIONS**

Task 004F.2.4-B.3.4 resolves limitation **L1** for default invocations: omitting `isTTY` now derives process stream interactivity and fails closed. CLI entry points strictly enforce TTY requirements, though terminal interactivity constitutes unauthenticated human attestation rather than authenticated identity. 

Because `executeStagePivot()` and `approveGate()` are exported public library APIs where `isTTY: true` can be supplied by programmatic callers without hardware/cryptographic validation of terminal interactivity, the programmatic authorization boundary is rated **PARTIAL**. Full cryptographic authentication remains reserved for Team Mode.
