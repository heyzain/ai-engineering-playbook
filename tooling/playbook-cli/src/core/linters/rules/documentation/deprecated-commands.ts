import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";

export interface DeprecatedCommandEntry {
  readonly command: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const DEPRECATED_COMMANDS_CATALOG: DeprecatedCommandEntry[] = [
  {
    command: "playbook run",
    pattern: /\bplaybook\s+run\b/,
    replacement: "playbook gate run",
  },
  {
    command: "playbook test",
    pattern: /\bplaybook\s+test\b/,
    replacement: "playbook gate run",
  },
  {
    command: "playbook gates",
    pattern: /\bplaybook\s+gates\b/,
    replacement: "playbook gate",
  },
  {
    command: "playbook hooks",
    pattern: /\bplaybook\s+hooks\b/,
    replacement: "playbook hook",
  },
  {
    command: "playbook stacks",
    pattern: /\bplaybook\s+stacks\b/,
    replacement: "playbook stack",
  },
];

// Context keywords indicating that the command is being discussed as historical, deprecated, or illustrative rather than an active command instruction
const EXPLANATORY_CONTEXT_PATTERNS = [
  /instead\s+of/i,
  /\bvs\.?\b/i,
  /deprecated/i,
  /superseded/i,
  /obsolete/i,
  /replaced\s+by/i,
  /migration/i,
  /legacy/i,
  /historical/i,
];

export const ruleDocDeprecatedCommands: GovernanceRule = {
  id: "RULE-DOC-DEPRECATED-COMMANDS",
  category: "documentation",
  name: "Deprecated CLI Command Detection",
  description:
    "Detects obsolete or superseded Playbook CLI command references in current operational documentation.",
  severity: "warning",
  defaultEnforcement: "warning",
  targetGlobs: [
    "docs/**/*.md",
    "governance/**/*.md",
    "core/**/*.md",
    "*.md",
  ],
  excludeGlobs: [
    "docs/adr/**", // Historical architectural records are exempt
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".playbook/.tmp/**",
    ".playbook/logs/**",
  ],
  evaluationMethod: "regex_pattern",
  version: "1.0.0",
  remediation: "Update the obsolete command reference to the canonical CLI command syntax.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const files = context.listFiles(ruleDocDeprecatedCommands.targetGlobs, ruleDocDeprecatedCommands.excludeGlobs);

    for (const relFile of files) {
      let content = "";
      try {
        content = context.readFile(relFile);
      } catch {
        continue;
      }

      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];

        // Skip if the line itself is describing a deprecation / migration context
        const isExplanatory = EXPLANATORY_CONTEXT_PATTERNS.some((pat) => pat.test(lineText));
        if (isExplanatory) {
          continue;
        }

        for (const entry of DEPRECATED_COMMANDS_CATALOG) {
          const match = entry.pattern.exec(lineText);
          if (match) {
            findings.push({
              ruleId: "RULE-DOC-DEPRECATED-COMMANDS",
              diagnosticCode: "DEPRECATED_CLI_COMMAND",
              severity: "warning",
              enforcement: "warning",
              filePath: relFile,
              line: i + 1,
              column: match.index + 1,
              message: `Deprecated CLI command syntax '${entry.command}' referenced in '${relFile}'. Use '${entry.replacement}' instead.`,
              expected: `Canonical command syntax '${entry.replacement}'`,
              actual: entry.command,
              remediation: `Replace '${entry.command}' with '${entry.replacement}'.`,
              blocksOperation: false,
            });
          }
        }
      }
    }

    return findings;
  },
};
