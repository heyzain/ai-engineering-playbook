# AI Engineering Playbook — Completion Plan

Date: 2026-11-17  
Status: Phase 1 discovery work submitted for review; Gate 0 approval and Phase 1 commit pending.
Working agreement: Complete one phase, verify its exit criteria, review the changes, commit that phase, and only then begin the next.

## 1. Outcome

Deliver a usable, tested engineering playbook and installable CLI that a developer and AI agent can use in a separate project from discovery through operational verification. The workflow must maintain requirements, architecture, deliverables, verification evidence, and human approval without relying on undocumented manual state edits.

Completion means that the agreed release requirements are implemented and verified, a packaged installation works outside this repository, the pilot demonstrates both successful work and blocked invalid actions, and a new user can follow the documented workflow.

This roadmap is a planning artifact. It does not approve an ADR, authorize a fenced transition, approve a lifecycle gate, or change the current stage. Scope and pilot choices below are proposals to finalize in Phases 1–2.

## 2. Verified starting point

| Area | Observed state | Qualification |
| --- | --- | --- |
| Governance state | Stage 0, `not_started`; empty `stage_history` | No retrospective approvals may be invented. |
| Required discovery artifact | `docs/prd/PRD-CORE.md` absent | Must be prepared and reviewed before advancing. |
| Existing executable | `inspect`, `validate`, and help run successfully | Existing `dist` output does not prove the latest source was built. |
| Source type check | `tsc --noEmit` passed during the initial review | Not a substitute for the full test suite. |
| Tests | 48 TypeScript test files present | Fresh execution and results remain outstanding. |
| Operational controllers | Core controller modules and validators exist | Stage/deliverable/exception command integration remains unfinished. |
| Exception architecture | ADR-20261110-001 is proposed; implementation authorization pending | Formal approval must precede the schema/controller changes it fences. |
| Documentation | README contains outdated future-work descriptions | Documentation must be reconciled with verified behavior. |
| Git state | Existing tracked modifications and many untracked files | Preserve and inventory this work before selecting commit contents. |

Sources: [project overview](../README.md), [agent instructions](../AGENTS.md), [state](../.playbook/state.json), [CLI](../tooling/playbook-cli/src/bin/playbook.ts), [package scripts](../tooling/playbook-cli/package.json), [controller design](architecture/operational-controller/design.md), and [pending exception ADR](adr/ADR-20261110-001-two-phase-exception-lifecycle.md).

## 3. Scope boundaries

Proposed release scope:

- Complete the existing local CLI workflow: initialize, inspect, validate, start a stage, record deliverables and evidence, submit for review, obtain human approval, and advance or close the lifecycle.
- Verify quality-gate execution, evidence integrity, governance linting, Git hooks, CI integration, and stack application against explicit release requirements.
- Resolve the unsafe documentary-waiver model through the approved exception design before exposing waiver commands or declaring the release ready.
- Verify existing Next.js, React Native, and Expo stack behavior to the level actually claimed by the release. Declare unsupported paths explicitly; no silent removal of existing commitments.
- Provide installation, agent onboarding, troubleshooting, upgrade/compatibility notes, and one reproducible pilot walkthrough.

Proposed exclusions: new UI/dashboard, hosted service, new stacks, autonomous human approval, and cryptographic identity infrastructure. TTY interaction is operator attestation; a hash proves integrity, not human identity.

## 4. Phases and commit checkpoints

Work phases are delivery batches, not additional lifecycle stages. There is no lifecycle Stage 7. Phases 4 and 5 share Stage 3; the Stage 3 gate is submitted only after both are verified.

| Work phase | Lifecycle stage | Main result | Proposed phase commit |
| --- | --- | --- | --- |
| 1. Scope and baseline | 0 — Discovery | Reviewed problem, boundaries, baseline inventory, success measures | `docs(plan): establish completion scope and repository baseline` |
| 2. Release requirements | 1 — Requirements | Testable requirements and acceptance matrix | `docs(spec): define release and pilot acceptance criteria` |
| 3. Architecture closure | 2 — Architecture | Approved contracts, compatibility policy, and security decisions | `docs(architecture): finalize controller and exception contracts` |
| 4. Controller safety | 3 — Implementation | Safe state transitions, evidence handling, exception lifecycle | `fix(controller): enforce approved transition and exception rules` |
| 5. Complete CLI workflow | 3 — Implementation | Usable commands, errors, help, and agent instructions | `feat(cli): expose the complete governed workflow` |
| 6. Integration and pilot | 4 — System verification | Packaged CLI verified in a separate project | `test(integration): verify packaged CLI and downstream pilot` |
| 7. Release hardening | 5 — Release readiness | Audited, documented, reproducible release candidate | `chore(release): prepare verified release candidate` |
| 8. Installation and closure | 6 — Operations | Final installation smoke test, observation, handover | `docs(release): record installation verification and handover` |

### Phase 1 — Scope and baseline

Work:

- Inventory tracked/untracked work, existing architecture decisions, known gaps, and available evidence. Separate observed facts from historical completion claims.
- Identify which existing changes belong to the release and which require investigation. Preserve all existing work; do not reset or bulk-stage the working tree.
- Write the Stage 0 PRD core: users, problem, goals, non-goals, and measurable success criteria.
- Propose the supported runtime/OS matrix, installation channel, and pilot choice for requirements review. Windows is the initial observed environment; broader support needs evidence.
- Identify the bootstrap route for maintaining this repository's Stage 0 records while the controller CLI is incomplete. Document any permitted interim process; never silently bypass a mandatory approval or transaction rule.
- Prepare Gate 0 artifacts and a baseline checkpoint strategy. Existing uncommitted implementation must receive an explicitly reviewed baseline checkpoint before later implementation commits; its presence does not imply verification or approval.

Exit: Baseline inventory and PRD core are reviewable, release boundaries are agreed, and Gate 0 evidence and human approval are recorded through the authorized process. Any unresolved bootstrap conflict is reported as a structured clarification, not bypassed.

### Phase 2 — Release requirements

Work:

- Assign requirement IDs and Given/When/Then criteria for each supported command and workflow.
- Specify malformed inputs, missing artifacts, path escapes, stale/tampered evidence, failed checks, blocked stages, expired/revoked exceptions, concurrent writes, interrupted transactions, and approval rejection.
- Specify terminal/JSON output contracts, exit codes, non-interactive behavior, backward compatibility, and installation from the distributed package.
- Define which checks are mandatory under each supported governance profile. Define runtime versions, platform coverage, performance budgets, and any network-dependent verification explicitly.
- Finalize the pilot and its isolation, storage, and cleanup boundaries. Recommended: a small Next.js task tracker in a separate disposable Git repository, with no credentials or production data.
- Map each requirement to an automated test or explicit manual acceptance check. Record requirement gaps as RFCs.

Exit: Complete release/pilot acceptance matrix, no unresolved blocking RFCs, and recorded Gate 1 approval. An existing feature may be deferred only by an explicit scope decision or authorized exception where required.

### Phase 3 — Architecture closure

Work:

- Compare controller design, state machine, schemas, APIs, and command dispatch with the approved requirements.
- Resolve ADR-20261110-001 through formal human ratification or an explicit alternative decision before affected implementation.
- Define proposal/authorization boundaries, expiry, revocation, remediation freshness, approval binding, and schema migration/compatibility.
- Decide the treatment of fenced deliverable invalidation; keep it inactive unless separately authorized.
- Define command contracts, transaction/locking guarantees, evidence resolution, packaged resource lookup, and agent access to canonical instructions without copying the entire playbook into downstream projects.
- Review package contents: stacks, templates, schemas, CI assets, and runtime dependencies must be available after installation outside the source tree.

Exit: Requirements-to-design traceability, reconciled governing documents, approved ADRs/contracts, and recorded Gate 2 approval. Review completion alone does not constitute human ratification.

### Phase 4 — Controller safety

Work:

- Run a fresh source build and full baseline suite; capture failures before fixes. Add behavior tests before each approved safety change.
- Implement only the approved schema/controller changes and migration behavior.
- Ensure exception proposals cannot waive deliverables; only the authorized human operation can activate a waiver.
- Verify evidence recording, stage submission, approval freshness, and fail-closed behavior under the approved contract.
- Exercise transaction interruption, lock contention, path containment, tampering, expiry, and unsupported transitions.

Exit: Relevant safety, schema, migration, and transaction tests pass; canonical/bundled schemas agree; no identified mandatory safety check remains unresolved. Commit this implementation batch before Phase 5. No Stage 3 approval is claimed yet.

### Phase 5 — Complete CLI workflow

Work:

- Expose the approved stage, deliverable, evidence, submission, and exception operations through CLI commands using the reviewed core APIs.
- Implement consistent help, human-readable output, machine-readable output, and specified exit codes.
- Keep agent-safe operations headless where specified. Human-only operations must reject prohibited automated invocation; do not simulate a human to pass approval gates.
- Update agent instructions and command examples so normal project work does not require undocumented state edits.
- Test the actual executable for both successful and rejected invocations; retain regression coverage for existing commands.

Exit: All Stage 3 release requirements implemented, fresh build/type checks and the full test suite pass with zero failures and zero skipped tests, and Gate 3 package is reviewed and approved. Any environment restriction that prevents a mandatory check blocks the claim until resolved or formally excepted.

### Phase 6 — Integration and pilot

Work:

- Build and pack the CLI, inspect the archive, and install it into an isolated location outside this repository. Exercise it without relying on source checkout paths or globally installed development tools.
- Initialize the approved separate pilot using the installed executable. Validate schema/resource lookup, stack application, linting, and agent onboarding.
- Progress the pilot through its own stages with its own artifacts, evidence, and genuine human approvals. Use the approved task-tracker requirements; do not invent application behavior during implementation.
- Demonstrate a failing check blocking progress, a tampered/stale evidence rejection, unauthorized approval rejection, and successful recovery/re-verification through authorized operations.
- Verify Git hooks against staged/pushed snapshots. Validate generated CI configuration; execute remote CI where required by the approved matrix. Distinguish local simulation from a real remote run.
- Store a reproducible walkthrough and acceptance matrix with exact commands, versions, exit codes, and evidence references. Keep pilot source separate from this repository; record its commit references here.

Exit: Every Stage 4 release acceptance criterion passes, installed-package tests and pilot evidence are fresh, no mandatory remote/platform result is silently substituted, and Gate 4 is approved.

### Phase 7 — Release hardening

Work:

- Audit dependencies and security boundaries; resolve high/critical findings or follow the formal exception process where permitted.
- Verify declared runtime/platform support and compatibility against the approved matrix. Do not claim untested cross-platform or mobile-native execution.
- Reconcile README, command reference, stack status, enforcement claims, and examples with verified behavior.
- Write release notes, installation/upgrade/removal instructions, troubleshooting, rollback, and support limitations.
- Produce a reproducible release archive/checksum and runbook tied to the reviewed source commit. Re-run affected verification if hardening changes code.

Exit: Release-readiness checklist and all mandatory checks pass, no unresolved high/critical issue remains without authorized disposition, artifact/source traceability is recorded, and Gate 5 is approved. Public publishing is a separate operator decision.

### Phase 8 — Installation and closure

Work:

- Install the approved final release candidate through the agreed distribution route and run the operational smoke checklist.
- Repeat the required pilot smoke checks with the final artifact if it differs from the package tested in Phase 6.
- Observe command outcomes, errors, and resource behavior for the window defined in Phase 2; record the baseline and exercise the agreed rollback procedure.
- Assemble final artifact references, pilot results, known limitations, and human handover.
- Obtain Gate 6 approval, then close the lifecycle through the supported advancement command. Commit closure records; source/artifact hashes must distinguish the release source commit from this later evidence commit.

Exit: Final installation, smoke checks, observation, and rollback requirements pass; human approval is recorded; lifecycle is `completed_terminal`. Publishing to a public registry is required only if selected in the approved release scope.

## 5. Rules for every phase

1. Inspect the branch, working tree, state, prerequisites, and blocking RFCs before work. Reuse the approved scope; do not request the same authorization repeatedly.
2. Implement only the current phase. Newly discovered architectural or product decisions go through the applicable RFC/ADR process.
3. Capture commands, environment, exit codes, test counts, and evidence hashes under `.playbook/logs/` or `docs/`. Link them to the active deliverables and run evidence verification as required.
4. Update this roadmap's progress record with results and unresolved issues. Never substitute `completed` for `verified` or `approved`.
5. Review the exact staged diff and run appropriate checks. Stage explicit paths; never use a blanket add to absorb pre-existing work. Inspect new hook/CI configuration before executing it.
6. Prefer one coherent phase commit with the proposed message. If the baseline or change size requires more commits, record the reviewed split in the phase handover. Do not mix unrelated changes.
7. Commit verified phase work before beginning the next phase. Record the commit hash in the next phase's baseline or handover; do not attempt a self-referential commit hash inside its own commit.
8. A commit does not approve a lifecycle gate. At stage boundaries, submit the exit package and wait for the required human approval before advancing. No push, public publication, or release tag is implied by this plan.

## 6. Progress record

| Item | Status | Evidence / next action |
| --- | --- | --- |
| Completion roadmap | Drafted for review | This document; not a lifecycle gate approval. |
| Phase 1 | Submitted for review | PRD core and inventory authored; transactional Gate 0 submission recorded; human approval and commit pending. |
| Phase 2 | Not started | Requires Phase 1 checkpoint and Gate 0 approval. |
| Phase 3 | Not started | Requires Phase 2 checkpoint and Gate 1 approval. |
| Phase 4 | Not started | Requires Phase 3 checkpoint and Gate 2 approval. |
| Phase 5 | Not started | Requires verified Phase 4 commit. |
| Phase 6 | Not started | Requires Phase 5 checkpoint and Gate 3 approval. |
| Phase 7 | Not started | Requires Phase 6 checkpoint and Gate 4 approval. |
| Phase 8 | Not started | Requires Phase 7 checkpoint and Gate 5 approval. |

The roadmap was preserved in baseline checkpoint `bc5c4d3`. Phase 1 execution now updates `.playbook/state.json` through the existing transactional core APIs; no stage has been approved or advanced by the agent.
