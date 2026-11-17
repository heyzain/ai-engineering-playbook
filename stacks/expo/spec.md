# Expo Extension Stack Specification

> **Stack Identifier**: `expo`  
> **Specification Version**: `1.1.0`  
> **Dependencies**: `react-native`  
> **Status**: NORMATIVE SPECIFICATION  
> **Governing ADR**: [`ADR-20261104-002`](../../docs/adr/ADR-20261104-002-mobile-technology-stacks.md)  
> **Target Framework**: Expo SDK 58 (Active Stable Reference Baseline; React Native 0.88 / React 19.3.0 / Node.js >= 22.13.x)

---

## 1. Scope & Framework Requirements

- **Base Foundation Dependency**: Declares an explicit, canonical dependency on `react-native`. Expo operates strictly as an extension layer over the React Native foundation.
- **Reference Baseline Target (Expo SDK 58)**:
  - Official documentation & changelog: [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/) & [SDK 58 Changelog](https://expo.dev/changelog/sdk-58).
  - Version terminology: Tilde ranges such as `~58.0.30` represent semver version ranges (permitting compatible patch revisions within `58.0`), whereas `19.3.0` represents an exact version.
  - Package version matrix (authoritative `bundledNativeModules.json` mapping):
    - `expo`: `~58.0.23`
    - `expo-router`: `~58.0.30`
    - `expo-secure-store`: `~58.0.2`
    - `expo-constants`: `~58.0.15`
    - `expo-linking`: `~58.0.16`
    - `expo-status-bar`: `~58.0.4`
    - `react-native-safe-area-context`: `~5.11.1`
    - `react-native-screens`: `~4.30.1`
    - `react`: `19.3.0`
    - `react-dom`: `19.3.0`
    - `react-native`: `0.88.1` (aligned with official Expo SDK 58 Core RN)
    - `typescript`: `~6.0.3`
    - `@types/react`: `19.3.0`
    - `@types/react-native`: **Omitted** (React Native 0.88 provides native first-party TypeScript definitions; DefinitelyTyped `@types/react-native` is deprecated/discontinued and causes type collisions).
  - Node.js Runtime: `>= 22.13.0` (Supports Node.js 22.13+ LTS, Node.js 24.3+, and Node.js 26+; odd versions 23/25 unsupported per Expo policy).
- **Compatibility Lifecycle ($N$ and $N-1$)**:
  - In alignment with official Expo release lifecycles ([Expo Versions](https://docs.expo.dev/versions/latest/)), the Playbook actively supports the current SDK release ($N$, SDK 58) and immediately preceding release ($N-1$, SDK 57).
  - Historical note: SDK 52 is archived context and is no longer the active baseline or current LTS.
- **Dynamic Compatibility Validation**:
  - Validated dynamically via `expo-doctor` and deterministic package mapping audit scripts against pinned version dictionaries.
  - Silent version drift or unvetted combinations fail closed.

---

## 2. Foundation-Extension Architectural Model & React Native Compatibility

### 2.1 The Two-Tier Compatibility Strategy
The Playbook enforces an explicit, deterministic compatibility resolution strategy between the React Native foundation and the Expo extension:
1. **Foundation Sovereignty**:
   - The standalone React Native foundation (`stacks/react-native/`) remains frozen at its LTS baseline (`react-native: 0.76.3`, `react: 18.3.1`).
   - Bare React Native projects are never upgraded or modified merely because the Expo extension exists.
2. **Explicit Extension Overrides (`packageOverrides`)**:
   - Expo SDK 58 requires React Native 0.88 and React 19.3.0.
   - In `stacks/expo/stack.json`, Expo explicitly declares:
     ```json
     "packageOverrides": {
       "dependencies": {
         "react": "19.3.0",
         "react-native": "0.88.1"
       },
       "devDependencies": {
         "@types/react": "19.3.0",
         "typescript": "~6.0.3"
       }
     }
     ```
   - When scaffolding a fresh Expo project (`playbook init --stack expo`), `StackManager` merges dependencies deterministically, applying explicit documented overrides rather than ambiguous last-write-wins overwriting.
3. **Fail-Closed Pre-Existing Dependency Incompatibility**:
   - When applying Expo (`playbook stack apply expo`) to an existing project that already has a `package.json`:
   - If the pre-existing project has an incompatible React Native version (e.g. `0.76.3`) without explicit upgrade approval, `StackManager` detects the conflict against Expo's declared `compatibility` constraints (`react-native: >= 0.88.0 < 0.89.0`) and halts closed with `STACK_INCOMPATIBLE_DEPENDENCY`.
   - Conflicting dependency declarations must not silently resolve through last-write-wins behavior.

---

## 3. Workflow Classification & Governance Taxonomy

The Playbook recognizes three distinct mobile workflow categories:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Expo Managed Workflow (Ephemeral CNG)                               │
│ - ios/ and android/ are ephemeral or gitignored                        │
│ - Single source of truth: app.json + Config Plugins                    │
│ - Native directories generated on-the-fly during build/CI              │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Expo Prebuild / Continuous Native Generation (Committed CNG)        │
│ - ios/ and android/ exist on disk and ARE committed to Git             │
│ - Single source of truth: STILL app.json + Config Plugins              │
│ - Direct native edits prohibited (overwritten on prebuild --clean)     │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Bare React Native CLI                                               │
│ - ios/ and android/ are permanent, hand-crafted native source code     │
│ - Single source of truth: ios/ and android/ native files directly      │
└────────────────────────────────────────────────────────────────────────┘
```

### Authoritative Classification Precedence
1. **Primary Authority**: `.playbook/manifest.json`.
   - `technology_stacks` containing `"expo"` designates an Expo project.
   - `technology_stacks == ["react-native"]` designates Bare React Native.
2. **Conflict & Ambiguity Detection (Fail-Closed)**:
   - If manifest declares `["react-native"]` but `package.json` contains `expo` and `app.json` is present:
     - Halt immediately with `AMBIGUOUS_WORKFLOW_CONFIGURATION`, deliverable status `INCOMPLETE`.
   - If manifest declares `["expo"]` but `package.json` lacks `expo`:
     - Halt immediately with `AMBIGUOUS_WORKFLOW_CONFIGURATION`, deliverable status `INCOMPLETE`.
   - If manifest declares `metadata.mobile_workflow: "expo-managed"` but native directories are committed:
     - Halt immediately with `AMBIGUOUS_WORKFLOW_CONFIGURATION`, deliverable status `INCOMPLETE`.
   - AI agents are strictly forbidden from guessing or silently choosing a workflow when metadata conflicts.
3. **Fallback Introspection**: Permitted only when the project is uninitialized (prior to Stage 0 manifest generation).

---

## 4. App Manifest & Config Plugins (`RULE-EXPO-PLUGINS`)

1. **Manifest Single Source of Truth**:
   - `app.json` defines project identity (`name`, `slug`, `version`), mobile identifiers (`ios.bundleIdentifier`, `android.package`), URL scheme (`scheme`), runtime version policy (`runtimeVersion`), and plugin registrations.
2. **Declarative Config Plugins**:
   - In Expo Managed and Committed CNG workflows, all native modifications (permissions, intent filters, CocoaPods hooks) must be declared in Config Plugins (`plugins/`).
   - Manual edits to `android/` and `ios/` in Expo projects will be overwritten on prebuild and are rejected by quality gates.

---

## 5. File-Based Routing with Expo Router

Expo Router provides universal file-based navigation under the `app/` directory:
1. **Root Layout (`app/_layout.tsx`)**: Global navigation container, status bar coordination, and splash screen management.
2. **Route Conventions**:
   - `app/index.tsx`: Initial entry route.
   - `app/(tabs)/`: Tab-based navigation feature group.
   - `app/+not-found.tsx`: Mandatory 404 fallback route.
3. **Default Export Requirement**:
   - Every file within `app/` representing a screen or layout MUST provide a default component export. Missing default exports cause fatal bundler errors and are caught by `expo-route-structure`.

---

## 6. Security & Storage Architecture

1. **Public Client Bundle Invariant (`SEC-MOB-01`)**:
   - Mobile JavaScript bundles are publicly inspectable and decompilable.
   - Private API keys, database credentials, and signing secrets must never be shipped in mobile bundles.
2. **Environment Variable Prefixing (`EXPO_PUBLIC_*`)**:
   - Only variables explicitly prefixed with `EXPO_PUBLIC_` are exposed to the mobile bundle.
   - Sensitive credentials (e.g. `EXPO_PUBLIC_DB_PASSWORD`) must NEVER be assigned to `EXPO_PUBLIC_*`.
3. **Secure Storage Protocol (`RULE-MOB-SEC-STORAGE`)**:
   - Auth tokens, session cookies, and credentials must use `expo-secure-store` (backed by iOS Keychain and Android Keystore).
   - `AsyncStorage` is permitted only for non-sensitive preferences and temporary cache.

---

## 7. Quality Gates Breakdown

The Expo Extension Stack defines 6 deterministic quality gates across Stages 4 and 5 (inheriting all React Native gates without duplication):

| Gate ID | Name | Stage | Command | Inputs |
| :--- | :--- | :--- | :--- | :--- |
| `expo-config-validate` | Manifest Validation | 4 | `node scripts/audit-expo-config.mjs` | `app.json`, `eas.json` |
| `expo-doctor` | Dependency Compatibility | 4 | `node scripts/audit-expo-doctor.mjs` | `package.json` |
| `expo-route-structure` | Route Structure Audit | 4 | `node scripts/audit-routes.mjs` | `app/**/*` |
| `expo-plugin-validate` | Config Plugin Audit | 4 | `node scripts/audit-expo-plugins.mjs` | `app.json`, `plugins/**/*` |
| `expo-secret-audit` | Expo Secret Leak Audit | 4 | `node scripts/audit-expo-secrets.mjs` | `.env*`, `app/**/*`, `src/**/*` |
| `expo-test` | Headless Route Tests | 5 | `node --test __tests__/**/*.test.js` | `app/**/*`, `__tests__/**/*` |

Composed gate set in projects declaring `["react-native", "expo"]`:
- Core: `core-typecheck`
- Inherited Foundation: `rn-typecheck`, `rn-lint`, `mobile-secret-audit`, `rn-platform-companion`, `rn-accessibility`, `rn-test`
- Expo Extension: `expo-config-validate`, `expo-doctor`, `expo-route-structure`, `expo-plugin-validate`, `expo-secret-audit`, `expo-test`

---

## 8. Agent Operating Instructions

When developing in an Expo extension project:
1. **Never edit `android/` or `ios/` directly in Expo projects**: Author declarative Config Plugins under `plugins/`.
2. **Always export default components from route files** under `app/`.
3. **Never place private secrets in `EXPO_PUBLIC_*` or `.env`**: Mobile bundles are public.
4. **Enforce accessibility**: Include `accessibilityRole` and meaningful `accessibilityLabel` on interactive elements.
5. **Route sensitive auth credentials through `expo-secure-store`**.
