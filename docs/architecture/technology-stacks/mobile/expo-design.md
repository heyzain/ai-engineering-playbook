# Expo Extension Stack Specification (Task 007C / 007C.1)

> **Document Type**: Architecture & Technology Reference Specification  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C.1 — Mobile Architecture Focused Clarifications  
> **Parent Foundation**: [`react-native-design.md`](react-native-design.md)  
> **Baseline Framework Version**: Expo SDK 52 LTS (Initial Reference Baseline)  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION

---

## 1. Executive Summary & Inheritance Scope

The **Expo Extension Stack** (`stacks/expo/`) defines the managed engineering standard for applications built within the Expo ecosystem.

Expo operates strictly as an **extension of the React Native Foundation**:
- **Inherited From Foundation**: All core React Native rules, component primitives, styling paradigms, companion file resolution rules, Hermes engine mandates, and secure storage requirements defined in [`react-native-design.md`](react-native-design.md) apply fully to Expo projects.
- **Specialized By Expo**: Managed manifests (`app.json`/`app.config.ts`), file-based routing (`expo-router`), declarative Config Plugins, continuous native generation (CNG) lifecycles, and Over-the-Air (OTA) runtime boundaries.

---

## 2. Expo SDK Version Policy & Compatibility Model

### 2.1 Initial Baseline vs. Evolving Support Lifecycle
- **Initial Reference Baseline**: Expo SDK `52.0.0` (paired with React Native `0.76.3`, React `18.3.1`, and Expo Router `v4.0.x`) serves as the initial reference baseline for scaffolding templates, quality gate configs, and test fixtures.
- **Not a Permanent Ceiling**: The architecture does not freeze SDK 52 as a permanent limit. The Playbook mobile stack follows an explicit lifecycle policy aligned with upstream Expo releases.
- **Support Lifecycle Policy ($N$ and $N-1$)**:
  - In alignment with official Expo documentation ([Expo Versions](https://docs.expo.dev/versions/latest/)), the Playbook actively supports the **current SDK release ($N$)** and the **immediately preceding release ($N-1$)**.
  - **Active Support**: Fully supported with verified scaffolding templates and active quality gate baselines.
  - **Legacy / Deprecated Transition**: When release $N+1$ is published, release $N-1$ transitions to maintenance, and release $N-2$ transitions to deprecated/legacy status.
  - **Unsupported Status**: An SDK reaches unsupported status when upstream Expo tools (Expo Go, EAS build worker base images, and React Native New Architecture codegen) terminate support (typically ~6 months after deprecation).

### 2.2 Exact Supported SDK Compatibility Pairings
In accordance with official Expo specifications, each explicitly supported SDK defines exact pairings with React Native, React, and router versions:

| Expo SDK Version | React Native Core | React Version | Expo Router Version | New Architecture (Fabric/Turbo) | Playbook Lifecycle Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Expo SDK 52 (Current)** | `0.76.3` | `18.3.1` | `v4.0.x` | Enabled by default | **Active Reference Baseline** |
| **Expo SDK 51 (Preceding)** | `0.74.5` | `18.2.0` | `v3.5.x` | Opt-in | **Active Maintenance** |
| **Expo SDK 50 (Legacy)** | `0.73.6` | `18.2.0` | `v3.4.x` | Opt-in | **Deprecated / Legacy** |

### 2.3 Dynamic Validation & Upgrade Protocol
1. **Dynamic Compatibility Validation (`expo-doctor`)**:
   - Rather than relying on arbitrary version ranges or speculative forward compatibility, compatibility is validated dynamically against official Expo package maps.
   - Stage 4 quality gate `expo-doctor` executes `npx expo-doctor`, which consults official bundled package dictionaries (`@expo/config` and SDK package list for the specific declared SDK version).
   - Validates that:
     - All installed `expo-*` companion packages match the exact versions vetted for the active SDK.
     - No mismatched `react` or `react-native` versions exist across the dependency graph.
     - Native module peer dependencies conform to the official Expo bundled package maps.
   - Any dependency incompatibility causes `expo-doctor` to fail closed.
2. **Official Upgrade Protocol**:
   - Upgrading between SDK versions follows the official Expo deterministic upgrade flow ([Expo Upgrade Walkthrough](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)):
     ```bash
     npx expo install --fix
     npx expo upgrade
     ```
   - Projects upgrade their declared SDK, run `expo-doctor`, and re-verify gates without requiring fundamental governance restructuring.

---

## 3. Expo Workflow Classification & Governance Taxonomy

To prevent architectural ambiguity between bare React Native and Expo projects, the Playbook formalizes three distinct workflow categories and establishes unambiguous classification authority.

### 3.1 The Three Workflow Categories

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Expo Managed Workflow (Ephemeral CNG)                               │
│ - ios/ and android/ are ephemeral or gitignored                        │
│ - Single source of truth: app.json / app.config.ts + Config Plugins    │
│ - Native projects generated on-the-fly during CI or EAS builds         │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Expo Prebuild / Continuous Native Generation (Committed CNG)        │
│ - ios/ and android/ exist on disk and ARE committed to Git             │
│ - Single source of truth: STILL app.json + Config Plugins (Generated)  │
│ - Committed for local Xcode/Android Studio debugging or enterprise CI  │
│ - Manual edits to native folders prohibited (overwritten on prebuild)  │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Bare React Native CLI                                               │
│ - ios/ and android/ are permanent, hand-crafted native source code     │
│ - Single source of truth: ios/ and android/ directories themselves     │
│ - No app.json, no expo dependency, native code modified directly       │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Workflow Comparison Matrix

| Architectural Attribute | 1. Expo Managed Workflow | 2. Expo Prebuild (Committed CNG) | 3. Bare React Native CLI |
| :--- | :--- | :--- | :--- |
| **`ios/` and `android/` Ownership** | Ephemeral (Gitignored / Not present) | Generated artifacts (Committed to Git) | Permanent source code (Committed) |
| **Native Source of Truth** | `app.json` / `app.config.ts` | `app.json` / `app.config.ts` | `ios/` and `android/` native files |
| **Native Customization Policy** | Config Plugins strictly required (`RULE-EXPO-PLUGINS`) | Config Plugins strictly required (`RULE-EXPO-PLUGINS`) | Direct edits in Xcode / Android Studio |
| **Manual Native Edit Consequence** | Impossible (directories not committed) | **Drift Hazard**: Erased on next `expo prebuild --clean` | Expected and standard engineering practice |
| **Prebuild Behavior & Drift Check** | Ephemeral dry-run in Gate 5 (`npx expo prebuild --no-install`) | Drift verification gate checks diff between disk and `npx expo prebuild` | Not applicable (No prebuild engine) |
| **Applicable Build Gates** | `expo-*` gates (Native build via EAS or ephemeral container) | `expo-*` + Tier 2 (`rn-android-build`) + Tier 3 (`rn-ios-build`) | `rn-*` gates directly on native directories |

### 3.3 Authoritative Workflow Classification Protocol

To eliminate classification ambiguity, the Playbook establishes a strict precedence hierarchy: **Manifest declaration is primary and authoritative; package and filesystem introspection serves strictly as fallback evidence.**

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Authoritative Manifest Evaluation                             │
│ ├─ If .playbook/manifest.json exists:                                  │
│ │   ├─ technology_stacks == ["react-native"] -> BARE REACT NATIVE CLI  │
│ │   └─ technology_stacks contains "expo"    -> EXPO ECOSYSTEM          │
│ └─ Cross-check against package.json (Sanity Verification)              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Conflict & Ambiguity Detection (Fail-Closed)                  │
│ ├─ IF manifest declares ["react-native"] BUT package.json contains     │
│ │   "expo" and app.json exists:                                        │
│ │   └─ HALT with AMBIGUOUS_WORKFLOW_CONFIGURATION (INCOMPLETE)         │
│ │      Agent cannot silently guess; Human operator must resolve.       │
│ └─ IF manifest declares ["expo"] BUT package.json lacks "expo":        │
│     └─ HALT with AMBIGUOUS_WORKFLOW_CONFIGURATION (INCOMPLETE)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Unambiguous
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Introspection Fallback (Manifest Uninitialized / Discovery)   │
│ ├─ Check package.json:                                                 │
│ │   ├─ dependencies.expo is ABSENT -> BARE REACT NATIVE CLI            │
│ │   └─ dependencies.expo is PRESENT -> EXPO ECOSYSTEM                  │
│ └─ If EXPO ECOSYSTEM:                                                  │
│     ├─ ios/ & android/ absent or in .gitignore -> EXPO MANAGED         │
│     └─ ios/ & android/ committed in Git        -> EXPO COMMITTED CNG   │
└────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **No Silent Guessing on Conflicting State**: If repository metadata contains conflicting signals (e.g., manifest declares bare React Native, but Expo config files exist; or native folders contain manual edits diverging from Config Plugins in a CNG project), the Playbook **must not silently guess or override**. It halts immediately, flags `AMBIGUOUS_WORKFLOW_CONFIGURATION`, records the deliverable as `INCOMPLETE`, and requires explicit human operator resolution.

---

## 4. Canonical Directory Topology (Expo Managed & CNG Workflows)

```
project-root/
├── .github/workflows/quality-gate.yml    # Playbook mobile CI workflow
├── .playbook/                           # Playbook governance state, manifest & logs
├── app/                                 # Expo Router file-based route tree
│   ├── _layout.tsx                      # Root layout (Navigation providers, fonts)
│   ├── index.tsx                        # Home route (Splash / Entry screen)
│   ├── (tabs)/                          # Tab-based feature group
│   │   ├── _layout.tsx                  # Bottom tabs navigator
│   │   ├── home.tsx
│   │   └── settings.tsx
│   ├── [id].tsx                         # Dynamic route parameter
│   └── +not-found.tsx                   # 404 fallback route
├── assets/                              # Static imagery, fonts, and icons
│   ├── images/
│   │   ├── icon.png                     # App icon (1024x1024)
│   │   ├── splash.png                   # Splash screen image
│   │   └── adaptive-icon.png            # Android adaptive icon
│   └── fonts/
├── src/                                 # Shared cross-platform application logic
│   ├── components/                      # Reusable UI primitives (inherits RN foundation)
│   │   └── ui/
│   │       └── button.tsx
│   ├── services/                        # API clients, secure storage (expo-secure-store)
│   │   ├── api.ts
│   │   └── auth.ts
│   ├── types/                           # TypeScript models and domain schemas
│   └── utils/
├── plugins/                             # Custom Expo Config Plugins
│   └── with-custom-native-config.js
├── app.json                             # Primary Expo application manifest
├── eas.json                             # EAS Build & Submit configuration profiles
├── tsconfig.json                        # Extends 'expo/tsconfig.base' (strict: true)
├── eslint.config.mjs                    # Flat ESLint configuration (eslint-config-expo)
└── package.json                         # Expo SDK dependencies & scripts
```

---

## 5. App Manifest & Config Plugins Architecture

### 5.1 Manifest Single Source of Truth (`app.json` / `app.config.ts`)
In managed workflows, `app.json` (or dynamic `app.config.ts`) serves as the immutable source of truth for:
- App identity: `name`, `slug`, `version`, `orientation`, `icon`.
- Android configuration: `package` (e.g. `com.company.app`), `versionCode`, `adaptiveIcon`, `permissions`.
- iOS configuration: `bundleIdentifier` (e.g. `com.company.app`), `buildNumber`, `infoPlist` usage descriptions.
- Deep linking: `scheme` (URL scheme) and universal links (`associatedDomains`).

### 5.2 Declarative Config Plugins (`RULE-EXPO-PLUGINS`)
1. **Never Manually Edit `android/` or `ios/`**: In an Expo-managed project, the native folders are ephemeral outputs generated by `npx expo prebuild`. Manual edits to XML or Swift files will be erased upon the next prebuild.
2. **Config Plugin Requirement**: Any customization to native build files (`AndroidManifest.xml`, `Info.plist`, `Podfile`, `build.gradle`) must be authored as a declarative Config Plugin under `plugins/` or imported from verified npm packages.
3. **Prebuild Verification Gate**: Gate 5 executes `npx expo prebuild --clean --no-install` in a dry-run environment to verify that all config plugins compile and generate valid native projects without syntax errors.

---

## 6. File-Based Routing with Expo Router

Expo Router brings React Server Component paradigms and file-based routing to mobile:
1. **Root Layout (`app/_layout.tsx`)**:
   - Manages global state providers (Theme, Auth, QueryClient).
   - Pre-loads assets and custom fonts using `useFonts` and `SplashScreen.preventAutoHideAsync()`.
   - Hides the native splash screen only after font loading and hydration complete via `SplashScreen.hideAsync()`.
2. **Type-Safe Routing**:
   - Navigation must use typed routes (`expo-router` typed links).
   - Imperative navigation uses `router.push('/settings')` or `router.replace()`.
   - Dynamic parameters must validate types via Zod schemas or strict parameter interfaces.
3. **404 Route Boundary (`app/+not-found.tsx`)**:
   - Every application must define a root `+not-found.tsx` view to gracefully catch unhandled deep links or broken route transitions.

---

## 7. Over-the-Air (OTA) Update Security & Runtime Versions

Expo Updates enables distributing JavaScript and asset patches directly to user devices over the air. To eliminate catastrophic native bridge mismatches:
1. **Strict `runtimeVersion` Policy**:
   - The `runtimeVersion` property in `app.json` must be bound to native compatibility.
   - Recommended: `"runtimeVersion": { "policy": "appVersion" }` or `"runtimeVersion": { "policy": "fingerprint" }` (calculates a SHA-256 hash of all native files and config plugins).
   - If an OTA update has a different `runtimeVersion` than the installed native shell, the client ignores the update, preventing crashes.
2. **Cryptographic Code Signing**:
   - Production OTA updates must enable code signing via `codeSigningMetadata` in `app.json`.
   - The native binary carries the public key certificate; update manifests must be signed with the corresponding private key to prevent Man-in-the-Middle (MITM) payload injection.

---

## 8. Cloud Build & Submission Boundaries (`eas.json`)

The Playbook treats Expo Application Services (EAS) as an external cloud build provider:
- **`eas.json` Profiles**:
  - `development`: Builds development client binaries with internal debugging tools.
  - `preview`: Standalone ad-hoc/TestFlight/Internal APK builds for QA verification.
  - `production`: Fully optimized release builds for Google Play Store and Apple App Store.
- **Hermetic Governance Boundary**:
  - The Playbook CLI does not perform live network calls to EAS APIs during local quality gates.
  - Quality gates validate that `eas.json` exists, satisfies JSON schema, and contains zero embedded plaintext signing secrets or API tokens.

---

## 9. Quality Gates Mapping for Expo Projects

Expo projects inherit the React Native quality gates and overlay specialized validation:

| Gate Check | Level | Description |
| :--- | :--- | :--- |
| `expo-doctor` | Tier 1 (Mandatory) | Evaluates installed packages against Expo SDK compatibility maps. |
| `expo-config-validate` | Tier 1 (Mandatory) | Validates `app.json` schema, scheme identifiers, and required properties. |
| `expo-secret-audit` | Tier 1 (Mandatory) | Checks `EXPO_PUBLIC_*` variable prefixing and bans private credentials. |
| `expo-prebuild-check` | Tier 1 / Tier 2 (Mandatory) | Runs `npx expo prebuild --clean --no-install` to test Config Plugin synthesis. In Committed CNG, also verifies zero drift against committed native files. |
| `expo-eas-config-audit` | Tier 1 (Mandatory) | Validates `eas.json` structure, build profiles, and secret exclusions. |
