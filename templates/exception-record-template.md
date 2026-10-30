# Engineering Gate Exception Record Template

> **Template Version**: 1.0.0  
> **Applicable Stages**: Any Lifecycle Stage (Stages 0–6) when a mandatory requirement must be temporarily waived  
> **Storage Location**: `governance/exceptions/EXC-YYYYMMDD-###.md` (Committed to version control)

---

## Operational Guidance for This Template

### 1. When to Use
- **Trigger**: In exceptional circumstances where a mandatory stage-gate deliverable, validation rule, or quality threshold cannot be satisfied immediately, but business or operational priorities necessitate progressing (e.g., prototype spike, emergency security hotfix, external dependency outage).
- **Strict Prohibition**: **Exceptions must not become a casual way to bypass engineering standards.** AI agents are strictly forbidden from granting themselves exceptions or waiving quality gates independently.

### 2. Who Creates It
- **Requester**: The engineer or AI agent identifying the temporary barrier.
- **Authorizer**: Authorized Human Engineer, Software Architect, or Engineering Lead.

### 3. Mandatory vs. Optional Sections
- **Mandatory**:
  - Section 1: Exception Metadata (Exception ID: `EXC-YYYYMMDD-###`, Date, Target Stage, Bypassed Gate/Rule)
  - Section 2: Requester & Authorizer Identification
  - Section 3: Reason & Justification for Exception
  - Section 4: Risk Assessment & Blast Radius Analysis
  - Section 5: Compensating Controls (Mitigations protecting the system)
  - Section 6: Remediation Plan & Mandatory Expiration / Review Date
  - Section 7: Human Authorization Signature
  - Section 8: Final Outcome & Retirement Record (Logged when remediated)
- **Optional**:
  - Section 9: Incident / Ticket Reference Link

### 4. Information Sufficiency Criteria
- Must provide a clear technical root cause explaining why the standard cannot be met immediately.
- Must articulate an honest risk assessment covering security, technical debt, and system stability.
- Must establish concrete **compensating controls** (e.g., feature flag isolation, manual canary verification, restricted traffic routing).
- Must have an immutable **Expiration / Review Date** (maximum allowable TTL is typically 30 days unless explicitly extended).

### 5. Handling Missing Information
- An exception record with undefined compensating controls, missing risk assessments, or lacking human authorization is **invalid**. The Controller immediately halts gate progression.

### 6. Validation and Quality Gate Checks
- The Exception Record must be committed under `governance/exceptions/` with a unique ID before the affected gate can be cleared.

---

# EXC-[YYYYMMDD]-[###]: [Concise Title of Exception, e.g., Defer Integration Test Suite for Third-Party Sandbox Outage]

## 1. Exception Metadata

| Field | Value |
| :--- | :--- |
| **Exception ID** | `EXC-YYYYMMDD-###` |
| **Creation Date** | [YYYY-MM-DD] |
| **Active Lifecycle Stage** | `Stage [0-6]: [Stage Name]` |
| **Bypassed Stage Gate** | `Gate [0-6]` |
| **Waived Rule / Requirement** | [Specific rule or acceptance criterion from stage-gate-rules.md] |
| **Exception Status** | `Proposed` \| `Active (Authorized)` \| `Remediated (Closed)` \| `Revoked` |
| **Expiration / Review Date** | [YYYY-MM-DD] *(Mandatory review deadline)* |

---

## 2. Requester & Authorizer Identification

| Role | Name | Title / Contact |
| :--- | :--- | :--- |
| **Requested By** | [Engineer Name / AI Agent] | [e.g., Senior Developer / AI Co-Author] |
| **Authorized By (Human)** | [Human Lead Name] | [e.g., Lead Architect / Engineering Manager] |

---

## 3. Reason & Justification for Exception

### 3.1 Root Cause & Situation
[Explain the specific blocker or circumstance preventing immediate compliance with the gate rule.]

*Realistic Example*:
> The third-party sandbox payment gateway API is experiencing an unannounced vendor outage (HTTP 503), preventing execution of end-to-end integration tests for `REQ-005` in Stage 4. Core payment logic unit tests and internal contract mock tests pass 100%. Blocking the release branch halts deployment of unrelated critical security patches (`NFR-001`).

### 3.2 Why Rework Cannot Precede Release
[Explain why the issue cannot be resolved prior to advancing.]

---

## 4. Risk Assessment & Blast Radius Analysis

### 4.1 Technical Debt & Instability Risks
- Risk of unverified payment gateway payload drift against the live vendor API.

### 4.2 Security & Compliance Implications
- Zero security risk: the payment service is tokenized; zero raw cardholder data is touched.

### 4.3 Severity & Blast Radius Rating
- **Risk Severity**: `Low` \| `Medium` \| `High` \| `Critical` (e.g., `Medium`)
- **Blast Radius**: Isolated strictly to the checkout payment flow; all other service domains unaffected.

---

## 5. Compensating Controls

To mitigate the risk during the active exception period, the following compensating controls are enforced:

1. **Feature Flag Isolation**: The new payment integration is placed behind dynamic feature flag `FF_NEW_PAYMENT_GATEWAY`, which defaults to `disabled` in production.
2. **Hermetic Mock Verification**: Automated unit tests pass 100% against frozen mock fixtures (`tests/mocks/gateway_fixtures.json`).
3. **Manual Canary Verification**: Prior to enabling the feature flag, the on-call engineer must execute a live single-transaction verification once vendor service is restored.

---

## 6. Remediation Plan & Expiration

### 6.1 Action Items
| Task ID | Remediation Action | Owner | Target Completion Date |
| :--- | :--- | :--- | :--- |
| `REM-001` | Execute full integration test suite once vendor sandbox restores | [Engineer Name] | YYYY-MM-DD |
| `REM-002` | Remove exception record and flip feature flag to enabled | [Engineer Name] | YYYY-MM-DD |

### 6.2 Mandatory Expiration Date
- **Expiration Date**: `YYYY-MM-DD` *(Cannot exceed 30 days without re-authorization)*.
- **Failure to Remediate**: If this exception is not remediated by the expiration date, the feature flag will remain disabled and subsequent release gates will be blocked.

---

## 7. Human Authorization & Sign-Off

> [!CAUTION]
> **Human Authority Required**: AI agents cannot self-authorize exceptions. Only the authorized human engineer listed below may authorize this record.

| Field | Record |
| :--- | :--- |
| **Authorizer Name** | [Human Lead Name] |
| **Title / Authority** | [Lead Architect / Engineering Manager] |
| **Authorization Decision** | `EXCEPTION AUTHORIZED` |
| **Authorization Date** | [YYYY-MM-DD] |
| **Sign-Off Reference** | [Commit SHA / PR #XX comment / In-chat confirmation] |

---

## 8. Final Outcome & Retirement Record

*(To be completed once the exception is remediated and closed)*

| Field | Value |
| :--- | :--- |
| **Closure Date** | [YYYY-MM-DD] |
| **Remediation Evidence** | [e.g., Passing integration test run logs, commit SHA] |
| **Closed By** | [Human Engineer Name] |
| **Final Resolution Status** | `Remediated (Closed)` \| `Revoked` |
