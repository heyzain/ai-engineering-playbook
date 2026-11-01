# Task 004F.2.4-B.1 — Stage Pivot Architectural Acceptance Audit Report

> **Auditor**: Antigravity (AI Engineering Agent)  
> **Date**: 2026-11-01  
> **Target Commit Under Audit**: `81e91f7` (Task 004F.2.4-B Stage Pivot Implementation)  
> **Target Audit Commit**: `fa5c937` (Initial B.1 Acceptance Audit)  
> **Audit Correction Task**: Task 004F.2.4-B.1.1 (Audit Traceability & Design Compliance Correction)  
> **Governing Architecture**: `governance/maintenance-stage-pivot-design.md` v1.3.0  
> **Foundation Commits**: `7bb91e6` (Phase A WAL Upgrade), `06b86f5` & `f0ab76a` (Adversarial WAL Audit)  
> **Test Suite**: 245 passing tests across 16 test suites (`tooling/playbook-cli`), 0 failures, 0 warnings.  
> **Final Verdict**: **ACCEPTED WITH DOCUMENTED LIMITATIONS**

---

## 1. Audit Correction History (Task 004F.2.4-B.1.1)

This audit report revises and strengthens the initial acceptance audit committed in `fa5c937`. A forensic re-examination of the test suite (`pivot.test.ts`), transaction engine (`transaction-manager.ts`), and CLI command layer (`commands/pivot.ts`) identified and resolved five substantive traceability and precision discrepancies:

1. **Test-to-Requirement Mapping Corrections**:
   - The initial audit table in `fa5c937` contained arbitrary test-number assignments that diverged from the actual test definitions in `tooling/playbook-cli/tests/pivot.test.ts`.
   - **T38 vs. T39 vs. T40 Clarified**: T38 in `pivot.test.ts` is *"Original PRD Hash Survives Archive Banner"*, T39 is *"Corrupt Journal Fails Closed"*, and T40 is *"COMMITTED Cleanup Is Idempotent"*. The audit matrix now reflects the authoritative source definitions in `pivot.test.ts`.
   - **Condition Mappings Corrected**: Condition C1 is tested by T4 (not T1/T2); Condition C2 is tested by T2 (not T3/T4); Condition C3 is tested by T3 (not T5); Condition C4 is tested by T5 (not T6-T8); Condition C5 is tested by T6, T7, and T8.
   - **Unexercised Requirements Classified**: Condition C6 (`PIVOT_TARGET_UNSUPPORTED`) and Agent Prohibition (H3 in pivot context) were found to be implemented in runtime source but lack dedicated tests in `pivot.test.ts`. They are now strictly classified as `NOT TESTED` in the pivot test suite rather than marked `PASS`.
2. **Storage Layout Discrepancy Resolved**:
   - Disproved the erroneous claim that *"CLI scaffolds missing directories"*. The CLI does NOT provision directories on the fly; preflight checks fail closed with `PIVOT_STORAGE_LAYOUT_MISSING`.
   - Identified a design deviation: while `checkPivotEligibility` fails closed before prompt display, `WriteAheadTransactionManager.prepare()` contains fallback `fs.mkdirSync` behavior, and `PIVOT_STORAGE_LAYOUT_MISSING` is not tested in `pivot.test.ts`. This requirement is classified as `DESIGN DEVIATION / NOT TESTED`.
3. **Snapshot Immutability Claims Corrected**:
   - Replaced all inaccurate descriptions of OS write protection (`0o444`) as "immutable" or "non-deletable".
   - Documented the exact technical reality: `0o444` provides advisory application-level file-modification protection. It does not prevent POSIX directory-level unlinking. Historical snapshot preservation is guaranteed by write-ahead transaction logic, monotonic sequence discovery, `createOnly: true` collision rejection, and Git version control.
4. **Corrupt Journal Error Pathway Reconfirmed**:
   - Traced the distinct roles of `TRANSACTION_JOURNAL_CORRUPT` (diagnostic detection layer) and `CRITICAL_RECOVERY_FAILURE` (crash recovery failure layer).
   - Added explicit test assertions to T39 in `pivot.test.ts` proving that the corrupted journal file is preserved on disk and zero speculative cleanup occurs.
5. **T20 Retention Invariant Hardened**:
   - Hardened test T20 to verify that `txManager.recover(lock)` actually executed (`recoveryResult.actionTaken === "none"`, `recoveryResult.recovered === false`) and that unjournaled temporary staging files remain untouched on disk, cementing the Phase A.2 retention invariant.

---

## 2. Section 1: Phase A Invariant Consistency Analysis (Preserving T20)

### 2.1 Investigation of Test T20 ("Crash Recovery with Incomplete Artifacts")
In the governance design v1.3.0 (Section 8, Test Matrix), scenario T20 was originally phrased as:
> *"Stale `*.tmp.*` files left in `.playbook/pivots/` after simulated crash. Subsequent CLI operation cleans up orphaned `.tmp` files during lock recovery."*

During Task 004F.2.4-A.2, an adversarial investigation established a non-negotiable safety invariant:
> **Phase A.2 Invariant**: The transaction manager must NEVER execute broad wildcard sweeps (`rmdir /s` or `rm *.tmp.*`) across arbitrary directories. An unjournaled `.tmp` file could belong to another process, an external tool, or an unfinalized operation. Deleting unjournaled files based solely on a `.tmp` file extension introduces data destruction hazards. Therefore, **unjournaled temporary files must be safely retained, and cleanup during lock recovery is restricted to files explicitly tracked in a valid journal.**

### 2.2 Forensic Inspection of Test T20 Implementation
Test T20 in `tooling/playbook-cli/tests/pivot.test.ts` (lines 731–752) sets up the following condition:
```typescript
const orphanedTmp = path.join(
  tempDir,
  DEFAULT_PATHS.pivotsDir,
  "state-PVT-M-1.1.0-001.json.tmp.tx-12345"
);
fs.writeFileSync(orphanedTmp, "orphaned tmp content", "utf-8");

const txManager = new WriteAheadTransactionManager({ targetDir: tempDir });
let recoveryResult: any;
await txManager.lockManager.withLock(async (lock) => {
  recoveryResult = await txManager.recover(lock);
});

// Explicitly verify recovery executed and determined no journal exists
assert.ok(recoveryResult, "Recovery must have executed");
assert.strictEqual(recoveryResult.actionTaken, "none");
assert.strictEqual(recoveryResult.recovered, false);

// Recovery runs without error and preserves unjournaled temporary file (Phase A.2 retention invariant)
assert.strictEqual(fs.existsSync(path.join(tempDir, DEFAULT_PATHS.stateFile)), true);
assert.strictEqual(fs.existsSync(orphanedTmp), true, "Unjournaled staging files must be safely retained and never swept by wildcards");
```

### 2.3 Forensic Trace & Proof
1. **File Ownership**: The path `state-PVT-M-1.1.0-001.json.tmp.tx-12345` matches the naming pattern used by `WriteAheadTransactionManager` during staging (`<target>.tmp.<txId>`). However, because no transaction journal exists on disk referencing `tx-12345`, the file is **unjournaled**.
2. **Lock Manager Behavior**: The lock manager (`TransactionLockManager`) acquires exclusive access to `.playbook/transaction.lock`. It does not inspect or sweep project directories.
3. **Recovery Engine Execution**: `txManager.recover(lock)` calls `readJournal()`. Because `tx-journal.json` does not exist, `readJournal()` returns `{ exists: false, journal: null, isCorrupted: false }`. `recover()` immediately returns `{ recovered: false, actionTaken: "none", filesAffected: [] }`.
4. **Filesystem State**: The orphaned temporary file `orphanedTmp` remains **intact on disk**. It is not deleted.
5. **Adherence to Phase A.2 Invariant**: The implementation strictly adheres to the Phase A.2 safety contract. It refuses to perform speculative wildcard deletion. The test explicitly proves both that recovery executed and that the file was preserved.

---

## 3. Section 2: Corrupted Journal Error Consistency & Execution Pathway

### 3.1 Trace of Error Origin and Propagation
The audit traced the corrupt-journal execution path across the transaction engine, recovery subsystem, and diagnostics:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. fs.readFileSync('.playbook/tx-journal.json')                        │
│    JSON.parse() throws SyntaxError                                     │
│         │                                                              │
│         ▼                                                              │
│ 2. readJournal(journalPath) [src/core/transaction/journal.ts:135]      │
│    Catches error; returns { exists: true, isCorrupted: true, ... }     │
│         │                                                              │
│         ├───────────────────────────────────────────────┐              │
│         ▼                                               ▼              │
│ 3A. recover(lock)                            3B. playbook inspect      │
│     [transaction-manager.ts:653]                 [diagnostics/engine]  │
│     Checks isCorrupted === true                  diagnoseLock()        │
│     Throws TransactionError:                     Produces Issue:       │
│     "CRITICAL_RECOVERY_FAILURE"                  "TRANSACTION_JOURNAL_ │
│     (Fail closed; journal preserved)              CORRUPT"             │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Distinction Between Diagnostic and Operational Layers
- **`TRANSACTION_JOURNAL_CORRUPT`** (`tooling/playbook-cli/src/core/diagnostics/types.ts` & `src/core/transaction/diagnostics.ts:14`):
  This is the *diagnostic classification* produced during read-only inspection (`playbook inspect`). It informs the human operator that a corrupted journal was discovered and provides remediation guidance (`"Inspect repository state with git diff and perform operator triage"`).
- **`CRITICAL_RECOVERY_FAILURE`** (`tooling/playbook-cli/src/core/transaction/transaction-manager.ts:655`):
  This is the *operational exception* thrown by `recover()` when a write or advance command attempts recovery on a corrupt journal. The engine halts execution immediately to prevent split-brain state mutations.

### 3.3 Fail-Closed Verification in Test T39
Test T39 (`tooling/playbook-cli/tests/pivot.test.ts:1241-1264`) proves:
1. `txManager.recover(lock)` rejects with `CRITICAL_RECOVERY_FAILURE`.
2. The corrupt `.playbook/tx-journal.json` file is preserved on disk (`assert.strictEqual(fs.existsSync(journalFilePath), true)`).
3. Zero speculative file deletions or state alterations occur.

---

## 4. Section 3: Snapshot Immutability vs. Preservation Analysis

### 4.1 Technical Realities of OS File Write Protection (`0o444`)
The design specification refers to snapshots as "immutable". The audit evaluated what this means in practice across operating systems:

1. **POSIX Permissions (`0o444` / `r--r--r--`)**:
   - Setting a file's mode to `0o444` clears write bits for owner, group, and others.
   - Any attempt to open the file with `O_WRONLY`, `O_RDWR`, or `truncate(2)` fails with `EACCES`.
   - **POSIX Unlinking Boundary**: In POSIX filesystems, **unlinking a file does NOT depend on file permissions**. Unlinking depends entirely on the write permission of the parent directory (`.playbook/pivots/`). Any process with write permissions to `.playbook/pivots/` can unlink a `0o444` file.
2. **Windows NTFS Read-Only Attribute**:
   - Setting `0o444` on Windows sets `FILE_ATTRIBUTE_READONLY`.
   - Windows `DeleteFileW` fails with `EPERM` / `EACCES` when attempting to delete a read-only file.
   - However, any user process can clear the attribute via `chmodSync(path, 0o666)` and then delete the file. (In fact, `fs-utils.ts` in our transaction engine does this when cleaning up transaction backups).
3. **Conclusion**: Describing `0o444` as "immutable" or "non-deletable" is technically inaccurate. `0o444` provides **advisory application-level write protection** against accidental text editor overwrites.

### 4.2 How Historical Snapshots Are Truly Preserved
Snapshot preservation does NOT rely on OS permissions alone. It is enforced by five interlocking mechanisms:
1. **Write-Ahead Transaction Invariants**: The pivot transaction engine registers `write` operations for new snapshot files (`.playbook/pivots/state-<PVT_ID>.json`) and `unlink` operations *only* for the active PRD and approval sidecar. It **never** registers an `unlink` operation against prior snapshot files.
2. **`createOnly: true` Semantics**: All snapshot writes declare `createOnly: true`. If a target file exists on disk, `commit()` aborts with `EXTERNAL_TARGET_MODIFIED` before modifying any file. In `COMMITTING` crash recovery, unexpected existing targets cause recovery to halt with `TRANSACTION_RECOVERY_REQUIRED` rather than overwrite.
3. **Monotonic Sequence Discovery**: `discoverNextPivotId()` scans `.playbook/pivots/`, `docs/pivots/`, and `docs/prd/archive/`, determines $\max(S) + 1$, and increments past any collided candidate path, guaranteeing that new pivots receive unique non-colliding paths.
4. **Rollback Isolation**: On failed or aborted transactions, `recover()` unlinks *only* temporary staging files listed in the journal (`<target>.tmp.<txId>`). Target files and historical snapshots are never touched during rollback.
5. **Git Repository Tracking**: Once committed, Git history provides permanent historical recovery.

---

## 5. Section 4: Storage Layout Design Discrepancy & Safety Analysis

### 5.1 Design Requirement vs. Actual Implementation
- **Design v1.3.0 Section 6.1 (line 467)**:
  > *"Required parent directories (`.playbook/pivots/`, `docs/pivots/`, and `docs/prd/archive/`) must exist before the pivot transaction starts. `playbook init` must provision them; an existing project missing any directory fails preflight with `PIVOT_STORAGE_LAYOUT_MISSING`. Directory creation is not an unjournaled side effect of pivot execution."*
- **Actual Implementation in `tooling/playbook-cli/src/core/pivot.ts`**:
  ```typescript
  // Preflight storage layout verification (lines 81-95)
  const requiredDirs = [
    path.resolve(targetDir, DEFAULT_PATHS.pivotsDir),
    path.resolve(targetDir, DEFAULT_PATHS.docsPivotsDir),
    path.resolve(targetDir, DEFAULT_PATHS.prdArchiveDir),
  ];

  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir)) {
      throw new TransactionError(
        "PIVOT_STORAGE_LAYOUT_MISSING",
        `Required pivot storage directory is missing: "${path.relative(targetDir, dir)}". Provision storage layout before executing pivot.`
      );
    }
  }
  ```

### 5.2 Identified Design Deviations & Test Gaps
1. **Advisory Preflight vs. In-Lock Verification**:
   `checkPivotEligibility` verifies the presence of these three directories before operator prompts. However, inside the transaction lock (`executeStagePivot`), the directories are **not** re-verified before staging begins.
2. **Transaction Manager Fallback Directory Creation**:
   In `WriteAheadTransactionManager.prepare()` (line 303):
   ```typescript
   const tmpDir = path.dirname(absTmp);
   if (!fs.existsSync(tmpDir)) {
     fs.mkdirSync(tmpDir, { recursive: true });
   }
   ```
   If a directory is removed between preflight and lock acquisition, `transaction-manager.ts` will silently create `tmpDir`, contradicting the design rule that *"directory creation is not an unjournaled side effect of pivot execution"*.
3. **No Automated Test Coverage**:
   Although `bootstrapStage1MaintenanceProject` defines an override `missingStorageDirs?: boolean`, **none of the 40 tests in `pivot.test.ts` pass this override**. There is zero automated test coverage exercising `PIVOT_STORAGE_LAYOUT_MISSING`.
4. **Safety Implications**:
   In standard CLI operation, `runPivot` calls `checkPivotEligibility`, which immediately throws `PIVOT_STORAGE_LAYOUT_MISSING` if directories are missing, preventing unjournaled execution. However, the transaction engine fallback and lack of test coverage represent an architectural inconsistency.
5. **Recommendation**:
   Record Requirement S1 as `DESIGN DEVIATION / NOT TESTED`. In a future maintenance task:
   - Add automated test coverage for `PIVOT_STORAGE_LAYOUT_MISSING`.
   - Re-check directory presence under the transaction lock before calling `txManager.prepare()`.

---

## 6. Section 5: Exception Disposition Lifecycle

### 6.1 Trace of `invalidated_by_pivot`
The disposition of Stage 1 exceptions during a stage pivot was traced through schemas, code, and tests:
1. **State Schema (`schemas/project-state.schema.json`)**:
   `current_stage_detail.exceptions` contains active exceptions for the current stage.
2. **Audit Document Generation (`tooling/playbook-cli/src/core/pivot.ts:320-328`)**:
   All active Stage 1 exceptions are enumerated in Section 4 of `docs/pivots/<PVT_ID>.md`:
   ```markdown
   - `EXC-20261101-001`: Disposed as `invalidated_by_pivot`. (Stage 1 exceptions do NOT carry over to Stage 0 or future Stage 1 scopes).
   ```
3. **State Re-initialization (`executeStagePivot`)**:
   The re-initialized Stage 0 state strictly resets the exceptions collection:
   ```typescript
   current_stage_detail: {
     stage: 0,
     status: "in_progress",
     deliverables: [...],
     rfcs: [],
     adrs: [],
     exceptions: [], // Cleared: Stage 1 exceptions do not carry forward
     exit_package: null,
   }
   ```
4. **Historical Exception Markdown Retention**:
   Historical exception files in `governance/exceptions/` (or `docs/exceptions/`) are permanent Git-tracked documentation. The pivot engine touches only active state, active PRD, and stage sidecars; exception files on disk are **never unlinked or deleted**.
5. **Gate 0 Eligibility & Waiver Block**:
   Under Gate 0 eligibility rules (`checkGateEligibility` in `approval.ts`), any waived deliverable must match an active exception listed in `current_stage_detail.exceptions`. Because `exceptions: []`, any attempt to claim a waived deliverable in Stage 0 without an authorized, freshly-issued Stage 0 exception is strictly rejected (`GATE_REQUIRED_DELIVERABLE_MISSING` / `EXCEPTION_EXPIRED`). Old Stage 1 waivers cannot authorize Stage 0 work.
6. **Tooling Verification (T22)**: Test T22 verifies that active exceptions are catalogued with disposition `invalidated_by_pivot` in the markdown audit file, removed from active state, and preserved on disk.

---

## 7. Section 6: Gate 0 Negative Byte-Match Guardrail

### 7.1 Guardrail Implementation (`tooling/playbook-cli/src/core/approval.ts`)
The negative byte-match guardrail was verified in `approval.ts` lines 313–360:
```typescript
if (requestedGate === 0) {
  const prdCorePath = path.resolve(targetDir, "docs/prd/PRD-CORE.md");
  if (fs.existsSync(prdCorePath)) {
    const activePrdHash = computeFileSha256(prdCorePath);
    if (activePrdHash) {
      const outdatedHashes = new Set<string>();
      for (const p of state.pivots || []) {
        if (p.milestone_id === state.milestone_id && p.source_prd_sha256) {
          outdatedHashes.add(p.source_prd_sha256.toLowerCase());
        }
      }
      // Scan docs/pivots/ directory for audit records
      // Add any matched hashes to outdatedHashes
      if (outdatedHashes.has(activePrdHash.toLowerCase())) {
        diagnostics.push({
          code: "PRD_CONTENT_UNALTERED",
          severity: "error",
          message: `Active 'docs/prd/PRD-CORE.md' has identical raw-byte SHA-256 hash (${activePrdHash}) to an outdated Problem Statement archived during a prior stage pivot for milestone '${state.milestone_id}'. Stage 0 requires authoring a fresh problem statement; reusing the outdated document is prohibited.`,
          path: "docs/prd/PRD-CORE.md",
          remediation: "Draft a fresh problem statement addressing the new problem domain.",
        });
      }
    }
  }
}
```

### 7.2 Evaluation Across Edge Cases & Adversarial Tests
1. **Multiple Pivots in One Milestone (T16, T38)**: Tested with consecutive pivots. The guardrail accumulates outdated hashes from both pivots. Restoring PRD content matching *either* pivot triggers `PRD_CONTENT_UNALTERED`.
2. **Archival Warning Banner vs. Original Hash (T38)**: Test T38 proves that although prepending the warning banner changes the hash of the archived file in `docs/prd/archive/`, the engine records the **original pre-banner SHA-256 hash** in `state.pivots[].source_prd_sha256` and the audit record. Gate 0 guards against this original hash.
3. **Byte-Different but Semantically Stale PRD (T32)**:
   - When whitespace or a single character is modified in `docs/prd/PRD-CORE.md`, the SHA-256 hash changes, clearing the automated guardrail (`eligible: true`).
   - **Critical Scientific Limitation Acknowledged**: Automated cryptographic hashing detects **byte-level identity only**. It cannot evaluate whether the text has semantically resolved the domain discrepancy.
   - **Human Authority**: Gate 0 approval requires interactive human gate review (`playbook approve --gate 0`). Automated tooling enforces the negative constraint (cannot be byte-identical), while human engineers bear the sole authority to approve semantic validity.

---

## 8. Section 7: Human Authorization Boundary

### 8.1 Interactive CLI Guardrail Verification
The audit examined `tooling/playbook-cli/src/commands/pivot.ts` and verified the enforcement of human authority:

```typescript
// 1. TTY Guardrail
if (!process.stdin.isTTY) {
  throw new Error(
    "[TTY_REQUIRED] Stage pivot requires an interactive terminal session. Automated, scripted, or piped invocations are strictly prohibited."
  );
}

// 2. Agent Name Prohibition
if (isForbiddenAgentName(authorizedBy) || isForbiddenAgentName(role)) {
  throw new Error(
    `[AGENT_APPROVAL_PROHIBITED] AI agents and automated tools cannot authorize a stage pivot. Found prohibited name/role: "${authorizedBy}" / "${role}".`
  );
}

// 3. Mandatory Reason
if (!reason || reason.trim().length === 0) {
  throw new Error("[PIVOT_REASON_REQUIRED] A non-empty pivot reason is mandatory.");
}

// 4. Confirmation Phrase Matching
const expectedPhrase = `CONFIRM PIVOT TO STAGE 0 ${state.milestone_id}`;
if (confirmed.trim() !== expectedPhrase) {
  throw new Error(`[PIVOT_ABORTED] Confirmation phrase mismatch.`);
}
```

### 8.2 Attestation Model vs Cryptographic Authentication
- **Attestation Model**: `authorizedBy` and `role` are human self-attestations collected in an interactive TTY session and permanently written into the audit markdown and state record.
- **Boundary Reality**: The CLI verifies interactive TTY execution and blocks recognizable AI agent strings (e.g. `copilot`, `gemini`, `claude`, `agent`, `cursor`, `antigravity`).
- **Limitation**: The system does NOT perform hardware token signing (e.g., FIDO2 / PGP / PKI). Trust is rooted in local terminal interactivity, Git commit provenance, and verifiable audit records. This limitation is explicitly documented in Section 9 of the governance design.

---

## 9. Section 8: Corrected Design-to-Code Acceptance Matrix

The following matrix maps every requirement from `governance/maintenance-stage-pivot-design.md` v1.3.0 against actual implementation source references, actual test names and numbers in `tooling/playbook-cli/tests/pivot.test.ts`, genuine test proof capabilities, and rigorous audit verdicts:

| Req ID | Requirement Description | Design Ref | Implementation Ref | Actual Test Ref | What the Test Genuinely Proves | What It Does Not Prove | Verdict |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :---: |
| **C1** | Project in `reopened_maintenance` | Sec 2.1 | `pivot.ts:186-193` | **T4**: *Pivot Rejected for Non-Maintenance* | Rejects with `LIFECYCLE_NOT_MAINTENANCE` when status is `active` or `completed_terminal` | Malformed/corrupted state string handling | **PASS** |
| **C2** | Current stage is Stage 1 | Sec 2.1 | `pivot.ts:195-202` | **T2**: *Pivot Rejected from Stage 2* | Rejects with `PIVOT_INVALID_STAGE` when stage $\ne 1$ | Rejection of negative or non-integer stages | **PASS** |
| **C3** | Stage 1 unapproved | Sec 2.1 | `pivot.ts:204-211` | **T3**: *Pivot Rejected After Gate 1 Approval* | Rejects with `STAGE_ALREADY_APPROVED` if `stage_status === "approved"` | Rejection of other stages after approval | **PASS** |
| **C4** | Inherited PRD explicitly OUTDATED | Sec 2.1 | `pivot.ts:213-228` | **T5**: *Pivot Rejected without OUTDATED Assessment* | Rejects with `PIVOT_PRD_NOT_OUTDATED` when assessment is `APPLICABLE` or `MISSING` | Ambiguous markdown syntax edge cases | **PASS** |
| **C5** | Human authorization, non-empty reason, confirmation phrase | Sec 2.1, 3 | `commands/pivot.ts:60-84`, `pivot.ts:230-238` | **T6**: *Non-TTY Rejected*, **T7**: *Incorrect Phrase Rejected*, **T8**: *Missing Reason Rejected* | Rejects non-TTY execution, confirmation phrase typos, and empty justification string | Cryptographic identity verification | **PASS** |
| **C6** | Target stage strictly 0 | Sec 2.1 | `pivot.ts:167-174` | None in `pivot.test.ts` (Code verified by inspection) | Throws `PIVOT_TARGET_UNSUPPORTED` if targetStage $\ne 0$ | No automated test exercises targetStage $\ne 0$ in pivot suite | **NOT TESTED** |
| **S1** | Storage directory layout verified | Sec 4.1, 6.1 | `pivot.ts:81-95` | None in `pivot.test.ts` (`missingStorageDirs` override uncalled) | `checkPivotEligibility` throws `PIVOT_STORAGE_LAYOUT_MISSING` in preflight | Tx manager creates dirs on prepare; no test exercises missing dirs | **DESIGN DEVIATION / NOT TESTED** |
| **S2** | Monotonic sequence discovery across 3 dirs | Sec 4.2 | `pivot.ts:107-158` | **T27**: *Repeated Pivot Sequence Discovery Across 3 Dirs*, **T28**: *Filename-Pattern Regex Correctness* | Finds $\max(S)+1$ across pivots, docs/pivots, and prd/archive; ignores non-matching filenames | Non-numeric directory suffix handling | **PASS** |
| **P1** | Pre-prompt baseline capture & lock TOCTOU revalidation | Sec 3.2 | `pivot.ts:241-251`, `pivot.ts:475-520` | **T15**: *TOCTOU State Modification Under Prompt*, **T31**: *State Drift Involving Assessment Artifact* | Aborts with `STATE_CONCURRENTLY_MODIFIED` when state or assessment changes under prompt | Drift in untracked ancillary project files | **PASS** |
| **W1** | Pre-pivot state snapshot staged with `0o444` | Sec 4.1, 6 | `pivot.ts:560-575` | **T1**: *Valid Pivot*, **T9**: *Historical Stage 1 Preservation*, **T17**: *Snapshot Staging Failure* | Staged with `createOnly: true`; committed with mode `0o444`; rollback unlinks `.tmp` | POSIX directory-level unlink protection | **PASS** |
| **W2** | Comprehensive audit record staged | Sec 4.3, 6 | `pivot.ts:577-586` | **T1**: *Valid Pivot*, **T18**: *Audit Doc Write Failure*, **T22**: *Historical Dispositions* | Staged to `docs/pivots/PVT-*.md` recording metadata, preserved deliverables, and invalidations | External automated Git commit | **PASS** |
| **W3** | Outdated PRD archived with warning banner | Sec 4.4, 6 | `pivot.ts:588-606` | **T21**: *PRD Archival & Guardrail*, **T38**: *Original PRD Hash Survives Banner* | Archived to `docs/prd/archive/` with banner; original pre-banner hash preserved in ledger | Custom banner template formatting | **PASS** |
| **W4** | Active PRD atomically unlinked | Sec 4.4, 6 | `pivot.ts:608-613` | **T1**: *Valid Pivot*, **T24**: *Crash During PRD Archive/Unlink*, **T25**: *PREPARED Rollback Preserves PRD* | Active PRD unlinked on commit; preserved untouched on rollback before commit intent | File restoration if deleted out-of-band | **PASS** |
| **W5** | Approval sidecar purged | Sec 5.2, 6 | `pivot.ts:615-619` | **T1**: *Valid Pivot*, **T33**: *Sidecar Cleanup Failure Defense* | Sidecar safely unlinked (`mustExist: false`); residual sidecar rejected by gate check | Cryptographic signature forgery defense | **PASS** |
| **W6** | Re-initialized Stage 0 state staged | Sec 5.1, 6 | `pivot.ts:621-638` | **T1**: *Valid Pivot*, **T10**: *Fresh Stage 0 Initialization* | State reset to stage 0, baseline `PRD-CORE` deliverable `not_started`/`unvalidated`, `pivots[]` updated | Subsequent Gate 0 approval progression | **PASS** |
| **W7** | Manifest synchronized to Stage 0 | Sec 5.1, 6 | `pivot.ts:640-649` | **T1**: *Valid Pivot*, **T30**: *Manifest Path Consistency Verification* | Manifest `active_lifecycle_stage` set to 0 strictly at `.playbook/manifest.json` | Manifest custom schema extensions | **PASS** |
| **R1** | Crash during `PREPARING` rolls back cleanly | Sec 6.2 | `transaction-manager.ts:672-747` | **T17**: *Snapshot Staging Failure*, **T23**: *Crash Before Durable Journal*, **T35**: *Crash During PREPARING* | Unlinks journal-listed `.tmp` files; leaves live targets untouched; deletes journal | Hardware power-loss kernel cache integrity | **PASS** |
| **R2** | Crash during `COMMITTING` rolls forward idempotently | Sec 6.2 | `transaction-manager.ts:749-865` | **T12**: *Transaction Interruption & Recovery*, **T24**: *Crash During Archive/Unlink*, **T36**: *Missing Temp During COMMITTING* | Replays remaining writes and unlinks to completion; reconstructs missing temps from journal | Recovery under concurrent conflicting write | **PASS** |
| **R3** | Unjournaled `.tmp` files safely retained | Sec 7.2 | `transaction-manager.ts:661-667` | **T20**: *Crash Recovery with Incomplete Artifacts* | Recovery executes, takes zero action (`actionTaken: "none"`), and retains unjournaled `.tmp` | Automated garbage collection of stale files | **PASS** |
| **R4** | Corrupt journal fails closed | Sec 6.2, 7.3 | `transaction-manager.ts:653-659` | **T39**: *Corrupt Journal Fails Closed* | Throws `CRITICAL_RECOVERY_FAILURE`; corrupt journal preserved on disk; zero file mutations | Syntax repair of partially readable JSON | **PASS** |
| **G1** | Gate 0 Negative Byte-Match Guardrail | Sec 5.3 | `approval.ts:313-360` | **T21**: *PRD Archival & Guardrail*, **T38**: *Original Hash Survives Banner* | Blocks Gate 0 with `PRD_CONTENT_UNALTERED` if active PRD hash matches archived outdated hash | Semantic staleness of byte-different text | **PASS** |
| **G2** | Guardrail clears on byte difference | Sec 5.3, 9 | `approval.ts:349-357` | **T32**: *Hash-Different but Semantically Stale PRD* | Byte difference clears automated hash check, deferring semantic approval to human reviewer | Automated evaluation of problem validity | **PASS** |
| **H1** | Non-TTY invocation rejected | Sec 3.1 | `commands/pivot.ts:46-50` | **T6**: *Non-TTY Invocation Rejected* | Rejects non-interactive execution with `TTY_REQUIRED` and exit code 1 | Hardware terminal spoofing defense | **PASS** |
| **H2** | Exact confirmation phrase enforced | Sec 3.1 | `commands/pivot.ts:76-80`, `pivot.ts:232-237` | **T7**: *Incorrect Confirmation Phrase Rejected* | Rejects if phrase does not match `CONFIRM PIVOT TO STAGE 0 <milestone>` | Case-insensitivity variations | **PASS** |
| **H3** | AI agent identity blocked in pivot | Sec 3.1 | `commands/pivot.ts:60-64`, `pivot.ts:410-415` | None in `pivot.test.ts` (Tested in `approval.test.ts:174` for gates) | Throws `AGENT_APPROVAL_PROHIBITED` if author matches agent heuristics | No test in `pivot.test.ts` explicitly exercises agent name in pivot | **NOT TESTED** |
| **E1** | Stage 1 exceptions marked `invalidated_by_pivot` | Sec 4.3, 5.2 | `pivot.ts:320-328`, `pivot.ts:630` | **T22**: *Historical RFC, ADR, Exception Dispositions* | Documented in audit markdown; `exceptions: []` in Stage 0 state; gate blocks old waivers | Automated deletion of disk exception files | **PASS** |
| **M1** | Multiple pivots within single milestone supported | Sec 4.2, 5.3 | `pivot.ts:145-156`, `approval.ts:318-347` | **T16**: *Repeated Pivot Without Historical Overwrite*, **T27**: *Repeated Pivot Sequence Discovery* | Increments sequence (`001`, `002`); both records co-exist permanently | Sequence numbers beyond 999 padding | **PASS** |
| **I1** | Post-pivot inspect reports clean Stage 0 | Sec 5.1 | `diagnostics/engine.ts` | **T13**: *Normal Stage 0 Progression*, **T1**: *Valid Pivot* | `playbook inspect` reports Stage 0 active and `PRD-CORE` deliverable incomplete | Inspection under corrupt schemas | **PASS** |
| **C7** | Post-committed cleanup idempotent | Sec 6.2 | `transaction-manager.ts:867-897` | **T40**: *COMMITTED Cleanup Is Idempotent* | Recovery detects `COMMITTED` phase, finalizes cleanup, and deletes journal | Cleanup of unlisted external backups | **PASS** |

---

## 10. Section 9: Final Architectural Verdict & Limitations Disclosure

### 10.1 Architectural Verdict: **ACCEPTED WITH DOCUMENTED LIMITATIONS**

The implementation in commit `81e91f7` provides robust, transactionally safe Stage 1-to-Stage 0 recovery. Zero runtime crash recovery failures or data loss vulnerabilities were found. All 40 test scenarios in `pivot.test.ts` pass deterministically.

However, based on the rigorous forensic audit in Task 004F.2.4-B.1.1, the acceptance is granted under **Documented Limitations** to account for test suite gaps and architectural nuances:

### 10.2 Itemized Documented Limitations & Recommendations
1. **Design Deviation on Storage Layout (Requirement S1)**:
   - *Finding*: `checkPivotEligibility` verifies storage layout in preflight, but `WriteAheadTransactionManager.prepare()` contains fallback directory creation (`fs.mkdirSync`), and no test in `pivot.test.ts` exercises `PIVOT_STORAGE_LAYOUT_MISSING`.
   - *Recommendation*: Schedule a follow-up task to add a unit test for `PIVOT_STORAGE_LAYOUT_MISSING` and re-verify directory presence under the exclusive lock.
2. **Untested Preflight Conditions in Pivot Suite (Requirements C6 and H3)**:
   - *Finding*: Target stage validation (`PIVOT_TARGET_UNSUPPORTED`) and AI agent prohibition (`AGENT_APPROVAL_PROHIBITED`) are implemented in source, but lack explicit test assertions in `pivot.test.ts` (agent prohibition is tested only in `approval.test.ts`).
   - *Recommendation*: Add focused tests for non-zero pivot target and agent-name rejection in `pivot.test.ts`.
3. **Advisory Nature of File Write Protection (`0o444`)**:
   - *Finding*: `0o444` provides advisory application-level file-modification protection against accidental text editor writes, but does NOT prevent POSIX directory-level unlinking.
   - *Reality*: Historical snapshot preservation is fundamentally guaranteed by write-ahead transaction logic, monotonic sequence discovery, `createOnly: true` collision rejection, and Git repository tracking.
4. **Byte Difference vs. Semantic Freshness (Requirement G2)**:
   - *Finding*: The Gate 0 negative byte-match guardrail strictly verifies that `docs/prd/PRD-CORE.md` is byte-for-byte different from historical outdated problem statements. It does NOT and CANNOT establish semantic problem validity.
   - *Reality*: Authoritative problem formulation validation remains strictly with the human gate approver.
5. **Attestation Model vs. Cryptographic Authentication**:
   - *Finding*: Human authorization checks enforce TTY interactivity and reject known automated agent strings. They do not constitute cryptographic non-repudiation (e.g., hardware-backed PKI signatures). Trust is rooted in local terminal interactivity, Git commit provenance, and verifiable audit records.

---

> **Audit Correction Sign-off**:  
> **Auditor**: Antigravity (AI Engineering Agent)  
> **Task**: Task 004F.2.4-B.1.1  
> **Status**: APPROVED & COMPLETE  
> **Repository Baseline**: Commit `81e91f7` + Test Invariants Verified  
