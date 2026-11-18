# Phase 5 CLI checkpoint — partial implementation

Date: 2026-11-17. Baseline: `ad0ff39`. Human ratification commit, tree, all specification blob IDs and empty inventory were verified against Git. The operator explicitly requested starting Phase 5. Both work batches remain within Stage 3; no lifecycle gate was skipped or approved. Starting these agent-safe adapters changes the roadmap's work-batch ordering, not lifecycle gates or exception authorization requirements.

## Implemented

- Stage start and strict review submission through existing transactional core services.
- Deliverable record and evidence commands with explicit enums, required options, safe integer/stage parsing and headless agent attribution.
- Strict per-action flags and positional validation, consistent terminal/JSON results, exit 0/1/2 contracts, and updated help/reference.
- Exception routes return a specific blocked diagnostic without calling the historical direct-waiver service.
- Separate Phase 4 reusable verifier of exact ratification commit/tree/specification/inventory bindings. It provides documentary local assurance only, never Level B or identity authentication. Unit test readers cannot create approval.

## Verification

Fresh source build passed. Targeted in-process test invocation:

```text
node --test --test-isolation=none dist/tests/workflow-cli.test.js dist/tests/ratification-verifier.test.js dist/tests/ratification.test.js dist/tests/validator.test.js dist/tests/paths.test.js
31 passed; 0 failed; 0 skipped
```

New coverage includes exact/missing/tampered ratification references, a successful start → authored/unvalidated → evidence/verified → pending-review workflow, unchanged bytes for invalid arguments, wrong-stage rejection, and exception fencing. Test-only synthetic review evidence does not approve actual project work.

Actual executable smoke in a disposable TEMP project passed: init/start/record/evidence commands, parseable JSON, invalid stage exit 2, fenced exception exit 1, and identical state bytes before/after rejected invocations. The smoke does not invoke real human approval. Outputs are `.playbook/logs/phase-5-smoke-*`.

The standard full-suite result is captured in `.playbook/logs/phase-5-full-suite.txt`; inspect that result separately from the limited passing subset. A full-suite pass is not established by this checkpoint. Git binding for the real record was verified using shell Git commands; the Node Git subprocess verifier's real-environment execution remains a separate integration check where child processes are permitted.

## Remaining work and authority

Phase 4 is still incomplete: exception schema migration, proposal/authorization/revocation/remediation lifecycle, legacy-waiver closure, shared expiry/waiver resolution, per-check evidence/configuration/freshness hardening, fault/concurrency verification and complete regression results remain required. Phase 5 exception routing and its success-path tests must wait for those safe services. Existing core behavior is not declared release-ready merely because adapters exist.

Neither this checkpoint nor the ratification commit completes Phase 4. Do not run `approve --gate 3` or `advance`. Do not mark either work phase verified while required checks remain unfinished or unavailable. Keep the historical full-suite inconclusive evidence and record new results truthfully.

## Suggested coherent commits

```powershell
git add -- tooling/playbook-cli/src/core/ratification-verifier.ts tooling/playbook-cli/tests/ratification-verifier.test.ts
git commit -m "feat(governance): verify local ratification object bindings"

git add -- .playbook/state.json docs/completion-plan.md docs/audits/phase-5-cli-checkpoint.md tooling/playbook-cli/README.md tooling/playbook-cli/src/bin/playbook.ts tooling/playbook-cli/src/commands/workflow.ts tooling/playbook-cli/tests/workflow-cli.test.ts
git add -f -- .playbook/logs/phase-5-*
git diff --cached --stat
git commit -m "feat(cli): add guarded stage and deliverable workflow commands"
git push
```

No human approval interaction is necessary for this reversible implementation checkpoint. Stage 3 approval remains reserved until both work phases are actually verified.
