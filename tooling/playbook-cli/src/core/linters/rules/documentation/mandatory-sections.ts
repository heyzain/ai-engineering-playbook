import path from "node:path";
import { matchesGlob } from "../../../quality-gates/glob.js";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";

interface MandatorySectionDefinition {
  readonly id: string;
  readonly name: string;
  readonly pattern: RegExp;
}

interface ScopedDocumentRequirement {
  readonly globPattern: string;
  readonly docType: string;
  readonly requiredSections: MandatorySectionDefinition[];
}

export const SCOPED_DOCUMENT_REQUIREMENTS: ScopedDocumentRequirement[] = [
  {
    globPattern: "docs/prd/**/*.md",
    docType: "Product Requirements Document (PRD)",
    requiredSections: [
      { id: "metadata", name: "Document Metadata", pattern: /#+\s+(?:1\.\s*)?(?:Document\s+)?Metadata/i },
      { id: "problem", name: "Problem Statement", pattern: /#+\s+(?:2\.\s*)?Problem\s+Statement/i },
      { id: "users", name: "Target Users & Personas", pattern: /#+\s+(?:3\.\s*)?(?:Target\s+Users|User\s+Personas|Personas)/i },
      { id: "scope", name: "Scope Boundaries", pattern: /#+\s+(?:4\.\s*)?Scope(?:\s+Boundaries)?/i },
      { id: "requirements", name: "Functional Requirements", pattern: /#+\s+(?:5\.\s*)?(?:Functional\s+Requirements|Requirements)/i },
      { id: "acceptance", name: "Acceptance Criteria", pattern: /#+\s+(?:6\.\s*)?Acceptance\s+Criteria/i },
    ],
  },
  {
    globPattern: "docs/adr/**/*.md",
    docType: "Architecture Decision Record (ADR)",
    requiredSections: [
      { id: "metadata", name: "ADR Metadata", pattern: /#+\s+(?:1\.\s*)?(?:ADR\s+Metadata|Document\s+Metadata|Metadata)/i },
      { id: "context", name: "Context and Problem Statement", pattern: /#+\s+(?:2\.\s*)?Context(?:\s+and\s+Problem\s+Statement)?/i },
      { id: "drivers", name: "Decision Drivers", pattern: /#+\s+(?:3\.\s*)?Decision\s+Drivers/i },
      { id: "options", name: "Considered Options / Alternatives", pattern: /#+\s+(?:4\.\s*)?(?:Considered\s+Options|Considered\s+Alternatives|Options)/i },
      { id: "decision", name: "Decision Outcome / Chosen Solution", pattern: /#+\s+(?:5\.\s*)?(?:Decision\s+Outcome|Chosen\s+Solution|Decision)/i },
      { id: "consequences", name: "Consequences & Trade-Offs", pattern: /#+\s+(?:6\.\s*)?Consequences(?:\s+(&|and)\s+Trade-Offs)?/i },
    ],
  },
  {
    globPattern: "docs/rfcs/**/*.md",
    docType: "Clarification Request (RFC)",
    requiredSections: [
      { id: "metadata", name: "RFC Metadata", pattern: /#+\s+(?:1\.\s*)?(?:RFC\s+Metadata|Document\s+Metadata|Metadata)/i },
      { id: "context", name: "Unresolved Question & Context", pattern: /#+\s+(?:2\.\s*)?(?:Unresolved\s+Question|Context)/i },
      { id: "options", name: "Analyzed Options & Trade-Off Matrix", pattern: /#+\s+(?:4\.\s*)?(?:Analyzed\s+Options|Options)/i },
      { id: "decision", name: "Human Decision Required / Sign-Off", pattern: /#+\s+(?:6\.\s*|7\.\s*)?(?:Actionable\s+Human\s+Decision|Decision\s+Outcome|Human\s+Sign-Off)/i },
    ],
  },
  {
    globPattern: "docs/gates/**/*.md",
    docType: "Stage Gate Exit Package",
    requiredSections: [
      { id: "identification", name: "Package & Stage Identification", pattern: /#+\s+(?:1\.\s*)?(?:Package\s+&\s+Stage\s+Identification|Stage\s+Identification|Metadata)/i },
      { id: "objectives", name: "Stage Objectives & Scope Summary", pattern: /#+\s+(?:2\.\s*)?(?:Stage\s+Objectives|Objectives)/i },
      { id: "deliverables", name: "Deliverables Manifest & Status Table", pattern: /#+\s+(?:3\.\s*)?(?:Deliverables\s+Manifest|Deliverables)/i },
      { id: "evidence", name: "Verifiable Validation Evidence", pattern: /#+\s+(?:4\.\s*)?(?:Verifiable\s+Validation\s+Evidence|Validation\s+Evidence|Evidence)/i },
    ],
  },
  {
    globPattern: "docs/exceptions/**/*.md",
    docType: "Gate Exception Record",
    requiredSections: [
      { id: "metadata", name: "Exception Metadata", pattern: /#+\s+(?:1\.\s*)?(?:Exception\s+Metadata|Metadata)/i },
      { id: "justification", name: "Reason & Justification", pattern: /#+\s+(?:3\.\s*)?(?:Reason\s+&\s+Justification|Justification)/i },
      { id: "risk", name: "Risk Assessment", pattern: /#+\s+(?:4\.\s*)?(?:Risk\s+Assessment|Risk)/i },
      { id: "controls", name: "Compensating Controls", pattern: /#+\s+(?:5\.\s*)?Compensating\s+Controls/i },
      { id: "remediation", name: "Remediation Plan & Expiration", pattern: /#+\s+(?:6\.\s*)?(?:Remediation\s+Plan|Remediation|Expiration)/i },
    ],
  },
];

export const ruleDocMandatorySections: GovernanceRule = {
  id: "RULE-DOC-MANDATORY-SECTIONS",
  category: "documentation",
  name: "Governed Document Mandatory Sections",
  description:
    "Verifies that authored governance artifacts in specific directories contain all mandatory heading sections defined by their canonical templates.",
  severity: "warning",
  defaultEnforcement: "warning",
  targetGlobs: [
    "docs/prd/**/*.md",
    "docs/adr/**/*.md",
    "docs/rfcs/**/*.md",
    "docs/gates/**/*.md",
    "docs/exceptions/**/*.md",
  ],
  excludeGlobs: [
    "templates/**",
    "docs/prd/archive/**",
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".playbook/.tmp/**",
    ".playbook/logs/**",
  ],
  evaluationMethod: "structural",
  version: "1.0.0",
  remediation: "Add the missing mandatory section heading to ensure compliance with the governance template.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];

    for (const scope of SCOPED_DOCUMENT_REQUIREMENTS) {
      const files = context.listFiles([scope.globPattern], ruleDocMandatorySections.excludeGlobs);

      for (const relFile of files) {
        // Skip template files or .gitkeep
        if (path.basename(relFile) === ".gitkeep" || relFile.startsWith("templates/")) {
          continue;
        }

        let content = "";
        try {
          content = context.readFile(relFile);
        } catch {
          continue;
        }

        const lines = content.split("\n");
        const headingLines: string[] = [];
        let inCodeBlock = false;

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            inCodeBlock = !inCodeBlock;
            continue;
          }
          if (!inCodeBlock && trimmed.startsWith("#")) {
            headingLines.push(trimmed);
          }
        }

        for (const section of scope.requiredSections) {
          const hasSection = headingLines.some((h) => section.pattern.test(h));
          if (!hasSection) {
            findings.push({
              ruleId: "RULE-DOC-MANDATORY-SECTIONS",
              diagnosticCode: "MISSING_MANDATORY_SECTION",
              severity: "warning",
              enforcement: "warning",
              filePath: relFile,
              message: `${scope.docType} '${relFile}' is missing mandatory section: '${section.name}'.`,
              expected: `Heading matching section '${section.name}'`,
              actual: `Section not found in document headings`,
              remediation: `Add the '## ${section.name}' section in '${relFile}' as specified in the governance template.`,
              blocksOperation: false,
            });
          }
        }
      }
    }

    return findings;
  },
};
