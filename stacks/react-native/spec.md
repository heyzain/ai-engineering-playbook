# React Native Foundation Stack Specification

> **Stack Identifier**: `react-native`  
> **Specification Version**: `1.0.0`  
> **Dependencies**: None  
> **Status**: NORMATIVE SPECIFICATION  
> **Governing ADR**: [`ADR-20261104-002`](../../docs/adr/ADR-20261104-002-mobile-technology-stacks.md)  
> **Target Framework**: React Native `>= 0.74.0 < 0.78.0` (Recommended: React Native 0.76 LTS)

---

## 1. Scope & Framework Requirements

- **Target Versions**: React Native `>= 0.74.0` (Recommended: `0.76.x` LTS).
- **Runtime Target**: Node.js `>= 20.9.0` LTS.
- **JavaScript Engine**: **Hermes** is mandatory. JavaScriptCore (JSC) is deprecated and barred for new projects.
- **Architecture Baseline**: React Native New Architecture (Fabric Renderer, TurboModules via C++ JSI) enabled by default. Legacy bridge modules are restricted to third-party dependencies with documented exception records (`EXC-*`).
- **Foundation Scope**: Standalone bare React Native CLI foundation. This stack does NOT require or depend on Expo, Expo Router, or EAS.

---

## 2. Project Architecture & Code Organization

### 2.1 Separation of Concerns
React Native projects governed by this stack must enforce strict structural separation:
1. **Screens (`src/screens/`)**: Top-level route/view containers responsible for layout orchestration and routing parameters.
2. **Components (`src/components/`)**:
   - `ui/`: Primitive, reusable, headless UI components (`button.tsx`, `card.tsx`, `input.tsx`).
   - `features/`: Domain-scoped composite components.
3. **Services (`src/services/`)**: API clients, network abstraction, and storage adapters.
4. **Navigation (`src/navigation/`)**: Type-safe stack, tab, or drawer definitions.
5. **Utils (`src/utils/`)**: Ecosystem-neutral formatting, platform helper functions.
6. **Types (`src/types/`)**: Shared TypeScript domain models and native specification types.

### 2.2 Presentation vs. Business Logic
- Business logic, authentication flows, data transformation, and state synchronization must reside outside presentation components (in services, custom hooks, or state stores).
- Presentation components must remain declarative, predictable, and easily testable under headless environments without requiring native runtime compilation.

### 2.3 Platform Isolation
- Platform-specific branches must be isolated using file companion extensions (`.ios.tsx`, `.android.tsx`, `.native.tsx`) or localized `Platform.select()` helpers. Never interleave massive inline platform ternary checks throughout component render trees.

### 2.4 Offline Scaffolding vs. Dependency Installation Boundary
- **Offline Scaffolding**: `playbook stack apply` and `playbook init --stack` generate all starter files, configs, and `package.json` hermetically from local repository templates without network access.
- **Dependency Reproducibility**: All direct dependencies and devDependencies in `package.json.template` use pinned, exact version numbers (e.g. `react-native: 0.76.3`, `react: 18.3.1`, `typescript: 5.6.3`). No static `package-lock.json` is bundled in the template because registry URLs, integrity hashes, and project names vary per environment and project ID. When developers or CI runners execute `npm install`, npm produces the project-specific lockfile, which is subsequently tracked by Git and verified by RIF (`package-lock.json` in RIF patterns). `npm ci` is mandated in automated CI pipelines once the lockfile is generated.

---

## 3. Platform Companion Resolution (`RULE-RN-COMPANION`)

Metro and TypeScript resolve module imports (e.g. `import { Modal } from './modal'`) according to strict target-specific resolution chains:
- **iOS Target**: `.ios.<ext>` → `.native.<ext>` → `.<ext>` (base)
- **Android Target**: `.android.<ext>` → `.native.<ext>` → `.<ext>` (base)

### 3.1 Standard Cross-Platform Modules (Bilateral Resolution)
To eliminate asymmetric runtime crashes and "Unable to resolve module" bundler defects, standard cross-platform modules must provide bilateral resolution across iOS and Android:
1. **Exact Companion Pairing**: `component.ios.tsx` exists alongside `component.android.tsx`.
2. **Universal Fallback Companion**: `component.ios.tsx` exists alongside base `component.tsx` (Android resolves base). Or `component.android.tsx` exists alongside base `component.tsx` (iOS resolves base).
3. **Universal Native Fallback**: `component.ios.tsx` exists alongside `component.native.tsx` (Android resolves `.native.tsx`).

### 3.2 Platform-Exclusive Modules (Exemption Protocol)
When an implementation accesses OS-exclusive APIs (e.g. Apple HealthKit, iOS PassKit, Android WidgetManager):
1. **Exemption Directive**: The file must declare the top-of-file pragma:
   ```typescript
   // @playbook-platform-exclusive <ios|android>
   ```
2. **Verified Guarded Imports**: Every consumer import of a platform-exclusive module must be verified as platform-guarded via:
   - `Platform.OS === '<target>'` condition,
   - `Platform.select({ <target>: ... })`, or
   - Dynamic `require()` / `import()` within a verified platform guard.
3. **Defect Rejection**:
   - **`UNPAIRED_PLATFORM_FILE`**: Fails closed if a file has candidates on one target platform but resolves to 0 candidates on the opposing target without a valid platform-exclusive exemption.
   - **`UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT`**: Fails closed if an exempt platform-exclusive file has an unguarded static import in platform-neutral code.
4. **No-Op Companion Recommendation**: Authors are strongly encouraged to provide a no-op stub companion (e.g. `healthkit.android.tsx` exporting a dummy implementation or `{ isSupported: false }`) rather than relying on exemption directives.

### 3.3 Detection Scope & Inherent Static Analysis Boundaries
- The `rn-platform-companion` gate performs static AST and file resolution scanning across `src/`.
- Dynamic computed module specifiers (e.g. `require('./picker.' + Platform.OS)`) cannot be statically resolved by AST scanners and are flagged by ESLint.
- Type parity across companion files is verified in tandem by `rn-typecheck` (`tsc --noEmit`).

---

## 4. Accessibility Standards (`RULE-RN-ACCESSIBILITY`)

Mobile applications must be accessible to users utilizing assistive technologies (VoiceOver on iOS, TalkBack on Android).

### 4.1 Interactive Control Verification
Every interactive component (`<Pressable>`, `<TouchableOpacity>`, `<TouchableHighlight>`) must explicitly declare:
1. **Accessibility Role**: `accessibilityRole` (or `role`) set to a valid mobile ARIA role: `"button"`, `"link"`, `"header"`, `"image"`, `"checkbox"`, `"alert"`, `"search"`, `"tab"`, `"switch"`, `"adjustable"`, `"radio"`, `"none"`.
2. **Accessibility Label**: `accessibilityLabel` (or `aria-label`) providing a meaningful, descriptive string localized for screen readers.
   - Generic placeholders (`"button"`, `"click"`, `"press"`, `"press here"`, `"icon"`, `"todo"`, `"test"`) are **strictly prohibited** and rejected by automated audits.

### 4.2 Non-Interactive Elements
- `<View>`, `<Text>`, and layout containers without event handlers are treated as layout/content elements and must not be cluttered with interactive accessibility roles unless explicitly acting as composite controls.

### 4.3 Minimum Touch Target Dimensions
- Android touch targets must meet a minimum dimension of **48 × 48 dp**.
- iOS touch targets must meet a minimum dimension of **44 × 44 pt**.

---

## 5. Security & Storage Architecture (`RULE-MOB-SEC-STORAGE`)

### 5.1 Public Client Bundle Invariant (`SEC-MOB-01`)
1. In mobile applications, **all compiled JavaScript and bundled assets are public**. Code compiles into client-distributed binaries and Hermes bytecode that can be decompiled via static analysis.
2. Private backend credentials, database passwords, JWT signing keys, and private API secrets must **never** be included in mobile source files or `.env*` configurations.
3. Automated gate `mobile-secret-audit` scans environment files and source trees for sensitive credential exposure.

### 5.2 Storage Classification (`SEC-MOB-02`)
Data persistence must strictly separate sensitive credentials from ordinary state:
- **Permitted in Unencrypted Storage (`AsyncStorage`, MMKV, SQLite)**:
  - User interface preferences (theme, font size, audio toggles).
  - Localization state (locale, language, currency).
  - Non-sensitive cache data and offline read-only catalog data.
  - Layout state (scroll positions, active tab indices).
- **Mandated in OS-Protected Secure Storage**:
  - Authentication tokens (OAuth access tokens, refresh tokens, JWTs).
  - Session cookies and bearer credentials.
  - Cryptographic private keys and user credentials (PINs, passwords).
  - High-sensitivity PII requiring encryption at rest.

### 5.3 Platform Secure Storage Implementation
- **iOS**: Keychain Services configured with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` via `react-native-keychain`.
- **Android**: Android Keystore Provider with hardware-backed Keymaster / StrongBox where supported by the physical host device.
- **Realistic Device Limitations**: Hardware-backed isolation (Secure Enclave / StrongBox) is capability-dependent and not universally present on all low-cost Android hardware or emulators. Operating systems fall back to OS-sandboxed cryptographic keystores when hardware chips are absent.
- **Verification Boundary**: Automated static checks (`mobile-secret-audit`) detect hardcoded secrets and unencrypted storage of token-like keys. Stage Gate 6 mandates human review of authentication lifecycles.

---

## 6. Directory Layout Standards

All React Native code must be structured under `src/`:

```
project-root/
├── android/                         # Android native project (Gradle)
├── ios/                             # iOS native project (Xcode & CocoaPods)
├── src/
│   ├── components/                  # Cross-platform components
│   │   └── ui/                      # Primitive UI components
│   │       ├── button.tsx           # Accessible button primitive
│   │       ├── modal.ios.tsx        # iOS modal specialization
│   │       └── modal.android.tsx    # Android modal companion
│   ├── screens/                     # Top-level screen components
│   │   └── home-screen.tsx
│   ├── services/                    # API clients and secure storage service
│   │   └── storage.ts               # Storage contract (AsyncStorage vs Keychain)
│   ├── utils/                       # Utility functions and platform helpers
│   │   └── platform.ts
│   └── types/                       # Shared domain models and specs
├── __tests__/                       # Headless component and unit tests
│   └── App.test.js
├── scripts/                         # Deterministic gate verification scripts
│   ├── audit-secrets.mjs            # Secret and AsyncStorage leakage audit
│   ├── audit-companions.mjs         # Platform file companion audit
│   └── audit-accessibility.mjs      # Accessibility role & label audit
├── index.js                         # React Native AppRegistry entry point
├── App.tsx                          # Root React Native application component
├── metro.config.js                  # Metro bundler configuration
├── babel.config.js                  # Babel preset configuration
├── tsconfig.json                    # Strict TypeScript compiler options
├── eslint.config.mjs                # ESLint configuration
└── package.json                     # Dependencies & lifecycle scripts
```

---

## 7. Quality Gates Breakdown

The React Native Foundation Stack provides 6 deterministic quality gates across Stages 4 and 5:

| Gate ID | Name | Stage | Command | Inputs |
| :--- | :--- | :--- | :--- | :--- |
| `rn-typecheck` | TypeScript Strict Check | 4 | `npx tsc --noEmit` | `src/**/*`, `App.tsx`, `tsconfig.json` |
| `rn-lint` | ESLint Code & Style | 4 | `npx eslint . --max-warnings=0` | `src/**/*`, `eslint.config.mjs` |
| `mobile-secret-audit` | Secret Leakage Audit | 4 | `node scripts/audit-secrets.mjs` | `.env*`, `src/**/*` |
| `rn-platform-companion` | Platform Companion Audit| 4 | `node scripts/audit-companions.mjs` | `src/**/*` |
| `rn-accessibility` | Accessibility Audit | 4 | `node scripts/audit-accessibility.mjs` | `src/**/*`, `App.tsx` |
| `rn-test` | Headless Unit Tests | 5 | `npm test` | `src/**/*`, `__tests__/**/*` |

---

## 8. Agent Operating Instructions

When developing or modifying code within a React Native Foundation project:
1. **Always Provide Companions for Platform Files**: When creating `.ios.*` or `.android.*`, immediately implement the matching companion or provide a universal base fallback (`.tsx` or `.native.tsx`).
2. **Enforce Interactive Accessibility**: Every `<Pressable>` or touchable component must include `accessibilityRole="button"` and a descriptive, non-generic `accessibilityLabel`.
3. **Never Store Auth Tokens in AsyncStorage**: Direct all authentication token storage through `SecureStorageService`.
4. **Verify Offline Scaffolding Determinism**: Run all audit scripts locally (`npm run audit:secrets`, `npm run audit:companions`, `npm run audit:accessibility`) before requesting stage gate approval.
