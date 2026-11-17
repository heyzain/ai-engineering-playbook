# Downstream Pilot Specification

Status: proposed for Gate 1 review. Date: 2026-11-17. Parent: [release requirements](REQUIREMENTS-SPEC.md), REQ-020 / GOAL-005. No application code created in Phase 2.

## Scope and isolation

Build a single-user Next.js task tracker using the existing stack's framework range and exact package-lock versions recorded at pilot initialization. Separate Git repository: `F:/workspace/playbook-pilot-task-tracker`. If that path already exists, stop and report the collision; never overwrite or recursively remove it. Use an isolated archive installation under the pilot's tooling directory and record CLI/archive/app commit hashes. No source repository imports or global development-tool dependencies.

Use synthetic tasks, no credentials or production data. No login, backend database, synchronization, due dates, teams, notifications, or public deployment. Tasks persist in browser localStorage at key `playbook-pilot.tasks.v1`; localhost is the operational environment. Public network access is needed only for dependency installation and explicitly approved CI. Pilot repository is not automatically pushed; operator selects a remote before remote integration.

## Application acceptance

| ID | Given / when | Then |
| --- | --- | --- |
| P-001 | First visit with no storage | Empty task list and clear empty-state text; title input and Add button accessible |
| P-002 | Add title trimmed to 1–120 Unicode code points | One task with stable unique ID, trimmed title and incomplete status; input clears; task persists |
| P-003 | Submit blank/whitespace or >120 code points | Inline associated error; no task created; entered text retained; Enter and button follow identical validation |
| P-004 | Toggle task then reload | Completion state persists; counts equal total/completed/remaining; duplicate titles allowed with distinct IDs |
| P-005 | Delete one task | Only selected ID removed, counts/storage updated; no cascade or ambiguous title matching |
| P-006 | Filter All/Active/Completed | Correct subset shown without changing underlying data; empty filtered state explained |
| P-007 | Malformed stored JSON, invalid records, or storage read/write failure | Visible recovery message; no silent overwrite of unreadable data; explicit Reset confirmation clears only the pilot key; write failure keeps current session UI and states that changes are not saved |
| P-008 | Keyboard-only use and 375px/1440px viewports | Labels, visible focus, reachable controls, no horizontal page overflow; completion/filter/count semantics observable in tests |

Storage records are arrays of objects containing non-empty unique string `id`, valid trimmed `title`, and boolean `completed`. Reject the entire stored payload if records violate this contract; do not silently drop tasks. Concurrent-tab synchronization and task editing are excluded. Test long titles using code-point counting, not UTF-16 code-unit assumptions.

## Governed workflow acceptance

Initialize at Stage 0; author and verify each stage's canonical deliverables; perform genuine human review at every gate; record source/evidence hashes and decisions; close Stage 6 without a Stage 7. Application specification may be reused as input, but pilot gate approval is not inherited from this playbook project.

Demonstrate one intentionally failing application check blocking progress, one evidence file modification causing verification rejection, and one headless approval attempt being rejected. Restore synthetic fixtures, reverify, and use authorized recovery where needed; keep original failure evidence. Rejected approval is never simulated as a real human approval.

Stage 6 uses local installation/server deployment, smoke results for P-001/P-002/P-004, the observation window from NFR-009, and rollback in a separate copy of the pilot. Record commands, browser checks, exact versions, app revision, archive checksum, and cleanup instructions. Leave the pilot intact for review; cleanup is a separate explicit operator action.
