# PRD Core — AI Engineering Playbook completion

## 1. Document Identification & Executive Summary

Date: 2026-11-17. Milestone: M-1.0.0. Stage: 0, Discovery & Problem Formulation. Author: Codex, AI agent. Human owner: Zain Ali. Status: submitted for scope review; no human approval asserted.

Complete and demonstrate the existing playbook so a developer and AI agent can apply its engineering lifecycle to a separate project. The completion roadmap is [completion-plan.md](../completion-plan.md). This document establishes the problem and measurable outcomes; detailed command contracts and application requirements belong to Stage 1.

## 2. Problem Statement & Value Proposition

### Context

AI coding makes implementation inexpensive, but teams can accumulate code without clear requirements, traceable decisions, reliable verification, or explicit authorization. A passing command or convincing narrative can be mistaken for validated delivery.

This repository already contains engineering guidance and substantial tooling. At the committed baseline, its governance ledger still reports Stage 0 not started, the problem statement is absent, controller command integration is incomplete, and there is no verified installed-package pilot. Historical audit descriptions do not establish current release acceptance.

### Core problem

Developers cannot yet rely on a demonstrated, reproducible path from a project request to a verified release with clear human decision boundaries and independently inspectable evidence.

### Value

Make engineering progress understandable and reviewable across agent sessions: what is required, what was built, what checks actually ran, what remains blocked, and which decisions a human approved.

### Quantitative success metrics

| ID | Current baseline | Release target | Measurement |
| --- | --- | --- | --- |
| MET-001 | Governance starts at Stage 0 without approval history | All seven lifecycle stages have valid artifacts, fresh evidence, and actual required human approvals | Validate state, evidence, and stage history; no retrospective approval invention |
| MET-002 | Core operational APIs exist; stage/deliverable command routes absent | Every workflow operation selected in Stage 1 is executable through documented commands | Requirement-to-command acceptance matrix, 100% pass |
| MET-003 | Full test runner blocked by worker `spawn EPERM`; limited 17-test subset passed | Full required suite has zero failures and zero skipped tests in the approved environment | Captured fresh build/test outputs and exit codes |
| MET-004 | External installed-package behavior unverified | One separate pilot uses the packaged CLI without source-checkout resource dependencies | Isolated installation and pilot transcript, 100% mandatory checks pass |
| MET-005 | Invalid-action protections have source/tests but no release pilot proof | All negative scenarios selected in Stage 1 are demonstrated, including failed checks, evidence tampering, and unauthorized approval | Acceptance matrix and preserved rejection evidence |
| MET-006 | Documentation contains stale planned-feature claims | Every supported release command has an executable example and an accurate enforcement statement | Documentation checklist against verified implementation |

These are targets, not current completion claims. Phase 2 defines the exact release matrix, runtime versions, failure contracts, and observation budgets before implementation.

## 3. Target Users & Personas

| ID | User | Need | Workflow |
| --- | --- | --- | --- |
| PER-001 | Solo developer acting as project owner | Understand progress and approve concrete work | Review requirements, evidence, stage packages, and release |
| PER-002 | AI coding agent | Preserve context and perform authorized work with explicit boundaries | Inspect, validate, author, verify, and submit |
| PER-003 | Reviewer or maintainer | Reproduce checks and assess limitations without trusting agent prose | Inspect artifacts, commits, evidence hashes, and negative results |

## 4. Scope Boundaries

### Goals

- GOAL-001: Reconcile this project's discovery records with the actual committed baseline without falsifying history.
- GOAL-002: Complete the existing local lifecycle workflow, including starting work, recording deliverables/evidence, review submission, human approval, and advancement/closure.
- GOAL-003: Verify quality gates, evidence integrity, governance linting, hooks, CI integration, and existing stack behavior against explicit release requirements.
- GOAL-004: Resolve the exception authorization gap through a formally approved design before claiming release readiness or exposing unsafe waiver operations.
- GOAL-005: Demonstrate installation and end-to-end use in a separate pilot project, and provide reproducible onboarding and operational documentation.

### Non-goals

- New hosted service, dashboard, UI, stacks, or generalized autonomous coding platform.
- Autonomous human sign-off or simulated human identities.
- Cryptographic identity infrastructure: TTY is operator attestation; SHA-256 establishes integrity, not identity.
- Production data, credentials, or public deployment in the pilot by default.
- Public registry publication unless explicitly selected later; a locally installable release archive can satisfy the distribution goal.
- Dropping existing stack/compatibility commitments silently to obtain passing results.

## 5. Planning Proposals for Stage 1

| Topic | Proposed direction | Boundary |
| --- | --- | --- |
| First execution environment | Windows x64 with the observed Node 24/npm 11 environment | Existing package declares Node >=18; Stage 1 must select and test a support matrix or explicitly revise that claim |
| Other platforms | Evaluate Linux/macOS claims and required evidence in Stage 1 | No cross-platform certification inferred from Windows checks |
| Distribution | `npm pack` archive, installed in an isolated directory | No public publishing permission implied |
| Pilot | Small Next.js task tracker in a separate disposable Git repository | Stage 1 defines app behavior, location, ownership, and cleanup; no app implementation yet |
| Existing mobile stacks | Preserve and verify declared stack/template behavior | Native builds and remote CI need explicit requirements and actual evidence where mandatory |

These proposals are concrete review inputs, not finalized Stage 1 requirements. Approving Gate 0 confirms the goals and boundaries; it does not ratify the exception ADR or approve future gates.

## 6. Stage 0 Acceptance Criteria

| ID | Assertion | Evidence |
| --- | --- | --- |
| AC0-001 | The problem is stated independently of a framework or command design | Sections 2–3 |
| AC0-002 | Users, goals, non-goals, and quantitative targets are explicit | Sections 2–4 |
| AC0-003 | Inventory references an actual committed baseline and distinguishes observed facts from unverified claims | Phase 1 inventory |
| AC0-004 | Stage 0 records use existing transactional APIs, with the actor recorded as an agent and no forged approval | Bootstrap transcript and schema/evidence verification |
| AC0-005 | Gate 0 package is structurally validated, submitted for human review, and preserves pending approval | Gate 0 package and resulting state |

## 7. Risks, Assumptions & Decisions

The standard suite's child-process restriction remains unresolved; it is not a waived release requirement. Source compilation does not establish system correctness. Stack lookup after package installation, exception authorization, and documentation drift require later verification. The proposed architecture amendment remains pending human ratification. Execution of Phase 1 authorizes discovery work only.

Detailed requirements, negative flows, non-functional budgets, and design contracts are intentionally assigned to Stages 1–2. No application business behavior is assumed here.
