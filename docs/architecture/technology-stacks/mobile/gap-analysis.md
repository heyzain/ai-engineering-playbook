# Mobile Technology Stacks Gap Analysis (Task 007C)

> **Document Type**: Gap Analysis & Requirements Traceability  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C — Mobile Technology Stacks Architecture  
> **Reference Subsystems**: React Native Foundation, Expo Extension, Metro, RIF, Security, CI/CD  
> **Status**: APPROVED GAP ANALYSIS

---

## 1. Executive Summary

While the Playbook successfully established web governance via the Next.js reference stack (Task 007A/B), mobile application development introduces distinct architectural constraints. AI coding agents and human teams routinely encounter severe failure modes when mobile stacks lack formal architectural constraints.

This gap analysis details **GAPs 25 through 34**, spanning inheritance, native bridges, Metro bundling, secure storage, permission auditing, and CI runner platform disparities.

---

## 2. Comprehensive Mobile Gaps Matrix (GAPs 25–34)

| Gap ID | Area | Problem Statement | Constitutional Risk | Architectural Remedy |
| :--- | :--- | :--- | :--- | :--- |
| **GAP-25** | Stack Hierarchy | React Native and Expo treated as isolated silos, duplicating core React Native rules and tests. | Principle 4 (Simplicity / DRY) | Establish a two-layer hierarchy: React Native is the shared foundation; Expo is an extension. |
| **GAP-26** | Platform Branching | AI agents mix platform code or write brittle runtime OS checks (`Platform.OS === 'ios'`) instead of deterministic platform-file extensions. | Principle 3 (Determinism) | Standardize platform file resolution (`.ios.tsx`, `.android.tsx`, `.native.tsx`) and static verification. |
| **GAP-27** | Native Directories | Manual mutations to `android/` and `ios/` inside Expo projects get erased during `expo prebuild`. | Principle 2 (Explicit Boundaries) | Enforce Config Plugins for native customizations in Expo; restrict direct native edits to bare React Native CLI. |
| **GAP-28** | Metro Bundling | Metro bundler cache outputs and lockfile mismatches cause false positive RIF mismatches or failed builds. | Principle 3 (Determinism) | Formulate mobile-specific RIF exclusion globs (`.metro/**`, `android/build/**`, `DerivedData/**`). |
| **GAP-29** | Secret Extraction | Inlining sensitive API tokens into mobile bundles allows trivial extraction via APK/IPA string dumps. | Principle 8 (Quality Gates) | Implement `rn-secret-audit` / `expo-secret-audit` blocking server credentials and non-public keys. |
| **GAP-30** | Insecure Storage | AI agents default to unencrypted `AsyncStorage` for sensitive auth tokens and refresh credentials. | Principle 8 (Quality Gates) | Mandate hardware-backed secure storage (`react-native-keychain`, `expo-secure-store`) via ESLint rules. |
| **GAP-31** | OS Permissions | Missing iOS `Info.plist` usage descriptions cause store rejections; unvetted Android permissions violate privacy. | Principle 8 (Quality Gates) | Static permission and usage description audit gate checks before integration approval. |
| **GAP-32** | CI Disparity | Remote CI assumes Linux runners can build iOS, leading to pipeline failures or skipped verification. | Principle 3 (Determinism) | Multi-tier runner architecture: headless tests on Linux, Android on Linux/JDK, iOS on macOS runners. |
| **GAP-33** | StackManager | Current `StackManager` assumes single, flat stacks without inter-stack dependency declarations. | Principle 5 (Modularity) | Design stack dependency declaration (`dependencies: ["react-native"]`) and composition ordering. |
| **GAP-34** | OTA Updates | Expo Updates applied to incompatible native binaries crash apps due to native bridge mismatch. | Principle 8 (Quality Gates) | Enforce strict `runtimeVersion` fingerprinting and code-signing validation for OTA releases. |

---

## 3. Deep-Dive Gap Explanations

### GAP-25: Monolithic vs. Layered Mobile Stacks
- *Root Cause*: Community repositories often duplicate all React Native documentation and quality checks inside Expo configurations.
- *Impact*: Inconsistencies emerge between bare and managed projects; updates to core React Native component rules do not propagate to Expo.
- *Resolution*: `stacks/react-native/` defines foundational component, TypeScript, Metro, and testing standards. `stacks/expo/` imports and specializes these rules for managed workflows.

### GAP-26: Platform File Branching & AST Divergence
- *Root Cause*: React Native allows file-based platform branching (`Button.ios.tsx` and `Button.android.tsx`). AI agents often create one platform file while omitting the companion file, causing build failures on the opposite OS.
- *Impact*: An application compiles cleanly on Android CI but fails catastrophically on iOS.
- *Resolution*: Automated lint and typecheck rules verify that any platform-specific file (`*.ios.tsx`) has a valid resolution candidate: either an exact counterpart (`*.android.tsx`), a universal native fallback (`*.native.tsx`), a base fallback (`*.tsx`), or an explicit platform-exclusive annotation (`// @playbook-platform-exclusive`) with verified platform-guarded imports.

### GAP-27: Native Directory Topology & Ephemeral Prebuild Drift
- *Root Cause*: In Expo-managed workflows, the `android/` and `ios/` folders are ephemeral outputs of `npx expo prebuild`. In Continuous Native Generation (CNG), teams may commit these generated folders to Git for local debugging or native CI. Developers or agents modifying Java/Swift code directly in these generated directories lose changes upon `npx expo prebuild --clean`. Furthermore, build tools erroneously classify projects as bare React Native simply because `ios/` or `android/` exists.
- *Impact*: Lost work, non-reproducible builds, CI failures, and misclassified project governance.
- *Resolution*: Formulate a three-way workflow taxonomy (Expo Managed, Expo Committed CNG, Bare React Native CLI). Manifest declaration is authoritative; package and Git introspection serve as fallback evidence. Conflicting configurations halt with `AMBIGUOUS_WORKFLOW_CONFIGURATION` as `INCOMPLETE` without silent heuristic guessing. In all Expo projects (Managed or CNG), `app.json` + Config Plugins are the sole source of truth; committed native folders are guarded against manual drift via `expo-prebuild-check`.

### GAP-28: Metro Bundler vs Node Resolution
- *Root Cause*: Metro bundler uses custom module resolution rules (e.g. `react-native` export conditions, asset plugins) that differ from Node's standard module resolution.
- *Impact*: Build tools hash ephemeral Metro caches (`.metro/`, `metro-cache/`) into RIF hashes, causing false-positive cache invalidation.
- *Resolution*: Precise RIF patterns isolating Metro caches while strictly hashing `metro.config.js` and dependency lockfiles.

### GAP-29: Mobile Client Bundle Secret Extraction Risk
- *Root Cause*: Mobile applications are distributed as compiled binaries executed entirely on user devices. Hermes compiles JS into bytecode, but strings and environment variables remain trivial to extract via `strings index.android.bundle` or decompilation tools (JADX, Ghidra).
- *Impact*: Severe security breach when developers inline database keys, private service tokens, or payment gateway private secrets into mobile code.
- *Resolution*: Gate checks `rn-secret-audit` and `expo-secret-audit` scanning `.env*` files, `EXPO_PUBLIC_*` prefixes, and source code for sensitive token naming patterns.

### GAP-30: Insecure Mobile Token Storage vs. Permitted Cache
- *Root Cause*: `AsyncStorage` stores data in unencrypted plaintext (XML files on Android, plist on iOS). If an agent assumes `AsyncStorage` is either globally permitted for all data (leaking auth tokens) OR globally banned (forcing developers into complex Keychain calls for trivial dark-mode toggles), security and usability suffer.
- *Impact*: Session hijacking if tokens are in `AsyncStorage`; severe developer friction or fragile workarounds if harmless UI preferences are banned.
- *Resolution*: Explicitly distinguish data categories: `AsyncStorage` is permitted for UI preferences, non-sensitive feature flags, and offline caches; OS-protected secure storage (`react-native-keychain`, `expo-secure-store`) is strictly mandated as baseline for session tokens, refresh tokens, signing keys, and credentials, utilizing hardware backing where supported by the host device. Enforced via AST linting (`mobile/no-sensitive-async-storage`) and Stage Gate 6 human review.

### GAP-31: Unaudited Mobile OS Permissions & Usage Descriptions
- *Root Cause*: Libraries automatically inject permissions into `AndroidManifest.xml` via manifest merging. On iOS, accessing hardware APIs without an explicit string in `Info.plist` (e.g. `NSCameraUsageDescription`) triggers an immediate runtime SIGABRT crash and Apple App Store submission rejection.
- *Impact*: App crashes in production and deployment rejections at Gate 6.
- *Resolution*: Static analysis gate auditing required usage descriptions and flagging unauthorized background permissions.

### GAP-32: Platform Runner Disparity in Remote CI
- *Root Cause*: Apple's macOS licensing mandates that Xcode and iOS toolchains can only execute on macOS hardware. Standard Linux GitHub Actions runners ($0 cost) can compile Android but cannot compile iOS binaries.
- *Impact*: CI pipelines fail if configured with monolithic jobs requiring both OS builds on a single runner.
- *Resolution*: Segment quality gates into a multi-tier runner architecture: universal headless checks (Linux), Android builds (Linux/JDK), and iOS builds (macOS runners with conditional triggers).

### GAP-33: StackManager Single-Stack Assumption
- *Root Cause*: The initial `StackManager` in Task 007B supports applying individual stacks without explicit cross-stack dependency graphs.
- *Impact*: Applying `expo` alone might not compose base `react-native` quality gates or RIF rules unless manually declared.
- *Resolution*: Architecture specifies `dependencies: ["react-native"]` in `expo` stack metadata and establishes layered composition in the StackManager evolution plan.

### GAP-34: Over-the-Air (OTA) Update Desynchronization
- *Root Cause*: Expo Updates delivers updated JavaScript bundles to installed mobile clients over the air. If the update requires native modules not compiled into the installed binary, the app crashes on launch.
- *Impact*: Global application outage for existing mobile users.
- *Resolution*: Mandate explicit `runtimeVersion` policies and cryptographic code signing for OTA updates.
