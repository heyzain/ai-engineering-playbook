import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";

const PROTECTED_GOVERNANCE_PREFIXES = [
  ".playbook/manifest.json",
  ".playbook/state.json",
  ".playbook/journal.json",
  ".playbook/.lock",
  "core/",
  "governance/",
];

export const ruleGovStackSovereignty: GovernanceRule = {
  id: "RULE-GOV-STACK-SOVEREIGNTY",
  category: "invariant",
  name: "Stack Sovereignty & Core Governance Non-Weakening",
  description:
    "Verifies that no modular technology stack template attempts to overwrite, weaken, or mutate Core Governance files (.playbook/manifest.json, .playbook/state.json, core/**, governance/**).",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: ["stacks/**/template/**", "stacks/*/template/**"],
  evaluationMethod: "filesystem_structural",
  version: "1.0.0",
  remediation:
    "Remove core governance paths from stack templates. Stacks extend application code and quality gates but can never overwrite Core Governance infrastructure.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    const templateFiles = context.listFiles([
      "stacks/**/template/**",
      "stacks/*/template/**",
    ]);

    for (const relFile of templateFiles) {
      // Extract the destination path relative to the template/ directory
      // e.g. "stacks/expo/template/app.json" -> "app.json"
      // e.g. "stacks/bad/template/.playbook/manifest.json" -> ".playbook/manifest.json"
      const templateIdx = relFile.indexOf("/template/");
      if (templateIdx === -1) {
        continue;
      }

      const destPath = relFile.slice(templateIdx + "/template/".length);

      for (const protectedPrefix of PROTECTED_GOVERNANCE_PREFIXES) {
        const isMatch =
          protectedPrefix.endsWith("/")
            ? destPath.startsWith(protectedPrefix) || destPath === protectedPrefix.slice(0, -1)
            : destPath === protectedPrefix;

        if (isMatch) {
          findings.push({
            ruleId: ruleGovStackSovereignty.id,
            diagnosticCode: "CORE_GOVERNANCE_OVERWRITE_ATTEMPT",
            severity: ruleGovStackSovereignty.severity,
            enforcement: ruleGovStackSovereignty.defaultEnforcement,
            message: `Stack template file '${relFile}' attempts to overwrite protected core governance path '${destPath}'. Stacks must not overwrite or weaken Core Governance.`,
            filePath: relFile,
            line: 1,
            column: 1,
            expected: "Stack template paths restricted to application code and stack configuration",
            actual: `Prohibited destination path: '${destPath}'`,
            remediation: `Remove '${destPath}' from '${relFile}'. Core Governance is sovereign and cannot be overridden by technology stacks.`,
            blocksOperation: true,
          });
          break;
        }
      }
    }

    return findings;
  },
};
