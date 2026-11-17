# Mobile Quality Gates Architecture & Verification DAG (Task 007C)

> **Document Type**: Architecture & Quality Gate Specification  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C — Mobile Technology Stacks Architecture  
> **Governing Standards**: [core/engineering-constitution.md](../../../core/engineering-constitution.md) (Principle 8: Quality Gates)  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION

---

## 1. Executive Summary & Multi-Tier Execution Strategy

Mobile applications cannot be validated by a single monolithic command. Compiling native code requires substantial compute, platform-specific tooling (Xcode requires macOS), and multiple minutes of compilation time.

To provide rapid developer feedback while guaranteeing uncompromising production quality, the mobile quality gate architecture establishes a **Four-Tier Verification Model**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Universal Headless Checks (Fast Feedback, < 2 min)             │
│ Environment: Any standard Linux/macOS/Windows runner with Node.js LTS  │
│ Checks: TypeScript Strict, ESLint, Jest+RNTL (Mocks), Config Audits    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Passed
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2: Android Native Compilation (JDK 17 + Android SDK)              │
│ Environment: Linux or macOS runner with Android SDK & Gradle cache     │
│ Checks: Gradle build verification, Android lint, Manifest merge check  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Passed
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 3: iOS Native Compilation (macOS Runner + Xcode + CocoaPods)      │
│ Environment: Dedicated macOS runner with Xcode and CocoaPods cache     │
│ Checks: Xcodebuild archive verification, CocoaPods lock, Info.plist    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Passed (Pre-Release / Staging)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 4: End-to-End & Device Automation (Simulators / Emulators)        │
│ Environment: Hardware/Simulators with Maestro or Detox                 │
│ Checks: Critical user journeys (Authentication, Payments, Navigation)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Master Mobile Quality Gates Matrix

### 2.1 React Native Foundation Checks (`rn-*`)

| Gate ID | Check Name | Stage | Tier | Command / Procedure | Severity | Environment Required |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `rn-typecheck` | React Native TypeScript Strict Typecheck | 4 | 1 | `tsc --noEmit` | blocking | Node.js LTS |
| `rn-lint` | React Native & Accessibility Linting | 4 | 1 | `eslint . --max-warnings=0` | blocking | Node.js LTS |
| `rn-test` | Headless Unit & Component Tests | 4 | 1 | `npm test -- --ci` | blocking | Node.js LTS (Jest + RNTL) |
| `rn-companion-check` | Platform File Companion Parity Audit | 4 | 1 | `node scripts/audit-companions.mjs` | blocking | Node.js LTS |
| `rn-secret-audit` | Mobile Client Secret & Env Leak Audit | 4 | 1 | `node scripts/audit-secrets.mjs` | blocking | Node.js LTS |
| `rn-permission-audit` | Android Manifest & Info.plist Audit | 5 | 1 | `node scripts/audit-permissions.mjs` | blocking | Node.js LTS |
| `rn-android-build` | Android Debug Compilation Validation | 5 | 2 | `cd android && ./gradlew assembleDebug --no-daemon` | blocking | JDK 17, Android SDK |
| `rn-ios-build` | iOS Workspace Compilation Validation | 5 | 3 | `xcodebuild -workspace ios/*.xcworkspace -scheme Project -configuration Debug -destination 'generic/platform=iOS Simulator' build` | blocking | macOS, Xcode, CocoaPods |

### 2.2 Expo Extension Checks (`expo-*`)

| Gate ID | Check Name | Stage | Tier | Command / Procedure | Severity | Environment Required |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `expo-typecheck` | Expo TypeScript Strict Typecheck | 4 | 1 | `tsc --noEmit` | blocking | Node.js LTS |
| `expo-lint` | Expo ESLint & A11y Validation | 4 | 1 | `eslint . --max-warnings=0` | blocking | Node.js LTS |
| `expo-doctor` | Expo SDK Dependency Compatibility Check | 4 | 1 | `npx expo-doctor` | blocking | Node.js LTS |
| `expo-config-validate` | App Manifest Schema & Property Audit | 4 | 1 | `node scripts/validate-app-config.mjs` | blocking | Node.js LTS |
| `expo-secret-audit` | Expo Client Secret & EXPO_PUBLIC Audit | 4 | 1 | `node scripts/audit-secrets.mjs` | blocking | Node.js LTS |
| `expo-test` | Headless Component & Router Tests | 4 | 1 | `npm test -- --ci` | blocking | Node.js LTS |
| `expo-prebuild-check` | Clean Prebuild Generation Validation | 5 | 1 | `npx expo prebuild --clean --no-install` | blocking | Node.js LTS |
| `expo-eas-config-audit` | EAS Build & Submit Profile Audit | 6 | 1 | `node scripts/audit-eas-config.mjs` | blocking | Node.js LTS |

---

## 3. Detailed Check Specifications

### 3.1 `rn-companion-check` (Stage 4)
- **Objective**: Guarantees that any platform-specific file (`*.ios.*`, `*.android.*`) resolves cleanly across both iOS and Android targets without asymmetric runtime resolution failures.
- **Resolution Verification Rules**:
  - Valid if an exact companion exists (`picker.ios.tsx` + `picker.android.tsx`).
  - Valid if a universal fallback exists (`picker.ios.tsx` + `picker.tsx`).
  - Valid if a universal native fallback exists (`picker.ios.tsx` + `picker.native.tsx`).
  - Valid if annotated as platform-exclusive (`// @playbook-platform-exclusive <platform>`) or registered in `.playbook/rif-patterns.json` AND all consumer imports are verified to be platform-guarded (`Platform.OS` or `Platform.select`).
- **Defect Condition**: Rejects with `UNPAIRED_PLATFORM_FILE` if a non-exempt file has 0 resolution candidates on the opposing target platform; rejects with `UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT` if a platform-exclusive file has unguarded static imports in cross-platform code.
- **Inherent Limitations**: Static file AST scanning verifies file resolution availability and export presence, but cannot trace dynamic string requires (`require('./' + Platform.OS)`). Export type parity is verified in tandem by `rn-typecheck` (`tsc --noEmit`).
- **Evidence Output**: Stored under `.playbook/logs/rn-companion-check.log`.

### 3.2 `expo-doctor` (Stage 4)
- **Objective**: Validates that all installed npm packages match the exact versions vetted for the project's configured Expo SDK version (supporting initial SDK 52 LTS or any upgraded SDK).
- **Procedure**: Executes official `npx expo-doctor`. Detects package version mismatches, duplicate react versions, or incompatible native peer dependencies against official Expo package maps.
- **Failure Consequence**: Fails closed. Incompatible dependencies in mobile crash at runtime.

### 3.3 `expo-prebuild-check` (Stage 5)
- **Objective**: Verifies that all declarative Config Plugins in `app.json` and `plugins/` generate valid native projects without crashing, and enforces zero native drift in Committed CNG projects.
- **Procedure**:
  - Runs `npx expo prebuild --clean --no-install` in an ephemeral temporary directory (`.playbook/.tmp/prebuild-test`).
  - **In Managed Workflows**: Verifies that `android/` and `ios/` projects are generated cleanly without unhandled JavaScript exceptions or malformed plugin configurations.
  - **In Committed CNG Workflows**: In addition to successful generation, executes a Git tree diff comparing generated directories against committed `android/` and `ios/` directories. Any manual native edits not produced by Config Plugins trigger a `PREBUILD_DRIFT_DETECTED` blocking error.
- **Evidence Output**: Captured log and generated tree manifest under `.playbook/logs/expo-prebuild.log`.

### 3.4 Workflow-Specific Gate Application Matrix

| Workflow Category | Tier 1 (Universal Headless) | Tier 2 (Android Compilation) | Tier 3 (iOS Compilation) |
| :--- | :--- | :--- | :--- |
| **Expo Managed Workflow** | Mandatory (`expo-typecheck`, `expo-lint`, `expo-test`, `expo-doctor`, `expo-config-validate`, `expo-secret-audit`, `expo-prebuild-check`) | Optional / Deferred to EAS Build | Optional / Deferred to EAS Build |
| **Expo Committed CNG** | Mandatory (`expo-*` Tier 1 suite including prebuild drift check) | Mandatory (`rn-android-build` executed on committed `android/`) | Mandatory (`rn-ios-build` executed on committed `ios/` where macOS runner available) |
| **Bare React Native CLI** | Mandatory (`rn-typecheck`, `rn-lint`, `rn-test`, `rn-companion-check`, `rn-secret-audit`, `rn-permission-audit`) | Mandatory (`rn-android-build` via Gradle) | Mandatory (`rn-ios-build` via Xcodebuild where macOS runner available) |

### 3.5 Platform Build Disparity Rules in CI
- **Tier 1 (Universal)**: Mandatory on ALL pull requests and local developer pre-push hooks.
- **Tier 2 (Android)**: Executes on standard Linux runners in CI.
- **Tier 3 (iOS)**:
  - If a macOS runner is available in CI: executes on PRs targeting `main` or modifying `ios/**` or `plugins/**`.
  - If a macOS runner is not available: marked as `unsupported_environment` with an approved exception record (`EXC-YYYYMMDD-###.md`), deferring iOS validation to EAS Build or authorized local engineer sign-off.
  - **Core Rule**: An AI agent cannot waive Tier 3 checks on its own authority.
