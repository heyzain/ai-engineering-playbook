# Mobile Technology Stacks System Design & Composition Model (Task 007C)

> **Document Type**: Architecture & System Design  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C — Mobile Technology Stacks Architecture  
> **Parent Architecture**: [`docs/architecture/technology-stacks/design.md`](../design.md)  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION

---

## 1. Architectural Role & The Foundation-Extension Model

The mobile architecture within the AI Engineering Playbook operates on a strict **Foundation-Extension inheritance hierarchy**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Core Governance (Universal & Immutable)                       │
│ ├─ Engineering Constitution (Separation of Powers, Simplicity, Gates)  │
│ ├─ Stage-Gate Lifecycle (Stage 0 to Stage 6)                           │
│ └─ State Machine & Write-Ahead Logging Contracts                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Specialized By
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2A: React Native Foundation Stack (`stacks/react-native/`)        │
│ ├─ Universal Cross-Platform React Components & Hooks                   │
│ ├─ Platform-Specific File Routing (*.ios.tsx, *.android.tsx)          │
│ ├─ Native Project Boundaries (`android/` and `ios/` folders)          │
│ ├─ Metro Bundler Core Config & Hermes Bytecode Compilation Defaults    │
│ └─ OS-Protected Secure Storage Baseline (Keychain/Keystore)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Extended By
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2B: Expo Extension Stack (`stacks/expo/`)                         │
│ ├─ Managed App Manifest (`app.json` / `app.config.ts`)                 │
│ ├─ File-Based Routing Engine (`expo-router` in `app/`)                 │
│ ├─ Declarative Native Config Plugins & Ephemeral Prebuild Hooks        │
│ ├─ Cloud & Local EAS Build Configuration Profiles (`eas.json`)         │
│ └─ Signed Over-the-Air (OTA) Updates & Runtime Fingerprint Verification│
└────────────────────────────────────────────────────────────────────────┘
```

### The Inviolable Architectural Principles
1. **Zero Core Bleed**: Mobile framework tools (Metro, Gradle, Xcode, CocoaPods, EAS) cannot alter or weaken the Tier 1 Engineering Constitution or core lifecycle state machines.
2. **Single Shared Foundation**: All mobile projects share the React Native foundation. Expo is an extension layer on top of React Native, not an isolated parallel ecosystem.
3. **Fail-Closed Precedence**: If any framework convention (e.g. skipping TypeScript strict mode, disabling linting on native folders, or storing secrets in client bundles) conflicts with the Constitution, **the Constitution strictly prevails**.

---

## 2. Canonical Directory Structure for Mobile Stacks

The physical filesystem layout under `stacks/` organizes mobile standards into two complementary packages:

```
stacks/
├── react-native/                 # React Native Foundation Stack
│   ├── README.md                 # Overview, supported RN versions, CLI usage
│   ├── spec.md                   # Normative React Native architectural rules & idioms
│   ├── quality-gates.partial.json# Modular gate checks for bare RN (rn-typecheck, rn-lint, etc.)
│   ├── rif-patterns.json         # RIF globs (isolates android/build, ios/Pods, .metro)
│   └── template/                 # Bare React Native project scaffold overlay
│       ├── package.json.template
│       ├── tsconfig.json         # Strict TypeScript compiler options
│       ├── eslint.config.mjs     # Flat ESLint config for React Native
│       ├── metro.config.js       # Standard Metro bundler configuration
│       ├── babel.config.js       # Babel preset for React Native
│       ├── index.js              # Native application entry point
│       ├── App.tsx               # Root component (bare workflow)
│       ├── android/              # Native Android project wrapper
│       └── ios/                  # Native iOS project wrapper
│
└── expo/                         # Expo Extension Stack
    ├── README.md                 # Overview, supported Expo SDKs, EAS usage
    ├── spec.md                   # Normative Expo rules, config plugins, router conventions
    ├── quality-gates.partial.json# Modular gate checks for Expo (expo-doctor, expo-prebuild-check)
    ├── rif-patterns.json         # Additional RIF globs (isolates .expo, web-build, .eas)
    └── template/                 # Managed Expo overlay
        ├── package.json.template # Expo SDK dependencies & scripts
        ├── app.json              # Managed Expo manifest
        ├── eas.json              # EAS Build & Submit profiles
        └── app/                  # File-based routing tree (expo-router)
            ├── _layout.tsx       # Root layout
            └── index.tsx         # Home route
```

---

## 3. The Multi-Stack Composition Model

A project declares its technology stack configuration in `.playbook/manifest.json`:

### 3.1 Bare React Native Project Declaration
```json
{
  "project_id": "crypto-wallet-native",
  "technology_stacks": ["react-native"]
}
```

### 3.2 Expo-Managed & Prebuild Project Declarations
Expo projects declare both the foundation and the extension in `.playbook/manifest.json`:
```json
{
  "project_id": "consumer-banking-app",
  "technology_stacks": ["react-native", "expo"]
}
```

The specific Expo workflow is governed by authoritative manifest declaration with introspection fallback:
- **Expo Managed Workflow (Ephemeral CNG)**: `ios/` and `android/` do not exist on disk or are explicitly gitignored. All native code is synthesized dynamically during CI/EAS builds.
- **Expo Prebuild (Committed CNG)**: `ios/` and `android/` exist and are committed to Git for specialized local debugging or native CI caching, but remain strictly generated code governed by Config Plugins and protected against drift by `expo-prebuild-check`.
- **Classification Authority Invariant**: Manifest declaration is primary and authoritative. Package introspection is used solely as a fallback when the manifest is uninitialized. The presence of `ios/` and `android/` directories never classifies a project as Bare React Native when `manifest.technology_stacks` includes `expo` or `package.json` declares an `expo` dependency.
- **Ambiguity Halt Rule**: Any conflicting state (e.g. manifest declaring `["react-native"]` while `package.json` contains `expo` and `app.json` is present) must not be silently resolved by heuristic guessing; the Playbook flags `AMBIGUOUS_WORKFLOW_CONFIGURATION` and halts as `INCOMPLETE` for human operator resolution.

### 3.3 Stack Dependency Contract
Every stack definition declares its dependency prerequisites within its `spec.md` and machine-readable metadata:
- `stacks/react-native/spec.md`: `dependencies: []` (Root foundation).
- `stacks/expo/spec.md`: `dependencies: ["react-native"]` (Requires foundation).

When a project declares `technology_stacks: ["expo"]`, the Playbook composition engine enforces topological resolution:
1. Validates that `react-native` is present or automatically resolves `react-native` as a prerequisite.
2. Injects `react-native` before `expo` in the evaluation sequence.
3. Rejects illegal configurations (e.g. attempting to apply `expo` on a project declaring conflicting web-only stacks without multi-target workspace isolation).

---

## 4. StackManager Evolution Plan (Implementation Requirements for Task 007D)

To support foundation-extension composition without breaking existing Next.js single-stack workflows, the future implementation milestone (Task 007D) must evolve `StackManager`:

### 4.1 Dependency Graph Resolution
- Add `dependencies?: string[]` to `StackInfo` and `StackQualityGatesPartial`.
- When `scaffoldStack` or `composeQualityGates` is invoked, execute topological sorting over declared stacks.
- If dependencies are missing from `manifest.technology_stacks`, fail closed with `STACK_DEPENDENCY_MISSING` unless `--resolve-dependencies` is passed.

### 4.2 Layered Template Overlay Semantics
When multiple stacks are scaffolded together:
```text
1. Foundation Scaffolding:
   Scaffold stacks/react-native/template/ -> establishes base TS, ESLint, and component trees.
2. Extension Overlay:
   Scaffold stacks/expo/template/ -> overlays app.json, eas.json, and app/ routing without destroying shared utilities.
```
- Collision handling between foundation and extension templates must permit explicit extension overrides (e.g. `package.json` scripts merging, `tsconfig.json` extending `expo/tsconfig.base`).

### 4.3 Gate Namespacing & Union Guarantees
- Check IDs must use stable, distinct prefixes:
  - React Native checks: `rn-*` (e.g. `rn-typecheck`, `rn-lint`, `rn-test`).
  - Expo checks: `expo-*` (e.g. `expo-doctor`, `expo-config-validate`, `expo-prebuild-check`, `expo-secret-audit`).
- Distinct prefixes prevent collisions when both `react-native` and `expo` quality gates merge into `.playbook/quality-gates.json`.
- Merging remains 100% idempotent: repeated calls to `playbook stack compose` produce identical configurations.

### 4.4 Backward Compatibility Contract
- The existing Next.js reference stack (`technology_stacks: ["nextjs"]`) continues to function with zero behavioral changes.
- Projects without `technology_stacks` remain 100% valid in technology-agnostic mode.
