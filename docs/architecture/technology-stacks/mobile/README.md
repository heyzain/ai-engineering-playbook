# Mobile Technology Stacks Architecture (React Native Foundation + Expo Extension)

> **Document Type**: Architecture Module Overview  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Task**: Task 007C — Mobile Technology Stacks Architecture  
> **Parent Architecture**: [`docs/architecture/technology-stacks/design.md`](../design.md)  
> **Authoritative ADR**: [`docs/adr/ADR-20261104-002-mobile-technology-stacks.md`](../../../adr/ADR-20261104-002-mobile-technology-stacks.md)  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION (Architecture & Design Only)

---

## 1. Executive Summary & Architectural Charter

Mobile application development introduces unique challenges that do not exist in web or backend environments:
1. **Heterogeneous Target Platforms**: Simultaneous compilation and execution across Android (JVM/NDK/Gradle) and iOS (Objective-C/Swift/Xcode).
2. **Native Bridging & TurboModules**: Interfacing high-level TypeScript/JavaScript runtime threads with platform-native UI threads via asynchronous bridges or synchronous C++ JSI (JavaScript Interface).
3. **Hardware & Secure Enclave Boundaries**: Managing device hardware (biometrics, secure enclaves, camera, location) through platform-specific permission manifests (`AndroidManifest.xml`, `Info.plist`).
4. **Client-Side Bytecode Bundling**: Compiling JS into Hermes bytecode bundles distributed as static binaries (APKs/AABs and IPAs), which cannot be modified after distribution without formal store updates or cryptographically signed Over-the-Air (OTA) patches.

To address these challenges while adhering strictly to the [Engineering Constitution](../../../core/engineering-constitution.md), this specification establishes a **two-layer modular mobile architecture**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Core Playbook Governance (Immutable & Technology-Agnostic)      │
│ ├─ Engineering Constitution (Human Sovereignty, Simplicity, Gates)     │
│ └─ Lifecycle Stages 0 to 6 & Deterministic State Machine Engine        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Specialized By
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2A: React Native Foundation Stack (`stacks/react-native/`)        │
│ ├─ Core Cross-Platform UI Primitives (View, Text, Pressable, Hooks)    │
│ ├─ Strict TypeScript & Platform-File Branching (.ios.tsx, .android.tsx)│
│ ├─ Metro Bundler Primitives & Hermes Bytecode Compilation Defaults     │
│ ├─ Native Project Boundaries (`android/` and `ios/` Topologies)        │
│ └─ OS-Protected Secure Storage Baseline (Keychain/Keystore)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Extended By
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2B: Expo Extension Stack (`stacks/expo/`)                         │
│ ├─ Managed Workflow & Unified Configuration (`app.json`/`app.config.ts`)│
│ ├─ File-Based Routing Engine (`expo-router` via `app/` Directory)      │
│ ├─ Declarative Native Config Plugins & Ephemeral `expo prebuild`       │
│ ├─ EAS Build & Submission Configuration Profiles (`eas.json`)          │
│ └─ Cryptographically Signed Over-the-Air (OTA) Updates & Runtime Seals │
└────────────────────────────────────────────────────────────────────────┘
```

### The Core Architectural Tenet
> **"React Native is the shared foundation. Expo is an extension built on top of that foundation."**

React Native CLI and Expo are **not** treated as two completely independent or competing stacks. React Native provides the baseline mobile idioms, platform file conventions, component architecture, and security baseline. Expo extends this foundation with managed tooling, file-based routing, declarative config plugins, and cloud build boundaries.

### Architectural Clarifications & Accurate Invariants (Task 007C.1 / 007C.2)
1. **Expo SDK Compatibility & Support Lifecycle**: Expo SDK 52 (paired with React Native 0.76.3 and React 18.3.1) serves as the initial reference baseline, not a permanent ceiling. The Playbook adopts Expo's official $N$ (active) and $N-1$ (maintenance) support lifecycle, dynamically validating dependencies via `expo-doctor` without relying on arbitrary or speculative version ranges.
2. **Reconciled Platform Companion Resolution (`RULE-RN-COMPANION`)**: Standard cross-platform modules require bilateral resolution across iOS and Android (via exact companions, universal base `.tsx`, or `.native.tsx`). Platform-exclusive modules are strictly exempt if and only if they carry an explicit directive pragma AND all import sites are verified to be platform-guarded (`Platform.OS` or `Platform.select`); unguarded imports trigger `UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT`.
3. **Authoritative Workflow Classification**: Manifest declaration (`manifest.technology_stacks`) is primary and authoritative. Package introspection and Git tracking are used strictly as fallback evidence. Conflicting configurations halt with `AMBIGUOUS_WORKFLOW_CONFIGURATION` as `INCOMPLETE` requiring human operator resolution.
4. **Accurate Secure Storage Policy (`RULE-MOB-SEC-STORAGE`)**: Establishes OS-protected secure storage (`expo-secure-store` / `react-native-keychain`) as the baseline requirement for credentials, with hardware backing utilized where supported by host hardware and OS. `AsyncStorage` is permitted for non-sensitive UI state and cache. Stage Gate 6 mandates human review of data persistence lifecycles.

---

## 2. Document Manifest

| Document | Purpose | Target Audience |
| :--- | :--- | :--- |
| [**gap-analysis.md**](gap-analysis.md) | Comprehensive analysis of mobile gaps (GAPs 25–34) across native compilation, bridging, secrets, and CI. | Architects, Tooling Authors |
| [**design.md**](design.md) | Foundation-plus-extension inheritance model, manifest composition, and StackManager evolution. | Systems Architects, CLI Leads |
| [**react-native-design.md**](react-native-design.md) | Normative specification for the React Native Foundation stack (`stacks/react-native/`). | Mobile Architects, React Native Engineers |
| [**expo-design.md**](expo-design.md) | Normative specification for the Expo Extension stack (`stacks/expo/`). | Mobile Architects, Expo Engineers |
| [**quality-gates-design.md**](quality-gates-design.md) | Multi-tier mobile quality gates across universal headless runners and platform-specific native toolchains. | QA Engineers, CI/CD Authors |
| [**security-model.md**](security-model.md) | Mobile threat model, bundle secret extraction defense, hardware secure storage, and permission auditing. | Security Architects, Lead Engineers |
| [**ci-build-model.md**](ci-build-model.md) | CI matrix design, platform disparity handling (Linux vs macOS), hermetic builds, and artifact collection. | DevOps Engineers, Systems Architects |
| [**audit-report.md**](audit-report.md) | Architectural compliance assessment and freeze recommendation for future implementation phases. | Governance Controller, Reviewers |
| [**ADR-20261104-002**](../../../adr/ADR-20261104-002-mobile-technology-stacks.md) | Authoritative Architecture Decision Record freezing the mobile architecture. | Humans & AI Agents |

---

## 3. Scope Boundaries: Architecture & Design Only

In accordance with Stage 2 of the Playbook Lifecycle:
- **Authorized Work**: Architectural analysis, formal specifications, directory topologies, threat modeling, quality-gate DAG definitions, and ADR authoring.
- **Strictly Barred Work**: Authoring code under `stacks/react-native/` or `stacks/expo/`, editing CLI runtime implementations, modifying `package.json`, installing mobile npm packages, or altering project state.
