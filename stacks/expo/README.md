# Expo Extension Stack (`stacks/expo`)

> **Stack Type**: Extension Layer  
> **Parent Foundation**: [`react-native`](../react-native/README.md)  
> **Target Framework**: Expo SDK 58 (Active Stable Reference Baseline; React Native 0.88 / React 19.3.0 / Node.js >= 22.13.x)  
> **Governing ADR**: [`ADR-20261104-002`](../../docs/adr/ADR-20261104-002-mobile-technology-stacks.md)

---

## Overview

The `expo` technology stack is an extension layer built on top of the **React Native Foundation** (`stacks/react-native/`).

It specializes the foundation for projects utilizing the **Expo ecosystem**, incorporating:
- Universal file-based routing via `expo-router` (`app/`).
- Centralized application manifest via `app.json`.
- Continuous Native Generation (CNG) and declarative Config Plugins (`plugins/`).
- EAS Build configuration profiles (`eas.json`).
- Hardware-backed secure storage via `expo-secure-store`.
- Deterministic quality gates for Expo dependencies, routing structures, config plugins, and public secret leaks.

## Canonical Dependency Relationship

```
expo ──(extends)──► react-native
```

When `expo` is initialized or applied to a project:
1. The **React Native foundation** is resolved and applied first.
2. The **Expo extension** overlays file-based routes, Expo manifests, and specialized gates with explicit `packageOverrides` for React Native 0.88.1 and React 19.3.0.
3. The resulting `.playbook/manifest.json` contains:
   ```json
   "technology_stacks": [
     "react-native",
     "expo"
   ]
   ```

## Authoritative Expo SDK 58 Package Matrix

Versions reflect official Expo SDK 58 metadata (verified via `bundledNativeModules.json` from `expo@58.0.23`). Tilde (`~`) prefixes denote semver range constraints, not exact pins:

| Package | Version Range / Constraint | Notes |
| :--- | :--- | :--- |
| `expo` | `~58.0.23` | Core Expo SDK runtime |
| `expo-router` | `~58.0.30` | Universal file-based routing |
| `expo-secure-store` | `~58.0.2` | Hardware-backed keychain/keystore |
| `expo-constants` | `~58.0.15` | System & manifest constants |
| `expo-linking` | `~58.0.16` | Deep linking & URL handling |
| `expo-status-bar` | `~58.0.4` | Status bar controller |
| `react-native-safe-area-context` | `~5.11.1` | Native safe area insets |
| `react-native-screens` | `~4.30.1` | Native navigation primitives |
| `react-native` | `0.88.1` | Required React Native runtime |
| `react` | `19.3.0` | React core runtime |
| `react-dom` | `19.3.0` | Required for Expo Router web parity |
| `typescript` | `~6.0.3` | Required TypeScript compiler version |
| `@types/react` | `~19.0.10` | Typing package for React 19 |
| `@types/react-native` | *(Omitted)* | Deprecated after RN 0.73; RN 0.88 includes built-in types |

## Quick Start

Initialize a new project with the Expo stack:
```bash
playbook init --stack expo --name "My Mobile App"
```

Apply the Expo stack to an existing initialized project:
```bash
playbook stack apply expo
```

Compose Expo and React Native quality gates:
```bash
playbook stack compose expo
```

## Quality Gates Mapping

| Gate ID | Name | Stage | Verification Purpose |
| :--- | :--- | :--- | :--- |
| `expo-config-validate` | Manifest Validation | 4 | Validates `app.json`, identifiers, scheme, and runtime version policy |
| `expo-doctor` | Dependency Compatibility | 4 | Verifies dependencies conform to Expo SDK 58 compatibility matrix |
| `expo-route-structure` | Route Structure Audit | 4 | Enforces `app/` structure and default component exports for route files |
| `expo-plugin-validate` | Config Plugin Audit | 4 | Validates declarative Config Plugins and rejects direct native edits |
| `expo-secret-audit` | Expo Secret Audit | 4 | Flags exposed private credentials and enforces `EXPO_PUBLIC_*` rules |
| `expo-test` | Headless Route Tests | 5 | Executes headless Node/Jest component and routing test suites |

## Scripts

- `npm run start` — Start the Expo development server.
- `npm run audit:expo-config` — Validate `app.json` configuration.
- `npm run audit:expo-doctor` — Validate dependency compatibility.
- `npm run audit:routes` — Validate Expo Router directory and exports.
- `npm run audit:expo-plugins` — Validate Config Plugin integrity.
- `npm run audit:expo-secrets` — Audit for credential leaks and `EXPO_PUBLIC_*` violations.
- `npm run audit:secrets` — Mobile secret and unencrypted storage audit.
- `npm run audit:companions` — Platform file companion parity audit.
- `npm run audit:accessibility` — Interactive control accessibility audit.
- `npm test` — Run headless test suite.
