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
├── governance/
│   ├── ENGINEERING_CONTROLLER.md       # AI Controller architecture, halt mechanisms, and RFC protocol
│   ├── stage-gate-rules.md             # 7-stage engineering lifecycle, entry/exit criteria, and gates
│   └── exceptions/                     # Directory for individual gate exception records (EXC-YYYYMMDD-###.md)
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
| [templates/README.md](templates/README.md) | Standardized artifact templates (PRD, ADR, RFC, Exit Package, Exception) | Humans & Agents |

---

## 4. Governance & Enforcement Reality

A core tenet of this playbook is **intellectual honesty**. Markdown instructions in a repository cannot technically guarantee compliance on their own.

### The Enforcement Spectrum

```
Current State:                           Target Future State:
Agent Cognitive Compliance              Automated Deterministic Tooling
├─ Structured prompt directives         ├─ Spec linters & schema checkers
├─ Explicit halt mechanisms             ├─ Pre-commit & pre-push git hooks
├─ Self-verification checklists         ├─ CI/CD branch protection gates
└─ Human-in-the-loop sign-offs           └─ AST-based architecture validators
```

1. **Current Foundation (Agent Compliance)**: The Controller operates through structured cognitive self-governance by the agent, backed by explicit human checkpoints and mandatory review sign-offs.
2. **Evolutionary Path (Automated Tooling)**: As the playbook expands, deterministic quality gates (linters, pre-commit hooks, CI checks, and policy-as-code engines) will be introduced to automate verification.

---

## 5. How to Use this Playbook

### For AI Coding Agents
1. Ingest [AGENTS.md](AGENTS.md) immediately upon workspace initialization.
2. Follow the 7 operational controller steps sequentially within the active lifecycle stage.
3. If an input or requirement is ambiguous, halt and trigger a structured Clarification Request using [templates/clarification-rfc-template.md](templates/clarification-rfc-template.md).
4. Verify every deliverable with concrete evidence before reporting completion.
5. **Never self-approve mandatory stage transitions**: Always assemble a Stage Exit Package using [templates/gate-exit-package-template.md](templates/gate-exit-package-template.md) and await explicit human sign-off.

### For Human Engineers and Architects
1. Use the [Stage-Gate Rules](governance/stage-gate-rules.md) to evaluate agent progress at each gate.
2. Review and authorize stage transitions:
   - **Solo Developer Mode**: Explicit in-chat confirmation with recorded evidence (PRs optional).
   - **Team Mode**: Formal Pull Request code reviews and approval sign-offs.
3. Grant gate exceptions only when justified, recording each as an individual document under `governance/exceptions/EXC-YYYYMMDD-###.md` per [ENGINEERING_CONTROLLER.md](governance/ENGINEERING_CONTROLLER.md#9-exception-handling-and-recording) using [templates/exception-record-template.md](templates/exception-record-template.md).
4. Update the [Engineering Constitution](core/engineering-constitution.md) when architectural paradigms evolve.

---

## 6. Next Implementation Steps

With the foundational methodology established, audited, and standard templates implemented, subsequent tasks will address:
1. **Automated Governance Tooling** (`tooling/`): Lightweight pre-commit hooks and gate checklist runners.
2. **Technology Stacks** (`stacks/<technology>/`): Specific engineering standards and scaffolds for Next.js, React, React Native, and Expo.
