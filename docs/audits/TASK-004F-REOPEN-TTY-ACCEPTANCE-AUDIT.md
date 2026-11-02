# TASK-004F-REOPEN-TTY-ACCEPTANCE-AUDIT.md — Independent Reopen TTY Acceptance Audit Report

> **Audit Type**: Independent Adversarial Acceptance Audit  
> **Target Scope**: Reopen API TTY Enforcement & Programmatic Alignment  
> **Audited Component**: `tooling/playbook-cli`  
> **Audited Files**:
> - [`tooling/playbook-cli/src/core/reopen.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/reopen.ts)
> - [`tooling/playbook-cli/src/commands/reopen.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/reopen.ts)
> - [`tooling/playbook-cli/tests/prd-applicability.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/prd-applicability.test.ts)
> - [`tooling/playbook-cli/tests/reopen.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/reopen.test.ts)
> - [`tooling/playbook-cli/tests/reopen-tty-alignment.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/reopen-tty-alignment.test.ts)  
> **Date**: 2026-11-02  
> **Audit Status**: **PARTIAL — ACCEPTED WITH DOCUMENTED LIMITATIONS** (Consistent with B.3.5)

---

## 1. Executive Summary

This independent acceptance audit evaluated the uncommitted changes implementing fail-closed TTY enforcement for `reopenLifecycle()`.

Prior to this implementation, `executeStagePivot()` and `approveGate()` enforced interactive terminal sessions (`TTY_REQUIRED`) at the core API entry point, whereas `reopenLifecycle()` only enforced TTY validation at the CLI command layer (`runReopen()`). Direct programmatic invocations of `reopenLifecycle()` could execute headlessly without interactive attestation.

The current implementation aligns `reopenLifecycle()` with the established authorization pattern:
1. `options.isTTY: false` is rejected fail-closed with `TransactionError("TTY_REQUIRED")`.
2. Omitted `options.isTTY` (`undefined`) derives interactivity from `Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)`, failing closed in headless, piped, or automated environments.
3. The guard executes at the entry of `reopenLifecycle()`, before any filesystem reads, state validations, lock acquisitions, or WAL transaction staging, ensuring zero mutations on rejection.
4. CLI `runReopen()` verifies actual terminal interactivity before prompting for confirmation and forwarding `isTTY: true`.

In conformance with the reconciliation verdict of **B.3.5** (`TASK-004F.2.4-B.3.5.1`), Category 4 is evaluated as **PARTIAL**: while the CLI boundary enforces interactive terminal sessions, programmatic callers can supply `isTTY: true` without cryptographic human authentication. This is recorded as a documented limitation of the unauthenticated attestation model.

---

## 2. Audit Matrix & Category Verdicts

| Audit Category | Evaluation Focus | Verdict | Summary Findings |
| :--- | :--- | :---: | :--- |
| **Category 1** | Default TTY Rejection | **PASS** | Explicit `false` and omitted `isTTY` in headless environments reject fail-closed with `TTY_REQUIRED`. Both stdin and stdout are required. |
| **Category 2** | Pre-Mutation & Pre-Read Rejection | **PASS** | TTY guard executes at the top of `reopenLifecycle()` before reading manifest/state, before lock acquisition, and before transaction staging. |
| **Category 3** | CLI TTY Verification | **PASS** | `runReopen()` strictly evaluates `options.nonInteractive` and process stdio TTY status before prompting and forwarding `isTTY: true`. |
| **Category 4** | Programmatic Boundary & Attestation Limitation | **PARTIAL** | Core API permits callers to pass `isTTY: true`. Consistent with B.3.5, this constitutes unauthenticated attestation, not authenticated identity. |
| **Category 5** | Test Integrity & Genuineness | **PASS** | All 8 dedicated test scenarios and wrapped regression suites genuinely exercise real code paths, child process pipes, and zero mutations. |
| **Category 6** | Test Suite Execution | **PASS** | 8/8 dedicated tests, 15/15 reopen tests, and 294/294 full CLI tests pass cleanly with zero failures. |
| **Category 7** | Diff Scope & Containment | **PASS** | Diff is strictly confined to reopen TTY alignment and tests; zero unrelated code, schemas, or transaction modifications. |

**Overall Acceptance Verdict**: **PARTIAL — ACCEPTED WITH DOCUMENTED LIMITATIONS**

---

## 3. Detailed Technical Verification

### Category 1: Default TTY Rejection
**Requirement**: `reopenLifecycle()` must reject omitted or false TTY context when stdin/stdout are non-interactive.
- **Implementation Check**: In [`tooling/playbook-cli/src/core/reopen.ts#L47-L57`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/reopen.ts#L47-L57):
  ```ts
  const isInteractive =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (!isInteractive) {
    throw new TransactionError(
      "TTY_REQUIRED",
      "Lifecycle reopening requires an interactive terminal session with human attestation. Automated, headless, or scripted execution claiming human authorization is strictly prohibited."
    );
  }
  ```
- **Adversarial Verification**:
  - `options.isTTY: false` -> Evaluates `isInteractive = false`, immediately throwing `TransactionError("TTY_REQUIRED")`.
  - `options.isTTY: undefined` in headless node environment -> `process.stdin.isTTY` and `process.stdout.isTTY` are undefined/false -> Throws `TransactionError("TTY_REQUIRED")`.
  - Asymmetric stdio (stdin true / stdout false, or stdin false / stdout true) -> Evaluates `Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)` -> Returns false, rejecting fail-closed.
  - Subprocess pipe (`stdio: "pipe"`) -> Child process importing `reopenLifecycle()` without `isTTY` exits with code 42 (`TTY_REQUIRED`).
- **Verdict**: **PASS**

---

### Category 2: Pre-Mutation and Pre-Read Rejection
**Requirement**: Rejection must occur before any persistent mutation, filesystem read, or lock acquisition.
- **Implementation Check**:
  - In [`tooling/playbook-cli/src/core/reopen.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/reopen.ts):
    - Lines 47–57: TTY guard evaluation.
    - Line 60: Path resolution (`manifestPath`, `statePath`, `sidecarPath`).
    - Line 64: Filesystem existence check (`fs.existsSync`).
    - Line 74: Filesystem read (`fs.readFileSync`).
    - Line 208: Lock manager acquisition (`lockManager.acquireLock`).
    - Line 235: Transaction manager staging and WAL journal writing.
- **Adversarial Verification**:
  - Tested against an uninitialized empty directory (`Scenario 8` in `reopen-tty-alignment.test.ts`). If filesystem checks preceded TTY checks, the operation would throw `PROJECT_UNINITIALIZED`. Because the TTY guard executes first, it throws `TTY_REQUIRED`.
  - Tested against initialized directories (`Scenarios 2, 3, 4` in `reopen-tty-alignment.test.ts`). Verified that on rejection:
    - `.playbook/tx-journal.json` does not exist.
    - `.playbook/milestones/state-M-1.1.0.json` does not exist.
    - `.playbook/state.json` is bit-for-bit identical to pre-test state.
    - `.playbook/manifest.json` is bit-for-bit identical to pre-test manifest.
- **Verdict**: **PASS**

---

### Category 3: CLI TTY Verification Before Forwarding
**Requirement**: CLI `runReopen()` must verify actual TTY state before forwarding `isTTY: true`.
- **Implementation Check**:
  - In [`tooling/playbook-cli/src/commands/reopen.ts#L38-L68`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/reopen.ts#L38-L68):
    ```ts
    const isTTY =
      options.isTTY !== undefined
        ? options.isTTY
        : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

    if (options.nonInteractive || !isTTY) {
      const msg =
        "Error: [TTY_REQUIRED] Lifecycle reopening requires an interactive terminal session.\nAutomated, scripted, or piped reopening invocations are strictly prohibited.";
      // ...
      return { success: false, exitCode: 1, message: msg, error: "TTY_REQUIRED" };
    }
    ```
  - Only after passing this guard and successfully verifying the human confirmation phrase via the interactive `prompter` does `runReopen()` reach line 298–306:
    ```ts
    const res = await reopenLifecycle(targetDir, {
      milestoneId,
      milestoneName,
      targetStage,
      reason,
      authorizedBy,
      role,
      isTTY: true,
    });
    ```
- **Adversarial Verification**:
  - When `runReopen` is invoked with `isTTY: false` or `nonInteractive: true`, it returns `{ success: false, exitCode: 1, error: "TTY_REQUIRED" }` without prompting and without invoking `reopenLifecycle()`.
- **Verdict**: **PASS**

---

### Category 4: Programmatic Authorization Boundary & Attestation Limitation
**Requirement**: Public programmatic callers can still supply `isTTY: true`; document this as an unauthenticated attestation limitation, consistent with B.3.5.
- **Implementation Analysis**:
  - `reopenLifecycle(targetDir, options)` is exported from `src/core/reopen.ts`.
  - While it is not re-exported from `src/index.ts`, any Node/ESM module can import `reopenLifecycle` from `@ai-engineering-playbook/cli/dist/src/core/reopen.js` (or via source paths in workspace tooling).
  - A programmatic caller can supply `{ isTTY: true }` alongside an unauthenticated human name (`authorizedBy: "Alice Human"`).
  - The guard rejects known agent identifiers (`isForbiddenAgentName`), but cannot cryptographically verify whether the caller is a genuine human or an automated script masquerading as one.
- **Consistency with B.3.5 Findings**:
  - **Technical Enforcement vs. Caller Assertion**: A caller-supplied boolean `isTTY: true` cannot and does not authenticate a human, nor does it prove that an interactive terminal is present. In Node.js, there is no technical enforcement or cryptographic isolation between in-process callers and library functions. A caller passing `isTTY: true` is merely asserting interactivity without technical verification.
  - **Crucial Distinction: Terminal Interactivity vs. Authenticated Human Identity**:
    - *Terminal Interactivity (`isTTY`)*: Verifies standard I/O streams are attached to a character device. At the CLI layer (`runReopen`), this is physically checked before prompting the operator.
    - *Human Attestation*: Authorization in solo mode is established by a claimed name, role, and confirmation phrase. It is an **unauthenticated attestation**.
    - *Authenticated Identity*: Genuine human identity authentication requires cryptographic signatures (GPG/SSH keys) or trusted third-party assertions (Team Mode PR approvals).
- **Limitation Statement (Consistent with B.3.5)**:
  > **Documented Governance Limitation**:
  > The `isTTY` option in `reopenLifecycle()`, `executeStagePivot()`, and `approveGate()` functions as an **unauthenticated human attestation signal**, not a cryptographic authentication mechanism.
  > While the CLI command layer (`playbook reopen`) strictly enforces interactive terminal sessions on `process.stdin` and `process.stdout`, programmatic callers with code execution privileges can supply `{ isTTY: true }` to bypass the interactive terminal check.
- **Verdict**: **PARTIAL**

---

### Category 5: Test Integrity & Genuineness
**Requirement**: Inspect all changed tests and confirm they genuinely exercise the claimed behavior.
- **Inspection**:
  1. [`tooling/playbook-cli/tests/reopen-tty-alignment.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/reopen-tty-alignment.test.ts):
     - `Test 1`: Genuine reopen execution verifying milestone snapshot, state transition, and WAL commit under `isTTY: true`.
     - `Test 2`: Explicit `isTTY: false` rejects with `TTY_REQUIRED` and verifies zero mutations against initial file hashes.
     - `Test 3`: Programmatic call without `isTTY` in headless environment fails closed with `TTY_REQUIRED` and zero mutations.
     - `Test 4`: Spawns a genuine detached Node subprocess via `execFileSync` with `stdio: "pipe"`. Standalone ESM script calls `reopenLifecycle()` without `isTTY` and exits with code 42 upon catching `TTY_REQUIRED`.
     - `Test 5`: Asymmetric stream tests (`stdin: true, stdout: false` and `stdin: false, stdout: true`) confirm both combinations fail closed.
     - `Test 6`: `runReopen()` integration with mock prompter confirms interactive confirmation phrase entry forwards `isTTY: true` and succeeds.
     - `Test 7`: `runReopen()` rejects on `isTTY: false` and `nonInteractive: true`.
     - `Test 8`: Verifies guard evaluation order on non-existent directory.
  2. [`tooling/playbook-cli/tests/reopen.test.ts#L9-L16`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/reopen.test.ts#L9-L16):
     - Wraps `coreReopenLifecycle` to default `isTTY: true`, preserving the existing 15 scenarios testing WAL rollforward/rollback, snapshot sealing, collision detection, and lock timeouts.
     - Scenario 7 continues to test CLI non-interactive execution rejection.
  3. [`tooling/playbook-cli/tests/prd-applicability.test.ts#L295-L305`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/prd-applicability.test.ts#L295-L305):
     - Supplies `isTTY: true` to the second reopen call so it correctly exercises the state invariant `LIFECYCLE_ALREADY_REOPENED`.
- **Verdict**: **PASS**

---

### Category 6: Test Suite Execution
**Requirement**: Independently run the dedicated and full test suites.
- **Execution Evidence**:
  1. **Dedicated Reopen TTY Suite**:
     - Command: `node --test tooling/playbook-cli/dist/tests/reopen-tty-alignment.test.js`
     - Result: `ℹ tests 8, ℹ suites 1, ℹ pass 8, ℹ fail 0` (709.5ms)
  2. **Core Reopen Regression Suite**:
     - Command: `node --test tooling/playbook-cli/dist/tests/reopen.test.js`
     - Result: `ℹ tests 15, ℹ suites 1, ℹ pass 15, ℹ fail 0` (5,462.4ms)
  3. **Full CLI Test Suite**:
     - Command: `npm test --prefix tooling/playbook-cli`
     - Result: `ℹ tests 294, ℹ suites 27, ℹ pass 294, ℹ fail 0` (27,565.4ms)
- **Verdict**: **PASS**

---

### Category 7: Diff Scope & Containment
**Requirement**: Inspect the complete diff for unrelated changes.
- **Git Working Tree Status**:
  The working tree currently contains the uncommitted implementation changes, tests, and audit deliverable awaiting review:
  ```
  Changes not staged for commit:
    modified:   tooling/playbook-cli/src/commands/reopen.ts
    modified:   tooling/playbook-cli/src/core/reopen.ts
    modified:   tooling/playbook-cli/tests/prd-applicability.test.ts
    modified:   tooling/playbook-cli/tests/reopen.test.ts

  Untracked files:
    docs/audits/TASK-004F-REOPEN-TTY-ACCEPTANCE-AUDIT.md
    tooling/playbook-cli/tests/reopen-tty-alignment.test.ts
  ```
  These files are uncommitted changes and do not represent a clean working tree until committed together.
- **Diff Analysis**:
  - `src/commands/reopen.ts`: +1 line (`isTTY: true,` passed to `reopenLifecycle`).
  - `src/core/reopen.ts`: +13 lines (`isTTY?: boolean` in options interface, early TTY check lines 47–57).
  - `tests/prd-applicability.test.ts`: +1 line (`isTTY: true,` in reopen call).
  - `tests/reopen.test.ts`: +8/-1 lines (wrapped `reopenLifecycle` helper).
  - `tests/reopen-tty-alignment.test.ts`: +517 lines (new dedicated test file).
  - Zero modifications to governance documentation, schemas, transaction engine, or unrelated commands.
- **Verdict**: **PASS**

---

## 4. Final Audit Verdict

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FINAL ACCEPTANCE VERDICT                        │
│                                                                        │
│            PARTIAL — ACCEPTED WITH DOCUMENTED LIMITATIONS              │
│                                                                        │
│  - All technical criteria for fail-closed TTY enforcement are met.     │
│  - Zero persistent mutations occur on non-interactive rejection.       │
│  - CLI entry points strictly verify interactive terminal sessions.     │
│  - Programmatic caller bypass of TTY via isTTY: true is documented    │
│    as an unauthenticated attestation limitation (identical to B.3.5).  │
│  - 294/294 tests passing across 27 test suites.                        │
└────────────────────────────────────────────────────────────────────────┘
```
