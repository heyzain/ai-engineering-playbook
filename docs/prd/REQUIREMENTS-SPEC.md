# Release Requirements & Specification

Date: 2026-11-17. Milestone: M-1.0.0. Stage: 1. Author: Codex. Status: proposed requirements submitted for human review; not implementation authorization. Parent: [PRD core](PRD-CORE.md). Gate 0 approval is recorded in state history. Baseline source checkpoint: `9afbfd1`.

## 1. Users, scope, and authority

PER-001 (developer) needs a reproducible project workflow and concrete approval packages. PER-002 (agent) needs headless access to authorized operations and preserved context. PER-003 (reviewer) needs reproducible checks, history, and explicit limitations. Goal IDs below refer to PRD core GOAL-001 through GOAL-005.

This specification completes the existing CLI and validates it in a separate pilot. It adds no hosted service, new stack, dashboard, or identity provider. Human-only operations retain their interactive boundary. Gate 1 approval accepts these requirements; it does not ratify ADR-20261110-001, authorize fenced invalidation, approve implementation architecture, or approve the pilot's own gates.

## 2. Shared input, output, and failure contracts

Every mutating operation receives an explicit or documented-default project directory, validates manifest/state schemas and lifecycle eligibility before committing, and reports its operation result. IDs are non-empty identifiers validated against the relevant schema; stage numbers are integers 0–6. Paths are project-relative where recorded, reject NUL/traversal/out-of-root resolution, and must meet the artifact type required by the command. Content, paths, environment variables, and repository metadata are untrusted inputs.

New stage/deliverable/exception commands provide terminal and `--json` modes. JSON stdout contains exactly one parseable result object with `success`, `operation`, and either `data` or `error: {code, message}`; optional diagnostics/context may be added. Diagnostic chatter goes to stderr; output never includes private environment values. Exit 0 means operation success, 2 means invalid invocation, 1 means a rejected or failed operation. Existing command exit-code contracts remain unchanged and receive command-specific regression assertions. Approval rejection is a successfully recorded decision, not approval; callers must inspect the decision field. Unknown commands/flags are rejected without state mutation.

For a rejected precondition/input, governed artifacts remain byte-identical and no approval is created. A check execution failure may append failed evidence and may block a stage only when the documented halt option requires it. A transaction interruption may leave a recoverable journal; recovery must restore a consistent transaction outcome, not silently discard evidence. A runtime environment restriction is an unavailable verification result, never a passing test. Recovery instructions must describe the next authorized action without advising destructive resets.

Read-only commands do not mutate source, state, evidence, index, or configuration. A matching hash establishes integrity only. Agent identity labels are recorded as agents; interactive operator claims are attestation, not authenticated identity.

## 3. Functional requirements and acceptance matrix

Each row defines a requirement, observable input/output, positive and negative acceptance, and required verification discipline. Every acceptance cell is a release test target, currently unexecuted unless separately evidenced. Architecture must map each row to a component; implementation must map it to an executable test or a named manual procedure.

| ID / goal | User action and I/O | Positive acceptance | Negative acceptance | Required proof |
| --- | --- | --- | --- | --- |
| REQ-001 / GOAL-001 | Developer initializes an empty target using project metadata | Given valid metadata, init creates schema-valid Stage 0 manifest/state and canonical artifact directories | Existing governed project without overwrite authorization is rejected; original bytes preserved | CLI integration |
| REQ-002 / GOAL-001 | Agent inspects and validates project path | Inspect reports authoritative stage, deliverables, approval, blockers; validate reports schema result | Malformed/missing files produce explicit diagnostics; no auto-repair | CLI integration, schema tests |
| REQ-003 / GOAL-002 | Agent starts current stage | `stage start` changes eligible not-started stage to in-progress using existing transaction machinery | Wrong stage, terminal lifecycle, missing predecessor approval, or blocked state is rejected | State transition tests |
| REQ-004 / GOAL-002 | Agent records ID, artifact path, authored status | `deliverable record` records existing artifact with completed/unvalidated status, preserving history | Missing artifact for completed status, unsafe path, illegal state is rejected; recording cannot preserve stale verified status | Unit and CLI tests |
| REQ-005 / GOAL-002 | Agent records evidence type/result/path and procedure | `deliverable evidence` appends schema-valid evidence with file hash and truthful actor; verification follows required disciplines | Missing/tampered evidence, invalid type, unknown ID, or incomplete required disciplines cannot yield verified status | Evidence/resolver tests |
| REQ-006 / GOAL-002 | Agent submits exit package path | `stage submit` accepts only complete verified/validly waived baseline deliverables, complete package, and resolved blockers; sets pending-review without approval | Incomplete sections/placeholders, unverified deliverables, blocking RFC, or expired waiver reject submission | Strict AST and CLI tests |
| REQ-007 / GOAL-002 | Human reviews active gate and decision | Interactive approve records the actual decision, operator attestation, fingerprint and audit through existing guarded path | No TTY, known agent identity, wrong gate, stale package/evidence, or wrong phrase cannot approve | Guard tests plus actual human pilot sign-off |
| REQ-008 / GOAL-002 | Developer advances/reopens/pivots/recovers | Approval-bound advance synchronizes manifest/state; Stage 6 closes terminal; existing maintenance/recovery contracts remain usable | Stale/missing approval, invalid Stage 7, automated human-only reopening/pivot/recovery rejected; no agent impersonation | Lifecycle regression and CLI tests |
| REQ-009 / GOAL-004 | Agent proposes exception document and target | Proposal validates scope/expiry/content and records proposed status only | Markdown saying Approved or naming a human must never activate a waiver | Exception API/CLI/schema tests after ADR ratification |
| REQ-010 / GOAL-004 | Human authorizes an exact exception proposal | Interactive operation binds authorization to exact document/target and only then activates waiver | Non-interactive/agent, wrong scope, tampered proposal, expired date or wrong phrase cannot waive | Guard, integrity, expiry tests |
| REQ-011 / GOAL-004 | Operator revokes or proves remediation of exception | Revoked/expired authorization cannot satisfy a gate; remediation requires fresh applicable passing evidence | Historical approval/evidence alone cannot keep an expired/revoked waiver effective or establish fresh remediation | Exception lifecycle tests; contracts finalized at Stage 2 |
| REQ-012 / GOAL-003 | Developer runs configured gates | Dependency order, selected profile, configured timeouts/env allowlist, secret masking and output bounds are respected; failed checks recorded truthfully | Invalid schema, cycle, missing executable, timeout or kill cannot become a pass; halt-on-failure blocks as documented | Execution, policy, RIF tests |
| REQ-013 / GOAL-003 | Reviewer verifies evidence/fingerprints | Verify accepts matching files/input fingerprints, reports integrity and freshness separately | Changed/missing files, unsafe symlink, stale input or malformed hash rejected; verifier executes no check commands | Verifier and containment tests |
| REQ-014 / GOAL-003 | Agent runs governance lint by category/rule/profile | Documentation, schema, governance, stack and security rules produce attributable findings; strict mode fails on promoted warnings | Invalid rule/config is explicit; no false clean result from unsupported input | Linter CLI and category tests |
| REQ-015 / GOAL-003 | Developer manages pre-commit/pre-push hooks | Existing hooks preserved/restored; commit checks read staged blobs; push checks read pushed trees | Unstaged fixes cannot mask staged errors; dirty working tree cannot mask pushed errors; index mutation, recursion and companion loss rejected | Disposable Git integration tests |
| REQ-016 / GOAL-003 | Developer generates/validates GitHub Actions workflow | Generated workflow validates; actual remote run produces revision-bound evidence for the exact tested commit | Invalid workflow, unrelated revision, untrusted/fabricated result cannot be accepted as authoritative | Local adapter tests plus one real remote CI run |
| REQ-017 / GOAL-003 | Developer lists/applies/composes existing stacks | Next.js/React Native/Expo dependencies, templates and gates resolve after package installation; generated metadata validates | Unknown stack, dependency cycle, collision without authorization, ambiguous mobile config rejected | Stack/template tests and external-install smoke |
| REQ-018 / GOAL-005 | Developer installs npm archive outside checkout | Installed executable and runtime resources work with source checkout unavailable; init/stack/inspect/validate/lint/gates execute | No dependence on source-relative stacks/templates or globally installed TypeScript; missing resources fail explicitly | Packed-install integration |
| REQ-019 / GOAL-005 | Agent/developer follows onboarding | Instructions locate canonical governance, describe safe commands, human boundaries, and recoverable failures; every public command has tested example | No example relies on silent JSON edits or claims guaranteed identity/enforcement from Markdown | Documentation acceptance checklist |
| REQ-020 / GOAL-005 | Developer operates separate pilot | Pilot meets application acceptance and traverses all seven stages with genuine human gates and recorded evidence | Failed check/evidence tampering/automated approval attempts visibly block as specified | Pilot transcript and matrix |
| REQ-021 / GOAL-003 | Concurrent processes mutate project | Consistent manifest/state/audit outcome under locks and WAL; recovery preserves committed evidence | Lock contention, changed source state, injected crashes cannot produce partial authorized transitions | Fault-injection/concurrency tests |

## 4. Non-functional release requirements

| ID / goal | Standard and boundary | Pass condition |
| --- | --- | --- |
| NFR-001 / GOAL-003 | Security | All specified path/approval/tamper negative tests pass; no private credential emitted by captured test fixtures; zero unresolved high/critical dependency findings without a valid authorized disposition |
| NFR-002 / GOAL-003 | Verification reproducibility | Fresh build and complete CLI unit/integration suite: zero failures, zero skipped tests; record exact source revision, runtime, commands and exit codes. Missing tool/network/device capability blocks that mandatory check |
| NFR-003 / GOAL-005 | Runtime support | Preserve Node >=18 declaration. Run CLI build/schema/core tests on Node majors 18, 20, 22, 24 using exact pinned patch versions recorded by CI; Windows x64 Node 24 is the full-suite/pilot reference. No assertion of tested future majors |
| NFR-004 / GOAL-005 | OS verification | Windows x64 full suite and pilot; Linux x64/macOS arm64 Node 24 packaged-init/inspect/validate/stack smoke. Platform-specific unavailable symlink/process features must fail explicitly. Other combinations unverified; changing advertised support requires explicit reviewed scope change |
| NFR-005 / GOAL-003 | Performance | On reference Windows environment, 100 repeated local inspect/validate calls over a fixture with 100 deliverables, 1000 evidence records and 100 small artifacts: p95 <=5 seconds each, no child check executions. Record CPU/RAM/filesystem, cold start separately; excludes network/package installation |
| NFR-006 / GOAL-003 | Reliability | Fault-injection prepare/commit/cleanup and concurrent-writer cases yield either consistent committed state or explicit recoverable failure; no unlogged approved transition or silently lost evidence |
| NFR-007 / GOAL-005 | CLI usability/accessibility | Help and errors usable without color; prompts work with keyboard-only input; documented non-interactive agent commands require no prompt; JSON output passes parsing/contracts |
| NFR-008 / GOAL-005 | Artifact provenance/rollback | Record archive SHA-256 and source revision; reinstall prior archive in isolated pilot copy and pass inspect/validate. Schema migration rollback must preserve original backups and reject unsupported versions rather than overwrite |
| NFR-009 / GOAL-005 | Operational observation | Final artifact: 20 consecutive inspect/validate operations across at least 10 minutes, zero unexpected errors; intentionally rejected negative tests recorded separately. No production telemetry service required |

Full React Native/Expo native-device builds and app-store publication are outside the pilot; their template/configuration and governance checks remain mandatory. Native execution is not claimed by those checks. Existing documentation that implies more must be reconciled explicitly. GitHub remote CI requires operator access and a test workflow run; local simulation cannot replace REQ-016.

## 5. Profile and evidence rules

For each supported profile (`lightweight`, `standard`, `strict`), execute all blocking checks configured for that profile. Warning/advisory checks remain visible; they cannot substitute for required disciplines. Governance lint `--strict` promotes warnings according to its contract. Mandatory lifecycle deliverables and human gates are never optional by profile. Custom deliverables require declared disciplines; missing or malformed definitions fail closed. No skipped mandatory check counts as evidence of passing.

Keep existing baseline discipline rules compatible until explicitly amended. Stage 2 must define a source-of-truth table for each deliverable/profile and migration contracts before implementation. That table maps requirements already stated here; it cannot silently reduce mandatory checks. Hash verification does not prove semantic truth, physical identity, or independent trust.

## 6. Error and recovery acceptance cases

| ID | Given / when | Then | Recovery |
| --- | --- | --- | --- |
| NEG-001 | Invalid JSON, unsupported schema, missing ID, stage -1/7, unsafe path | Reject before governed mutation; stable code and actionable diagnostic | Correct input, rerun |
| NEG-002 | Artifact/evidence changes after verification or approval | Gate/advance rejects stale binding; old evidence retained | Reverify changed work and obtain fresh human approval |
| NEG-003 | Check exits nonzero or times out | Failed/timed-out evidence, no verification promotion; requested halt applied | Fix cause, rerun checks; human recovery if blocked |
| NEG-004 | No TTY, agent label, wrong confirmation or scope | Human-only operation rejected without authorized mutation | Actual operator reviews and executes interactive operation |
| NEG-005 | Proposed/expired/revoked/tampered exception | Cannot satisfy waiver or gate | Correct proposal and seek authorization, or satisfy original requirement |
| NEG-006 | Concurrent write/crash/lock contention | Explicit error or recoverable journal; consistent outcome | Supported recovery after cause inspection; no manual status reset |
| NEG-007 | Unsupported stack, ambiguous workflow, existing file collision | Explicit rejection, no silent replacement | Resolve configuration or authorize reviewed overwrite |
| NEG-008 | Worker/process/network capability unavailable | Inconclusive/failed execution with exact environment error; no pass claim | Run required check in capable environment |
| NEG-009 | Output contains seeded synthetic secret | Capture is masked, while enough diagnostics remain to identify failure | Fix masker before release; never insert actual credentials |

## 7. Pilot, verification ownership, and dependencies

[Pilot specification](PILOT-SPEC.md) defines application behavior and P-001–P-008. All REQ/NFR/NEG rows require evidence in the release acceptance matrix at Stage 4; this document is the planned matrix, not passing execution results. Tests exercising human boundaries can use isolated test fixtures, but actual pilot approval actions require the operator. Agent may author/run checks and submit; only the operator approves gates/waivers. Gate 1 review decides whether to accept these concrete proposed budgets and platform/pilot targets.

Dependencies: child-process-capable test environment; Git for snapshot checks; isolated writable pilot directory; package installation access; GitHub Actions access for real CI; Linux/macOS execution capacity for declared smoke matrix. Missing access is a future execution blocker, not assumed availability. No new paid services are required by the design.

## 8. Assumptions and decision closure

| Item | Treatment |
| --- | --- |
| Next.js task tracker, local archive, reference Windows environment | Concrete proposals from approved discovery, specified here for Gate 1 acceptance |
| Stage 2 exception ADR and fenced invalidation | Not approved by Gate 1; no invalidation feature requirement is added |
| Full-suite baseline EPERM | Open execution issue, preserved; no exception or passing claim |
| Architecture/migration details | Required Stage 2 deliverables, not invented implementation now |
| Public publishing, production data, native-device pilot | Excluded; separate human scope decision needed |

No blocking product ambiguity is intentionally left as an implementation default. A rejected requirement or conflicting prior contract must be resolved through an RFC before architecture or implementation advances. Requirement review does not waive any required quality gate.
