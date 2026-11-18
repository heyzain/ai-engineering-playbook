# Phase 4/5 implementation handover

Date: 2026-11-18. Baseline: `ad0ff39`. Active milestone M-1.0.0, Stage 3.
Status: implementation authored; mandatory complete regression verification open.
The operator requested completing the remaining work before committing. No commit,
push, schema migration of this repository, exception authorization, or gate approval
was performed by the agent.

## Delivered behavior

- Headless stage start, deliverable record/evidence and strict stage submission.
  Explicit per-action flags, stage/enumeration validation, JSON/terminal output,
  exit 0/1/2 contract and public programmatic exports.
- Local exception proposal, interactive approval/revocation, remediation initiation
  and retirement. Proposals cannot waive. Human review binds exact inputs;
  real streams and exact confirmation guard authorization. No injected TTY option.
- Explicit 1.0.0 to 1.1.0 local migration, read-only original backups/inventory,
  atomic manifest/state/audit persistence. Legacy active authority is withdrawn;
  no documentary waiver is grandfathered. Historic direct-waive API rejects calls.
- Exact ratification commit/tree/specification/inventory checks, document and scoped
  sidecar hashes, shared expiry/revocation/waiver checks across submission,
  inspection and approval. Local documentary assurance does not authenticate identity.
- Remediation UUID, monotonic sequence and audit linkage require fresh proof after
  authorization and initiation. Prior passing evidence cannot retire an exception.
- Every mandatory configured check needs its own matching proof with current
  configuration/profile, tool/script, evidence hash and input fingerprint. Missing
  mappings retain baseline obligations; unknown custom mappings fail closed.
  Advisory proof remains visible without blocking mandatory checks.
- Quality runner persists proof before aggregate verification. A passing individual
  check cannot verify a deliverable with another missing/failed mandatory check.
  Existing locks/WAL, stale-state preconditions and crash recovery are reused.
- CLI reference, agent onboarding and historical architecture disposition updated.
  Portable test discovery enumerates compiled test files without shell globs.

## Scope and traceability

| Requirements | Implementation / proof | Remaining acceptance |
| --- | --- | --- |
| REQ-001,002 | Existing init/inspect/validate plus updated inspector; executable smoke | Full CLI regression |
| REQ-003..006 | workflow.ts, stage/deliverable controllers; workflow-cli and AST tests | Full suite |
| REQ-007,008 | Existing human lifecycle plus formal pending-review guard; approval/recovery regressions | Genuine pilot human gates in Phase 6 |
| REQ-009..011 | exception-lifecycle/service, schemas, ratification verifier; synthetic lifecycle/service tests | Actual operator pilot; complete process/concurrency checks |
| REQ-012,013 | Resolver, evidence-binding, runner/verifier; resolver-safety, RIF, execution tests | Process-based execution suite |
| REQ-014..017 | Existing lint/hooks/CI/stacks retained; schema fixtures updated for explicit v1.1 audit fields | Full regression; installed and remote CI proof in Phase 6 |
| REQ-018,020 | Approved architecture and pilot specifications | Packaged installation and separate real pilot in Phase 6 |
| REQ-019 | CLI README, AGENTS.md, executable JSON/negative smoke | Broader onboarding walkthrough in Phase 6 |
| REQ-021; NFR-006 | WAL stale-write checks, migration backups, existing fault recovery tests | Multiprocess contention blocked in this environment |
| NFR-002,007; NEG-001..008 | Build, focused suites, actual executable rejection checks | Complete capable-environment regression remains mandatory |
| NFR-001,003..005,008,009; NEG-009 | Existing security/runtime/rollback requirements retained | Planned integration/hardening/observation matrix; no new certification claimed |

## Verification

Runtime: Windows x64, Node v24.14.0, npm 11.9.0. Source is the uncommitted diff
against `ad0ff39`; no self-referential commit identifier is asserted.
Exact logs are under `.playbook/logs/completion-*`.

- Build/typecheck passes. Canonical and bundled schemas are synchronized.
- Synthetic exception-service suite: 5 passed, 0 failed, 0 skipped. It runs alone
  when using in-process test mode because terminal/Git/clock simulation is confined
  to a disposable test process and project. It cannot authorize this repository.
- Focused safety/CLI tests: 23 passed, 0 failed, 0 skipped.
- Broad in-process regression (exception-service isolated separately): 1006 tests,
  864 passed, 142 failed, 0 skipped. Many failures depend on blocked subprocesses;
  the full suite is not passing. See `completion-regression-final.txt` and
  `completion-verification-summary.json`. Focused counts overlap this run.
- Actual executable smoke: init/start/record/evidence/submit succeed; review remains pending; invalid stage exit 2;
  headless exception approval exit 1 / TTY_REQUIRED; rejected state bytes unchanged.
- `validate` passes; `verify-evidence` checks recorded file integrity. Passing file
  integrity does not establish passing tests or actor authenticity.
- Standard `npm test` cannot launch its child process in this sandbox (spawn EPERM).
  In-process fallback also cannot exercise tests that spawn tools, Git or workers.
  No failed test is skipped, waived or relabeled as a passing check.

## Release boundary and operator follow-up

Stage 3 remains in progress and unvalidated. The Gate 3 package is a draft, not a
submission or approval. Full suite must pass with zero failures and zero skips
before Phase 5 can be called verified or Gate 3 can be submitted. Team/remote-CI
exception authority is intentionally fail-closed because Level B is outside the
ratified local assurance implementation; ordinary remote checks remain required.
Installed resources, separate pilot, remote run, runtime/platform matrix and release
hardening are later roadmap work, not certified by these unit checks.

Run in a normal PowerShell terminal:

```powershell
Set-Location F:/workspace/ai-engineering-playbook
npm --prefix tooling/playbook-cli test
node tooling/playbook-cli/dist/src/bin/playbook.js validate
node tooling/playbook-cli/dist/src/bin/playbook.js verify-evidence --json
```

Preserve the complete output. Any assertion failure still requires correction;
an external passing result must be recorded as fresh evidence before stage submission.
Do not approve or advance Gate 3 based on this draft.

Suggested commit message after review:
`feat(cli): complete guarded workflows and local exception lifecycle`

The implementation and evidence are left uncommitted for operator review. Review
all changed/untracked paths and the ignored `completion-*` logs before staging.

## Operator regression follow-up (2026-11-18)

The operator supplied a normal PowerShell `npm --prefix tooling/playbook-cli test`
transcript: **1011 tests, 1008 passed, 3 failed, 0 skipped**. Source:
[Pasted text(1).txt](https://chatgpt.com/library?file_id=libfile_76739873acec8191a51394c0ebded1b4&account_id=personal).
The summary and exact three diagnostics are preserved in
`.playbook/logs/phase-5-operator-test-review.json`. This is a reviewed external
run, distinct from the earlier environment-limited in-process runs above.

Two mobile integration failures exposed a generator defect: default
`core-typecheck` referenced placeholder `DELIV-1` while all mobile checks use
`CODE-IMPL`. Default composition now uses `CODE-IMPL`. A regression initializes
both RN and Expo projects and evaluates their declarations through the resolver;
it failed before the fix and passes afterward. Undeclared references still reject.

Lifecycle Scenario D expected a documentary active flag to clear Gate 4. It now
requires rejection and unchanged state, withdraws invalid legacy metadata only in
its disposable fixture, then records and verifies the original INT-TESTS requirement
through CLI operations before submitting and exercising the existing approval worker.
A separate in-process workflow regression checks rejection, recovery, strict
submission and read-only gate eligibility without approving a gate.

Follow-up build and targeted results are under `.playbook/logs/phase-5-followup-*`.
The real process-based lifecycle/mobile cases and complete isolated suite require
another normal-terminal run. No full pass, stage approval, commit or push is claimed.

The recovery regression additionally exposed a blanket schema prohibition on
retired exception history. The schema now preserves those records;
`SchemaValidator.validateState` checks the exact cross-array reference instead:
a waived target still relying on an expired/revoked ID is invalid, while retired
history unrelated to an effective waiver remains valid. JSON Schema alone cannot
compare those dynamic IDs. This split is documented in `schemas/README.md` and
covered for both expired and revoked records.

Follow-up verification: **56 focused tests passed, 0 failed, 0 skipped** across
workflow, evidence, exception, runner, schema and approval suites. The RN/Expo
composition regression separately passes (1 test, zero failures/skips), after an
observed failing baseline. These checks do not replace the complete subprocess
suite. Run `npm --prefix tooling/playbook-cli test` again and preserve its output.

## Final exit-package fixture correction (2026-11-18)

The next normal-terminal transcript reports **1014 tests, 1013 passed, 1 failed,
zero skipped**. Source: [Pasted text(2).txt](https://chatgpt.com/library?file_id=libfile_168c889b05308191a0c87c675cba5f38&account_id=personal).
The only failure is lifecycle Scenario D: its legacy helper produced four sections,
but the new guarded CLI submission requires eight canonical sections.

The complete helper is now shared from `tests/fixtures/exit-package.ts`. A workflow
regression checks that exact helper against strict validation for all seven stages
and confirms that removing a required heading fails. Production strictness remains
unchanged. The prior generator/waiver fixes pass in the operator transcript.
Local fixture build and workflow results are in `.playbook/logs/phase-5-final-fixture-*`.
The complete isolated suite still needs a fresh normal-terminal pass; this handover
and Gate 3 remain unapproved, with changes uncommitted.
