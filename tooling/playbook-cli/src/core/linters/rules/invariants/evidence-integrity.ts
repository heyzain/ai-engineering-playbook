import crypto from "node:crypto";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseJsonSafely, findPropertyLocation } from "./helpers.js";

const STATE_PATH = ".playbook/state.json";
const CANONICAL_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export const ruleGovEvidenceIntegrity: GovernanceRule = {
  id: "RULE-GOV-EVIDENCE-INTEGRITY",
  category: "invariant",
  name: "Evidence Integrity & Verification Proof Consistency",
  description:
    "Verifies that any deliverable marked with status 'verified' contains at least one evidence record with result 'passed', a valid evidence file on disk, and a matching SHA-256 hash.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [STATE_PATH],
  evaluationMethod: "cross_reference",
  version: "1.0.0",
  remediation:
    "Execute the required quality gates to produce verifiable evidence, or reset the deliverable status to 'in_progress'.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    if (!context.fileExists(STATE_PATH)) {
      return findings;
    }

    let stateContent = "";
    try {
      stateContent = context.readFile(STATE_PATH);
    } catch {
      return findings;
    }

    const parseResult = parseJsonSafely<Record<string, unknown>>(stateContent);
    if (!parseResult.success || !parseResult.data) {
      return findings;
    }

    const state = parseResult.data;
    const deliverablesToInspect: Array<{ deliverable: Record<string, unknown>; stageName: string }> = [];

    // 1. Current stage deliverables
    const currentStage = state.current_stage_detail as Record<string, unknown> | undefined;
    if (currentStage && Array.isArray(currentStage.deliverables)) {
      const stageName = String(currentStage.stage_name || `Stage ${currentStage.stage}`);
      for (const d of currentStage.deliverables) {
        if (d && typeof d === "object") {
          deliverablesToInspect.push({ deliverable: d as Record<string, unknown>, stageName });
        }
      }
    }

    // 2. Historical deliverables
    if (Array.isArray(state.stage_history)) {
      for (const entry of state.stage_history) {
        if (entry && typeof entry === "object" && Array.isArray(entry.deliverables)) {
          const stageName = String(entry.stage_name || `Stage ${entry.stage}`);
          for (const d of entry.deliverables) {
            if (d && typeof d === "object") {
              deliverablesToInspect.push({ deliverable: d as Record<string, unknown>, stageName });
            }
          }
        }
      }
    }

    for (const { deliverable, stageName } of deliverablesToInspect) {
      const id = String(deliverable.id || "UNKNOWN");
      const status = String(deliverable.status || "");
      const validationStatus = String(deliverable.validation_status || "");

      if (status !== "verified") {
        continue;
      }

      // Check validation_status must be 'passed'
      if (validationStatus !== "passed") {
        const loc = findPropertyLocation(stateContent, id);
        findings.push({
          ruleId: ruleGovEvidenceIntegrity.id,
          diagnosticCode: "DELIVERABLE_UNVERIFIED_CLAIM",
          severity: ruleGovEvidenceIntegrity.severity,
          enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
          message: `Deliverable '${id}' in ${stageName} is marked status: 'verified' but has validation_status: '${validationStatus}'. Verified deliverables require validation_status: 'passed'.`,
          filePath: STATE_PATH,
          line: loc.line,
          column: loc.column,
          expected: "validation_status: 'passed'",
          actual: `validation_status: '${validationStatus}'`,
          remediation: `Update validation_status to 'passed' after verifying evidence, or revert deliverable '${id}' to 'in_progress'.`,
          blocksOperation: true,
        });
      }

      const evidence = deliverable.evidence;
      if (!Array.isArray(evidence) || evidence.length === 0) {
        const loc = findPropertyLocation(stateContent, id);
        findings.push({
          ruleId: ruleGovEvidenceIntegrity.id,
          diagnosticCode: "MISSING_EVIDENCE_RECORD",
          severity: ruleGovEvidenceIntegrity.severity,
          enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
          message: `Deliverable '${id}' in ${stageName} is marked as 'verified' but contains no evidence records in evidence[].`,
          filePath: STATE_PATH,
          line: loc.line,
          column: loc.column,
          expected: "At least 1 evidence record with result: 'passed'",
          actual: "evidence: []",
          remediation: `Execute quality gates to collect verified proof before marking deliverable '${id}' as 'verified'.`,
          blocksOperation: true,
        });
        continue;
      }

      // Check if at least one evidence has result 'passed'
      const hasPassed = evidence.some((e) => e && typeof e === "object" && e.result === "passed");
      if (!hasPassed) {
        const loc = findPropertyLocation(stateContent, id);
        findings.push({
          ruleId: ruleGovEvidenceIntegrity.id,
          diagnosticCode: "DELIVERABLE_UNVERIFIED_CLAIM",
          severity: ruleGovEvidenceIntegrity.severity,
          enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
          message: `Deliverable '${id}' in ${stageName} is marked 'verified' but contains no evidence records with result: 'passed'.`,
          filePath: STATE_PATH,
          line: loc.line,
          column: loc.column,
          expected: "At least 1 evidence record with result: 'passed'",
          actual: "All evidence records failed or inconclusive",
          remediation: `Satisfy all gate verification checks before marking deliverable '${id}' as 'verified'.`,
          blocksOperation: true,
        });
      }

      // Validate each evidence record
      for (const ev of evidence) {
        if (!ev || typeof ev !== "object") continue;

        const evRef = String(ev.evidence_ref || "");
        const recordedHash = String(ev.recorded_hash || ev.evidence_hash || "");

        if (!evRef) {
          findings.push({
            ruleId: ruleGovEvidenceIntegrity.id,
            diagnosticCode: "DELIVERABLE_UNVERIFIED_CLAIM",
            severity: ruleGovEvidenceIntegrity.severity,
            enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
            message: `Evidence record for deliverable '${id}' is missing a valid evidence_ref.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "Non-empty relative path in evidence_ref",
            actual: "empty string",
            remediation: "Provide a valid evidence log path.",
            blocksOperation: true,
          });
          continue;
        }

        // Check hash format
        if (!recordedHash || !CANONICAL_HASH_PATTERN.test(recordedHash)) {
          findings.push({
            ruleId: ruleGovEvidenceIntegrity.id,
            diagnosticCode: "DELIVERABLE_UNVERIFIED_CLAIM",
            severity: ruleGovEvidenceIntegrity.severity,
            enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
            message: `Evidence record '${evRef}' for deliverable '${id}' has invalid or missing evidence_hash: '${recordedHash}'.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "sha256:<64-hex-characters>",
            actual: recordedHash || "null",
            remediation: "Compute and record valid sha256 hash for evidence file.",
            blocksOperation: true,
          });
        }

        // Check file existence on disk
        if (!context.fileExists(evRef)) {
          findings.push({
            ruleId: ruleGovEvidenceIntegrity.id,
            diagnosticCode: "MISSING_EVIDENCE_RECORD",
            severity: ruleGovEvidenceIntegrity.severity,
            enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
            message: `Evidence file '${evRef}' referenced by deliverable '${id}' does not exist on disk.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: `Existing evidence file at '${evRef}'`,
            actual: "File missing on disk",
            remediation: `Run the verification check to regenerate '${evRef}'.`,
            blocksOperation: true,
          });
          continue;
        }

        // If file exists and hash is valid pattern, verify hash integrity
        if (recordedHash && CANONICAL_HASH_PATTERN.test(recordedHash)) {
          try {
            const buf = context.readFileBuffer(evRef);
            const calculated = "sha256:" + crypto.createHash("sha256").update(buf).digest("hex").toLowerCase();
            if (calculated !== recordedHash.toLowerCase()) {
              findings.push({
                ruleId: ruleGovEvidenceIntegrity.id,
                diagnosticCode: "DELIVERABLE_UNVERIFIED_CLAIM",
                severity: ruleGovEvidenceIntegrity.severity,
                enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
                message: `Calculated hash '${calculated}' does not match recorded evidence_hash '${recordedHash}' for '${evRef}' in deliverable '${id}'.`,
                filePath: STATE_PATH,
                line: 1,
                column: 1,
                expected: `Calculated SHA-256 matching '${recordedHash}'`,
                actual: `Calculated '${calculated}'`,
                remediation: `Re-run verification check to regenerate fresh evidence matching '${evRef}'.`,
                blocksOperation: true,
              });
            }
          } catch (err: unknown) {
            findings.push({
              ruleId: ruleGovEvidenceIntegrity.id,
              diagnosticCode: "DELIVERABLE_UNVERIFIED_CLAIM",
              severity: ruleGovEvidenceIntegrity.severity,
              enforcement: ruleGovEvidenceIntegrity.defaultEnforcement,
              message: `Failed to read evidence file '${evRef}' for hash verification: ${err instanceof Error ? err.message : String(err)}`,
              filePath: STATE_PATH,
              line: 1,
              column: 1,
              expected: "Readable evidence file",
              actual: "Read failure",
              remediation: `Ensure evidence file '${evRef}' is accessible.`,
              blocksOperation: true,
            });
          }
        }
      }
    }

    return findings;
  },
};
