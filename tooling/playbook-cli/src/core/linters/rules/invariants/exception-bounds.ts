import crypto from "node:crypto";
import path from "node:path";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import {
  parseJsonSafely,
  findPropertyLocation,
  parseExpiryDate,
  containsProhibitedAgentPattern,
  isPlaceholder,
} from "./helpers.js";

const STATE_PATH = ".playbook/state.json";

function cleanValue(str: string): string {
  if (!str) return "";
  let s = str.trim();
  // Strip enclosing backticks
  s = s.replace(/^`+|`+$/g, "").trim();
  // Strip markdown comments like *(Mandatory review deadline)*
  s = s.replace(/\s*\*\([^)]*\)\*/g, "").trim();
  return s;
}

function extractTableOrBullet(content: string, fieldNamePattern: string): string | null {
  // Table format: | **Field** | Value |
  const tableRegex = new RegExp(
    `\\|\\s*\\*\\*${fieldNamePattern}\\*\\*\\s*\\|\\s*([^|\\n]+)\\|`,
    "i"
  );
  const tableMatch = tableRegex.exec(content);
  if (tableMatch) {
    return cleanValue(tableMatch[1]);
  }

  // Bullet format: - **Field**: Value
  const bulletRegex = new RegExp(
    `(?:^|\\n)[*-]\\s*\\*\\*${fieldNamePattern}\\*\\*\\s*:\\s*([^\\n]+)`,
    "i"
  );
  const bulletMatch = bulletRegex.exec(content);
  if (bulletMatch) {
    return cleanValue(bulletMatch[1]);
  }

  // Frontmatter/YAML format: field: Value
  const yamlRegex = new RegExp(
    `(?:^|\\n)${fieldNamePattern}\\s*:\\s*["']?([^"'\n]+)["']?`,
    "i"
  );
  const yamlMatch = yamlRegex.exec(content);
  if (yamlMatch) {
    return cleanValue(yamlMatch[1]);
  }

  return null;
}

function extractSection2Authorizer(content: string): { name: string | null; role: string | null } {
  const rowRegex = /\|\s*\*\*Authorized By(?:\s*\(Human\))?\*\*\s*\|\s*([^|]+)\|\s*([^|\n]+)\|/i;
  const match = rowRegex.exec(content);
  if (match) {
    return {
      name: cleanValue(match[1]),
      role: cleanValue(match[2]),
    };
  }
  return { name: null, role: null };
}

function hasJustification(content: string): boolean {
  const headingRegex = /#{1,4}\s+(?:\d+\.\s*)?(?:Reason|Justification|Root Cause)/i;
  if (headingRegex.test(content)) {
    const split = content.split(headingRegex);
    if (split.length > 1) {
      const body = split[1].split(/\n#{1,4}\s+/)[0].trim();
      if (body.length > 5 && !isPlaceholder(body)) {
        return true;
      }
    }
  }

  const bulletRegex = /(?:^|\n)[*-]\s*\*\*(?:Reason|Justification)\*\*\s*:\s*([^\n]+)/i;
  const match = bulletRegex.exec(content);
  if (match) {
    const val = cleanValue(match[1]);
    if (val.length > 5 && !isPlaceholder(val)) {
      return true;
    }
  }
  return false;
}

function hasCompensatingControls(content: string): boolean {
  const headingRegex = /#{1,4}\s+(?:\d+\.\s*)?(?:Compensating Controls|Mitigations)/i;
  if (headingRegex.test(content)) {
    const split = content.split(headingRegex);
    if (split.length > 1) {
      const body = split[1].split(/\n#{1,4}\s+/)[0].trim();
      if (body.length > 5 && !isPlaceholder(body)) {
        return true;
      }
    }
  }

  const bulletRegex = /(?:^|\n)[*-]\s*\*\*Compensating Controls\*\*\s*:\s*([^\n]+)/i;
  const match = bulletRegex.exec(content);
  if (match) {
    const val = cleanValue(match[1]);
    if (val.length > 5 && !isPlaceholder(val)) {
      return true;
    }
  }
  return false;
}

function checkScope(
  docWaivedReq: string | null,
  docStage: string | null,
  docGate: string | null,
  deliverableId: string,
  deliverableReqId: string | null,
  stageNum: number,
  stageName: string
): { matches: boolean; reason?: string } {
  if (docStage && !isPlaceholder(docStage)) {
    const m = /stage\s*([0-6])/i.exec(docStage);
    if (m) {
      const docStageNum = parseInt(m[1], 10);
      if (docStageNum !== stageNum) {
        return {
          matches: false,
          reason: `Exception targets stage 'Stage ${docStageNum}' which does not match deliverable stage 'Stage ${stageNum}'`,
        };
      }
    }
  }

  if (docGate && !isPlaceholder(docGate)) {
    const m = /gate\s*([0-6])/i.exec(docGate);
    if (m) {
      const docGateNum = parseInt(m[1], 10);
      if (docGateNum !== stageNum) {
        return {
          matches: false,
          reason: `Exception targets gate 'Gate ${docGateNum}' which does not match deliverable gate 'Gate ${stageNum}'`,
        };
      }
    }
  }

  if (docWaivedReq && !isPlaceholder(docWaivedReq)) {
    const lowerDoc = docWaivedReq.toLowerCase();
    const lowerDelivId = deliverableId.toLowerCase();
    const lowerReqId = deliverableReqId ? deliverableReqId.toLowerCase() : null;
    const lowerStageName = stageName.toLowerCase();

    const matchesId = lowerDoc.includes(lowerDelivId);
    const matchesReq = lowerReqId ? lowerDoc.includes(lowerReqId) : false;
    const matchesStage =
      lowerDoc.includes(lowerStageName) ||
      lowerDoc.includes(`stage ${stageNum}`) ||
      lowerDoc.includes(`gate ${stageNum}`);

    if (!matchesId && !matchesReq && !matchesStage) {
      return {
        matches: false,
        reason: `Exception specifies waived requirement '${docWaivedReq}' which does not cover deliverable '${deliverableId}'`,
      };
    }
  }

  return { matches: true };
}

interface WaivedTarget {
  deliverable: Record<string, unknown>;
  stageNum: number;
  stageName: string;
  exceptionsList: Array<Record<string, unknown>>;
}

export const ruleGovExceptionBounds: GovernanceRule = {
  id: "RULE-GOV-EXCEPTION-BOUNDS",
  category: "invariant",
  name: "Exception Validity & Expiry Bounds",
  description:
    "Verifies that any deliverable marked with status 'waived' references an active, authorized, unexpired human exception record with verified record integrity, human approver authority, valid approval evidence, and matching deliverable scope.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [STATE_PATH, "docs/exceptions/**/*.md", "governance/exceptions/**/*.md"],
  evaluationMethod: "cross_reference",
  version: "1.0.0",
  remediation:
    "Author an authorized human exception record (EXC-YYYYMMDD-###.md) with complete metadata, compensating controls, and verified human sign-off, or satisfy the deliverable requirements and remove the waiver.",

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
    const targets: WaivedTarget[] = [];

    // Current stage deliverables
    const currentStage = state.current_stage_detail as Record<string, unknown> | undefined;
    if (currentStage && Array.isArray(currentStage.deliverables)) {
      const stageNum = typeof currentStage.stage === "number" ? currentStage.stage : 0;
      const stageName = String(currentStage.stage_name || `Stage ${stageNum}`);
      const exceptionsList = Array.isArray(currentStage.exceptions)
        ? (currentStage.exceptions as Array<Record<string, unknown>>)
        : [];

      for (const d of currentStage.deliverables) {
        if (d && typeof d === "object") {
          const status = String(d.status || "");
          const vStatus = String(d.validation_status || "");
          if (status === "waived" || vStatus === "waived") {
            targets.push({
              deliverable: d as Record<string, unknown>,
              stageNum,
              stageName,
              exceptionsList,
            });
          }
        }
      }
    }

    // Historical stage deliverables
    if (Array.isArray(state.stage_history)) {
      for (const entry of state.stage_history) {
        if (entry && typeof entry === "object" && Array.isArray(entry.deliverables)) {
          const stageNum = typeof entry.stage === "number" ? entry.stage : 0;
          const stageName = String(entry.stage_name || `Stage ${stageNum}`);
          const exceptionsList = Array.isArray(entry.exceptions)
            ? (entry.exceptions as Array<Record<string, unknown>>)
            : [];

          for (const d of entry.deliverables) {
            if (d && typeof d === "object") {
              const status = String(d.status || "");
              const vStatus = String(d.validation_status || "");
              if (status === "waived" || vStatus === "waived") {
                targets.push({
                  deliverable: d as Record<string, unknown>,
                  stageNum,
                  stageName,
                  exceptionsList,
                });
              }
            }
          }
        }
      }
    }

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    for (const { deliverable, stageNum, stageName, exceptionsList } of targets) {
      const id = String(deliverable.id || "UNKNOWN");
      const deliverableReqId = deliverable.requirement_id ? String(deliverable.requirement_id) : null;
      const exceptionRef = deliverable.exception_ref ? String(deliverable.exception_ref).trim() : "";

      if (!exceptionRef) {
        const loc = findPropertyLocation(stateContent, id);
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Deliverable '${id}' in ${stageName} is marked as 'waived' but does not declare an exception_ref.`,
          filePath: STATE_PATH,
          line: loc.line,
          column: loc.column,
          expected: "Valid exception reference (e.g. docs/exceptions/EXC-20261102-001.md)",
          actual: "null / missing exception_ref",
          remediation: `Link an authorized exception record under docs/exceptions/ or satisfy deliverable '${id}'.`,
          blocksOperation: true,
        });
        continue;
      }

      // ── Locate corresponding exception entry in state ──────────────────────
      const excBaseName = path.basename(exceptionRef, ".md");
      const stateExc = exceptionsList.find((e) => {
        const eId = String(e.exception_id || "");
        const ePath = String(e.path || "");
        return (
          eId === exceptionRef ||
          eId === excBaseName ||
          ePath === exceptionRef ||
          path.basename(ePath, ".md") === excBaseName
        );
      });

      // State-level checks if state contains exception record
      if (stateExc) {
        const stateStatus = String(stateExc.status || "").toLowerCase();
        if (stateStatus !== "active") {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `State records exception '${stateExc.exception_id || exceptionRef}' with inactive status '${stateStatus}'.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "status: 'active'",
            actual: `status: '${stateStatus}'`,
            remediation: "Activate the exception with authorized sign-off or satisfy requirement.",
            blocksOperation: true,
          });
        }

        const stateAuthBy = stateExc.authorized_by ? String(stateExc.authorized_by) : "";
        if (isPlaceholder(stateAuthBy)) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `State exception '${stateExc.exception_id || exceptionRef}' has placeholder/unverified authorizer '${stateAuthBy}'.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "Authorized human engineer name and role",
            actual: `Placeholder '${stateAuthBy}'`,
            remediation: "Ensure an authorized human signs off on the exception.",
            blocksOperation: true,
          });
        } else if (containsProhibitedAgentPattern(stateAuthBy)) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `State exception '${stateExc.exception_id || exceptionRef}' authorizer '${stateAuthBy}' is an AI agent; AI agents are constitutionally prohibited from authorizing exceptions.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "Human engineer authorizer",
            actual: `AI agent '${stateAuthBy}'`,
            remediation: "Replace AI agent with an authorized human engineer approval.",
            blocksOperation: true,
          });
        }

        const stateExpDate = stateExc.expiration_date ? String(stateExc.expiration_date) : "";
        const stateExpTs = parseExpiryDate(stateExpDate);
        if (stateExpTs === null) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `State exception '${stateExc.exception_id || exceptionRef}' has malformed expiration date '${stateExpDate}'.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "Valid expiration date format (YYYY-MM-DD)",
            actual: `Malformed date '${stateExpDate}'`,
            remediation: "Format expiration date as YYYY-MM-DD.",
            blocksOperation: true,
          });
        } else if (stateExpTs < now) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "EXPIRED_EXCEPTION_IN_USE",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `State records exception '${stateExc.exception_id || exceptionRef}' for deliverable '${id}' that expired on ${stateExpDate}.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: `Unexpired exception date >= ${today}`,
            actual: `Expired on ${stateExpDate}`,
            remediation: "Obtain human re-authorization with extended expiration date.",
            blocksOperation: true,
          });
        }

        if (stateExc.waived_requirement && !isPlaceholder(String(stateExc.waived_requirement))) {
          const waivedReq = String(stateExc.waived_requirement).trim();
          const scope = checkScope(waivedReq, null, null, id, deliverableReqId, stageNum, stageName);
          if (!scope.matches) {
            findings.push({
              ruleId: ruleGovExceptionBounds.id,
              diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
              severity: ruleGovExceptionBounds.severity,
              enforcement: ruleGovExceptionBounds.defaultEnforcement,
              message: `State exception '${stateExc.exception_id || exceptionRef}' scope mismatch: specifies waived requirement '${waivedReq}' which does not cover deliverable '${id}'.`,
              filePath: STATE_PATH,
              line: 1,
              column: 1,
              expected: `Exception covering deliverable '${id}'`,
              actual: `Waived requirement '${waivedReq}'`,
              remediation: `Align exception waived_requirement with '${id}' or attach correct exception.`,
              blocksOperation: true,
            });
          }
        }
      }

      // ── Resolve candidate path on disk ────────────────────────────────────
      const candidatePaths: string[] = [];
      if (stateExc?.path) {
        candidatePaths.push(String(stateExc.path));
      }
      candidatePaths.push(exceptionRef);
      if (!exceptionRef.endsWith(".md")) {
        candidatePaths.push(`${exceptionRef}.md`);
      }
      if (!exceptionRef.includes("/")) {
        candidatePaths.push(`docs/exceptions/${exceptionRef}.md`);
        candidatePaths.push(`governance/exceptions/${exceptionRef}.md`);
      } else {
        if (!exceptionRef.startsWith("docs/exceptions/") && !exceptionRef.startsWith("governance/exceptions/")) {
          candidatePaths.push(`docs/exceptions/${path.basename(exceptionRef)}`);
          candidatePaths.push(`governance/exceptions/${path.basename(exceptionRef)}`);
        }
      }

      let resolvedPath: string | null = null;
      for (const cp of candidatePaths) {
        if (context.fileExists(cp)) {
          resolvedPath = cp;
          break;
        }
      }

      if (!resolvedPath) {
        const loc = findPropertyLocation(stateContent, id);
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Referenced exception record '${exceptionRef}' for deliverable '${id}' does not exist on disk.`,
          filePath: STATE_PATH,
          line: loc.line,
          column: loc.column,
          expected: `Existing exception file at candidate path(s): ${candidatePaths.slice(0, 2).join(", ")}`,
          actual: "File missing",
          remediation: `Author an authorized exception record under docs/exceptions/ or restore it from git.`,
          blocksOperation: true,
        });
        continue;
      }

      // ── Read exception record ──────────────────────────────────────────────
      let exceptionContent = "";
      try {
        exceptionContent = context.readFile(resolvedPath);
      } catch (err: unknown) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Failed to read exception record '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Readable UTF-8 exception record",
          actual: "Read failure",
          remediation: "Ensure the exception record is accessible and readable.",
          blocksOperation: true,
        });
        continue;
      }

      // Check minimum content length (< 50 bytes is corrupt/truncated)
      if (exceptionContent.trim().length < 50) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' is truncated or incomplete (< 50 bytes).`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Complete exception record adhering to exception-record-template.md",
          actual: "Truncated or empty file",
          remediation: "Author a complete exception record per templates/exception-record-template.md.",
          blocksOperation: true,
        });
        continue;
      }

      // ── 1. Record Integrity: verify document identifier matches ───────────
      const docIdMatch =
        /#+\s*(?:📋\s*Gate\s*Exception\s*Record:\s*\[?)?(EXC-[0-9]{8}-[0-9]{3})/i.exec(exceptionContent) ||
        /\|\s*\*\*Exception ID\*\*\s*\|\s*`?(EXC-[0-9]{8}-[0-9]{3})`?/i.exec(exceptionContent) ||
        /exception_id:\s*["']?(EXC-[0-9]{8}-[0-9]{3})["']?/i.exec(exceptionContent);

      if (docIdMatch) {
        const docId = docIdMatch[1].toUpperCase();
        if (excBaseName.startsWith("EXC-") && docId !== excBaseName.toUpperCase()) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record identifier mismatch: document specifies '${docId}' but deliverable references '${excBaseName}'.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: `Exception record matching ID '${excBaseName}'`,
            actual: `Found ID '${docId}'`,
            remediation: "Ensure the referenced exception file corresponds to the correct exception ID.",
            blocksOperation: true,
          });
        }
      }

      // ── 1. Record Integrity: verify cryptographic integrity evidence if present ─
      if (Array.isArray(deliverable.evidence)) {
        for (const ev of deliverable.evidence) {
          if (ev && typeof ev === "object" && ev.evidence_ref) {
            const ref = String(ev.evidence_ref).trim();
            if (
              ref === resolvedPath ||
              ref === exceptionRef ||
              ref.endsWith(path.basename(resolvedPath))
            ) {
              if (ev.evidence_hash && typeof ev.evidence_hash === "string") {
                const expectedHash = ev.evidence_hash.trim().toLowerCase();
                const actualSha =
                  "sha256:" +
                  crypto
                    .createHash("sha256")
                    .update(Buffer.from(exceptionContent, "utf-8"))
                    .digest("hex");
                if (actualSha.toLowerCase() !== expectedHash) {
                  findings.push({
                    ruleId: ruleGovExceptionBounds.id,
                    diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
                    severity: ruleGovExceptionBounds.severity,
                    enforcement: ruleGovExceptionBounds.defaultEnforcement,
                    message: `Corrupt or inconsistent integrity evidence: SHA-256 hash of exception record '${resolvedPath}' (${actualSha}) does not match recorded evidence hash (${expectedHash}).`,
                    filePath: resolvedPath,
                    line: 1,
                    column: 1,
                    expected: `Matching evidence hash '${expectedHash}'`,
                    actual: `Computed hash '${actualSha}'`,
                    remediation: "Ensure the exception record is not tampered with, or re-verify the hash.",
                    blocksOperation: true,
                  });
                }
              }
            }
          }
        }
      }

      // ── 5. Status: Check status in document ────────────────────────────────
      let docStatus = extractTableOrBullet(
        exceptionContent,
        "(?:Exception Status|Status)"
      );

      if (!docStatus) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' is missing a declared status.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "status: 'active' or 'approved'",
          actual: "missing status",
          remediation: "Specify an explicit status in the exception record.",
          blocksOperation: true,
        });
      } else {
        const lowerDocStatus = docStatus.toLowerCase();
        if (lowerDocStatus.includes("revoked") || lowerDocStatus.includes("rejected")) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' has status '${docStatus}' and cannot be used to waive deliverable '${id}'.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "status: 'active' or 'approved'",
            actual: `status: '${docStatus}'`,
            remediation: `Obtain an active exception approval or satisfy deliverable '${id}'.`,
            blocksOperation: true,
          });
        } else if (lowerDocStatus.includes("expired")) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "EXPIRED_EXCEPTION_IN_USE",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' has status 'expired' and cannot be used to waive deliverable '${id}'.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "status: 'active' or 'approved'",
            actual: "status: 'expired'",
            remediation: `Renew the exception record with human re-authorization or fulfill deliverable '${id}'.`,
            blocksOperation: true,
          });
        } else if (
          lowerDocStatus.includes("proposed") ||
          lowerDocStatus.includes("pending") ||
          lowerDocStatus.includes("draft")
        ) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' has pending/proposed status '${docStatus}' and is not authorized.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "status: 'active' or 'approved'",
            actual: `status: '${docStatus}'`,
            remediation: "Obtain formal human authorization before waiving requirements.",
            blocksOperation: true,
          });
        } else if (lowerDocStatus.includes("remediated") || lowerDocStatus.includes("closed")) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' is remediated/closed and cannot authorize active waivers.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "status: 'active'",
            actual: `status: '${docStatus}'`,
            remediation: "Remove the waiver and verify deliverable, or open a new exception.",
            blocksOperation: true,
          });
        } else if (
          !lowerDocStatus.includes("active") &&
          !lowerDocStatus.includes("authorized") &&
          !lowerDocStatus.includes("approved")
        ) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' has unrecognized status '${docStatus}'.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "status: 'active' or 'approved'",
            actual: `status: '${docStatus}'`,
            remediation: "Set status to 'active' or obtain valid exception authorization.",
            blocksOperation: true,
          });
        }

        // Verify status consistency with state
        if (stateExc && String(stateExc.status).toLowerCase() === "active" && (lowerDocStatus.includes("revoked") || lowerDocStatus.includes("expired"))) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception status contradiction: state records exception '${exceptionRef}' as 'active' but exception record on disk specifies '${docStatus}'.`,
            filePath: STATE_PATH,
            line: 1,
            column: 1,
            expected: "Consistent active exception status across state and document",
            actual: `state: 'active', document: '${docStatus}'`,
            remediation: "Synchronize state with the exception record or resolve the discrepancy.",
            blocksOperation: true,
          });
        }
      }

      // ── 6. Expiry: Check expiration date in document ──────────────────────
      const rawExpiry = extractTableOrBullet(
        exceptionContent,
        "(?:Expiration / Review Date|Expiration Date|Expires|Expiry|Expires At|Remediation Plan & Deadline)"
      );

      if (!rawExpiry) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' is missing a mandatory expiration / review date.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Mandatory expiration date (YYYY-MM-DD)",
          actual: "Missing expiration date",
          remediation: "Specify an explicit expiration date adhering to maximum allowable TTL.",
          blocksOperation: true,
        });
      } else {
        const expiryTs = parseExpiryDate(rawExpiry);
        if (expiryTs === null) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' contains malformed expiration date '${rawExpiry}'.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "Valid expiration date format (YYYY-MM-DD)",
            actual: `Malformed date '${rawExpiry}'`,
            remediation: "Format expiration date as YYYY-MM-DD.",
            blocksOperation: true,
          });
        } else if (expiryTs < now) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "EXPIRED_EXCEPTION_IN_USE",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' expired on ${rawExpiry} and cannot be used to waive deliverable '${id}'.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: `Active exception with expiration date after current date (${today})`,
            actual: `Expired on ${rawExpiry}`,
            remediation: `Renew the exception record with human re-authorization or fulfill deliverable '${id}'.`,
            blocksOperation: true,
          });
        }
      }

      // ── 4. Scope: verify exception explicitly covers the deliverable ──────
      const docWaivedReq = extractTableOrBullet(
        exceptionContent,
        "(?:Waived Rule / Requirement|Waived Requirement|Bypassed Gate / Requirement|Waived Rule)"
      );
      const docStage = extractTableOrBullet(
        exceptionContent,
        "(?:Active Lifecycle Stage|Active Stage|Target Stage|Stage)"
      );
      const docGate = extractTableOrBullet(
        exceptionContent,
        "(?:Bypassed Stage Gate|Bypassed Gate|Gate)"
      );

      const scopeResult = checkScope(
        docWaivedReq,
        docStage,
        docGate,
        id,
        deliverableReqId,
        stageNum,
        stageName
      );

      if (!scopeResult.matches) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' scope mismatch: ${scopeResult.reason}.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: `Exception covering deliverable '${id}' in ${stageName}`,
          actual: scopeResult.reason || "Scope mismatch",
          remediation: `Attach an exception record whose scope covers '${id}' or update the exception scope.`,
          blocksOperation: true,
        });
      }

      // ── 2 & 3. Authorization & Approval Evidence ──────────────────────────
      // Extract Section 7 fields
      const sec7AuthorizerName = extractTableOrBullet(exceptionContent, "Authorizer Name");
      const sec7Title = extractTableOrBullet(exceptionContent, "(?:Title / Authority|Authorizer Title)");
      const sec7Decision = extractTableOrBullet(exceptionContent, "(?:Authorization Decision|Decision)");
      const sec7SignOff = extractTableOrBullet(exceptionContent, "(?:Sign-Off Reference|Signature Reference|Signature)");

      let authorizerName: string | null = sec7AuthorizerName;
      let authorizerRole: string | null = sec7Title;
      const decision: string | null = sec7Decision;
      let signOffRef: string | null = sec7SignOff;

      if (!authorizerName || !authorizerRole) {
        const sec2 = extractSection2Authorizer(exceptionContent);
        if (!authorizerName) authorizerName = sec2.name;
        if (!authorizerRole) authorizerRole = sec2.role;
      }

      if (!authorizerName) {
        const bulletApprover = extractTableOrBullet(
          exceptionContent,
          "(?:Authorized Human Approver|Authorized By)"
        );
        if (bulletApprover) {
          const parts = bulletApprover.split("/").map((p) => cleanValue(p));
          authorizerName = parts[0] || null;
          if (!authorizerRole && parts.length > 1) authorizerRole = parts[1] || null;
          if (!signOffRef && parts.length > 2) signOffRef = parts[2] || null;
        }
      }

      // Fallback to state if state has authorizer recorded
      if (!authorizerName && stateExc?.authorized_by) {
        const parts = String(stateExc.authorized_by).split(",").map((p) => p.trim());
        authorizerName = parts[0] || null;
        if (!authorizerRole && parts.length > 1) authorizerRole = parts[1] || null;
      }

      // Validate Authorizer Identification
      if (!authorizerName || isPlaceholder(authorizerName)) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' lacks valid human authorizer identification (missing or placeholder).`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Documented human engineer name",
          actual: authorizerName || "Missing authorizer",
          remediation: "Ensure an authorized human engineer is named in the exception record.",
          blocksOperation: true,
        });
      } else if (containsProhibitedAgentPattern(authorizerName)) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception authorizer '${authorizerName}' in '${resolvedPath}' is an AI agent or automated persona; AI agents are constitutionally prohibited from authorizing exceptions.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Human engineer authorizer",
          actual: `AI agent '${authorizerName}'`,
          remediation: "Replace AI agent with an authorized human engineer approval.",
          blocksOperation: true,
        });
      }

      // Validate Authorizer Role
      if (!authorizerRole || isPlaceholder(authorizerRole)) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' lacks verified authorizer role or authority.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Documented human governance role (e.g. Lead Architect, Engineering Manager)",
          actual: authorizerRole || "Missing role",
          remediation: "Document the authorizer's engineering role or authority in the exception record.",
          blocksOperation: true,
        });
      } else if (containsProhibitedAgentPattern(authorizerRole)) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception authorizer role '${authorizerRole}' in '${resolvedPath}' indicates an automated persona.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Human engineering role",
          actual: `Automated persona role '${authorizerRole}'`,
          remediation: "Specify an authorized human engineering role.",
          blocksOperation: true,
        });
      }

      // Validate Approval Evidence
      const hasFormalSec7 = /##\s*7\.\s*Human\s*Authorization/i.test(exceptionContent);
      if (hasFormalSec7) {
        if (!decision || isPlaceholder(decision) || (!decision.toUpperCase().includes("AUTHORIZED") && !decision.toUpperCase().includes("APPROVED"))) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' Section 7 lacks an explicit authorized decision ('EXCEPTION AUTHORIZED').`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "Decision: 'EXCEPTION AUTHORIZED'",
            actual: decision || "Missing decision",
            remediation: "Record an explicit human authorization decision in Section 7.",
            blocksOperation: true,
          });
        }

        if (!signOffRef || isPlaceholder(signOffRef)) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' lacks verifiable sign-off reference evidence (missing or placeholder in Section 7).`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "Verifiable sign-off reference (e.g. Commit SHA, PR #XX, or signature)",
            actual: signOffRef || "Missing sign-off reference",
            remediation: "Attach a verifiable sign-off reference to Section 7.",
            blocksOperation: true,
          });
        }
      } else {
        // Non-Section 7 formats (e.g. bullet format) must provide sign-off ref or state authorized_at evidence
        const hasStateAuthEvidence = Boolean(stateExc && stateExc.authorized_at && !isPlaceholder(String(stateExc.authorized_at)));
        const hasDocSignOff = Boolean(signOffRef && !isPlaceholder(signOffRef));

        if (!hasDocSignOff && !hasStateAuthEvidence) {
          findings.push({
            ruleId: ruleGovExceptionBounds.id,
            diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
            severity: ruleGovExceptionBounds.severity,
            enforcement: ruleGovExceptionBounds.defaultEnforcement,
            message: `Exception record '${resolvedPath}' lacks verifiable approval evidence or sign-off reference.`,
            filePath: resolvedPath,
            line: 1,
            column: 1,
            expected: "Verifiable sign-off reference in document or authorized_at timestamp in state",
            actual: "No approval evidence found",
            remediation: "Document human sign-off evidence in the exception record or record state authorization.",
            blocksOperation: true,
          });
        }
      }

      // ── Required Structural Sections: Justification & Compensating Controls ─
      if (!hasJustification(exceptionContent)) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' lacks required technical justification or root cause rationale.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Section 3: Reason & Justification with non-empty content",
          actual: "Missing or placeholder justification",
          remediation: "Articulate the technical root cause and justification in the exception record.",
          blocksOperation: true,
        });
      }

      if (!hasCompensatingControls(exceptionContent)) {
        findings.push({
          ruleId: ruleGovExceptionBounds.id,
          diagnosticCode: "UNRESOLVED_EXCEPTION_RECORD",
          severity: ruleGovExceptionBounds.severity,
          enforcement: ruleGovExceptionBounds.defaultEnforcement,
          message: `Exception record '${resolvedPath}' lacks mandatory compensating controls to mitigate risk.`,
          filePath: resolvedPath,
          line: 1,
          column: 1,
          expected: "Section 5: Compensating Controls with non-empty content",
          actual: "Missing or placeholder compensating controls",
          remediation: "Document concrete compensating controls (e.g. feature flags, mocks, canary verification).",
          blocksOperation: true,
        });
      }
    }

    return findings;
  },
};
