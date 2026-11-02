# Task 004F.2.4-B.3.4 — Programmatic TTY Default Alignment Report

**Date**: 2026-11-02  
**Target Remediation**: Limitation L1 identified in [`TASK-004F.2.4-B.3.3-FINAL-ACCEPTANCE-AUDIT.md`](file:///f:/workspace/ai-engineering-playbook/docs/audits/TASK-004F.2.4-B.3.3-FINAL-ACCEPTANCE-AUDIT.md)  
**Base Commit**: `9320c45`  
**Governing Design**: [`governance/maintenance-stage-pivot-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/maintenance-stage-pivot-design.md) v1.3.0  
**Status**: COMPLETE / VERIFIED  

---

## 1. Executive Summary & Root Cause Analysis

### 1.1 Root Cause of Limitation L1
In commit `9db3420` (Task B.3.2), interactive TTY enforcement was introduced to `executeStagePivot()` via the check:
```ts
if (options.isTTY === false) {
  throw new TransactionError("TTY_REQUIRED", ...);
}
```
While this successfully rejected explicit calls passing `isTTY: false`, it left an architectural asymmetry between the CLI command wrapper (`runPivot`) and the programmatic core library (`executeStagePivot`):
- `runPivot` evaluated `Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)`, correctly blocking headless or piped CLI execution with exit code 1.
- `executeStagePivot` only evaluated `options.isTTY === false`. If a programmatic caller (e.g. an automated agent script or library consumer) invoked `executeStagePivot()` directly and omitted `isTTY` (`undefined`), the check evaluated to false and allowed headless execution to proceed.
- Furthermore, `approveGate()` in `approval.ts` already enforced fail-closed TTY derivation:
  ```ts
  const isInteractive =
    options.isTTY !== undefined
      ? options.isTTY
      : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!isInteractive) {
    throw new TransactionError("TTY_REQUIRED", ...);
  }
  ```
This resulted in inconsistent authorization contracts across the two core state-transition functions.

### 1.2 Exact Behavior Before vs. After

| Execution Context / Argument | Behavior Before (B.3.2 / B.3.3) | Behavior After (B.3.4) |
| :--- | :--- | :--- |
| **`executeStagePivot` with `isTTY: true`** | Allowed interactive attestation flow. | Allowed interactive attestation flow. |
| **`executeStagePivot` with `isTTY: false`** | Rejected with `TTY_REQUIRED`. | Rejected with `TTY_REQUIRED`. |
| **`executeStagePivot` with omitted `isTTY` in headless environment (`stdin.isTTY == false`)** | **FAIL-OPEN**: Execution proceeded without TTY attestation. | **FAIL-CLOSED**: Derives actual process TTY (`false`) and throws `TransactionError("TTY_REQUIRED")`. |
| **`executeStagePivot` with omitted `isTTY` in real interactive terminal** | Executed normally. | Derives actual process TTY (`true`) and executes normally. |
| **CLI `runPivot` invoked via interactive terminal** | Executed normally, but did not forward `isTTY: true` to core. | Passes verified interactive context `isTTY: true` directly to `executeStagePivot()`. |

---

## 2. Public Entry Points Inspected

1. **`executeStagePivot(targetDir, options)`** ([`pivot.ts#L421-L432`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/pivot.ts#L421-L432)):
   - Updated to derive TTY status from `options.isTTY !== undefined ? options.isTTY : Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)`.
   - Rejects with `TTY_REQUIRED` if `!isInteractive`.
2. **`runPivot(options)`** ([`pivot.ts#L34-L64`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/pivot.ts#L34-L64) & [L171-L180](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/pivot.ts#L171-L180)):
   - Checks `options.nonInteractive || !isTTY` upfront.
   - Forwards verified interactive context `isTTY: true` to `executeStagePivot()`.
3. **`approveGate(targetDir, options)`** ([`approval.ts#L663-L674`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts#L663-L674)):
   - Confirmed consistent: enforces `isInteractive` check with identical process TTY fallback.
4. **`runApprove(options)`** ([`approve.ts#L43-L55`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts#L43-L55) & [L305](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts#L305)):
   - Confirmed consistent: checks `options.nonInteractive || !isTTY`, forwards `isTTY: true` to `approveGate()`.
5. **`runReopen(options)`** ([`reopen.ts#L38-L58`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/reopen.ts#L38-L58)):
   - Confirmed consistent: checks `options.nonInteractive || !isTTY` at CLI boundary.

---

## 3. Test Suite Implementation & Verification Evidence

A dedicated, isolated test suite was created in [`tooling/playbook-cli/tests/programmatic-tty-alignment.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/programmatic-tty-alignment.test.ts) covering all 8 required scenarios:

```
Command: node --test tooling/playbook-cli/dist/tests/programmatic-tty-alignment.test.js
▶ Task 004F.2.4-B.3.4 — Programmatic TTY Default Alignment
  ✔ 1. Explicit isTTY: true allows interactive attestation flow (275.1878ms)
  ✔ 2. Explicit isTTY: false rejects with TTY_REQUIRED and zero mutations (9.4968ms)
  ✔ 3. Omitted isTTY in a real headless child process fails closed with TTY_REQUIRED (258.0535ms)
  ✔ 4. Omitted isTTY in programmatic call derives process TTY and fails closed when unavailable (9.7664ms)
  ✔ 5. Existing CLI interactive approval succeeds when isTTY is true (255.269ms)
  ✔ 6. Existing CLI piped/headless rejection enforces TTY_REQUIRED (9.876ms)
  ✔ 7. Programmatic bypass attempts are thwarted across identity and TTY guards (169.2569ms)
  ✔ 8. Existing valid pivot and approval workflows succeed end-to-end (406.3816ms)
✔ Task 004F.2.4-B.3.4 — Programmatic TTY Default Alignment (1395.017ms)
ℹ tests 8
ℹ suites 1
ℹ pass 8
ℹ fail 0
```

### 3.1 Verification of Subprocess Headless Execution (Scenario 3)
Scenario 3 launches a real, separate Node.js child process (`node headless-runner.mjs`) with `stdio: "pipe"` (where `process.stdin.isTTY` is undefined/false) importing `executeStagePivot()` and calling it without `isTTY`. The subprocess fails closed with code `42` (`TTY_REQUIRED`), proving that external scripts or uninstrumented node processes cannot silently bypass the interactive requirement.

### 3.2 Unit Test Execution Context Preservation
In unit test environments (`pivot.test.ts`, `pivot-storage-enforcement.test.ts`, `pivot-governance-hardening.test.ts`), test runners execute headlessly. To preserve the intent of those tests as simulating authorized human execution without altering individual scenario logic, a fixture wrapper was supplied passing `{ isTTY: true, ...options }`. Any explicit option (such as `isTTY: false`) continues to override the wrapper.

---

## 4. Full CLI Test Suite Regression Evidence

The entire Playbook CLI test suite was executed to ensure zero regressions across all 26 test suites:

```
Command: npm test --prefix tooling/playbook-cli
Exit Code: 0
Total Suites: 26
Total Tests: 286
Passed: 286
Failed: 0
Skipped: 0
Duration: 22.798s
```

---

## 5. Requirement Verification Matrix

| Requirement | Description | Status | Evidence |
| :--- | :--- | :---: | :--- |
| **1. Explicit `isTTY: true`** | Allows interactive attestation flow | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 1 |
| **2. Explicit `isTTY: false`** | Rejects with `TTY_REQUIRED` | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 2 |
| **3. Omitted `isTTY` in Headless Process** | Real spawned child process with pipe rejects fail-closed | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 3 |
| **4. Omitted `isTTY` (Unavailable TTY)** | Programmatic direct call derives process TTY and fails closed | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 4 |
| **5. CLI Interactive Approval** | Interactive CLI approval succeeds when TTY is available | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 5 |
| **6. CLI Piped/Headless Rejection** | CLI rejects piped and non-interactive calls | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 6 |
| **7. Programmatic Bypass Attempts** | Unknown agent blocked by TTY; known agent blocked by agent check | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 7 |
| **8. Valid Workflows End-to-End** | Pivot to Stage 0 -> verify deliverable -> approve Gate 0 -> advance | **PASS** | `programmatic-tty-alignment.test.ts` Scenario 8 |
| **9. Scientific Honesty** | No claim of cryptographic human authentication | **PASS** | Records `human_attestation` and limitations |
| **10. Regression Invariance** | Full CLI suite passes with 0 failures | **PASS** | 286/286 tests passed across 26 test suites |

---

## 6. Conclusion & Acceptance Status

Limitation **L1** is fully resolved. `executeStagePivot()` now strictly enforces fail-closed TTY derivation identical to `approveGate()`. Missing or unavailable TTY information never silently authorizes the operation across either CLI or programmatic interfaces.
