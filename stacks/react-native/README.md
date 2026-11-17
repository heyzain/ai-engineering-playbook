# React Native Foundation Stack

> **Stack Identifier**: `react-native`  
> **Type**: Tier 2A Foundation Technology Stack  
> **Status**: Official Reference Implementation  
> **Specification**: [`spec.md`](spec.md)  
> **Governing ADR**: [`ADR-20261104-002`](../../docs/adr/ADR-20261104-002-mobile-technology-stacks.md)

---

## Overview

The React Native Foundation Stack establishes the official mobile engineering standard for bare React Native applications governed by the AI Engineering Playbook. It serves as both a standalone foundation for React Native CLI applications and the shared foundation extended by `stacks/expo/`.

## Key Capabilities

1. **New Architecture Baseline**: Built for React Native 0.76+ LTS with Hermes JavaScript Engine and TurboModules via C++ JSI.
2. **Platform Companion Resolution (`RULE-RN-COMPANION`)**: Automated enforcement guaranteeing that platform-specialized implementations (`.ios.tsx`, `.android.tsx`) resolve symmetrically without runtime crashes.
3. **Mobile Accessibility (`RULE-RN-ACCESSIBILITY`)**: Automated gate auditing ensuring all interactive elements (`<Pressable>`, `<TouchableOpacity>`) declare valid accessibility roles and meaningful labels.
4. **Mobile Security & Storage (`RULE-MOB-SEC-STORAGE`)**: Strict separation between unencrypted preference caching (`AsyncStorage`) and OS-protected secure storage (iOS Keychain / Android Keystore).
5. **Universal Headless Quality Gates**: Full verification test suites and static analysis capable of executing on standard Linux/macOS/Windows runners without requiring physical mobile hardware.

## Quick Start

### Initializing a New Project
```bash
playbook init my-mobile-app --stack react-native
```

### Applying to an Existing Playbook Project
```bash
playbook stack apply react-native
```

### Composing Quality Gates
```bash
playbook stack compose react-native
```

## Quality Gates

- `rn-typecheck`: TypeScript strict compilation verification.
- `rn-lint`: ESLint mobile and accessibility rules.
- `mobile-secret-audit`: Client bundle credential and unencrypted token scan.
- `rn-platform-companion`: Bilateral platform companion parity verification.
- `rn-accessibility`: Interactive control accessibility role and label audit.
- `rn-test`: Headless component and unit tests.
