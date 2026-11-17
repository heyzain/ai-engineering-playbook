# Governance Linters Rule Catalog

> **Specification Version**: 1.0.0  
> **Milestone**: Task 008A — Governance Linters Architecture & Design  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION  
> **Parent Document**: [`README.md`](README.md)  
> **Authoritative Decision**: [`docs/adr/ADR-20261106-001-governance-linters.md`](../../adr/ADR-20261106-001-governance-linters.md)  
> **Governing Constitution**: [`core/engineering-constitution.md`](../../../core/engineering-constitution.md)

---

## 1. Overview & Catalog Organization

This catalog provides the normative specification for all initial rules implemented in the Governance Linter engine. Rules are classified across five functional categories:

- **Category A: Documentation & Reference Consistency (`RULE-DOC-*`)**
- **Category B: Schema & Configuration Integrity (`RULE-SCH-*`)**
- **Category C: Governance Invariants (`RULE-GOV-*`)**
- **Category D: Technology Stack Governance (`RULE-STK-*`)**
- **Category E: Security & Workflow Governance (`RULE-SEC-*`)**

Every rule specifies:
1. **Rule ID**: Canonical stable identifier.
2. **Severity**: Intrinsic defect severity (`error`, `warning`, `info`).
3. **Default Enforcement**: Operational enforcement (`blocking`, `warning`, `advisory`).
4. **Target Scope**: File glob pattern.
5. **Evaluation Method**: Inspection technique.
6. **Diagnostic Codes**: Machine-readable defect codes.
7. **Description & Rationale**: Why the rule exists.
8. **Remediation**: Concrete instructions to resolve violations.
9. **Autofix Feasibility**: Whether an automated safe fix is possible.

---

## 2. Category A: Documentation & Reference Consistency

### `RULE-DOC-REF-INTEGRITY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `**/*.md` (excluding `node_modules/**`, `.playbook/.tmp/**`)
- **Evaluation Method**: `markdown_ast` + `cross_reference`
- **Diagnostic Codes**: `UNRESOLVED_MARKDOWN_LINK`, `BROKEN_RELATIVE_ANCHOR`
- **Description**: Verifies that all relative markdown links and image references point to valid, existing files on disk, and that target anchors (`#section`) exist in the referenced document.
- **Rationale**: Broken documentation links degrade human and agent context navigation, causing hallucinated assumptions.
- **Remediation**: Correct the relative path or anchor target to point to an existing file.
- **Autofix Feasibility**: Partial (can resolve known renamed file paths via path mapping index).

---

### `RULE-DOC-ADR-INTEGRITY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `**/*.md`, `stacks/**/*.json`
- **Evaluation Method**: `regex_pattern` + `filesystem_structural`
- **Diagnostic Codes**: `UNRESOLVED_ADR_REFERENCE`, `MALFORMED_ADR_ID`
- **Description**: Verifies that every referenced Architecture Decision Record (matching `ADR-YYYYMMDD-###`) resolves to an existing file under `docs/adr/`.
- **Rationale**: Decisions cited in governance documents, state transitions, or stack specifications must be verifiable against recorded architecture records.
- **Remediation**: Author the missing ADR using `templates/adr-template.md` or correct the referenced ADR identifier.
- **Autofix Feasibility**: None (human architecture documentation required).

---

### `RULE-DOC-STAGE-BOUNDS`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `governance/**/*.md`, `docs/**/*.md`, `templates/**/*.md`
- **Evaluation Method**: `regex_pattern` + `markdown_ast`
- **Diagnostic Codes**: `INVALID_STAGE_REFERENCE`, `NONEXISTENT_STAGE_SEVEN`
- **Description**: Enforces that the software lifecycle comprises strictly Stages 0 through 6 (`state-machine.md`). Flags any reference to a nonexistent "Stage 7" or stage numbers outside the `0..6` range.
- **Rationale**: Transitioning to or referencing "Stage 7" is strictly barred by state machine invariants; Stage 6 terminal closure seals the milestone.
- **Remediation**: Correct stage references to Stage 6 (Deployment & Milestone Closure) or maintenance milestone reopening (`reopened_maintenance`).
- **Autofix Feasibility**: Yes (replaces `Stage 7` references with appropriate lifecycle terminology).

---

### `RULE-DOC-MANDATORY-SECTIONS`
- **Severity**: `warning` (promoted to `blocking` in `--strict` mode)
- **Default Enforcement**: `warning`
- **Target Scope**: `docs/prd/**/*.md`, `docs/adr/**/*.md`, `docs/rfcs/**/*.md`, `docs/gates/**/*.md`, `docs/exceptions/**/*.md`
- **Evaluation Method**: `markdown_ast`
- **Diagnostic Codes**: `MISSING_MANDATORY_SECTION`, `EMPTY_MANDATORY_SECTION`
- **Description**: Verifies that authored governance artifacts contain all mandatory heading sections defined in their respective canonical templates under `templates/`.
- **Rationale**: Omission of critical sections (e.g. "Security Impact", "Rollback Strategy") leads to unvetted changes entering the codebase.
- **Remediation**: Add the missing heading sections and provide substantive technical details.
- **Autofix Feasibility**: Yes (scaffolds missing heading sections with placeholder tokens).

---

### `RULE-DOC-DEPRECATED-COMMANDS`
- **Severity**: `warning`
- **Default Enforcement**: `warning`
- **Target Scope**: `docs/**/*.md`, `README.md`, `stacks/**/*.md`
- **Evaluation Method**: `regex_pattern`
- **Diagnostic Codes**: `DEPRECATED_CLI_COMMAND_USED`
- **Description**: Detects references to obsolete or superseded CLI command patterns (e.g., `playbook run` instead of `playbook gate run`, or manual script executions when a CLI wrapper exists).
- **Rationale**: Outdated command references cause human errors and AI agent command execution failures.
- **Remediation**: Update commands to current CLI syntax documented in `playbook --help`.
- **Autofix Feasibility**: Yes (deterministic string replacement).

---

## 3. Category B: Schema & Configuration Integrity

> **Reconciliation Note (Task 008B.3)**: Category B was refined from the initial architectural draft (which used generic `RULE-SCH-SYNTAX-VALIDITY` and `RULE-SCH-ENUM-CONSTRAINTS`) into four concrete schema and configuration integrity rules scoped to governing configuration boundaries (`RULE-SCHEMA-MANIFEST-VALIDITY`, `RULE-SCHEMA-STATE-VALIDITY`, `RULE-SCHEMA-GATES-VALIDITY`, and `RULE-CFG-STACK-DECLARATION`). Cross-document check-to-deliverable relational linkage checks (`RULE-SCH-ID-COLLISION`, `RULE-SCH-GATE-REFERENCE`) are consolidated under Category C Governance Invariants.

### `RULE-SCHEMA-MANIFEST-VALIDITY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/manifest.json`
- **Evaluation Method**: `json_schema`
- **Diagnostic Codes**: `MANIFEST_MISSING`, `MANIFEST_PARSE_ERROR`, `MANIFEST_SCHEMA_VIOLATION`
- **Description**: Validates project manifest files against the canonical project-manifest schema (`project-manifest.schema.json`), checking syntax, required properties, types, enum constraints, and prohibited additional properties.
- **Rationale**: The project manifest establishes governance baseline, milestone, lifecycle stage, and capability profile. Corrupted or invalid manifests invalidate controller operations.
- **Remediation**: Correct `.playbook/manifest.json` so all fields conform strictly to `project-manifest.schema.json`.
- **Autofix Feasibility**: None.

---

### `RULE-SCHEMA-STATE-VALIDITY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/state.json`
- **Evaluation Method**: `json_schema`
- **Diagnostic Codes**: `STATE_MISSING`, `STATE_PARSE_ERROR`, `STATE_SCHEMA_VIOLATION`
- **Description**: Validates project state files against the canonical project-state schema (`project-state.schema.json`), detecting malformed JSON, invalid structures, unpermitted enum values, and schema violations without modifying state.
- **Rationale**: State machine transitions require valid, uncorrupted state files. Corrupted state halts CLI execution and lifecycle progression.
- **Remediation**: Repair `.playbook/state.json` to conform to `project-state.schema.json`.
- **Autofix Feasibility**: None (read-only; manual repair or verified rollback required).

---

### `RULE-SCHEMA-GATES-VALIDITY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/quality-gates.json`, `stacks/**/quality-gates.partial.json`
- **Evaluation Method**: `json_schema`
- **Diagnostic Codes**: `GATES_CONFIG_MISSING`, `GATES_PARSE_ERROR`, `GATES_SCHEMA_VIOLATION`
- **Description**: Validates quality-gate configuration against the canonical quality-gates schema (`quality-gates.schema.json`), ensuring all stages, checks, and commands are schema-compliant without executing gates.
- **Rationale**: Malformed quality-gate configurations prevent automated gate evaluation and evidence gathering.
- **Remediation**: Update quality-gate JSON files to satisfy `quality-gates.schema.json`.
- **Autofix Feasibility**: None.

---

### `RULE-CFG-STACK-DECLARATION`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/manifest.json`
- **Evaluation Method**: `cross_reference`
- **Diagnostic Codes**: `UNKNOWN_STACK_ID`, `STACK_DEFINITION_MISSING`, `STACK_DEPENDENCY_MISSING`, `CIRCULAR_STACK_DEPENDENCY`, `STACK_CONFIG_CONFLICT`, `STACK_PREREQUISITE_INCONSISTENCY`
- **Description**: Validates technology-stack declarations and their configuration consistency using canonical StackManager discovery and dependency resolution. Ensures declared stacks exist, dependencies resolve in a valid DAG, and stack configurations do not conflict.
- **Rationale**: Technology stack modules extend quality gates and templates. Invalid declarations or broken dependency DAGs cause composition failures and unmanaged drift.
- **Remediation**: Update declared `technology_stacks` in `.playbook/manifest.json` to valid, available stacks that satisfy prerequisite dependencies.
- **Autofix Feasibility**: None.

---

## 4. Category C: Governance Invariants

### `RULE-GOV-NO-AGENT-APPROVAL`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/state.json`, `docs/gates/**/*.md`
- **Evaluation Method**: `json_ast` + `regex_pattern`
- **Diagnostic Codes**: `AGENT_APPROVAL_PROHIBITED`, `FORGED_APPROVAL_SIDECAR`
- **Description**: Verifies that no stage approval record (`human_approval`) declares an agent actor or agent signature. Inspects `verified_by`, `approver_name`, and approval sidecars for prohibited AI agent patterns.
- **Rationale**: Non-negotiable Principle 1: AI agents are strictly forbidden from approving their own mandatory stage transitions.
- **Remediation**: Stage approval must be executed interactively by an authenticated human operator via `playbook approve`.
- **Autofix Feasibility**: None (requires human decision).

---

### `RULE-GOV-IMMUTABLE-WAL-CI`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.github/workflows/**/*.yml`, `.playbook/quality-gates.json`
- **Evaluation Method**: `yaml_ast` + `regex_pattern`
- **Diagnostic Codes**: `CI_MUTATION_PROHIBITED`, `WAL_MUTATION_IN_CI`
- **Description**: Scans CI workflow definitions and quality gate check commands to ensure they do NOT execute lifecycle-mutating commands (e.g. `playbook advance`, `playbook approve`, `playbook reopen`, `playbook recover`).
- **Rationale**: ADR-20261103-002 establishes that Remote CI is strictly a read-only verifier and must never mutate state or write-ahead journals.
- **Remediation**: Remove lifecycle mutation commands from CI scripts. CI must only run `playbook gate run --headless` and `playbook verify-evidence`.
- **Autofix Feasibility**: None.

---

### `RULE-GOV-EVIDENCE-INTEGRITY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/state.json`
- **Evaluation Method**: `cross_reference` + `filesystem_structural`
- **Diagnostic Codes**: `DELIVERABLE_UNVERIFIED_CLAIM`, `MISSING_EVIDENCE_RECORD`
- **Description**: Verifies that any deliverable marked with `status: "verified"` contains at least one evidence record in `evidence[]` with `result: "passed"`, a non-empty `evidence_ref`, and a valid `evidence_hash`.
- **Rationale**: Agents cannot claim completion or verification without concrete, verifiable evidence files on disk.
- **Remediation**: Run the required quality gate to produce evidence, or reset deliverable status to `in_progress`.
- **Autofix Feasibility**: None.

---

### `RULE-GOV-EXCEPTION-BOUNDS`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.playbook/state.json`, `docs/exceptions/**/*.md`
- **Evaluation Method**: `cross_reference` + `json_ast`
- **Diagnostic Codes**: `UNRESOLVED_EXCEPTION_RECORD`, `EXPIRED_EXCEPTION_IN_USE`
- **Description**: Verifies that all waived deliverables in `state.json` have a corresponding, active exception record under `docs/exceptions/` that has not expired and matches the deliverable scope. Note: record hashing proves byte integrity only; approval evidence and human role authorization remain required for valid waiver governance.
- **Rationale**: Quality gates cannot be waived informally; all waivers require bounded, auditable, authorized human exception records. Cryptographic hashes guarantee record integrity, not human approval.
- **Remediation**: Author an authorized exception record (`EXC-YYYYMMDD-###.md`) or revoke the waiver and satisfy the gate requirement.
- **Autofix Feasibility**: None.

---

### `RULE-GOV-STACK-SOVEREIGNTY`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `stacks/**/template/**`
- **Evaluation Method**: `filesystem_structural`
- **Diagnostic Codes**: `CORE_GOVERNANCE_OVERWRITE_ATTEMPT`
- **Description**: Verifies that no technology stack template contains files targeting `.playbook/manifest.json`, `.playbook/state.json`, `core/`, or `governance/`.
- **Rationale**: Modular technology stacks must never weaken, overwrite, or mutate Core Governance infrastructure.
- **Remediation**: Remove governance-violating files from the stack template directory.
- **Autofix Feasibility**: None.

---

## 5. Category D: Technology Stack Governance

### `RULE-STK-CANONICAL-METADATA`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `stacks/*/stack.json`, `stacks/*`
- **Evaluation Method**: `json_schema` + `filesystem_structural`
- **Diagnostic Codes**: `INCOMPLETE_STACK_STRUCTURE`, `MISSING_CANONICAL_STACK_FILE`, `STACK_METADATA_CONFLICT`
- **Description**: Verifies that every stack directory contains the 6 canonical files (`stack.json`, `spec.md`, `README.md`, `quality-gates.partial.json`, `rif-patterns.json`, `template/`), valid `stack.json` metadata, and consistency between `spec.md` and `stack.json`.
- **Rationale**: Enforces stack modularity standards established in ADR-20261104-001.
- **Remediation**: Scaffold the missing canonical stack files and ensure consistent metadata across stack.json and spec.md.
- **Autofix Feasibility**: Yes (can generate starter metadata files).

---

### `RULE-STK-DEPENDENCY-DAG`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `stacks/*/stack.json`, `stacks/*/quality-gates.partial.json`, `stacks/*/rif-patterns.json`
- **Evaluation Method**: `cross_reference` + `json_ast`
- **Diagnostic Codes**: `CYCLIC_STACK_DEPENDENCY`, `MISSING_STACK_DEPENDENCY`, `DUPLICATE_STACK_DEPENDENCY`, `INVALID_STACK_DEPENDENCY_ID`, `SUBORDINATE_DEPENDENCY_DECLARATION`
- **Description**: Verifies that the stack dependency graph is strictly acyclic, all declared dependencies exist under `stacks/`, dependency IDs are unique and valid kebab-case strings, and subordinate files (`quality-gates.partial.json`, `rif-patterns.json`) do NOT declare dependencies.
- **Rationale**: Prevents deadlocks during topological stack composition and preserves single source of truth.
- **Remediation**: Remove circular or self-dependencies, ensure all referenced dependencies exist, remove duplicate declarations, and delete dependency arrays from subordinate files.
- **Autofix Feasibility**: Yes (removes unauthorized dependency keys from subordinate files).

---

### `RULE-STK-PACKAGE-OVERRIDES`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `stacks/*/stack.json`
- **Evaluation Method**: `json_ast`
- **Diagnostic Codes**: `INVALID_PACKAGE_OVERRIDE_SEMVER`, `FOUNDATION_DEPENDENCY_DELETION`, `CONTRADICTORY_PACKAGE_OVERRIDE`, `INVALID_PACKAGE_OVERRIDE_STRUCTURE`
- **Description**: Verifies that any `packageOverrides` declared in `stack.json` specify valid, concrete package versions (exact pinned versions like `19.3.0` or bounded `~`/`^` prefix constraints like `~6.0.3`), bar open-ended comparison ranges (`>=`, `<=`, `>`, `<`) and wildcards (`*`, `1.x`), do not declare contradictory overrides and removals, and do not delete foundation dependencies of prerequisite stacks without justification.
- **Rationale**: Prevents broken dependency graphs and runtime corruption when composing multi-tier stacks (e.g. Expo over React Native).
- **Remediation**: Specify concrete semver strings in `packageOverrides`, remove contradictory entries, and preserve prerequisite foundation packages in `removeDependencies`.
- **Autofix Feasibility**: None.

---

## 6. Category E: Security & Workflow Governance

### `RULE-SEC-WORKFLOW-PERMS`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.github/workflows/**/*.yml`
- **Evaluation Method**: `yaml_ast`
- **Diagnostic Codes**: `UNSAFE_WORKFLOW_PERMISSIONS`, `MISSING_PERMISSIONS_BLOCK`
- **Description**: Verifies that GitHub Actions workflows declare an explicit, top-level `permissions` block restricted to `contents: read` (or specific least-privilege permissions). Bars `write-all` or unconstrained tokens.
- **Rationale**: Least-privilege token access prevents compromise in the event of runner exploitation.
- **Remediation**: Add `permissions: { contents: read }` at the top level of the workflow.
- **Autofix Feasibility**: Yes (injects safe permissions block).

---

### `RULE-SEC-ACTION-PINNING`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.github/workflows/**/*.yml`
- **Evaluation Method**: `yaml_ast` + `regex_pattern`
- **Diagnostic Codes**: `UNPINNED_THIRD_PARTY_ACTION`
- **Description**: Verifies that all third-party GitHub Actions (e.g. `actions/checkout`, `actions/setup-node`) are pinned to a full 40-character commit SHA, not a mutable tag (`@v4`) or branch.
- **Rationale**: Protects against supply chain attacks and upstream tag mutability.
- **Remediation**: Pin the action to its immutable commit SHA (e.g. `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`).
- **Autofix Feasibility**: Partial (requires lookup of SHA for known official actions).

---

### `RULE-SEC-PR-TARGET-BAN`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.github/workflows/**/*.yml`
- **Evaluation Method**: `yaml_ast`
- **Diagnostic Codes**: `FORBIDDEN_PR_TARGET_TRIGGER`
- **Description**: Flags any workflow using the `pull_request_target` trigger if it also checks out or executes code from the pull request head.
- **Rationale**: `pull_request_target` runs in the context of the base repository with access to repository secrets; executing untrusted fork code in this context allows immediate secret exfiltration.
- **Remediation**: Switch trigger to `pull_request`, or isolate untrusted code execution from privileged workflows.
- **Autofix Feasibility**: None (security architecture modification required).

---

### `RULE-SEC-PUBLIC-ENV-LEAK`
- **Severity**: `error`
- **Default Enforcement**: `blocking`
- **Target Scope**: `.env*`, `**/*.env*`, `stacks/**/.env*`
- **Evaluation Method**: `regex_pattern`
- **Diagnostic Codes**: `PUBLIC_ENV_SECRET_LEAK`
- **Description**: Detects high-entropy private credentials, API keys, private keys, database connection strings, or password variables assigned to `EXPO_PUBLIC_*`, `NEXT_PUBLIC_*`, or unencrypted `.env` files.
- **Rationale**: Public bundle prefixes (`EXPO_PUBLIC_`, `NEXT_PUBLIC_`) are compiled into client bytecode and exposed to the public.
- **Remediation**: Move private secrets to backend environments or secure storage; never expose private credentials in public client bundles.
- **Autofix Feasibility**: None.
