# Phase 4 — Ratification prerequisite checkpoint

Date: 2026-11-17. Status: partial implementation checkpoint; Phase 4 is not complete. Stage 3 remains in progress. Approved architecture baseline: `ef1b3db`. No schema migration, exception lifecycle change, waiver, human approval, or ratification is performed by this checkpoint.

## Implemented

- Separate executable `tooling/playbook-cli/dist/src/bin/ratify-exception-amendment.js`, built from TypeScript.
- Sorted ASCII exception-ID canonicalization and empty committed inventory. Only the empty-inventory bootstrap is supported; any legacy active exception/waived deliverable fails closed rather than being grandfathered without reviewed migration authority.
- Real stdin/stdout TTY checks with no override flag, named operator/Lead Architect role and exact amendment confirmation phrase. Agent cannot perform this operation for the human.
- Committed amendment/design/policy/manifest/state Git object bindings, clean-checkpoint requirement, input checks before and after prompting and under the transaction lock. Commit C, tree T, canonical inventory digest, and scope are shown before confirmation.
- Create-only documentary record and audit file in one existing WAL transaction. Input changes, unavailable Git, missing committed inventory, unsafe paths, unsupported project/stage, and existing record are rejected. No project state/schema is changed by ratification itself.

The record establishes operator-attested local Level A only. Local writers can fabricate documentary files; TTY and SHA-256 do not authenticate physical identity. Future exception consumers must verify the referenced Git objects and inventory and reject remote/team waiver reliance. Those consumers are not implemented before ratification.

## Verification performed

| Check | Result |
| --- | --- |
| Fresh baseline `npm test` | Build passed; test-worker spawning blocked by `spawn EPERM`, exit 1. No full-suite passing claim |
| Fresh build after utility implementation | Passed; TypeScript and schema synchronization succeeded |
| `node --test --test-isolation=none dist/tests/ratification.test.js dist/tests/validator.test.js dist/tests/paths.test.js` | 23 passed, 0 failed, 0 skipped; includes six new behavior tests |
| Actual headless ratification executable | Rejected with `TTY_REQUIRED`, exit 1; no ratification record created |
| Repository manifest/state validation | Passed |

Tests cover canonical digest, malformed/duplicate/unsorted inventory, exact operator/role/phrase rules, real-stream TTY guard, legacy-waiver rejection and bound record rendering. Actual interactive Git/transaction success and reference verification need the operator's normal capable terminal; they have not been claimed as tested here. The standard full suite remains mandatory later. Raw baseline and headless output are under `.playbook/logs/phase-4-*`.

## Operator handoff

The approved architecture section 5 and ADR-20261110-001 section 7 require a committed inventory/specification checkpoint before the human ratification record can reference it. Commit this prerequisite batch first. Run the commands from the repository root; do not pipe answers or supply an agent identity.

```powershell
git add -- .playbook/state.json docs/completion-plan.md docs/adr/amendment-grandfathered-inventory.json docs/audits/phase-4-ratification-bootstrap.md tooling/playbook-cli/src/core/ratification.ts tooling/playbook-cli/src/bin/ratify-exception-amendment.ts tooling/playbook-cli/tests/ratification.test.ts
git add -f -- .playbook/logs/phase-4-*
git diff --cached --stat
git commit -m "feat(governance): add phase 4 ratification prerequisite"
git push

npm.cmd --prefix tooling/playbook-cli run build
node tooling/playbook-cli/dist/src/bin/ratify-exception-amendment.js
```

Review the exact displayed commit/tree/digest, enter your own name and declared `Lead Architect` authority, and type `CONFIRM RATIFICATION AMEND-20261110-001` only if you approve local activation. If any check fails, preserve the diagnostic and stop; do not manually generate the record. Successful execution prints the record path and audit path. Commit both (the audit log is ignored by default):

```powershell
git add -- docs/adr/RATIFY-20261110-001.md
git add -f -- .playbook/logs/ratification-*.json
git commit -m "docs(governance): record operator ratification for local exceptions"
git push
```

No `approve --gate 3` or `advance` belongs to this checkpoint. Stage 3 approval requires completion of both work Phases 4 and 5. After the operator's ratification, verify its binding before affected schema/controller work continues.
