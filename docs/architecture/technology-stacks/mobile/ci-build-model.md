# Mobile Native Build & CI Pipeline Architecture (Task 007C)

> **Document Type**: Architecture & CI/CD Pipeline Specification  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C — Mobile Technology Stacks Architecture  
> **Target Subsystems**: GitHub Actions Workflows, Native Toolchains, Platform Disparity, EAS Boundaries  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION

---

## 1. Executive Summary & The Platform Disparity Problem

Continuous Integration for mobile applications faces a fundamental architectural asymmetry:
- **Android**: Compiles on standard, low-cost Linux runners using OpenJDK 17 and the Android Command-Line SDK.
- **iOS**: Strictly requires Apple hardware running macOS and Xcode due to Apple licensing agreements. macOS runners in CI environments are significantly more expensive and have lower concurrency limits.

If a CI pipeline naively runs monolithic builds requiring both Android and iOS compilation on every commit, pull request validation becomes sluggish (15–30 minutes) and economically unsustainable.

This document establishes the **Segmented Mobile CI Pipeline Architecture**, decoupling universal verification from platform-specific compilation while maintaining cryptographic evidence integrity.

---

## 2. Segmented Mobile CI Pipeline Topology

```
Pull Request Event / Push
        │
        ▼
┌────────────────────────────────────────────────────────┐
│ Job 1: Headless Quality Gates (Tier 1)                 │
│ Runner: ubuntu-latest (Fast Feedback: < 2 min)        │
│ ├─ Checkout Snapshot & Node 20 Setup                   │
│ ├─ npm ci (Clean lockfile install)                     │
│ ├─ Bare RN: rn-typecheck, rn-lint, rn-test, rn-secrets │
│ ├─ Expo: expo-doctor, expo-config, expo-prebuild-check │
│ └─ CNG Drift Audit: Git diff vs generated prebuild     │
└───────────────────┬────────────────────────────────────┘
                    │ All Tier 1 Checks Passed
                    ├────────────────────────────────────┐
                    ▼                                    ▼
┌──────────────────────────────────────┐ ┌──────────────────────────────────────┐
│ Job 2: Android Build (Tier 2)        │ │ Job 3: iOS Build (Tier 3)            │
│ Runner: ubuntu-latest                │ │ Runner: macos-14 / macos-15          │
│ Target: Bare RN & Committed CNG      │ │ Target: Bare RN & Committed CNG      │
│ (Expo Managed: optional / EAS)       │ │ (Expo Managed: optional / EAS)       │
│ ├─ Setup Java 17 & Android SDK       │ │ ├─ Select Xcode Version & CocoaPods  │
│ ├─ Restore Gradle Cache              │ │ ├─ Restore Pods Cache                │
│ ├─ ./gradlew assembleDebug           │ │ ├─ xcodebuild -configuration Debug   │
│ └─ Record APK SHA-256 Digest         │ │ └─ Record App Archive Digest         │
└──────────────────────────────────────┘ └──────────────────────────────────────┘
```

---

## 3. Toolchain & Environment Requirements

### 3.1 Tier 1 (Universal Headless Runner)
- **Host OS**: `ubuntu-latest` (Linux x86_64).
- **Tooling**: Node.js `>= 20.9.0` LTS, npm `>= 10.0.0`.
- **Execution Cost**: Lowest; runs on 100% of pull requests, commits, and local Git hooks.

### 3.2 Tier 2 (Android Native Toolchain)
- **Host OS**: `ubuntu-latest`.
- **Tooling**:
  - OpenJDK 17 (Temurin recommended).
  - Android SDK (API 34 / 35, Build-Tools `34.0.0` or `35.0.0`).
  - Gradle Daemon disabled (`--no-daemon`) to ensure clean process teardown.
- **Caching**: Gradle wrapper, `~/.gradle/caches`, and `android/.gradle`.

### 3.3 Tier 3 (iOS Native Toolchain)
- **Host OS**: `macos-14` (Apple Silicon M1/M2) or `macos-15`.
- **Tooling**:
  - Xcode `>= 15.4` or `16.0`.
  - CocoaPods `>= 1.15.0`.
  - Ruby `>= 3.2.0` (managed via `chruby` / `rbenv`).
- **Conditional Triggering**: To conserve macOS runner minutes, Job 3 executes:
  1. On PRs modifying files under `ios/**`, `plugins/**`, `package.json`, or lockfiles.
  2. On pushes to `main` and release branches (`release/*`).
  3. When manually triggered via `workflow_dispatch`.

---

## 4. Expo Application Services (EAS) Boundary

In Expo-managed projects, production binaries are often compiled via EAS Build in the cloud:
1. **Separation of Concerns**:
   - The Playbook CLI validates configuration, dependencies, and code quality **before** code leaves the local repository or CI runner.
   - EAS Build is the production compilation engine; it is **not** an alternative to Playbook Quality Gates.
2. **Local EAS Validation Gate (`expo-eas-config-audit`)**:
   - Verifies that `eas.json` strictly adheres to schema.
   - Confirms that build profiles (`development`, `preview`, `production`) specify explicit distribution channels and node versions.
   - Ensures no embedded signing keystores or passwords exist in `eas.json`.
3. **EAS Submission Evidence**:
   - When an EAS build completes, the resulting build URL, git commit SHA, and artifact hash are recorded into `.playbook/logs/eas-build-receipt.json` as formal evidence for Stage Gate 6.

---

## 5. Offline Scaffolding vs. Online CI Installation

In accordance with [Principle 3 (Determinism Over Heuristics)](../../../core/engineering-constitution.md):
- **Local Scaffolding (Hermetic & Offline)**:
  - `playbook stack apply` and `playbook init --stack` generate local templates, configuration files, and `package.json` purely from local template files without network access.
  - No automatic `npm install` or CocoaPods installation occurs during CLI scaffolding.
- **Remote CI (Reproducible & Isolated)**:
  - CI runners execute `npm ci` validating against the immutable `package-lock.json`.
  - Native dependencies are resolved from trusted package registries (npm, Maven Central, Google Maven, CocoaPods CDN) with strict checksum verification.
