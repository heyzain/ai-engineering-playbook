import path from "node:path";
import { DEFAULT_PATHS } from "../../../../constants.js";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";

export const ADR_FILENAME_REGEX = /^ADR-\d{8}-\d{3}(-[a-z0-9-]+)?\.md$/;
export const ADR_ID_REGEX = /ADR-\d{8}-\d{3}/g;
export const VALID_ADR_STATUSES = new Set([
  "proposed",
  "accepted",
  "rejected",
  "deprecated",
  "superseded",
]);

export const ruleDocAdrIntegrity: GovernanceRule = {
  id: "RULE-DOC-ADR-INTEGRITY",
  category: "documentation",
  name: "Architecture Decision Record Integrity",
  description:
    "Validates ADR file naming, required metadata, valid status values, and cross-document ADR references.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: ["docs/adr/*.md", "**/*.md", "stacks/**/*.json"],
  excludeGlobs: [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".playbook/.tmp/**",
    ".playbook/logs/**",
  ],
  evaluationMethod: "structural",
  version: "1.0.0",
  remediation:
    "Ensure all ADR files in docs/adr/ conform to ADR-YYYYMMDD-### naming, declare a valid status, and that all ADR references resolve to an existing ADR.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const adrDir = DEFAULT_PATHS.adrDir;

    // 1. Discover all files in docs/adr/
    const adrFiles = context.listFiles([`${adrDir}/*.md`]);
    const knownAdrIds = new Map<string, string>(); // adrId -> relativeFilePath

    for (const relFile of adrFiles) {
      const fileName = path.basename(relFile);
      if (fileName === ".gitkeep") continue;

      // Validate filename convention
      if (!ADR_FILENAME_REGEX.test(fileName)) {
        findings.push({
          ruleId: "RULE-DOC-ADR-INTEGRITY",
          diagnosticCode: "INVALID_ADR_FILENAME",
          severity: "error",
          enforcement: "blocking",
          filePath: relFile,
          message: `ADR file '${fileName}' does not match canonical naming convention 'ADR-YYYYMMDD-###[-slug].md'.`,
          expected: "ADR-YYYYMMDD-###[-slug].md",
          actual: fileName,
          remediation: `Rename '${relFile}' to follow the ADR-YYYYMMDD-### pattern.`,
          blocksOperation: true,
        });
        continue;
      }

      const match = fileName.match(/ADR-\d{8}-\d{3}/);
      if (!match) continue;
      const adrId = match[0];

      // Check for duplicate ADR IDs
      if (knownAdrIds.has(adrId)) {
        const prevFile = knownAdrIds.get(adrId)!;
        findings.push({
          ruleId: "RULE-DOC-ADR-INTEGRITY",
          diagnosticCode: "DUPLICATE_ADR_ID",
          severity: "error",
          enforcement: "blocking",
          filePath: relFile,
          message: `Duplicate ADR identifier '${adrId}' found in both '${prevFile}' and '${relFile}'.`,
          expected: `Unique ADR identifier`,
          actual: `Duplicate ID '${adrId}'`,
          remediation: `Assign a unique sequence number to one of the conflicting ADR files.`,
          blocksOperation: true,
        });
      } else {
        knownAdrIds.set(adrId, relFile);
      }

      // Read and validate ADR content
      let content = "";
      try {
        content = context.readFile(relFile);
      } catch {
        continue;
      }

      // Validate required metadata & status
      validateAdrContent(content, relFile, adrId, findings);
    }

    // 2. Cross-reference check: Scan all markdown and stack json files for references to ADR-YYYYMMDD-###
    const candidateFiles = context.listFiles(
      ["**/*.md", "stacks/**/*.json"],
      ["node_modules/**", ".git/**", "dist/**", "build/**", ".playbook/.tmp/**", `${adrDir}/**`]
    );

    for (const relFile of candidateFiles) {
      let content = "";
      try {
        content = context.readFile(relFile);
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        ADR_ID_REGEX.lastIndex = 0;
        let refMatch: RegExpExecArray | null;

        while ((refMatch = ADR_ID_REGEX.exec(lineText)) !== null) {
          const referencedId = refMatch[0];
          if (!knownAdrIds.has(referencedId)) {
            findings.push({
              ruleId: "RULE-DOC-ADR-INTEGRITY",
              diagnosticCode: "UNRESOLVED_ADR_REFERENCE",
              severity: "error",
              enforcement: "blocking",
              filePath: relFile,
              line: i + 1,
              column: refMatch.index + 1,
              message: `Reference to non-existent Architecture Decision Record '${referencedId}' in '${relFile}'.`,
              expected: `Existing ADR file under docs/adr/ matching ID '${referencedId}'`,
              actual: `ADR '${referencedId}' does not exist on disk`,
              remediation: `Author the missing ADR in docs/adr/ or update the reference in '${relFile}'.`,
              blocksOperation: true,
            });
          }
        }
      }
    }

    return findings;
  },
};

function validateAdrContent(
  content: string,
  relFile: string,
  adrId: string,
  findings: RuleFinding[]
): void {
  // Check for status field
  const statusMatch = content.match(/\*\*Status\*\*\s*\|\s*`?([A-Za-z]+)`?/i) || content.match(/Status:\s*([A-Za-z]+)/i);

  if (!statusMatch) {
    findings.push({
      ruleId: "RULE-DOC-ADR-INTEGRITY",
      diagnosticCode: "MISSING_ADR_METADATA",
      severity: "error",
      enforcement: "blocking",
      filePath: relFile,
      message: `ADR '${adrId}' is missing mandatory 'Status' metadata field.`,
      expected: "Metadata table with '**Status** | <Proposed|Accepted|Rejected|Deprecated|Superseded>'",
      actual: "Status field not found",
      remediation: "Add '**Status** | `Accepted`' (or appropriate status) to the ADR metadata section.",
      blocksOperation: true,
    });
  } else {
    const rawStatus = statusMatch[1].trim().toLowerCase();
    if (!VALID_ADR_STATUSES.has(rawStatus)) {
      findings.push({
        ruleId: "RULE-DOC-ADR-INTEGRITY",
        diagnosticCode: "INVALID_ADR_STATUS",
        severity: "error",
        enforcement: "blocking",
        filePath: relFile,
        message: `ADR '${adrId}' declares an invalid status: '${statusMatch[1]}'.`,
        expected: "One of: Proposed, Accepted, Rejected, Deprecated, Superseded",
        actual: statusMatch[1],
        remediation: "Update the ADR Status field to a valid canonical value.",
        blocksOperation: true,
      });
    }
  }
}
