# @ai-engineering-playbook/cli

> Foundational, cross-platform governance CLI for the AI Engineering Playbook.

---

## 1. Overview

`@ai-engineering-playbook/cli` is the executable tooling layer for the AI Engineering Playbook. It operationalizes machine-readable project governance by establishing a deterministic, verifiable workflow for bootstrapping, validating, and governing software repositories co-authored by human engineers and AI coding agents.

### Core Capabilities
- **Project Bootstrapping (`playbook init`)**: Scaffolds standard downstream repository directories (`.playbook/`, `docs/prd/`, `docs/adr/`, `docs/rfcs/`, `docs/gates/`, `docs/exceptions/`, `.playbook/logs/`) and generates schema-conforming `manifest.json` and Stage 0 `state.json`.
- **Accidental State Overwrite Protection**: Refuses to overwrite existing governance manifests or lifecycle state files without explicit human confirmation or the `--force` flag.
- **Real JSON Schema Validation**: Compiles and verifies JSON Schema Draft 2020-12 specifications (`schemas/project-manifest.schema.json` and `schemas/project-state.schema.json`) with detailed JSON-pointer diagnostics.
- **Cross-Platform Path Normalization**: Enforces canonical POSIX forward slashes (`/`) for relative paths across Windows, macOS, and Linux, preventing git diff churn.
- **Programmatic & Headless APIs**: Fully supports interactive terminal prompts (TTY) as well as headless CI/automation execution.

---

## 2. Installation & Setup

### Requirements
- **Node.js**: `>= 18.0.0` (Tested on Node 20 and Node 24)
- **Platforms**: Windows, macOS, Linux

### Development Setup
```bash
# Navigate to CLI workspace
cd tooling/playbook-cli

# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Run automated test suite
npm test
```

### Local Linking
To make the `playbook` binary globally available on your workstation:
```bash
cd tooling/playbook-cli
npm link
```

---

## 3. CLI Command Reference

### `playbook init`
Bootstraps a repository into an AI Engineering Playbook governed project.

```bash
# Interactive mode (guides you through project identity, tech stack, and profile)
playbook init

# Non-interactive / headless mode with custom options
playbook init --non-interactive \
  --project-id payment-service \
  --name "Payment Processing Service" \
  --ecosystem node \
  --language typescript \
  --profile strict \
  --mode solo \
  --milestone M-1.0.0

# Overwrite existing governance files
playbook init --force
```

#### Flags & Options
| Flag | Short | Description | Default |
| :--- | :--- | :--- | :--- |
| `--project-id <id>` | | Unique kebab-case project identifier (e.g. `zentrix-lms`). | Derived from directory name |
| `--name <name>` | | Human-readable display name. | Title Case of directory |
| `--description <desc>` | | Project summary and scope. | Generated summary |
| `--ecosystem <eco>` | | Software ecosystem (`node`, `python`, `go`, `rust`, `java`, `agnostic`). | Inferred or `agnostic` |
| `--language <lang>` | | Primary programming language (`typescript`, `python`, `go`, `rust`, etc.). | Inferred or `agnostic` |
| `--profile <profile>` | | Governance profile (`strict`, `standard`, `lightweight`). | `standard` |
| `--mode <mode>` | | Stage gate human approval mode (`solo`, `team`). | `solo` |
| `--milestone <id>` | | Initial milestone identifier (`^M-[a-zA-Z0-9.-]+$`). | `M-1.0.0` |
| `--force` | `-f` | Overwrite existing governance state. | `false` |
| `--non-interactive` | | Run without terminal prompt questions. | `false` |
| `--cwd <path>` | | Target project directory path. | `process.cwd()` |
| `--help` | `-h` | Display help screen. | |
| `--version` | `-v` | Display CLI and Playbook versions. | |

---

### `playbook validate`
Validates existing project governance files against official JSON Schemas.

```bash
# Validate both manifest.json and state.json
playbook validate

# Validate manifest only
playbook validate manifest

# Validate state only
playbook validate state

# Validate a specific project directory
playbook validate --cwd /path/to/project
```

Returns exit code `0` on success and non-zero exit code (`1`) with clear, field-level error diagnostics on validation failures.

---

## 4. Downstream Directory Layout Created

Running `playbook init` creates the canonical downstream layout defined in [governance/downstream-storage-convention.md](../../governance/downstream-storage-convention.md):

```
<project-root>/
├── .playbook/
│   ├── manifest.json       # Project identity, tech stack, governance profile & paths
│   ├── state.json          # Active lifecycle stage (Stage 0: not_started), deliverables & audit log
│   └── logs/               # Verifiable test runner and static analysis proof outputs
│       └── .gitkeep
└── docs/
    ├── prd/                # Product Requirements Documents (Stage 0 & 1)
    │   └── .gitkeep
    ├── adr/                # Architecture Decision Records (Stage 2)
    │   └── .gitkeep
    ├── rfcs/               # Clarification Requests (Gap analysis halts)
    │   └── .gitkeep
    ├── gates/              # Stage Gate Exit Packages (Gates 0–6)
    │   └── .gitkeep
    └── exceptions/         # Authorized Gate Exceptions (EXC-YYYYMMDD-###.md)
        └── .gitkeep
```

---

## 5. Programmatic TypeScript API

The CLI exports clean, strongly-typed components for use in custom scripts or downstream automation tools:

```typescript
import {
  SchemaValidator,
  ProjectScaffolder,
  createInitialManifest,
  createInitialState,
  runInit,
  runValidate
} from "@ai-engineering-playbook/cli";

// 1. JSON Schema Validator
const validator = new SchemaValidator();
const manifestValidation = validator.validateManifest(someManifestObject);
if (!manifestValidation.valid) {
  console.error(manifestValidation.formattedErrors);
}

// 2. Generate canonical templates
const manifest = createInitialManifest({
  projectId: "core-platform",
  projectName: "Core Platform",
  ecosystem: "node",
  primaryLanguage: "typescript",
});

const state = createInitialState({
  projectId: "core-platform",
  approvalMode: "solo",
});

// 3. Programmatic Scaffolder
const scaffolder = new ProjectScaffolder(validator);
scaffolder.scaffold({
  targetDir: "./my-project",
  manifest,
  state,
  force: false,
});
```

---

## 6. Automated Testing

The CLI includes comprehensive tests running on Node's native test runner (`node:test`):

- **Validator Unit Tests (`tests/validator.test.ts`)**:
  - Compiles Draft 2020-12 schemas.
  - Verifies bundled schemas match repository root schemas.
  - Tests canonical fixtures (`valid-manifest.json`, `valid-state-stage1-verified.json`, `valid-state-stage2-approved.json`).
  - Asserts detection of missing fields, malformed milestone patterns, invalid enums, and out-of-range stage numbers.
- **Scaffolder Unit Tests (`tests/init.test.ts`)**:
  - Tests end-to-end directory creation in temporary sandboxes.
  - Tests collision rejection and `--force` overwrite behavior.
  - Tests fail-fast schema validation before filesystem mutations.
- **Path Utilities Tests (`tests/paths.test.ts`)**:
  - Tests Windows backslash to POSIX slash conversion.
- **CLI Executable Integration Tests (`tests/cli.test.ts`)**:
  - Tests command dispatch, exit codes, version flags, and end-to-end `init` and `validate` executions.

Run tests:
```bash
npm test
```
