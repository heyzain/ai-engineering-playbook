# React Native Foundation Stack Specification (Task 007C)

> **Document Type**: Architecture & Technology Reference Specification  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C — Mobile Technology Stacks Architecture  
> **Target Subsystem**: React Native Core Engine, Platform Branching, Native Boundaries, Metro  
> **Target Framework Version**: React Native `>= 0.74.0` (Recommended: React Native 0.76+ with New Architecture enabled)  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION

---

## 1. Executive Summary & Adoption Scope

The **React Native Foundation Stack** (`stacks/react-native/`) defines the universal mobile engineering standard for all mobile applications governed by the AI Engineering Playbook.

It serves two primary roles:
1. **Standalone Foundation**: Powers bare React Native CLI applications where developers maintain direct control over native Android and iOS project files.
2. **Shared Substrate**: Provides the normative component rules, TypeScript conventions, platform file routing, and security invariants inherited by higher-level mobile stacks (specifically `stacks/expo/`).

---

## 2. Framework Versioning & The New Architecture

### 2.1 Supported Versions
- **Recommended**: React Native `0.76.x` LTS.
- **Minimum Supported**: React Native `0.74.0`.
- **Runtime Engine**: **Hermes JavaScript Engine** is mandatory. JavaScriptCore (JSC) is deprecated and barred for new projects.

### 2.2 The New Architecture (Fabric & TurboModules)
- **Fabric Renderer**: Direct C++ rendering tree eliminating the asynchronous serial bridge for layout and UI mutations.
- **TurboModules (JSI)**: Synchronous, typed native calls via JavaScript Interface (JSI). Legacy asynchronous `NativeModules` (`RCTBridgeModule`) are restricted to legacy dependencies with documented exception records (`EXC-*`).
- **Codegen**: Automated generation of native C++, Java, and Objective-C/Swift scaffolding from TypeScript specs (`Native<Module>.ts`).

---

## 3. Canonical Directory Topology (Bare React Native CLI)

```
project-root/
├── .github/workflows/quality-gate.yml    # Playbook mobile CI workflow
├── .playbook/                           # Playbook governance state, manifest & logs
├── android/                             # Android native project (Gradle)
│   ├── app/
│   │   ├── build.gradle
│   │   └── src/main/AndroidManifest.xml
│   ├── build.gradle
│   └── gradle.properties
├── ios/                                 # iOS native project (Xcode & CocoaPods)
│   ├── Podfile
│   ├── ProjectName/
│   │   ├── AppDelegate.mm               # Objective-C++ entry point
│   │   └── Info.plist                   # iOS permissions & configuration
│   └── ProjectName.xcworkspace
├── src/
│   ├── components/                      # Reusable cross-platform UI components
│   │   ├── ui/                          # Headless primitives (Button, Input, Card)
│   │   │   ├── button.tsx               # Universal implementation
│   │   │   ├── modal.ios.tsx            # iOS-specific modal specialization
│   │   │   └── modal.android.tsx        # Android-specific modal companion
│   │   └── features/                    # Domain-scoped feature views
│   ├── navigation/                      # React Navigation root & stack definitions
│   │   ├── types.ts                     # Strict TypeScript navigation types
│   │   └── app-navigator.tsx
│   ├── screens/                         # Top-level screen components
│   │   ├── home-screen.tsx
│   │   └── profile-screen.tsx
│   ├── services/                        # Native and API client integrations
│   │   ├── api.ts
│   │   └── storage.ts                   # Secure hardware-backed storage wrapper
│   ├── types/                           # Shared business models and domain types
│   └── utils/                           # Formatting, platform helpers
├── index.js                             # React Native entry point (AppRegistry)
├── App.tsx                              # Root React Native component
├── metro.config.js                      # Metro bundler configuration
├── babel.config.js                      # Babel preset for React Native
├── tsconfig.json                        # Strict TypeScript compiler options
├── eslint.config.mjs                    # Flat ESLint configuration
└── package.json                         # Dependencies & scripts
```

---

## 4. Platform-Specific File Branching & Companion Invariants

React Native and Metro enable file-based platform specialization using extension suffixes:
- `*.ios.<ext>`: Compiled exclusively for iOS bundles.
- `*.android.<ext>`: Compiled exclusively for Android bundles.
- `*.native.<ext>`: Shared across all native targets (iOS and Android), distinct from Web.
- `*.<ext>`: Universal platform-neutral fallback (`.tsx`, `.ts`, `.jsx`, `.js`).

### 4.1 Resolution Hierarchy Order
Metro and TypeScript resolve module imports (e.g. `import { Widget } from './widget'`) according to strict target-specific resolution chains:
- **iOS Target Resolution Order**:
  1. `widget.ios.<ext>`
  2. `widget.native.<ext>`
  3. `widget.<ext>` (Platform-neutral fallback)
- **Android Target Resolution Order**:
  1. `widget.android.<ext>`
  2. `widget.native.<ext>`
  3. `widget.<ext>` (Platform-neutral fallback)
- **Web Target Resolution Order** (where applicable):
  1. `widget.web.<ext>`
  2. `widget.<ext>` (Platform-neutral fallback)

### 4.2 The Platform Companion Invariant (`RULE-RN-COMPANION`)
To prevent asymmetric compile failures, runtime crashes, and missing symbol errors across target operating systems, the Playbook enforces `RULE-RN-COMPANION`:

#### Module Classification & Resolution Validity
Modules utilizing platform-specific extensions fall into two distinct classifications:

1. **Standard Cross-Platform Modules (Default)**:
   A platform-specialized implementation is valid under any of the following standard resolution conditions:
   - **Exact Companion Pairing**: `component.ios.tsx` exists alongside `component.android.tsx`. Both targets resolve dedicated implementations.
   - **Universal Fallback Companion**: `component.ios.tsx` exists alongside a base `component.tsx`. iOS resolves `.ios.tsx`; Android safely resolves the base `component.tsx`. An exact `component.android.tsx` is **not required**. (Similarly, `component.android.tsx` paired with `component.tsx` is valid without `component.ios.tsx`).
   - **Universal Native with Platform Specialization**: `component.ios.tsx` exists alongside `component.native.tsx`. iOS resolves `.ios.tsx`; Android falls back to `component.native.tsx`. Valid without `component.android.tsx`.

2. **Platform-Exclusive Modules (Exemption by Directive)**:
   When an implementation interacts with OS-exclusive capabilities (e.g., Apple HealthKit, iOS PassKit, Android Widget Manager), it may exist for a single platform without an opposing companion file if and only if:
   - **Exemption Directive**: The file carries the explicit top-of-file pragma: `// @playbook-platform-exclusive <ios|android>` OR is registered under `platform_exclusive_modules` in `.playbook/rif-patterns.json`.
   - **Verified Guarded Imports**: The `rn-companion-check` gate scans all imports of the module across the codebase. Every import must be strictly guarded by:
     - `Platform.OS === '<target>'` conditionals,
     - `Platform.select({ <target>: ... })`, or
     - Dynamic `import()` executed strictly within a verified platform guard.
   - If an unguarded static import of a platform-exclusive file is detected in platform-neutral code, the exemption is rejected with `UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT`.
   - **Recommended Alternative**: Authors are strongly encouraged to provide a no-op stub companion (`healthkit.android.tsx` exporting null / `{ isSupported: false }`). Providing a stub satisfies cross-platform resolution natively and avoids bundler-level resolution errors.

#### Reconciled Defect Condition (`UNPAIRED_PLATFORM_FILE`)
A violation of `RULE-RN-COMPANION` occurs **if and only if** for any module base name:
- One target platform (iOS or Android) has an implementation file; AND
- The opposing target platform resolves to **zero candidate files** (no `.<platform>.*`, no `.native.*`, and no base `.*`); AND
- The module is **not** an authorized platform-exclusive module with verified guarded imports.

If these conditions are met, the gate halts with `UNPAIRED_PLATFORM_FILE`.

#### Interface Parity Invariant
When companion files exist (`component.ios.tsx` and `component.android.tsx` or fallback):
- Both files must export identical TypeScript type signatures, exported component names, and prop contracts.
- Interface divergence must be caught during Stage 4 verification via `tsc --noEmit`.

### 4.3 Static Detection Scope & Inherent Limitations
The `rn-companion-check` gate performs deterministic static file and AST analysis over `src/`. Engineers and agents must recognize the inherent boundaries of static inspection:
- **Heuristic Scope**: Static checks trace standard ESM imports (`import ... from './picker'`), file extension matching, and AST guard verification on platform-exclusive pragmas.
- **Dynamic Imports Limitation**: Static checks cannot dynamically evaluate runtime computed module specifiers (e.g., `require('./module.' + Platform.OS)` or complex ternary requires). Such dynamic patterns are flagged by ESLint and discouraged.
- **Semantic Type Equivalence**: Static filename matching verifies that resolution will not crash Metro with "Unable to resolve module". However, semantic verification that companion files export identical properties requires TypeScript type checking (`tsc --noEmit`), which runs in tandem in Tier 1 quality gates.

---

## 5. Component Architecture & Core Primitives

### 5.1 Permitted Core Components
React Native projects must build UI exclusively with official, performant primitives:
- Layout: `<View>`, `<SafeAreaView>` (via `react-native-safe-area-context`).
- Typography: `<Text>` (raw strings must never be placed outside `<Text>`).
- User Interaction: `<Pressable>` is mandatory. Legacy `<TouchableOpacity>` and `<TouchableHighlight>` are deprecated due to hit-testing overhead.
- Lists: `<FlatList>` or `<SectionList>` for virtualized datasets. `<ScrollView>` is barred for unbounded collections.

### 5.2 Accessibility & Mobile WCAG Mapping
All interactive components must declare accessibility semantics:
- `accessible={true}`
- `accessibilityRole`: One of `"button"`, `"link"`, `"header"`, `"image"`, `"checkbox"`, `"alert"`.
- `accessibilityLabel`: Screen-reader descriptive string localized and un-truncated.
- `accessibilityHint`: Explains the consequence of taking action.
- Minimum touch target size: **48x48 dp** on Android, **44x44 pt** on iOS.

---

## 6. Native Module Boundaries & C++ JSI

1. **Strict Type Contracts**: All native module integrations must define pure TypeScript specifications under `src/types/specs/` adhering to React Native Codegen format (`export interface Spec extends TurboModule`).
2. **Hermetic Mocks for Testing**: Every custom TurboModule or native library must provide a JavaScript mock under `__mocks__/` to allow Jest and React Native Testing Library tests to execute on headless Linux runners without compiling native binaries.
3. **Autolinking Adherence**: Third-party native modules must support standard autolinking. Manual edits to `settings.gradle` or Xcode target build phases are restricted to native exceptions (`EXC-*`).

---

## 7. Metro Bundler & Hermes Compilation

- **Hermes Bytecode Default**: Release builds compile JavaScript into Hermes bytecode (`.hbc`), preventing runtime parsing latency and obfuscating source text.
- **Metro Source Maps**: Hidden inline source maps are disabled in production builds to reduce bundle size and protect source structure.
- **Cache Isolation**: Ephemeral Metro caches (`.metro/`, `metro-cache/`) must never be committed to Git or included in RIF hashes.
