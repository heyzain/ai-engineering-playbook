# AI Engineering Playbook

> A disciplined, technology-agnostic methodology for high-assurance, AI-assisted software engineering.

---

## 1. Vision and Purpose

The **AI Engineering Playbook** establishes how software is engineered when AI coding agents act as primary co-authors and executors alongside human engineers.

### The Problem
AI-assisted coding has drastically reduced the cost of generating source code. However, without systematic engineering governance, AI agents introduce subtle defects, bypass architectural standards, hallucinate ambiguous requirements, and accumulate technical debt at machine velocity. Speed without discipline is a liability.

### The Solution
This playbook shifts the paradigm from ad-hoc "prompt-and-pray" generation to **disciplined, governed, and repeatable engineering**. It establishes:
- An **Engineering Constitution** defining immutable software quality principles.
- A **Lifecycle Governance Model** with explicit stage gates from discovery to production.
- An **AI Engineering Controller** that inspects repository state, prevents premature advancement, detects missing requirements, and enforces human authority.

---

## 2. Scope and Architectural Boundaries

### Technology-Agnostic Core
The foundational principles, stage gates, and controller rules defined in this repository are **100% technology-agnostic**. They apply uniformly regardless of programming language, application domain, or deployment runtime.

### Modular Architecture
Technology-specific rules, linters, project scaffolds, and idioms will be introduced as modular extensions under the canonical directory structure `stacks/<technology>/` without polluting the core governance model:
- `stacks/nextjs/` (Planned) — Next.js App Router, SSR/SSG patterns, edge runtimes.
- `stacks/react/` (Planned) — React component architecture, state management, and web accessibility.
- `stacks/react-native/` (Planned) — Mobile cross-platform patterns, native bridges, performance.
- `stacks/expo/` (Planned) — Expo Application Services (EAS), file-based routing, device APIs.

### Non-Goals for the Foundation
- No premature automation, external frameworks, or heavy package dependencies.
- No language-specific lock-in within the core governance documents.
- No false claims of automated enforcement before automated tooling is integrated.

---

## 3. Repository Organization

```
ai-engineering-playbook/
│
├── README.md                           # Repository overview, vision, scope, and structure (this file)
├── AGENTS.md                           # Primary entry point and operational contract for AI agents
│
├── core/
│   └── engineering-constitution.md     # 10 fundamental engineering principles and non-negotiables
│
├── docs/                               # Repository documentation & decisions
│   └── adr/                            # Architecture Decision Records
│       └── ADR-20261031-001-state-model-refinements.md # State model refinements & two-phase handshake
│
├── governance/
│   ├── ENGINEERING_CONTROLLER.md       # AI Controller architecture, halt mechanisms, and RFC protocol
│   ├── stage-gate-rules.md             # 7-stage engineering lifecycle, entry/exit criteria, and gates
│   ├── state-machine.md                # Deterministic FSM, transition rules, and validation checks
│   ├── downstream-storage-convention.md# Storage architecture and folder layout for downstream projects
│   └── exceptions/                     # Directory for individual gate exception records (EXC-YYYYMMDD-###.md)
│
├── schemas/                            # Machine-readable project schemas & examples
│   ├── README.md                       # Schema specifications, taxonomy, and validation rules
│   ├── project-manifest.schema.json    # JSON Schema for project identity, stack, and paths
│   ├── project-state.schema.json       # JSON Schema for lifecycle progression and approvals
│   └── examples/                       # Canonical valid and invalid test fixtures
│       ├── README.md                   # Examples catalog and assertion criteria
│       ├── valid-manifest.json
│       ├── invalid-manifest.json
│       ├── valid-state-stage1-verified.json
│       ├── valid-state-stage2-approved.json
│       ├── invalid-state-agent-self-approval.json
│       ├── invalid-state-unverified-advance.json
│       ├── invalid-state-unresolved-rfc.json
│       └── invalid-state-expired-exception.json
│
└── templates/                          # Standardized operational engineering templates
    ├── README.md                       # Template catalog and usage guide
    ├── prd-template.md                 # Product Requirements Document template (Stage 0 & 1)
    ├── adr-template.md                 # Architecture Decision Record template (Stage 2)
    ├── clarification-rfc-template.md   # Clarification Request (RFC) template (Gap analysis)
    ├── gate-exit-package-template.md   # Stage Gate Exit Package template (Gates 0–6)
    └── exception-record-template.md    # Gate Exception Record template (Governance exceptions)
```

### Document Manifest

| Document | Purpose | Primary Audience |
| :--- | :--- | :--- |
| [README.md](README.md) | High-level overview, vision, and repository roadmap | Humans & Agents |
| [AGENTS.md](AGENTS.md) | Operational guidelines, execution loop, and mandatory directives | AI Agents |
| [core/engineering-constitution.md](core/engineering-constitution.md) | Immutable engineering values, YAGNI, simplicity, and spec-first rules | Humans & Agents |
| [governance/ENGINEERING_CONTROLLER.md](governance/ENGINEERING_CONTROLLER.md) | Controller mechanics, state inspection, gap analysis, and halts | Humans & Agents |
| [governance/stage-gate-rules.md](governance/stage-gate-rules.md) | Lifecycle stages (0–6), entry/exit criteria, and gate validation | Humans & Agents |
| [governance/state-machine.md](governance/state-machine.md) | Deterministic FSM transition matrix, preconditions, and guards | Humans, Agents & Tools |
| [governance/downstream-storage-convention.md](governance/downstream-storage-convention.md) | Downstream directory layout, state storage, and log retention | Humans & Agents |
| [schemas/README.md](schemas/README.md) | Machine-readable JSON Schema specifications and validation rules | Humans, Agents & Tools |
| [docs/adr/ADR-20261031-001-state-model-refinements.md](docs/adr/ADR-20261031-001-state-model-refinements.md) | Architectural decision record for state model taxonomy and two-phase handshake | Humans & Agents |
| [templates/README.md](templates/README.md) | Standardized artifact templates (PRD, ADR, RFC, Exit Package, Exception) | Humans & Agents |

---

## 4. Governance & Enforcement Reality

A core tenet of this playbook is **intellectual honesty**. Markdown instructions in a repository cannot technically guarantee compliance on their own.

### The Enforcement Spectrum

```
Current Baseline:             Machine-Readable State Layer:       Target Future State:
Agent Cognitive Compliance    Deterministic Schema Contracts       Automated Tool Validation
├─ Structured prompt directives├─ project.manifest.json            ├─ Automated CLI (playbook validate)
├─ Explicit halt mechanisms   ├─ state.json (auditable FSM)        ├─ Spec linters & schema checkers
├─ Self-verification checks   ├─ Verifiable evidence blocks        ├─ Pre-commit & pre-push git hooks
└─ Human-in-the-loop sign-offs └─ Explicit human approval guards   └─ CI/CD branch protection gates
```

1. **Current Foundation (Agent Compliance)**: The Controller operates through structured cognitive self-governance by the agent, backed by explicit human checkpoints and mandatory review sign-offs.
2. **Machine-Readable State (Task 003)**: Formal JSON schemas and finite state machine rules define verifiable boundaries, ensuring project state, deliverables, and evidence are deterministically structured.
3. **Evolutionary Path (Automated Tooling)**: As the playbook expands, deterministic quality gates (CLI validators, pre-commit hooks, CI checks, and policy-as-code engines) will be introduced to automate verification directly against `.playbook/state.json`.

---

## 5. How to Use this Playbook

### For AI Coding Agents
1. Ingest [AGENTS.md](AGENTS.md) immediately upon workspace initialization.
2. Follow the 7 operational controller steps sequentially within the active lifecycle stage.
3. Inspect and update `.playbook/manifest.json` and `.playbook/state.json` per [state-machine.md](governance/state-machine.md).
4. If an input or requirement is ambiguous, halt and trigger a structured Clarification Request using [templates/clarification-rfc-template.md](templates/clarification-rfc-template.md).
5. Verify every deliverable with concrete evidence before reporting completion. Never conflate `completed` with `verified` or `approved`.
6. **Never self-approve mandatory stage transitions**: Always assemble a Stage Exit Package using [templates/gate-exit-package-template.md](templates/gate-exit-package-template.md) and await explicit human sign-off.

### For Human Engineers and Architects
1. Use the [Stage-Gate Rules](governance/stage-gate-rules.md) and [State Machine](governance/state-machine.md) to evaluate agent progress at each gate.
2. Review and authorize stage transitions:
   - **Solo Developer Mode**: Explicit in-chat confirmation with recorded evidence (PRs optional).
   - **Team Mode**: Formal Pull Request code reviews and approval sign-offs.
3. Grant gate exceptions only when justified, recording each as an individual document under `governance/exceptions/EXC-YYYYMMDD-###.md` per [ENGINEERING_CONTROLLER.md](governance/ENGINEERING_CONTROLLER.md#9-exception-handling-and-recording) using [templates/exception-record-template.md](templates/exception-record-template.md).
4. Update the [Engineering Constitution](core/engineering-constitution.md) when architectural paradigms evolve.

---

## 6. Next Implementation Steps

With the foundational methodology, standard templates, and machine-readable project state system established, subsequent tasks will address:
1. **Automated Governance CLI & Tooling** (`tooling/`): A lightweight CLI (e.g. `playbook validate`, `playbook advance`) implementing the state machine checks against `.playbook/state.json`, pre-commit hooks, and CI gate validators.
2. **Technology Stacks** (`stacks/<technology>/`): Specific engineering standards and scaffolds for Next.js, React, React Native, and Expo.
