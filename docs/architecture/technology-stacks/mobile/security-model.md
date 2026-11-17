# Mobile Security Model & Threat Mitigation Architecture (Task 007C)

> **Document Type**: Architecture & Security Specification  
> **Lifecycle Stage**: Stage 2 — Architecture & System Design  
> **Milestone**: Task 007C — Mobile Technology Stacks Architecture  
> **Governing Standards**: [core/engineering-constitution.md](../../../core/engineering-constitution.md) (Principle 8: Quality Gates & Zero-Trust)  
> **Status**: APPROVED ARCHITECTURAL SPECIFICATION

---

## 1. Executive Summary & Mobile Threat Landscape

Mobile applications execute entirely on untrusted client hardware owned by end users. Unlike backend web servers where source code and environment variables reside behind physical and network perimeters, mobile applications are subject to:
1. **Binary Decompilation & Static Analysis**: Unpacking APKs/AABs or IPAs to dump Hermes bytecode strings (`strings index.android.bundle`), extract hardcoded tokens, or decompile Java/Kotlin with JADX.
2. **Local Storage Extraction**: Rooted Android devices or jailbroken iOS devices allowing attackers to read application sandboxes and SQLite databases.
3. **Man-in-the-Middle (MITM) Interception**: Proxies (Charles, Burp Suite, mitmproxy) intercepting network traffic via user-installed root CA certificates.
4. **Deep-Link URL Injection**: Malicious applications crafting malicious URI schemes (`myapp://payment?callback=attacker.com`) to hijack sessions.

---

## 2. Threat Classification & Mitigation Matrix

| Threat Class | Attack Vector | Automated Gate Check | Human Verification Mandate |
| :--- | :--- | :--- | :--- |
| **Client Bundle Secret Leak** | Private API keys or DB passwords compiled into JS bundle. | `rn-secret-audit` / `expo-secret-audit` scans `.env*`, `EXPO_PUBLIC_*`, and source code. | Verify third-party SDK keys (e.g. Stripe publishable vs secret key). |
| **Plaintext Sensitive Token Storage** | Auth tokens written to `AsyncStorage` (stored in unencrypted SQLite / XML / plist). | ESLint rule `mobile/no-sensitive-async-storage` flags `AsyncStorage.setItem` on token/auth keys. | Code review of session persistence and Keychain/Keystore adapters (`expo-secure-store`). |
| **Missing iOS Usage Description** | Hardware API called without `NS*UsageDescription` in `Info.plist` (crashes app). | `rn-permission-audit` scans Info.plist against imported native modules. | Legal & privacy review of user-facing permission explanations. |
| **Over-Permissioned Android** | Native libraries injecting background location or SMS reading permissions. | Manifest merge audit compares final `AndroidManifest.xml` against baseline. | Security team sign-off on any dangerous Android permissions. |
| **Malicious Deep Links** | Attacker crafts URI query to trigger unauthorized state mutation or redirect. | Static regex check flags unsanitized `Linking.addEventListener` callbacks. | Threat model audit of all custom deep link route handlers. |
| **Tampered OTA Updates** | Rogue server pushes malicious JS bundle over the air to installed clients. | `expo-config-validate` enforces `codeSigningMetadata` and `runtimeVersion`. | Secure key rotation and certificate management for EAS update keys. |
| **Exposed Keystore / Signing Keys** | Android `.jks` keystores or iOS `.p12` certificates committed to Git repository. | Pre-commit Git hook & CI secret scanner halts if `.jks`, `.keystore`, `.p12` staged. | Verify signing secrets reside exclusively in EAS Secrets or CI secrets vault. |

---

## 3. Detailed Security Invariants

### 3.1 Zero Server Secrets in Mobile Bundles (`SEC-MOB-01`)
1. **The Public Invariant**: In mobile development, **every line of JavaScript and every environment variable is public**.
2. **Naming Restrictions**:
   - Expo: Only non-sensitive variables prefixed with `EXPO_PUBLIC_` (e.g. `EXPO_PUBLIC_API_URL`) are permitted. Any key containing `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, `PRIVATE`, `CREDENTIAL`, or `AUTH` is blocked.
   - React Native CLI: `.env` keys must never expose private backend credentials.
3. **Architecture Rule**: Mobile apps must communicate with a Backend-for-Frontend (BFF) or API Gateway. The mobile client presents a user bearer token; the backend holds database credentials and third-party secret keys.

### 3.2 Storage Classification & OS-Protected Secure Storage (`SEC-MOB-02` / `RULE-MOB-SEC-STORAGE`)

Mobile applications must strictly distinguish sensitive secrets from non-sensitive application state:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Permitted in Ordinary Unencrypted Storage (AsyncStorage, MMKV, SQLite) │
│ ├─ User UI preferences (theme: light/dark, font size, sound toggles)   │
│ ├─ Internationalization state (locale, preferred language, currency)   │
│ ├─ Non-sensitive application cache & offline catalog/article data      │
│ ├─ Feature flags and rollout variant markers                           │
│ └─ UI state persistence (scroll position, tab index, non-PII drafts)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ BANNED FOR SENSITIVE SECRETS
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Mandated in OS-Protected Secure Storage (Keychain / Keystore)          │
│ ├─ Authentication tokens (OAuth access tokens, refresh tokens, JWTs)   │
│ ├─ Session bearer tokens and authentication state cookies              │
│ ├─ Cryptographic signing keys, private keys, API secrets, seed phrases │
│ ├─ User credentials (passwords, PINs, biometric signature payloads)    │
│ └─ Highly sensitive, regulated PII requiring encryption at rest        │
└────────────────────────────────────────────────────────────────────────┘
```

#### Detailed Storage Boundaries & Implementation Mandates
1. **AsyncStorage Permitted for Ordinary Application Data**:
   - `AsyncStorage` (and unencrypted key-value stores) remains an acceptable, standard solution for non-sensitive local preferences, caching, and layout state.
   - The architecture strictly **bans the storage of sensitive secrets** in unencrypted storage; it does not ban `AsyncStorage` for general application data.
2. **OS-Protected Secure Storage as Baseline Requirement**:
   - The non-negotiable baseline requirement is **OS-protected secure storage**, where encryption keys, access control policies, and data sandboxing are managed by the host operating system.
   - **Hardware-Backed Protection Where Supported**:
     - On devices and platforms equipped with specialized hardware (Apple Secure Enclave on iOS; Hardware Security Module / Trusted Execution Environment / StrongBox Keymaster on Android), cryptographic keys and secrets leverage physical hardware isolation.
     - *Realistic Device Limitation*: Not all end-user devices, low-cost Android variants, or developer emulators possess physical hardware TEE or StrongBox chips. When hardware backing is unsupported by the host device, the OS automatically falls back to software-protected Keystores or OS-sandboxed encryption. The architecture mandates the use of OS-protected secure storage abstractions (`expo-secure-store` or `react-native-keychain`) without falsely claiming that every runtime host guarantees physical hardware security.
3. **Platform-Specific Verifiable Guarantees**:
   - **iOS (Keychain Services via `react-native-keychain` / `expo-secure-store`)**:
     - Configured with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (or `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) to prevent inclusion in unencrypted device backups.
     - Biometric protection configured via `kSecAccessControlBiometryAny` where step-up authentication is specified.
   - **Android (Android Keystore Provider)**:
     - Cryptographic keys generated within the Android Keystore using AES-GCM or RSA-OAEP.
     - Runtime verification possible via `KeyInfo.isInsideSecureHardware()` to determine if key material resides in hardware TEE / StrongBox.
     - Biometric binding configured via `setUserAuthenticationRequired(true)`.
   - **Expo Extension (`expo-secure-store`)**:
     - Backed by iOS Keychain and Android Keystore with `EncryptedSharedPreferences`.
     - High-security secrets configure `requireAuthentication: true`.

#### Verification: Automated Detection vs. Mandatory Human Review
- **Automated Static Checks (ESLint `mobile/no-sensitive-async-storage`)**:
  - Scans `AsyncStorage.setItem(key, ...)` and similar unencrypted storage calls (`localStorage.setItem`, unencrypted SQLite `INSERT`).
  - Flags calls where the key literal or variable name matches sensitive heuristic patterns: `token`, `auth`, `jwt`, `secret`, `key`, `password`, `session`, `credential`, `refresh`, `bearer`.
  - **Static Limitations**: AST checks catch common and overt misconfigurations, but cannot determine whether dynamically concatenated keys (`storage.set(getDynamicKey(), val)`) or custom wrapper classes conceal sensitive payloads.
- **Human Governance Sign-off (Stage Gate 6 Prerequisite)**:
  - Automated gates cannot verify complete cryptographic security. Stage Gate 6 mandates explicit human engineering sign-off verifying:
    - End-to-end data flow diagrams for authentication lifecycles (`auth.ts`, `storage.ts`).
    - Graceful degradation and security posture on devices lacking hardware TEE.
    - Token revocation, session invalidation, and complete cache purging upon user logout.

### 3.3 Over-the-Air Update Code Signing (`SEC-MOB-03`)
In Expo projects utilizing `expo-updates`:
- Updates must configure code signing using standard public-key cryptography (RSA-2048 or ECDSA P-256).
- Public certificates are embedded in the native binary during initial build.
- Update manifests delivered over the network are rejected by the client unless cryptographically verified against the embedded certificate.

### 3.4 Deep-Link URL Sanitization (`SEC-MOB-04`)
- Incoming deep links (`Linking` in React Native, `expo-linking` in Expo) must treat all query parameters as untrusted user input.
- Navigation targets extracted from deep links must validate against a strict internal route allowlist.
- External redirect targets (e.g. OAuth callbacks) must match an exact hardcoded domain allowlist; open redirects are strictly prohibited.

---

## 4. Verification Taxonomy: Automated vs. Human Review

To avoid false claims of "automated perfection", the Playbook establishes an explicit verification boundary:

```
┌────────────────────────────────────────────────────────┐
│ Automated Gate Enforcement (Deterministic Static Proof)│
│ ├─ Zero sensitive naming patterns in .env* files       │
│ ├─ Mandatory presence of iOS usage description strings │
│ ├─ Absence of .jks, .keystore, .p12 files in Git index │
│ ├─ Schema conformance of eas.json and app.json         │
│ └─ ESLint rejection of sensitive key storage in AsyncStorage│
└───────────────────────────┬────────────────────────────┘
                            │ Supported By
                            ▼
┌────────────────────────────────────────────────────────┐
│ Human Governance Sign-off (Stage Gate 6 Prerequisite) │
│ ├─ Review of third-party native SDK privacy practices  │
│ ├─ Penetration test review (certificate pinning, JNI)  │
│ ├─ Legal review of requested permissions & disclosures │
│ └─ Secure provisioning profile and keystore ownership  │
└────────────────────────────────────────────────────────┘
```
