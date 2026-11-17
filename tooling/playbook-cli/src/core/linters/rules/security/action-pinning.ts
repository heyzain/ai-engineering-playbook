import YAML from "yaml";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import {
  parseYamlSafely,
  getYamlNodeLocation,
  isThirdPartyAction,
  COMMIT_SHA_40_REGEX,
} from "./helpers.js";

interface ActionInvocation {
  readonly uses: string;
  readonly node: YAML.Scalar;
}

/**
 * Traverses a parsed workflow YAML AST to collect all step-level and job-level 'uses' action invocations.
 */
function collectUsesNodes(doc: YAML.Document): ActionInvocation[] {
  const invocations: ActionInvocation[] = [];
  const root = doc.contents;
  if (!root || !(root instanceof YAML.YAMLMap)) {
    return invocations;
  }

  const jobsPair = root.items.find(
    (item) => item.key instanceof YAML.Scalar && String(item.key.value) === "jobs"
  );
  if (!jobsPair || !(jobsPair.value instanceof YAML.YAMLMap)) {
    return invocations;
  }

  for (const jobItem of jobsPair.value.items) {
    if (!(jobItem.value instanceof YAML.YAMLMap)) {
      continue;
    }

    // 1. Check job-level uses (reusable workflows)
    const jobUsesPair = jobItem.value.items.find(
      (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "uses"
    );
    if (jobUsesPair && jobUsesPair.value instanceof YAML.Scalar) {
      invocations.push({
        uses: String(jobUsesPair.value.value || "").trim(),
        node: jobUsesPair.value,
      });
    }

    // 2. Check steps in job
    const stepsPair = jobItem.value.items.find(
      (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "steps"
    );
    if (stepsPair && stepsPair.value instanceof YAML.YAMLSeq) {
      for (const stepItem of stepsPair.value.items) {
        if (!(stepItem instanceof YAML.YAMLMap)) {
          continue;
        }

        const stepUsesPair = stepItem.items.find(
          (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "uses"
        );
        if (stepUsesPair && stepUsesPair.value instanceof YAML.Scalar) {
          invocations.push({
            uses: String(stepUsesPair.value.value || "").trim(),
            node: stepUsesPair.value,
          });
        }
      }
    }
  }

  return invocations;
}

export const ruleSecActionPinning: GovernanceRule = {
  id: "RULE-SEC-ACTION-PINNING",
  category: "security",
  name: "Third-Party GitHub Action SHA Pinning",
  description:
    "Verifies that all third-party GitHub Actions are pinned to an immutable 40-character commit SHA, not a mutable tag or branch.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [".github/workflows/**/*.yml", ".github/workflows/**/*.yaml"],
  evaluationMethod: "yaml_ast",
  version: "1.0.0",
  remediation:
    "Pin third-party actions to an immutable 40-character commit SHA (e.g. 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2').",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const workflowFiles = context.listFiles(
      [".github/workflows/**/*.yml", ".github/workflows/**/*.yaml"],
      []
    );

    if (workflowFiles.length === 0) {
      return findings;
    }

    for (const filePath of workflowFiles) {
      let content = "";
      try {
        content = context.readFile(filePath);
      } catch {
        continue;
      }

      if (!content.trim()) {
        continue;
      }

      const parseResult = parseYamlSafely(content);
      if (!parseResult.success || !parseResult.doc) {
        continue; // Handled by workflow-perms syntax check
      }

      const invocations = collectUsesNodes(parseResult.doc);

      for (const inv of invocations) {
        const rawUses = inv.uses;
        if (!rawUses) continue;

        // Skip local actions (./path) and docker container actions (docker://image)
        if (!isThirdPartyAction(rawUses)) {
          continue;
        }

        const loc = getYamlNodeLocation(inv.node, parseResult.lineCounter);

        if (!rawUses.includes("@")) {
          findings.push({
            ruleId: ruleSecActionPinning.id,
            diagnosticCode: "UNPINNED_THIRD_PARTY_ACTION",
            severity: ruleSecActionPinning.severity,
            enforcement: ruleSecActionPinning.defaultEnforcement,
            message: `Third-party action '${rawUses}' in '${filePath}' lacks a version pin. Actions must be pinned to an immutable 40-character commit SHA.`,
            filePath,
            line: loc.line,
            column: loc.column,
            expected: `Action reference pinned to 40-char SHA (e.g. '${rawUses}@<sha>')`,
            actual: rawUses,
            remediation: `Pin action '${rawUses}' to its full 40-character commit SHA.`,
            blocksOperation: true,
          });
          continue;
        }

        const atIndex = rawUses.indexOf("@");
        const actionName = rawUses.slice(0, atIndex).trim();
        const actionRef = rawUses.slice(atIndex + 1).trim();

        if (!COMMIT_SHA_40_REGEX.test(actionRef)) {
          findings.push({
            ruleId: ruleSecActionPinning.id,
            diagnosticCode: "UNPINNED_THIRD_PARTY_ACTION",
            severity: ruleSecActionPinning.severity,
            enforcement: ruleSecActionPinning.defaultEnforcement,
            message: `Third-party action '${actionName}' is not pinned to an immutable 40-character commit SHA (found '@${actionRef}'). Mutable action tags and branches violate supply chain security policy.`,
            filePath,
            line: loc.line,
            column: loc.column,
            expected: `Action '${actionName}' pinned to full 40-character commit SHA`,
            actual: `${actionName}@${actionRef}`,
            remediation: `Replace mutable tag '@${actionRef}' with the action's immutable 40-character commit SHA (e.g. '${actionName}@11bd71901bbe5b1630ceea73d27597364c9af683 # ${actionRef}').`,
            blocksOperation: true,
          });
        }
      }
    }

    return findings;
  },
};
