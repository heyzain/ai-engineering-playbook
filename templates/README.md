# Engineering Artifact Templates

> Standardized, operational templates for the AI Engineering Playbook.

This directory provides operational templates used by AI agents and human engineers across every stage of the software engineering lifecycle.

---

## Template Catalog

| Template | Primary Stage Alignment | Purpose | Authority / Author |
| :--- | :--- | :--- | :--- |
| [prd-template.md](prd-template.md) | **Stage 0 & Stage 1** | Product Requirements Document: problem formulation, user stories, functional/non-functional specs, and acceptance criteria. | Product Lead / Engineer & AI Co-Author |
| [adr-template.md](adr-template.md) | **Stage 2** | Architecture Decision Record: structural choices, persistence patterns, trade-off analysis, and dependencies. | Architect / Tech Lead & AI Co-Author |
| [clarification-rfc-template.md](clarification-rfc-template.md) | **All Stages** (Step 3) | Clarification Request (RFC): structured resolution of ambiguities, contradictions, or unstated requirements without guessing. | AI Agent / Human Lead Decision |
| [gate-exit-package-template.md](gate-exit-package-template.md) | **Gates 0 through 6** | Stage Gate Exit Package: deliverable verification, test evidence, traceability matrix, and human sign-off record. | AI Agent Compiler / Human Sign-Off |
| [exception-record-template.md](exception-record-template.md) | **Governance** | Engineering Gate Exception: temporary waiver of quality rules with risk assessment, compensating controls, and expiration. | Human Authority Sign-Off |

---

## Operational Principles for Templates

1. **Non-Negotiable Completeness**: Mandatory sections must never be omitted. If information is unavailable, agents must halt and issue an RFC.
2. **Deterministic Evidence Over Claims**: Exit packages and deliverables must include concrete command logs, test counts, and artifact links.
3. **No Self-Approval**: AI agents draft and assemble artifacts; authorized human engineers retain exclusive sign-off authority.
