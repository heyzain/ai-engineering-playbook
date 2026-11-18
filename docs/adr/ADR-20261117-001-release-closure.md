# ADR-20261117-001 — Release architecture closure

Date: 2026-11-17. Status: Proposed for Gate 2 review. Author: Codex. No human acceptance or ratification recorded here.

## Recorded disposition (2026-11-18)

Original proposal text below is preserved as history. The operator approved Gate 2
and advanced to Stage 3; see `.playbook/state.json` stage history and
`docs/gates/GATE-2-EXIT-PACKAGE.md`. Separate amendment ratification was recorded
in `docs/adr/RATIFY-20261110-001.md` (commit `ad0ff39`), binding prerequisite
commit `4eea89f`. Local affected implementation is no longer blocked on
ratification. Level B distributed authority remains unimplemented. This note
grants no new approval and does not certify Stage 3.

## Context

Approved requirements call for a complete usable CLI, safety of exception authorization, installed-package proof, and remote CI evidence. Existing controllers are reusable, while exception amendment AMEND-20261110-001 remains fenced and requires different assurance for local and distributed use. The runtime package currently relies on source-tree stack discovery. Duplicating core machinery or treating a documentary human name as authorization would violate the constitution.

## Proposed decision

Reuse existing transactional services behind thin command adapters; add no runtime dependency. Adopt [release architecture](ARCHITECTURE-SPEC.md) as the proposed command, data, resource, threat and verification contract. Close per-check evidence resolution and missing-configuration gaps before exposing completion commands. Bundle installed runtime assets with deterministic module-relative lookup.

Preserve the existing amendment: add a tested ratification bootstrap utility as an implementation prerequisite, obtain the actual prescribed operator ratification, and only then implement affected local exception lifecycle/schema changes. Fail closed for team/remote-CI waiver authority because Level B is unimplemented. Remote CI with all required checks satisfied remains in scope. Do not expose fenced invalidation or retain the historical direct-waive bypass.

## Alternatives considered

| Alternative | Benefit | Reason not selected |
| --- | --- | --- |
| Rewrite controllers/CLI | Uniform new API | Unnecessary duplication and regression surface |
| Treat Gate 2 approval as special amendment ratification | Less operator work | Violates existing explicit ratification/commit binding contract |
| Add PKI/remote identity and distributed waivers now | Broader authorization assurance | Outside approved identity-infrastructure scope; requires new requirements |
| Drop exception support entirely | Smaller implementation | Fails approved exception requirements; any deferral needs human scope decision |

## Consequences and authority

Implementation remains blocked for affected exception changes until actual ratification. The prerequisite tool needs tests and a separate implementation checkpoint before the operator can use it. Gate 2 may approve the release design and prerequisite-tool implementation without pretending the tool's future approval event already occurred. No current governing policy or amendment status is silently superseded. If the operator rejects this boundary, issue a requirements RFC before implementation.

All release requirements, compatibility/migration, installed assets, human boundaries and verification allocations are specified in ARCHITECTURE-SPEC. Unknown future runtime combinations and native mobile execution are not certified by architectural review.
