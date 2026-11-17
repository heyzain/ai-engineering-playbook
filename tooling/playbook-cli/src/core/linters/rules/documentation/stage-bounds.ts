import { STAGE_NAMES } from "../../../../constants.js";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";

// Canonical stage count: 7 stages (Stages 0 through 6)
export const MAX_STAGE_NUMBER = STAGE_NAMES.length - 1; // 6
export const MIN_STAGE_NUMBER = 0;

// Matches "Stage N" or "stage N" or "Stages N"
export const STAGE_REF_REGEX = /\b[Ss]tages?\s+(-?\d+)\b/g;

// Negative context patterns indicating an explicit prohibition or negative statement rather than a false claim
const PROHIBITION_PATTERNS = [
  /prohibit/i,
  /forbidden/i,
  /non-existent/i,
  /nonexistent/i,
  /never\s+create/i,
  /disallow/i,
  /cannot\s+(?:create|advance|transition|proceed)\s+to/i,
  /invalid/i,
  /replaces?\s+(?:the\s+)?need\s+for/i,
];

export const ruleDocStageBounds: GovernanceRule = {
  id: "RULE-DOC-STAGE-BOUNDS",
  category: "documentation",
  name: "Governance Stage Bounds Verification",
  description:
    "Enforces that explicit stage references in documentation adhere to the canonical 0..6 lifecycle and flags references to invalid or out-of-bounds stages.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [
    "governance/**/*.md",
    "docs/**/*.md",
    "core/**/*.md",
    "*.md",
  ],
  excludeGlobs: [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".playbook/.tmp/**",
    ".playbook/logs/**",
  ],
  evaluationMethod: "regex_pattern",
  version: "1.0.0",
  remediation:
    "Update stage references to valid stages within Stage 0 through Stage 6, or refer to maintenance milestone reopening.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const files = context.listFiles(ruleDocStageBounds.targetGlobs, ruleDocStageBounds.excludeGlobs);

    for (const relFile of files) {
      let content = "";
      try {
        content = context.readFile(relFile);
      } catch {
        continue;
      }

      const lines = content.split("\n");
      let inCodeBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const trimmed = lineText.trim();

        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }

        if (inCodeBlock) {
          continue;
        }

        // Check if the line is explicitly describing a prohibition of invalid stages
        const isProhibitionContext = PROHIBITION_PATTERNS.some((pat) => pat.test(lineText));

        STAGE_REF_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = STAGE_REF_REGEX.exec(lineText)) !== null) {
          const rawNum = match[1];
          const stageNum = parseInt(rawNum, 10);

          if (Number.isNaN(stageNum)) {
            continue;
          }

          if (stageNum < MIN_STAGE_NUMBER || stageNum > MAX_STAGE_NUMBER) {
            // If the text is explicitly noting that this stage is prohibited or nonexistent, skip
            if (isProhibitionContext) {
              continue;
            }

            findings.push({
              ruleId: "RULE-DOC-STAGE-BOUNDS",
              diagnosticCode: "INVALID_STAGE_BOUNDS",
              severity: "error",
              enforcement: "blocking",
              filePath: relFile,
              line: i + 1,
              column: match.index + 1,
              message: `Invalid stage reference '${match[0]}'. The canonical Playbook lifecycle defines strictly Stage 0 through Stage 6.`,
              expected: `Stage number within [${MIN_STAGE_NUMBER}..${MAX_STAGE_NUMBER}]`,
              actual: match[0],
              remediation: `Correct '${match[0]}' to a valid stage (0..6) or refer to milestone reopening (playbook reopen).`,
              blocksOperation: true,
            });
          }
        }
      }
    }

    return findings;
  },
};
