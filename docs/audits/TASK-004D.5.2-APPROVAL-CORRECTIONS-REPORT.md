# Task 004D.5.2 — Approval Eligibility & Human Review Corrections Report

> **Component**: Playbook CLI Governance & Approval Subsystem  
> **Package**: `@ai-engineering-playbook/cli`  
> **Author**: AI Engineering Controller  
> **Date**: 2026-10-31  
> **Task Ref**: Task 004D.5.2  
> **Preceding Tasks**: Task 004D.5 (Approval & Advancement CLI Implementation), Task 004D.5.1 (Code-Level Approval Integrity Audit)  
> **Authoritative Specification**: [`governance/approval-and-advancement-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/approval-and-advancement-design.md)

---

## 1. Executive Summary & Classification

Task 004D.5.2 implements all corrective actions and governance hardening identified in the Task 004D.5.1 code-level safety audit. The implementation resolves defects across mandatory deliverable baseline enforcement, interactive human review presentation, structural exit package validation, and regression test suites for evidence and approval sidecars.

All operations strictly preserve the Write-Ahead Logging (WAL) transaction architecture, atomic process locking, and Draft 2020-12 JSON schema contracts.

### Final Classification

```
APPROVED_WITH_DOCUMENTED_LIMITATIONS
```

> [!NOTE]
> The implementation strictly prevents artificial or synthetic bypasses of stage quality gates. All baseline deliverables must be explicitly declared and verified or validly waived; exit packages must satisfy structural section completeness without unresolved template placeholders; and interactive terminal reviews present rich project context before confirmation.
> Documented limitations (heuristic TTY/name safeguards vs. cryptographic identity proof, structural document checks vs. human semantic engineering evaluation, and governance-frozen snapshots vs. hardware-enforced immutability) are explicitly formalized in design documentation.

---

## 2. Summary of Corrective Work by Part

### Part A — Mandatory Baseline Deliverables Enforcement (Critical)
- **Problem**: In Task 004D.5, `checkGateEligibility` iterated only over declared deliverables in `state.current_stage_detail.deliverables`. If an actor removed a mandatory baseline deliverable from state entirely, the gate check did not detect its absence, allowing premature gate approval.
- **Correction**:
  - Implemented and exported `getStageBaselineDeliverableIds(stage: StageNumber): string[]` in [`src/core/stage-defaults.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/stage-defaults.ts).
  - Added diagnostic code `GATE_REQUIRED_DELIVERABLE_MISSING` across `DiagnosticCode`, `TransactionFailureCode`, and diagnostic message mappers.
  - Updated `checkGateEligibility` in [`src/core/approval.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts) to verify that every mandatory deliverable defined in canonical baseline defaults exists in `current_stage_detail.deliverables`. If any mandatory baseline deliverable is missing, approval is blocked immediately with `GATE_REQUIRED_DELIVERABLE_MISSING`.
  - Enforced that optional or custom deliverables cannot substitute for missing mandatory baseline deliverables.
  - Verified that validly waived mandatory deliverables (with active, unexpired exception references) clear gate approval.

### Part B — Human Review Experience & Pre-Approval Context Presentation
- **Problem**: In Task 004D.5, the terminal approval command prompted for reviewer name and confirmation phrase without displaying the rich governance context, active exceptions, RFCs, or exit package preview.
- **Correction**:
  - Updated [`src/commands/approve.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts) to format and present a complete terminal review summary before any reviewer prompts or confirmation phrases.
  - Summary presents:
    - Project ID, Milestone ID, and Stage Name / Number.
    - Verified and Waived deliverables with artifact paths and validation statuses.
    - Supporting evidence records with paths, SHA-256 hashes, and execution results.
    - Active exceptions and waivers with expiration dates and authorized roles.
    - Clarification RFCs with status and blocking flags.
    - Exit package file location and content preview.
  - If the exit package cannot be read from disk, `approve.ts` fails closed immediately with diagnostic `EXIT_PACKAGE_INCOMPLETE`.

### Part C — Structural Exit Package Validation & Placeholder Rejection
- **Problem**: The exit package check previously only verified that the markdown file existed and had length $> 200$ bytes, permitting empty or unedited template copies with unresolved placeholders.
- **Correction**:
  - Implemented `validateExitPackageStructure(content: string, gate: number): ExitPackageValidationResult` in [`src/core/approval.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts).
  - Validation requires:
    1. Markdown `# Stage Gate Exit Package` header with stage indicator.
    2. Executive Summary section heading.
    3. Deliverables Manifest section heading.
    4. Validation Evidence section heading.
    5. Traceability & Sign-Off section heading.
    6. Minimum document length ($\ge 200$ bytes).
    7. Zero unresolved template placeholders (`<!-- TODO`, `[TODO`, `[INSERT`, `[PLACEHOLDER`).
  - Integrated `validateExitPackageStructure` into `checkGateEligibility`. If any structural requirement or placeholder fails, approval halts with `EXIT_PACKAGE_INCOMPLETE`.

### Part D — Evidence Evaluation & Regression Suite
- **Added Regression Tests in [`tests/approval.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/approval.test.ts)**:
  - `Scenario 8f`: Evidence record with `result: "failed"` rejects with `EVIDENCE_RESULT_FAILED`.
  - `Scenario 8g`: Evidence record with `result: "inconclusive"` rejects with `EVIDENCE_RESULT_FAILED`.
  - `Scenario 8h`: Null or absent hash in automated evidence rejects with `EVIDENCE_HASH_MISMATCH`.
  - `Scenario 8i`: Manual review evidence without hash is accepted when file exists on disk (`existence_verified`).
  - `Scenario 8j`: Multi-evidence deliverable where second evidence fails rejects with `EVIDENCE_RESULT_FAILED`.

### Part E — Approval Sidecar Regression Suite
- **Added Regression Tests in [`tests/advancement.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/advancement.test.ts)**:
  - `Scenario 14a`: Missing approval sidecar on approved stage rejects with `APPROVAL_FINGERPRINT_MISSING`.
  - `Scenario 14b`: Malformed or unparseable JSON sidecar rejects with `APPROVAL_FINGERPRINT_MALFORMED`.
  - `Scenario 14c`: Sidecar gate mismatch rejects with `APPROVAL_FINGERPRINT_MALFORMED`.
  - `Scenario 14d`: Tampered sidecar fingerprint rejects with `APPROVAL_STALE`.

### Part F — Architectural Design & Documentation Boundaries
- **Updated [`governance/approval-and-advancement-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/approval-and-advancement-design.md)**:
  - **Section 3.3**: Formalized the boundary between structural exit package validation and substantive semantic human judgment.
  - **Section 3.4 & 5.1**: Formalized the boundary between heuristic anti-scripting safeguards (TTY checks, forbidden name keyword matching) and cryptographic identity proof / non-repudiation.
  - **Section 4.3**: Formalized the boundary between governance-frozen snapshots and physical/hardware immutability realities.

---

## 3. Files Modified & Implemented

| File Path | Description of Changes |
| :--- | :--- |
| [`tooling/playbook-cli/src/core/stage-defaults.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/stage-defaults.ts) | Exported `getStageBaselineDeliverableIds(stage)` helper |
| [`tooling/playbook-cli/src/core/diagnostics/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/diagnostics/types.ts) | Added `GATE_REQUIRED_DELIVERABLE_MISSING` to `DiagnosticCode` |
| [`tooling/playbook-cli/src/core/transaction/types.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/types.ts) | Added `GATE_REQUIRED_DELIVERABLE_MISSING` to `TransactionFailureCode` |
| [`tooling/playbook-cli/src/core/transaction/diagnostics.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/transaction/diagnostics.ts) | Added diagnostic message mapping for `GATE_REQUIRED_DELIVERABLE_MISSING` |
| [`tooling/playbook-cli/src/core/approval.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/core/approval.ts) | Implemented `validateExitPackageStructure`, mandatory deliverable verification, and fail-closed checks |
| [`tooling/playbook-cli/src/commands/approve.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/src/commands/approve.ts) | Implemented terminal review summary, exit package preview, and fail-closed file reads |
| [`tooling/playbook-cli/tests/fixtures/governance-helper.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/fixtures/governance-helper.ts) | Updated test exit package fixture with required section headers and zero placeholders |
| [`tooling/playbook-cli/tests/approval.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/approval.test.ts) | Added Scenarios 5a, 5b, 5c (Part A), 8c, 8d, 8e (Part C), 8f, 8g, 8h, 8i, 8j (Part D) |
| [`tooling/playbook-cli/tests/advancement.test.ts`](file:///f:/workspace/ai-engineering-playbook/tooling/playbook-cli/tests/advancement.test.ts) | Added Scenarios 14a, 14b, 14c, 14d (Part E) |
| [`governance/approval-and-advancement-design.md`](file:///f:/workspace/ai-engineering-playbook/governance/approval-and-advancement-design.md) | Documented heuristic vs cryptographic, structural vs semantic, and governance vs hardware boundaries |

---

## 4. Test Suite Execution & Verification Evidence

All automated test suites were compiled and executed against Node.js runtime test runner (`npm test --prefix tooling/playbook-cli`).

### Test Summary

```text
▶ Lifecycle Advancement Engine & CLI (playbook advance)
  ✔ Scenario 11: Successful stage advancement from Stage 0 to Stage 1 archives history, syncs manifest, and preserves sidecar (898.998ms)
  ✔ Scenario 12: Manifest and state remain strictly synchronized, detecting prior stage drift (671.9531ms)
  ✔ Scenario 13: Modification to state deliverable invalidates approval fingerprint with APPROVAL_STALE (352.1926ms)
  ✔ Scenario 14: Out-of-band disk evidence modification invalidates fingerprint with APPROVAL_STALE (366.2369ms)
  ✔ Scenario 14a: Missing approval sidecar on approved stage rejects with APPROVAL_FINGERPRINT_MISSING (546.6436ms)
  ✔ Scenario 14b: Corrupted or malformed JSON sidecar rejects with APPROVAL_FINGERPRINT_MALFORMED (304.1696ms)
  ✔ Scenario 14c: Sidecar gate mismatch rejects with APPROVAL_FINGERPRINT_MALFORMED (301.08ms)
  ✔ Scenario 14d: Tampered sidecar fingerprint rejects with APPROVAL_STALE (264.4082ms)
  ✔ Scenario 15: Advancing approved Stage 6 executes CLOSE_LIFECYCLE, severs advancement, and writes milestone snapshot (406.4855ms)
  ✔ Scenario 16: Advance on Stage 6 never creates Stage 7; repeated advance throws ADVANCEMENT_BLOCKED (494.3187ms)
  ✔ Scenario 17: Crash during COMMITTING phase of stage advancement rolls forward cleanly on recovery (302.5338ms)
  ✔ Scenario 18: Orphaned lock and journal from dead process are recovered before new operation executes (348.4129ms)
✔ Lifecycle Advancement Engine & CLI (playbook advance) (5263.0497ms)

▶ Gate Approval Engine & CLI (playbook approve)
  ✔ Scenario 1: Successful gate approval updates state to approved, creates sidecar, and finalizes WAL (860.0605ms)
  ✔ Scenario 2: Non-TTY approval invocation is rejected with TTY_REQUIRED and zero mutations (157.2177ms)
  ✔ Scenario 3: Incorrect confirmation phrase aborts with zero mutations (151.701ms)
  ✔ Scenario 4: Agent self-approval is strictly prohibited for known AI/agent patterns (258.1398ms)
  ✔ Scenario 5: Incomplete or unverified deliverables block gate approval with GATE_CRITERIA_UNMET (351.2145ms)
  ✔ Scenario 5a: Missing mandatory baseline deliverable rejects with GATE_REQUIRED_DELIVERABLE_MISSING (308.7922ms)
  ✔ Scenario 5b: Optional deliverable cannot substitute for missing mandatory baseline deliverable (407.448ms)
  ✔ Scenario 5c: Validly waived mandatory deliverable with active exception clears gate approval (526.7328ms)
  ✔ Scenario 6: Expired or revoked exceptions block gate approval with EXCEPTION_EXPIRED (422.2161ms)
  ✔ Scenario 7: Unresolved blocking RFC blocks gate approval with RFC_BLOCKING_UNRESOLVED (301.0454ms)
  ✔ Scenario 8: Missing evidence file or mismatched hash blocks gate approval (405.5849ms)
  ✔ Scenario 8c: Exit package missing required sections rejects with EXIT_PACKAGE_INCOMPLETE (278.6543ms)
  ✔ Scenario 8d: Exit package with unresolved placeholders rejects with EXIT_PACKAGE_INCOMPLETE (228.8054ms)
  ✔ Scenario 8e: Truncated exit package (< 200 bytes) rejects with EXIT_PACKAGE_INCOMPLETE (198.384ms)
  ✔ Scenario 8f: Evidence record with result 'failed' rejects with EVIDENCE_RESULT_FAILED (254.3819ms)
  ✔ Scenario 8g: Evidence record with result 'inconclusive' rejects with EVIDENCE_RESULT_FAILED (236.7364ms)
  ✔ Scenario 8h: Null or absent hash in automated evidence rejects with EVIDENCE_HASH_MISMATCH (201.0219ms)
  ✔ Scenario 8i: Manual review evidence without hash is accepted when file exists on disk (260.8315ms)
  ✔ Scenario 8j: Multi-evidence deliverable where second evidence fails rejects with EVIDENCE_RESULT_FAILED (213.8996ms)
  ✔ Scenario 9: Gate rejection reverts stage to in_progress, records conditions, and purges sidecar (244.2096ms)
  ✔ Scenario 10: Crash during COMMITTING phase of approval is rolled forward cleanly upon recovery (480.2037ms)
✔ Gate Approval Engine & CLI (playbook approve) (6176.6713ms)

ℹ tests 157
ℹ suites 11
ℹ pass 157
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8256.4875
```

---

## 5. Non-Negotiable Boundaries & Scientific Limitations

1. **Heuristic Anti-Scripting Safeguards vs. Cryptographic Identity Proof**:
   TTY session checks (`isatty`) and forbidden reviewer string matching (`agent`, `bot`, `ai`) are operational anti-scripting safeguards to prevent unattended automated pipeline execution. They do **not** cryptographically prove the identity of the human reviewer. Cryptographic identity proof requires external forge mechanisms (such as GPG commit signatures, WebAuthn/FIDO2 hardware keys, and branch protection rules).
2. **Structural Document Validation vs. Semantic Human Judgment**:
   Automated structural validation verifies file presence, minimum length, header presence, and the absence of unresolved template placeholders. It does **not** evaluate the truthfulness, rigor, or architectural soundness of the content. Evaluative engineering decisions remain the sole responsibility of the human reviewer.
3. **Governance-Frozen Snapshots vs. Hardware Immutability**:
   Milestone snapshots (`state-<milestone_id>.json`) and stage history entries are application-level governance-frozen artifacts protected by CLI state machines and Git commit history. They are **not** hardware WORM (Write Once Read Many) storage; local processes with root/admin access can alter files out-of-band. Cryptographic tamper evidence requires remote signed tags and immutable object locks.
