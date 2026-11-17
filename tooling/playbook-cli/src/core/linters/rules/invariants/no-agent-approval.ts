import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseJsonSafely, findPropertyLocation, containsProhibitedAgentPattern } from "./helpers.js";

const STATE_PATH = ".playbook/state.json";

export const ruleGovNoAgentApproval: GovernanceRule = {
  id: "RULE-GOV-NO-AGENT-APPROVAL",
  category: "invariant",
  name: "Prohibition of AI Agent Stage Approvals",
  description:
    "Verifies that no stage approval record, human_approval block, or approval sidecar declares an AI agent as approver. Principle 1: AI agents are strictly forbidden from approving mandatory stage transitions.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [STATE_PATH, "docs/gates/**/*.md", "docs/gates/**/*.json", ".playbook/approval-fingerprint-*.json"],
  evaluationMethod: "json_ast",
  version: "1.0.0",
  remediation:
    "Stage approvals must be executed interactively by an authenticated human operator via 'playbook approve'. Replace agent approval records with genuine human sign-offs.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    // 1. Inspect .playbook/state.json
    if (context.fileExists(STATE_PATH)) {
      let stateContent: string;
      try {
        stateContent = context.readFile(STATE_PATH);
      } catch {
        stateContent = "";
      }

      if (stateContent) {
        const parseResult = parseJsonSafely<Record<string, unknown>>(stateContent);
        if (parseResult.success && parseResult.data) {
          const state = parseResult.data;

          // Check current_stage_detail.human_approval
          const currentStage = state.current_stage_detail as Record<string, unknown> | undefined;
          if (currentStage && typeof currentStage === "object") {
            const approval = currentStage.human_approval as Record<string, unknown> | undefined;
            if (approval && typeof approval === "object") {
              const status = String(approval.status || "");
              const approver = String(approval.approved_by || "");
              const sigRef = String(approval.signature_reference || "");

              if (status === "approved" || status === "pending_review") {
                if (approver && containsProhibitedAgentPattern(approver)) {
                  const loc = findPropertyLocation(stateContent, "/current_stage_detail/human_approval/approved_by");
                  findings.push({
                    ruleId: ruleGovNoAgentApproval.id,
                    diagnosticCode: "AGENT_APPROVAL_PROHIBITED",
                    severity: ruleGovNoAgentApproval.severity,
                    enforcement: ruleGovNoAgentApproval.defaultEnforcement,
                    message: `Prohibited AI agent pattern detected in stage approval: approved_by='${approver}'. Stage transitions must be approved by authenticated human operators.`,
                    filePath: STATE_PATH,
                    line: loc.line,
                    column: loc.column,
                    expected: "Human approver name / signature",
                    actual: approver,
                    remediation: "Revoke the agent approval and require an authenticated human operator to run 'playbook approve'.",
                    blocksOperation: true,
                  });
                }

                if (sigRef && containsProhibitedAgentPattern(sigRef)) {
                  const loc = findPropertyLocation(stateContent, "/current_stage_detail/human_approval/signature_reference");
                  findings.push({
                    ruleId: ruleGovNoAgentApproval.id,
                    diagnosticCode: "AGENT_APPROVAL_PROHIBITED",
                    severity: ruleGovNoAgentApproval.severity,
                    enforcement: ruleGovNoAgentApproval.defaultEnforcement,
                    message: `Prohibited AI agent signature reference detected in stage approval: '${sigRef}'.`,
                    filePath: STATE_PATH,
                    line: loc.line,
                    column: loc.column,
                    expected: "Human signature / PR reference",
                    actual: sigRef,
                    remediation: "Provide a valid human signature reference.",
                    blocksOperation: true,
                  });
                }
              }

              // Check actor_type in last_updated if stage is marked approved
              if (status === "approved") {
                const lastUpdated = state.last_updated as Record<string, unknown> | undefined;
                if (lastUpdated && typeof lastUpdated === "object") {
                  const actorType = String(lastUpdated.actor_type || "");
                  if (actorType === "agent") {
                    const loc = findPropertyLocation(stateContent, "/last_updated/actor_type");
                    findings.push({
                      ruleId: ruleGovNoAgentApproval.id,
                      diagnosticCode: "AGENT_APPROVAL_PROHIBITED",
                      severity: ruleGovNoAgentApproval.severity,
                      enforcement: ruleGovNoAgentApproval.defaultEnforcement,
                      message: "Approved stage records actor_type: 'agent'. AI agents cannot approve or advance mandatory lifecycle transitions.",
                      filePath: STATE_PATH,
                      line: loc.line,
                      column: loc.column,
                      expected: "actor_type: 'human'",
                      actual: "actor_type: 'agent'",
                      remediation: "Approvals must be executed by authenticated human operators.",
                      blocksOperation: true,
                    });
                  }
                }
              }
            }
          }

          // Check historical stages in stage_history
          const history = state.stage_history;
          if (Array.isArray(history)) {
            for (let i = 0; i < history.length; i++) {
              const entry = history[i] as Record<string, unknown>;
              if (!entry || typeof entry !== "object") continue;

              const approval = entry.human_approval as Record<string, unknown> | undefined;
              if (approval && typeof approval === "object") {
                const approver = String(approval.approved_by || "");
                if (approver && containsProhibitedAgentPattern(approver)) {
                  findings.push({
                    ruleId: ruleGovNoAgentApproval.id,
                    diagnosticCode: "AGENT_APPROVAL_PROHIBITED",
                    severity: ruleGovNoAgentApproval.severity,
                    enforcement: ruleGovNoAgentApproval.defaultEnforcement,
                    message: `Historical stage ${entry.stage} records prohibited AI agent approver: '${approver}'.`,
                    filePath: STATE_PATH,
                    line: 1,
                    column: 1,
                    expected: "Human approver in historical approval record",
                    actual: approver,
                    remediation: "Human sovereignty requires all lifecycle transitions to be human-authorized.",
                    blocksOperation: true,
                  });
                }
              }
            }
          }
        }
      }
    }

    // 2. Inspect approval sidecars and exit packages
    const sidecarFiles = context.listFiles([
      "docs/gates/**/GATE-*-APPROVAL.json",
      ".playbook/approval-fingerprint-*.json",
    ]);

    for (const sidecarFile of sidecarFiles) {
      let sidecarContent = "";
      try {
        sidecarContent = context.readFile(sidecarFile);
      } catch {
        continue;
      }

      const parseResult = parseJsonSafely<Record<string, unknown>>(sidecarContent);
      if (parseResult.success && parseResult.data) {
        const sidecar = parseResult.data;
        const approver = String(sidecar.approved_by || sidecar.approver || "");
        const approverType = String(sidecar.approver_type || sidecar.actor_type || "");

        if (approverType === "agent" || (approver && containsProhibitedAgentPattern(approver))) {
          findings.push({
            ruleId: ruleGovNoAgentApproval.id,
            diagnosticCode: "FORGED_APPROVAL_SIDECAR",
            severity: ruleGovNoAgentApproval.severity,
            enforcement: ruleGovNoAgentApproval.defaultEnforcement,
            message: `Approval sidecar '${sidecarFile}' specifies prohibited agent approver: '${approver || approverType}'.`,
            filePath: sidecarFile,
            line: 1,
            column: 1,
            expected: "Human approver in approval sidecar",
            actual: approver || approverType,
            remediation: "Remove the forged agent approval sidecar and obtain human approval via 'playbook approve'.",
            blocksOperation: true,
          });
        }
      }
    }

    // 3. Inspect Markdown exit packages under docs/gates/
    const gateDocs = context.listFiles(["docs/gates/**/*.md"]);
    const agentApprovalDocPattern = /\|\s*\*\*Approved By\*\*\s*\|\s*`?(agent|bot|copilot|gemini|claude|chatgpt|antigravity|ai)`?/i;

    for (const docFile of gateDocs) {
      let docContent = "";
      try {
        docContent = context.readFile(docFile);
      } catch {
        continue;
      }

      const lines = docContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (agentApprovalDocPattern.test(lines[i])) {
          findings.push({
            ruleId: ruleGovNoAgentApproval.id,
            diagnosticCode: "AGENT_APPROVAL_PROHIBITED",
            severity: ruleGovNoAgentApproval.severity,
            enforcement: ruleGovNoAgentApproval.defaultEnforcement,
            message: `Stage exit package '${docFile}' records an AI agent as stage approver: '${lines[i].trim()}'.`,
            filePath: docFile,
            line: i + 1,
            column: 1,
            expected: "Human operator recorded in gate exit approval table",
            actual: lines[i].trim(),
            remediation: "Record the authenticated human operator who conducted the gate review.",
            blocksOperation: true,
          });
        }
      }
    }

    return findings;
  },
};
