import YAML from "yaml";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import { parseYamlSafely, getYamlNodeLocation } from "./helpers.js";

interface PrTargetTriggerDetection {
  readonly hasPrTarget: boolean;
  readonly triggerNode?: YAML.Node;
}

/**
 * Inspects workflow 'on' triggers in scalar, sequence, or mapping form to detect 'pull_request_target'.
 */
function detectPrTargetTrigger(doc: YAML.Document): PrTargetTriggerDetection {
  const root = doc.contents;
  if (!root || !(root instanceof YAML.YAMLMap)) {
    return { hasPrTarget: false };
  }

  const onPair = root.items.find(
    (item) => item.key instanceof YAML.Scalar && String(item.key.value) === "on"
  );
  if (!onPair || !onPair.value) {
    return { hasPrTarget: false };
  }

  const val = onPair.value;

  // Form 1: Scalar (e.g. 'on: pull_request_target')
  if (val instanceof YAML.Scalar) {
    if (String(val.value).trim() === "pull_request_target") {
      return { hasPrTarget: true, triggerNode: val };
    }
  }

  // Form 2: Sequence (e.g. 'on: [push, pull_request_target]')
  if (val instanceof YAML.YAMLSeq) {
    for (const item of val.items) {
      if (item instanceof YAML.Scalar && String(item.value).trim() === "pull_request_target") {
        return { hasPrTarget: true, triggerNode: item };
      }
    }
  }

  // Form 3: Mapping (e.g. on: { pull_request_target: { branches: [main] } })
  if (val instanceof YAML.YAMLMap) {
    const prTargetItem = val.items.find(
      (item) => item.key instanceof YAML.Scalar && String(item.key.value).trim() === "pull_request_target"
    );
    if (prTargetItem) {
      return { hasPrTarget: true, triggerNode: prTargetItem.key as YAML.Node };
    }
  }

  return { hasPrTarget: false };
}

interface PrHeadCheckoutDetection {
  readonly checksOutPrHead: boolean;
  readonly reason: string;
  readonly locationNode?: YAML.Node;
}

/**
 * Inspects workflow steps and run commands to determine if PR head code or untrusted refs are checked out.
 */
function detectPrHeadCheckout(doc: YAML.Document): PrHeadCheckoutDetection {
  const root = doc.contents;
  if (!root || !(root instanceof YAML.YAMLMap)) {
    return { checksOutPrHead: false, reason: "" };
  }

  const jobsPair = root.items.find(
    (item) => item.key instanceof YAML.Scalar && String(item.key.value) === "jobs"
  );
  if (!jobsPair || !(jobsPair.value instanceof YAML.YAMLMap)) {
    return { checksOutPrHead: false, reason: "" };
  }

  for (const jobItem of jobsPair.value.items) {
    if (!(jobItem.value instanceof YAML.YAMLMap)) continue;

    const stepsPair = jobItem.value.items.find(
      (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "steps"
    );
    if (!stepsPair || !(stepsPair.value instanceof YAML.YAMLSeq)) continue;

    for (const stepItem of stepsPair.value.items) {
      if (!(stepItem instanceof YAML.YAMLMap)) continue;

      const usesPair = stepItem.items.find(
        (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "uses"
      );
      const withPair = stepItem.items.find(
        (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "with"
      );
      const runPair = stepItem.items.find(
        (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "run"
      );

      // 1. Check actions/checkout configuration
      if (usesPair && usesPair.value instanceof YAML.Scalar) {
        const usesStr = String(usesPair.value.value || "").trim();
        if (usesStr.startsWith("actions/checkout")) {
          if (withPair && withPair.value instanceof YAML.YAMLMap) {
            // Check ref parameter
            const refPair = withPair.value.items.find(
              (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "ref"
            );
            if (refPair && refPair.value instanceof YAML.Scalar) {
              const refVal = String(refPair.value.value || "").trim();
              if (
                refVal.includes("github.event.pull_request.head") ||
                refVal.includes("github.head_ref") ||
                refVal.includes("head.sha") ||
                refVal.includes("head.ref") ||
                refVal.includes("github.event.pull_request")
              ) {
                return {
                  checksOutPrHead: true,
                  reason: `actions/checkout explicitly configures ref: '${refVal}'`,
                  locationNode: refPair.value,
                };
              }

              // Ambiguous or dynamic expression that cannot be statically proven to be base ref
              if (
                refVal.includes("${{") &&
                !refVal.includes("github.base_ref") &&
                !refVal.includes("github.ref")
              ) {
                return {
                  checksOutPrHead: true,
                  reason: `actions/checkout configures dynamic or ambiguous ref '${refVal}' whose safety cannot be established statically`,
                  locationNode: refPair.value,
                };
              }
            }

            // Check repository parameter
            const repoPair = withPair.value.items.find(
              (p) => p.key instanceof YAML.Scalar && String(p.key.value) === "repository"
            );
            if (repoPair && repoPair.value instanceof YAML.Scalar) {
              const repoVal = String(repoPair.value.value || "").trim();
              if (
                repoVal.includes("github.event.pull_request.head") ||
                repoVal.includes("head.repo")
              ) {
                return {
                  checksOutPrHead: true,
                  reason: `actions/checkout explicitly configures repository: '${repoVal}'`,
                  locationNode: repoPair.value,
                };
              }
            }
          }
        }
      }

      // 2. Check run commands for manual git/gh checkout of PR head
      if (runPair && runPair.value instanceof YAML.Scalar) {
        const runCmd = String(runPair.value.value || "");
        if (
          /git\s+checkout\s+.*(?:github\.event\.pull_request\.head|head\.sha|head\.ref|pull_request)/i.test(runCmd) ||
          /git\s+fetch\s+.*pull\/\$\{\{.*\}\}\/head/i.test(runCmd) ||
          /git\s+fetch\s+.*pull\/.*\/head/i.test(runCmd) ||
          /gh\s+pr\s+checkout/i.test(runCmd)
        ) {
          return {
            checksOutPrHead: true,
            reason: `run step manually checks out PR head code: '${runCmd.trim().split("\n")[0]}'`,
            locationNode: runPair.value,
          };
        }
      }
    }
  }

  return { checksOutPrHead: false, reason: "" };
}

export const ruleSecPrTargetBan: GovernanceRule = {
  id: "RULE-SEC-PR-TARGET-BAN",
  category: "security",
  name: "Pull Request Target Safety & Trigger Isolation",
  description:
    "Flags any workflow using the pull_request_target trigger if it checks out or executes code from the pull request head.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [".github/workflows/**/*.yml", ".github/workflows/**/*.yaml"],
  evaluationMethod: "yaml_ast",
  version: "1.0.0",
  remediation:
    "Switch trigger to 'pull_request', or isolate untrusted PR-head code execution from privileged workflows with access to repository secrets.",

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
        continue;
      }

      const doc = parseResult.doc;
      const triggerDetection = detectPrTargetTrigger(doc);

      if (!triggerDetection.hasPrTarget) {
        continue; // Workflow does not use pull_request_target
      }

      const checkoutDetection = detectPrHeadCheckout(doc);

      if (checkoutDetection.checksOutPrHead) {
        const targetNode = checkoutDetection.locationNode || triggerDetection.triggerNode;
        const loc = getYamlNodeLocation(targetNode, parseResult.lineCounter);

        findings.push({
          ruleId: ruleSecPrTargetBan.id,
          diagnosticCode: "FORBIDDEN_PR_TARGET_TRIGGER",
          severity: ruleSecPrTargetBan.severity,
          enforcement: ruleSecPrTargetBan.defaultEnforcement,
          message: `Workflow '${filePath}' combines 'pull_request_target' trigger with checkout/execution of untrusted code from PR head (${checkoutDetection.reason}). Running untrusted code in a privileged base repository context permits immediate secret exfiltration.`,
          filePath,
          line: loc.line,
          column: loc.column,
          expected: "Trigger 'pull_request' for untrusted PR code, or zero checkout of PR-head context",
          actual: `pull_request_target with PR head checkout: ${checkoutDetection.reason}`,
          remediation: `Change trigger to 'pull_request', or remove PR-head checkout ('${checkoutDetection.reason}') from this privileged workflow.`,
          blocksOperation: true,
        });
      }
    }

    return findings;
  },
};
