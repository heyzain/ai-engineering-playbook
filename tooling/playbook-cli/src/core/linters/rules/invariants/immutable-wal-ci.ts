import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseJsonSafely } from "./helpers.js";

const FORBIDDEN_CI_COMMAND_PATTERNS = [
  /\bplaybook\s+advance\b/i,
  /\bplaybook\s+approve\b/i,
  /\bplaybook\s+reopen\b/i,
  /\bplaybook\s+recover\b/i,
  /\bplaybook\s+init\b/i,
  />\s*\.playbook\/(?:state\.json|journal\.json|\.lock)/i,
];

export const ruleGovImmutableWalCi: GovernanceRule = {
  id: "RULE-GOV-IMMUTABLE-WAL-CI",
  category: "invariant",
  name: "Immutability of Lifecycle State & WAL in CI",
  description:
    "Verifies that Remote CI workflows and quality-gate checks do not attempt to execute lifecycle mutations (playbook advance, playbook approve, playbook reopen, playbook recover) or write to write-ahead journals.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [
    ".github/workflows/**/*.yml",
    ".github/workflows/**/*.yaml",
    ".playbook/quality-gates.json",
    "stacks/**/quality-gates.partial.json",
  ],
  evaluationMethod: "yaml_ast",
  version: "1.0.0",
  remediation:
    "Remove lifecycle mutation commands from CI workflows and quality-gate checks. Remote CI is strictly a read-only verifier.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    // 1. Scan CI workflow files (.github/workflows/**/*.yml, *.yaml)
    const workflowFiles = context.listFiles([
      ".github/workflows/**/*.yml",
      ".github/workflows/**/*.yaml",
    ]);

    for (const workflowFile of workflowFiles) {
      let content = "";
      try {
        content = context.readFile(workflowFile);
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        for (const pattern of FORBIDDEN_CI_COMMAND_PATTERNS) {
          if (pattern.test(lineText)) {
            findings.push({
              ruleId: ruleGovImmutableWalCi.id,
              diagnosticCode: "CI_MUTATION_PROHIBITED",
              severity: ruleGovImmutableWalCi.severity,
              enforcement: ruleGovImmutableWalCi.defaultEnforcement,
              message: `CI workflow '${workflowFile}' attempts to execute lifecycle-mutating command: '${lineText.trim()}'. CI must remain strictly read-only.`,
              filePath: workflowFile,
              line: i + 1,
              column: 1,
              expected: "Read-only CI verification (e.g. playbook gate run --headless)",
              actual: lineText.trim(),
              remediation:
                "Remove mutating commands from CI workflows. State transitions and approvals require human authority.",
              blocksOperation: true,
            });
            break;
          }
        }
      }
    }

    // 2. Scan quality gates check definitions (.playbook/quality-gates.json and stacks/**/quality-gates.partial.json)
    const gateFiles = context.listFiles([
      ".playbook/quality-gates.json",
      "stacks/**/quality-gates.partial.json",
    ]);

    for (const gateFile of gateFiles) {
      let content = "";
      try {
        content = context.readFile(gateFile);
      } catch {
        continue;
      }

      const parseResult = parseJsonSafely<Record<string, unknown>>(content);
      if (!parseResult.success || !parseResult.data) continue;

      const data = parseResult.data;
      const gates = Array.isArray(data.gates) ? (data.gates as Array<Record<string, unknown>>) : [];

      for (const gate of gates) {
        const checks = Array.isArray(gate.checks) ? (gate.checks as Array<Record<string, unknown>>) : [];
        for (const check of checks) {
          const checkId = String(check.id || "unknown");
          const cmd = String(check.command || "");
          const args = Array.isArray(check.args) ? check.args.map(String).join(" ") : "";
          const fullCmd = `${cmd} ${args}`.trim();

          for (const pattern of FORBIDDEN_CI_COMMAND_PATTERNS) {
            if (pattern.test(fullCmd)) {
              findings.push({
                ruleId: ruleGovImmutableWalCi.id,
                diagnosticCode: "WAL_MUTATION_IN_CI",
                severity: ruleGovImmutableWalCi.severity,
                enforcement: ruleGovImmutableWalCi.defaultEnforcement,
                message: `Quality gate check '${checkId}' in '${gateFile}' executes mutating command '${fullCmd}'. Quality gates must not mutate lifecycle state or WAL journals.`,
                filePath: gateFile,
                line: 1,
                column: 1,
                expected: "Read-only verification command in quality gate check",
                actual: fullCmd,
                remediation: "Configure quality gate checks to execute verification scripts without altering state.",
                blocksOperation: true,
              });
              break;
            }
          }
        }
      }
    }

    return findings;
  },
};
