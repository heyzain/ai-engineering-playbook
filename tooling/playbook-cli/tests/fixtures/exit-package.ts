/** Complete synthetic fixture shared by executable lifecycle and strict-parser tests. */
export function createValidExitPackage(stage: number, stageName: string, deliverablesSummary: string): string {
  return `# Stage Gate Exit Package - Stage ${stage}: ${stageName}

## 1. Package & Stage Identification
Synthetic lifecycle fixture for Stage ${stage} (${stageName}), milestone M-1.0.0,
project e2e-service. This document applies only to its disposable test project.

## 2. Stage Objectives & Scope Summary
Exercise governed authoring, evidence review and the lifecycle transition for this stage.

## 3. Deliverables Manifest & Status
The following fixture deliverables are ready for review:
- ${deliverablesSummary}

## 4. Verifiable Validation Evidence
Synthetic verification logs are recorded with SHA-256 hashes in the fixture state.
The approval operation must independently check the referenced proof.

## 5. Traceability Matrix
The listed deliverables map to the fixture's baseline stage obligations.

## 6. Outstanding Issues & Accepted Limitations
No unresolved blocking issues remain in this synthetic fixture. It certifies no real project.

## 7. Related Governance Artifacts
The fixture follows the baseline lifecycle contract and preserves its state and audit history.

## 8. AI Agent Completion Assertion
Fixture artifacts are prepared for human review. This document grants no gate approval.
`;
}
