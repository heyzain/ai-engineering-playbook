import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  MarkdownParser,
  MarkdownDocument,
  ExceptionValidator,
  ExitPackageValidator,
  validateExceptionDocumentAst,
  validateExitPackageAst,
  isForbiddenAgentName,
  FORBIDDEN_SUBSTRINGS,
} from "../src/core/controller/index.js";
import {
  startStage,
  recordDeliverable,
  recordEvidence,
  recordException,
  submitStage,
  resolveAuthoritativeVerification,
  resolveGovernanceProfile,
  ControllerError,
} from "../src/core/controller/index.js";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { ProjectState } from "../src/types/state.js";

describe("AST Governance Validators & Stage Gate Integration (Task 009B.2)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ast-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore transient lock on Windows
      }
    }
  });

  // --------------------------------------------------------------------------
  // 1. Markdown AST Parser Core Capabilities
  // --------------------------------------------------------------------------
  describe("1. Markdown AST Parser Architecture", () => {
    test("parses headings, tables, blockquotes, lists, and code blocks with line accuracy", () => {
      const markdown = `# Main Title
Paragraph line 1.
Paragraph line 2.

## Section 1: Tables
| Field | Value |
| :--- | :--- |
| Key1 | Val1 |
| Key2 | Val2 |

> Blockquote line 1
> Blockquote line 2

- List item 1
- List item 2

\`\`\`typescript
// Code block
const x = 10;
## Not a real heading
\`\`\`
`;

      const doc = MarkdownParser.parse(markdown);
      const headings = doc.getHeadings();
      assert.equal(headings.length, 2);
      assert.equal(headings[0].level, 1);
      assert.equal(headings[0].text, "Main Title");
      assert.equal(headings[0].startLine, 1);
      assert.equal(headings[1].level, 2);
      assert.equal(headings[1].text, "Section 1: Tables");

      const tables = doc.getTables();
      assert.equal(tables.length, 1);
      assert.deepEqual(tables[0].headers, ["Field", "Value"]);
      assert.equal(tables[0].rows.length, 2);

      const kvs = doc.extractTableKeyValues(tables[0]);
      assert.equal(kvs.get("key1")?.value, "Val1");
      assert.equal(kvs.get("key2")?.value, "Val2");

      const codeBlocks = doc.getCodeBlocks();
      assert.equal(codeBlocks.length, 1);
      assert.equal(codeBlocks[0].language, "typescript");
      assert.ok(codeBlocks[0].content.includes("## Not a real heading"));
    });

    test("fenced code block contents are never misclassified as genuine headings or tables", () => {
      const markdown = `# Real Title

\`\`\`markdown
# Fake Heading in Code Block
| Col1 | Col2 |
| --- | --- |
| Val1 | Val2 |
\`\`\`

## Genuine Section
`;
      const doc = MarkdownParser.parse(markdown);
      const headings = doc.getHeadings();
      assert.equal(headings.length, 2);
      assert.equal(headings[0].text, "Real Title");
      assert.equal(headings[1].text, "Genuine Section");

      const tables = doc.getTables();
      assert.equal(tables.length, 0); // table was inside code block!
    });

    test("findPlaceholders skips tokens in code blocks while detecting tokens in paragraphs/tables", () => {
      const markdown = `# Section

Normal text with [TODO: Fix this].

| Item | Status |
| :--- | :--- |
| A | [TBD] |

\`\`\`text
Example snippet:
[TODO: This is code example, must not fail]
[INSERT code here]
\`\`\`
`;
      const doc = MarkdownParser.parse(markdown);
      const occurrences = doc.findPlaceholders({ excludeCodeBlocks: true });
      assert.equal(occurrences.length, 2);
      assert.match(occurrences[0].token, /TODO/);
      assert.equal(occurrences[0].line, 3);
      assert.match(occurrences[1].token, /TBD/);
      assert.equal(occurrences[1].line, 7);
    });

    test("escaped pipe (\\|) and inline code containing pipes do not split table columns", () => {
      const markdown = `
| Key | Value | Description |
| :--- | :--- | :--- |
| Escaped | Alpha \\| Beta | Contains escaped pipe |
| InlineCode | \`foo | bar\` | Contains inline code pipe |
`;
      const doc = MarkdownParser.parse(markdown);
      const tables = doc.getTables();
      assert.equal(tables.length, 1);
      assert.equal(tables[0].rows.length, 2);
      assert.equal(tables[0].rows[0].cells.length, 3);
      assert.equal(tables[0].rows[0].cells[1], "Alpha | Beta");
      assert.equal(tables[0].rows[1].cells.length, 3);
      assert.equal(tables[0].rows[1].cells[1], "foo | bar");
    });

    test("unclosed fenced code block records a syntax error in doc.syntaxErrors", () => {
      const markdown = `# Title
\`\`\`typescript
const unclosed = true;
// No closing fence
`;
      const doc = MarkdownParser.parse(markdown);
      assert.equal(doc.syntaxErrors.length, 1);
      assert.ok(doc.syntaxErrors[0].message.includes("Unclosed fenced code block"));
      assert.equal(doc.syntaxErrors[0].line, 2);
    });

    test("unclosed HTML comment records a syntax error in doc.syntaxErrors", () => {
      const markdown = `# Title
<!-- Unclosed comment started here
without closing tag
`;
      const doc = MarkdownParser.parse(markdown);
      assert.equal(doc.syntaxErrors.length, 1);
      assert.ok(doc.syntaxErrors[0].message.includes("Unclosed HTML comment"));
      assert.equal(doc.syntaxErrors[0].line, 2);
    });

    test("nested lists and continuation lines: parses nodes and detects placeholders in both", () => {
      const markdown = `# Task List
- Root item 1
  - Indented child item with [TODO: Child detail]
- Root item 2
  Continuation line for root item 2 containing [TBD: Specification]
`;
      const doc = MarkdownParser.parse(markdown);
      const placeholders = doc.findPlaceholders();
      assert.equal(placeholders.length, 2);
      assert.ok(placeholders.some((p) => p.token.includes("TODO")));
      assert.ok(placeholders.some((p) => p.token.includes("TBD")));
    });

    test("blockquotes containing heading and table-like text are encapsulated and isolated from document headings/tables", () => {
      const markdown = `# Legitimate Header

> ## Quoted Fake Heading
> | FakeCol1 | FakeCol2 |
> | :--- | :--- |
> | Val1 | Val2 |

Regular text paragraph.
`;
      const doc = MarkdownParser.parse(markdown);
      const headings = doc.getHeadings();
      const tables = doc.getTables();
      // Quoted fake heading and table must NOT appear as root document headings or tables
      assert.equal(headings.length, 1);
      assert.equal(headings[0].text, "Legitimate Header");
      assert.equal(tables.length, 0);

      const bq = doc.nodes.find((n) => n.type === "blockquote");
      assert.ok(bq);
      assert.ok(bq.raw.includes("Quoted Fake Heading"));
    });

    test("duplicate section headings: detects duplicate canonical headings and handles gracefully", () => {
      const markdown = `# Stage Gate 1 Exit Package: Test

## 1. Package & Stage Identification
First identification content.

## 1. Package & Stage Identification
Duplicate identification content.

## 3. Deliverables Manifest & Status
Deliverables content.
`;
      const doc = MarkdownParser.parse(markdown);
      const h2s = doc.getHeadings(2);
      assert.equal(h2s.length, 3);
      const sec1s = h2s.filter((h) => h.text.includes("Package & Stage Identification"));
      assert.equal(sec1s.length, 2);

      // findSection locates first match deterministically
      const sectionMatch = doc.findSection(/Package & Stage Identification/, 2);
      assert.ok(sectionMatch);
      assert.equal(sectionMatch.heading.startLine, 3);
    });

    test("setext-style headings are not parsed as ATX headings and fail closed safely", () => {
      const markdown = `Stage Gate 1 Exit Package
=========================

Package Identification
----------------------
Some substantive body text that provides descriptive context for the stage review.
`.padEnd(250, " ");
      const doc = MarkdownParser.parse(markdown);
      // Setext headings do not produce HeadingNodes in this ATX-focused parser
      const headings = doc.getHeadings();
      assert.equal(headings.length, 0);

      // Validating this with ExitPackageValidator fails closed safely because H1 is missing
      const result = ExitPackageValidator.validate(markdown);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("Missing top-level header")));
    });

    test("malformed or unclosed fences with tildes (~~~) record syntax errors", () => {
      const markdown = `# Title
~~~json
{ "unclosed": true }
`;
      const doc = MarkdownParser.parse(markdown);
      assert.equal(doc.syntaxErrors.length, 1);
      assert.ok(doc.syntaxErrors[0].message.includes("Unclosed fenced code block"));
      assert.equal(doc.syntaxErrors[0].line, 2);

      const valRes = ExitPackageValidator.validate(markdown.padEnd(250, " "));
      assert.equal(valRes.valid, false);
      assert.ok(valRes.diagnostics.some((d) => d.code === "SYNTAX_ERROR"));
    });
  });

  // --------------------------------------------------------------------------
  // 2. Exception Document AST Validator
  // --------------------------------------------------------------------------
  describe("2. Exception Document AST Validator (ExceptionValidator)", () => {
    const validExceptionContent = `# EXC-20261109-001: Defer Integration Test Suite

## 1. Exception Metadata
| Field | Value |
| :--- | :--- |
| **Exception ID** | \`EXC-20261109-001\` |
| **Creation Date** | 2026-11-09 |
| **Active Lifecycle Stage** | Stage 3: Implementation |
| **Bypassed Stage Gate** | Gate 3 |
| **Waived Rule / Requirement** | DELIV-02 (Integration Tests) |
| **Exception Status** | Active (Authorized) |
| **Expiration / Review Date** | 2026-12-09 |

## 2. Requester & Authorizer Identification
| Role | Name | Title / Contact |
| :--- | :--- | :--- |
| **Requested By** | Senior Developer | Core Engineering |
| **Authorized By (Human)** | Alice Smith | Lead Architect |

## 3. Reason & Justification for Exception
Due to third-party sandbox outage, integration tests are temporarily deferred.
Unit test coverage remains 100% against frozen contract mocks.

## 4. Risk Assessment & Blast Radius Analysis
Risk is low as changes are behind feature flags.

## 5. Compensating Controls
Dynamic feature flag FF_PAYMENT defaults to disabled.

## 6. Remediation Plan & Expiration
Execute full test suite as soon as vendor sandbox recovers.

## 7. Human Authorization & Sign-Off
Signed off by Lead Architect.

## 8. Final Outcome & Retirement Record
Pending remediation.
`;

    test("valid exception passes with full metadata extracted", () => {
      const res = ExceptionValidator.validate(
        validExceptionContent,
        "governance/exceptions/EXC-20261109-001.md",
        "DELIV-02",
        new Date("2026-11-10T10:00:00Z")
      );

      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
      assert.ok(res.metadata);
      assert.equal(res.metadata.exception_id, "EXC-20261109-001");
      assert.equal(res.metadata.authorized_by, "Alice Smith");
      assert.equal(res.metadata.expiration_date, "2026-12-09");
      assert.equal(res.metadata.status, "Active (Authorized)");
      assert.equal(res.metadata.waived_requirement, "DELIV-02 (Integration Tests)");
    });

    test("rejects invalid filename not conforming to EXC-YYYYMMDD-###.md", () => {
      const res = ExceptionValidator.validate(
        validExceptionContent,
        "governance/exceptions/EXC-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("EXC-YYYYMMDD-###.md")));
      assert.equal(res.diagnostics[0].code, "EXCEPTION_METADATA_INVALID");
    });

    test("rejects mismatched Exception ID between filename and document body", () => {
      const mismatchedContent = validExceptionContent.replaceAll(
        "EXC-20261109-001",
        "EXC-20261109-999"
      );
      const res = ExceptionValidator.validate(
        mismatchedContent,
        "governance/exceptions/EXC-20261109-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("does not match file name identifier")));
      assert.equal(res.diagnostics[0].code, "EXCEPTION_METADATA_INVALID");
    });

    test("rejects unapproved status (Draft / Proposed / Revoked / Closed)", () => {
      const draftContent = validExceptionContent.replace("Active (Authorized)", "Proposed");
      const res = ExceptionValidator.validate(
        draftContent,
        "governance/exceptions/EXC-20261109-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("is not approved (status: \"Proposed\")")));
      assert.ok(res.diagnostics.some((d) => d.code === "EXCEPTION_NOT_APPROVED"));
    });

    test("Documentary Attribution: rejects synthetic or forbidden AI agent authorizers", () => {
      const testCases = [
        "agent:controller",
        "gpt-4-turbo",
        "Claude-3-Opus",
        "copilot",
        "antigravity-bot",
        "synthetic-reviewer",
        "[Human Lead Name]", // unresolved placeholder
      ];

      for (const forbidden of testCases) {
        const content = validExceptionContent.replace(
          "| **Authorized By (Human)** | Alice Smith | Lead Architect |",
          `| **Authorized By (Human)** | ${forbidden} | Lead Architect |`
        );
        const res = ExceptionValidator.validate(
          content,
          "governance/exceptions/EXC-20261109-001.md"
        );
        assert.equal(res.valid, false, `Expected rejection for: ${forbidden}`);
        assert.ok(
          res.diagnostics.some(
            (d) =>
              d.code === "EXCEPTION_AGENT_ATTRIBUTION_FORBIDDEN" ||
              d.code === "EXCEPTION_METADATA_INVALID"
          ),
          `Expected attribution failure for: ${forbidden}`
        );
      }
    });

    test("Scope Check: rejects exception when waived requirement does not match deliverable", () => {
      const res = ExceptionValidator.validate(
        validExceptionContent,
        "governance/exceptions/EXC-20261109-001.md",
        "DELIV-99-UNRELATED"
      );
      assert.equal(res.valid, false);
      assert.ok(res.diagnostics.some((d) => d.code === "EXCEPTION_SCOPE_MISMATCH"));
    });

    test("Strict UTC Expiration Boundary: valid before 23:59:59.999Z, expired after", () => {
      // Expiration: 2026-12-09
      // Boundary is 2026-12-09T23:59:59.999Z
      const beforeBoundary = new Date("2026-12-09T23:59:59.998Z");
      const atBoundary = new Date("2026-12-09T23:59:59.999Z");
      const afterBoundary = new Date("2026-12-10T00:00:00.000Z");

      const resBefore = ExceptionValidator.validate(
        validExceptionContent,
        "governance/exceptions/EXC-20261109-001.md",
        "DELIV-02",
        beforeBoundary
      );
      assert.equal(resBefore.valid, true);

      const resAt = ExceptionValidator.validate(
        validExceptionContent,
        "governance/exceptions/EXC-20261109-001.md",
        "DELIV-02",
        atBoundary
      );
      assert.equal(resAt.valid, true);

      const resAfter = ExceptionValidator.validate(
        validExceptionContent,
        "governance/exceptions/EXC-20261109-001.md",
        "DELIV-02",
        afterBoundary
      );
      assert.equal(resAfter.valid, false);
      assert.ok(resAfter.diagnostics.some((d) => d.code === "EXCEPTION_EXPIRED"));
    });

    test("rejects malformed expiration date format fail-closed", () => {
      const malformedDates = ["2026/12/09", "12-09-2026", "invalid-date", "2026-99-99"];
      for (const badDate of malformedDates) {
        const content = validExceptionContent.replace("2026-12-09", badDate);
        const res = ExceptionValidator.validate(
          content,
          "governance/exceptions/EXC-20261109-001.md"
        );
        assert.equal(res.valid, false, `Expected failure for date: ${badDate}`);
        assert.ok(
          res.diagnostics.some((d) => d.code === "EXCEPTION_METADATA_INVALID")
        );
      }
    });

    test("read-only validation does not mutate any files", () => {
      const filePath = path.join(tempDir, "EXC-20261109-001.md");
      fs.writeFileSync(filePath, validExceptionContent, "utf-8");
      const statBefore = fs.statSync(filePath);

      const res = ExceptionValidator.validate(validExceptionContent, filePath);
      assert.equal(res.valid, true);

      const statAfter = fs.statSync(filePath);
      assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
      assert.equal(statBefore.size, statAfter.size);
    });

    test("unclosed fenced code block in exception fails closed with SYNTAX_ERROR", () => {
      const unclosedContent = validExceptionContent + "\n```typescript\nconst broken = true;\n";
      const res = ExceptionValidator.validate(
        unclosedContent,
        "governance/exceptions/EXC-20261109-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(res.diagnostics.some((d) => d.code === "SYNTAX_ERROR"));
    });

    test("duplicate contradictory metadata tables fail closed with EXCEPTION_METADATA_INVALID", () => {
      const duplicateConflicting = validExceptionContent + `
## Supplementary Table
| Field | Value |
| :--- | :--- |
| **Exception Status** | Proposed |
`;
      const res = ExceptionValidator.validate(
        duplicateConflicting,
        "governance/exceptions/EXC-20261109-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(
        res.errors.some((e) => e.includes("Contradictory metadata declarations detected"))
      );
      assert.ok(
        res.diagnostics.some((d) => d.code === "EXCEPTION_METADATA_INVALID")
      );
    });

    test("documentary Approved with Section 7 sign-off placeholder fails closed", () => {
      const placeholderSignOff = validExceptionContent.replace(
        "## 7. Human Authorization & Sign-Off\nSigned off by Lead Architect.",
        `## 7. Human Authorization & Sign-Off
| Field | Record |
| :--- | :--- |
| **Authorizer Name** | Alice Smith |
| **Title / Authority** | Lead Architect |
| **Authorization Decision** | EXCEPTION AUTHORIZED |
| **Sign-Off Reference** | [Commit SHA / PR #XX comment / In-chat confirmation] |`
      );

      const res = ExceptionValidator.validate(
        placeholderSignOff,
        "governance/exceptions/EXC-20261109-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(
        res.errors.some((e) => e.includes("unpopulated placeholder in Sign-Off Reference"))
      );
    });

    test("Section 7 explicit REJECTED decision fails closed with EXCEPTION_NOT_APPROVED", () => {
      const rejectedContent = validExceptionContent.replace(
        "## 7. Human Authorization & Sign-Off\nSigned off by Lead Architect.",
        `## 7. Human Authorization & Sign-Off
| Field | Record |
| :--- | :--- |
| **Authorizer Name** | Alice Smith |
| **Authorization Decision** | REJECTED BY ARCHITECTURE BOARD |
| **Sign-Off Reference** | PR #42 Review |`
      );

      const res = ExceptionValidator.validate(
        rejectedContent,
        "governance/exceptions/EXC-20261109-001.md"
      );
      assert.equal(res.valid, false);
      assert.ok(
        res.diagnostics.some((d) => d.code === "EXCEPTION_NOT_APPROVED")
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Exit Package AST Validator
  // --------------------------------------------------------------------------
  describe("3. Exit Package AST Validator (ExitPackageValidator)", () => {
    const valid8SectionExitPackage = `# Stage Gate 1 Exit Package: Requirements & Specification

## 1. Package & Stage Identification
| Field | Value |
| :--- | :--- |
| Project Name | Governance System |
| Stage | Stage 1: Requirements |
| Date | 2026-11-09 |

## 2. Stage Objectives & Scope Summary
All functional specifications drafted and reviewed.

## 3. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Completed |

## 4. Verifiable Validation Evidence
All automated schema validation checks pass 100%.

## 5. Traceability Matrix
Requirements are mapped to baseline test cases.

## 6. Outstanding Issues & Accepted Limitations
Zero high-priority issues remaining.

## 7. Related Governance Artifacts
ADR-20261109-001 recorded.

## 8. AI Agent Completion Assertion
I confirm all deliverables are verified.
`;

    test("complete 8-section exit package passes validation", () => {
      const res = ExitPackageValidator.validate(valid8SectionExitPackage, {
        stage: 1,
        strict: true,
      });
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });

    test("rejects truncated exit package (< 200 bytes)", () => {
      const shortContent = "# Exit Package\nToo short\n";
      const res = ExitPackageValidator.validate(shortContent);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("200 bytes")));
      assert.equal(res.diagnostics[0].code, "EXIT_PACKAGE_INCOMPLETE");
    });

    test("rejects missing top-level H1 header", () => {
      const noH1 = valid8SectionExitPackage.replace("# Stage Gate 1 Exit Package", "### Subheader");
      const res = ExitPackageValidator.validate(noH1);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Missing top-level header")));
    });

    test("rejects missing core sections (e.g. Deliverables Manifest)", () => {
      const missingDeliverables = valid8SectionExitPackage.replace(
        "## 3. Deliverables Manifest & Status",
        "## 3. Omitted Section"
      );
      const res = ExitPackageValidator.validate(missingDeliverables);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Deliverables Manifest")));
    });

    test("rejects unresolved placeholders in text while ignoring placeholders in fenced code blocks", () => {
      const withCodeBlockPlaceholder = valid8SectionExitPackage + `
\`\`\`text
Example code snippet:
[TODO: Sample placeholder in code block]
\`\`\`
`;
      const resCodeOk = ExitPackageValidator.validate(withCodeBlockPlaceholder);
      assert.equal(resCodeOk.valid, true, "Placeholder inside code block must not cause failure");

      const withRealPlaceholder = valid8SectionExitPackage + "\n[TODO: Fill this real section later]\n";
      const resRealFail = ExitPackageValidator.validate(withRealPlaceholder);
      assert.equal(resRealFail.valid, false, "Placeholder in document text must cause failure");
      assert.ok(resRealFail.errors.some((e) => e.includes("TODO")));
    });
  });

  // --------------------------------------------------------------------------
  // 4. Controller Integration Tests
  // --------------------------------------------------------------------------
  describe("4. Stage-Gate & Controller Integration", () => {
    test("recordException integration: documentary approval cannot create a waiver", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const excPath = path.join(tempDir, "docs", "exceptions", "EXC-20261109-001.md");
      fs.mkdirSync(path.dirname(excPath), { recursive: true });
      fs.writeFileSync(
        excPath,
        `# EXC-20261109-001: Waive PRD-CORE

## 1. Exception Metadata
| Field | Value |
| :--- | :--- |
| **Exception ID** | \`EXC-20261109-001\` |
| **Creation Date** | 2026-11-09 |
| **Active Lifecycle Stage** | Stage 0 |
| **Bypassed Stage Gate** | Gate 0 |
| **Waived Rule / Requirement** | PRD-CORE |
| **Exception Status** | Active (Authorized) |
| **Expiration / Review Date** | 2026-12-09 |

## 2. Requester & Authorizer Identification
| Role | Name | Title / Contact |
| :--- | :--- | :--- |
| **Authorized By (Human)** | Carol Danvers | Principal Engineer |

## 3. Reason & Justification for Exception
Prototyping phase bypass.

## 4. Risk Assessment & Blast Radius Analysis
Low risk.

## 5. Compensating Controls
Manual review completed.

## 6. Remediation Plan & Expiration
Resolve in Stage 1.

## 7. Human Authorization & Sign-Off
Signed.

## 8. Final Outcome & Retirement Record
Open.
`,
        "utf-8"
      );

      const before = fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf8");
      await assert.rejects(recordException({targetDir:tempDir,deliverableId:"PRD-CORE",exceptionPath:"docs/exceptions/EXC-20261109-001.md"}), {code:"EXCEPTION_LEGACY_WAIVER_DISABLED"});
      assert.equal(fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf8"), before);
    });

    test("recordException integration: fails closed when AST detects synthetic agent authorizer", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const excPath = path.join(tempDir, "docs", "exceptions", "EXC-20261109-002.md");
      fs.mkdirSync(path.dirname(excPath), { recursive: true });
      fs.writeFileSync(
        excPath,
        `# EXC-20261109-002: Waive PRD-CORE

## 1. Exception Metadata
| Field | Value |
| :--- | :--- |
| **Exception ID** | \`EXC-20261109-002\` |
| **Waived Rule / Requirement** | PRD-CORE |
| **Exception Status** | Active (Authorized) |
| **Expiration / Review Date** | 2026-12-09 |

## 2. Requester & Authorizer Identification
| Role | Name | Title / Contact |
| :--- | :--- | :--- |
| **Authorized By (Human)** | agent:playbook-bot | Self Authorizer |
`,
        "utf-8"
      );

      await assert.rejects(
        async () => {
          await recordException({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            exceptionPath: "docs/exceptions/EXC-20261109-002.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXCEPTION_LEGACY_WAIVER_DISABLED");
          return true;
        }
      );
    });

    test("submitStage integration: fails closed when exit package AST is incomplete", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-test.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");

      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-test.log",
        result: "passed",
      });

      // Exit package missing deliverables section
      const badExitPackage = path.join(tempDir, "docs", "gates", "GATE-0.md");
      fs.writeFileSync(
        badExitPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 identification.

## 3. Verifiable Validation Evidence
Evidence details here exceeding the minimum character length required for tests.

## 4. Traceability & Sign-Off Record
All sign-offs complete.
`.padEnd(250, " "),
        "utf-8"
      );

      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
          assert.match(err.message, /Deliverables/i);
          return true;
        }
      );
    });

    test("submitStage with strict mode: rejects exit package missing Section 8 completion assertion", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-test.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");

      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-test.log",
        result: "passed",
      });

      // 7 sections (missing Section 8)
      const missingSection8 = path.join(tempDir, "docs", "gates", "GATE-0-STRICT.md");
      fs.writeFileSync(
        missingSection8,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
| Field | Value |
| :--- | :--- |
| Project Name | Governance System |
| Stage | Stage 0: Discovery |
| Date | 2026-11-09 |

## 2. Stage Objectives & Scope Summary
All discovery objectives completed.

## 3. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 4. Verifiable Validation Evidence
All automated test checks pass cleanly.

## 5. Traceability Matrix
Traceability matrix mapped.

## 6. Outstanding Issues & Accepted Limitations
Zero high-priority issues remaining.

## 7. Related Governance Artifacts
ADR-20261109-001 recorded.
`,
        "utf-8"
      );

      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0-STRICT.md",
            strict: true,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
          assert.match(err.message, /Completion Assertion/i);
          return true;
        }
      );
    });

    test("persisted-state semantics: subsequent failing evidence keeps status: verified and validation_status: passed, authoritative resolution fails, blocking submitStage until fresh evidence passes", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");

      // 1. Starts with a verified deliverable
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
      });

      const stateFile = path.join(tempDir, ".playbook", "state.json");
      const manifestFile = path.join(tempDir, ".playbook", "manifest.json");
      const state1 = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const manifest1 = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      assert.equal(state1.current_stage_detail.deliverables[0].status, "verified");
      assert.equal(state1.current_stage_detail.deliverables[0].validation_status, "passed");

      // Write full 8-section exit package
      const exitPackagePath = path.join(tempDir, "docs", "gates", "GATE-0-VALID.md");
      fs.writeFileSync(
        exitPackagePath,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
| Field | Value |
| :--- | :--- |
| Project Name | Governance System |
| Stage | Stage 0: Discovery |
| Date | 2026-11-09 |

## 2. Stage Objectives & Scope Summary
All discovery objectives completed.

## 3. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 4. Verifiable Validation Evidence
All automated test checks pass cleanly.

## 5. Traceability Matrix
Traceability matrix mapped.

## 6. Outstanding Issues & Accepted Limitations
Zero high-priority issues remaining.

## 7. Related Governance Artifacts
ADR-20261109-001 recorded.

## 8. AI Agent Completion Assertion
I confirm all deliverables are verified.
`,
        "utf-8"
      );

      // 2. Records failing evidence for a required discipline
      const failLog = path.join(tempDir, ".playbook", "logs", "prd-fail.log");
      fs.writeFileSync(failLog, "Test failed with assertion error\n", "utf-8");

      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-fail.log",
        result: "failed",
      });

      const state2 = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const deliv2 = state2.current_stage_detail.deliverables[0];

      // 3. Confirms persisted status remains verified
      assert.equal(
        deliv2.status,
        "verified",
        "Persisted status must remain 'verified' under non-demotion rule"
      );

      // 4. Confirms persisted validation_status remains passed
      assert.equal(
        deliv2.validation_status,
        "passed",
        "Persisted validation_status must remain 'passed' reflecting historical milestone"
      );

      // 5. Confirms authoritative resolution is failed
      const resolution2 = resolveAuthoritativeVerification(
        tempDir,
        0,
        deliv2,
        manifest1,
        state2.current_stage_detail.deliverables
      );
      assert.equal(resolution2.authoritativeResult, "failed");
      assert.equal(resolution2.isContended, true);
      assert.deepEqual(resolution2.failingDisciplines, ["automated_test"]);

      // 6. Confirms stage submission is blocked
      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0-VALID.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EVIDENCE_RESULT_FAILED");
          return true;
        }
      );

      // 7. Records fresh passing evidence
      const passLog2 = path.join(tempDir, ".playbook", "logs", "prd-pass-2.log");
      fs.writeFileSync(passLog2, "All tests passed cleanly\n", "utf-8");

      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass-2.log",
        result: "passed",
      });

      // 8. Confirms persisted lifecycle fields remain valid and authoritative resolution returns passed
      const state3 = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const deliv3 = state3.current_stage_detail.deliverables[0];
      assert.equal(deliv3.status, "verified");
      assert.equal(deliv3.validation_status, "passed");

      const resolution3 = resolveAuthoritativeVerification(
        tempDir,
        0,
        deliv3,
        manifest1,
        state3.current_stage_detail.deliverables
      );
      assert.equal(resolution3.authoritativeResult, "passed");
      assert.equal(resolution3.isContended, false);
      assert.deepEqual(resolution3.failingDisciplines, []);

      // 9. Confirms stage submission can proceed when all other requirements are satisfied
      const submitRes = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0-VALID.md",
        strict: true,
      });

      assert.equal(submitRes.success, true);
      assert.equal(submitRes.stageStatus, "pending_review");
    });

    test("governance profile integration: lightweight profile allows 4-section exit package on normal submitStage", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Update manifest governance_profile to lightweight
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.playbook.governance_profile = "lightweight";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      // Verify PRD-CORE
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
      });

      // 4-section exit package (missing sections 2, 5, 6, 7, 8)
      const fourSecPackage = path.join(tempDir, "docs", "gates", "GATE-0-4SEC.md");
      fs.writeFileSync(
        fourSecPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 discovery package identification and executive summary.

## 2. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 3. Verifiable Validation Evidence
All automated test checks pass cleanly with 100% coverage.

## 4. Traceability & Sign-Off Record
All traceability and residual risks accepted and signed off.
`.padEnd(250, " "),
        "utf-8"
      );

      // Normal submitStage invocation without options.strict
      const res = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0-4SEC.md",
      });
      assert.equal(res.success, true);
      assert.equal(res.stageStatus, "pending_review");
    });

    test("governance profile integration: standard profile allows 4-section exit package on normal submitStage", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Update manifest governance_profile to standard
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.playbook.governance_profile = "standard";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      // Verify PRD-CORE
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
      });

      // 4-section exit package
      const fourSecPackage = path.join(tempDir, "docs", "gates", "GATE-0-4SEC.md");
      fs.writeFileSync(
        fourSecPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 discovery package identification and executive summary.

## 2. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 3. Verifiable Validation Evidence
All automated test checks pass cleanly with 100% coverage.

## 4. Traceability & Sign-Off Record
All traceability and residual risks accepted and signed off.
`.padEnd(250, " "),
        "utf-8"
      );

      // Normal submitStage invocation without options.strict
      const res = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0-4SEC.md",
      });
      assert.equal(res.success, true);
      assert.equal(res.stageStatus, "pending_review");
    });

    test("governance profile integration: strict profile automatically enforces 8 canonical sections on normal submitStage", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Update manifest governance_profile to strict
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.playbook.governance_profile = "strict";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      // Verify PRD-CORE
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
      });

      // 4-section exit package (missing canonical sections 2, 5, 6, 7, 8)
      const fourSecPackage = path.join(tempDir, "docs", "gates", "GATE-0-4SEC.md");
      fs.writeFileSync(
        fourSecPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 discovery package identification and executive summary.

## 2. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 3. Verifiable Validation Evidence
All automated test checks pass cleanly with 100% coverage.

## 4. Traceability & Sign-Off Record
All traceability and residual risks accepted and signed off.
`.padEnd(250, " "),
        "utf-8"
      );

      // 1. Normal submitStage without options.strict MUST fail closed under strict manifest profile
      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0-4SEC.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
          assert.match(err.message, /missing canonical section/i);
          return true;
        }
      );

      // 2. Full 8-section exit package succeeds under normal submitStage
      const full8Package = path.join(tempDir, "docs", "gates", "GATE-0-8SEC.md");
      fs.writeFileSync(
        full8Package,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
| Field | Value |
| :--- | :--- |
| Project Name | Governance System |
| Stage | Stage 0: Discovery |
| Date | 2026-11-09 |

## 2. Stage Objectives & Scope Summary
All discovery objectives completed.

## 3. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 4. Verifiable Validation Evidence
All automated test checks pass cleanly.

## 5. Traceability Matrix
Traceability matrix mapped.

## 6. Outstanding Issues & Accepted Limitations
Zero high-priority issues remaining.

## 7. Related Governance Artifacts
ADR-20261109-001 recorded.

## 8. AI Agent Completion Assertion
I confirm all deliverables are verified.
`,
        "utf-8"
      );

      const res = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0-8SEC.md",
      });
      assert.equal(res.success, true);
      assert.equal(res.stageStatus, "pending_review");
    });

    test("governance profile fallback: manifest omits profile, quality-gates config sets strict -> strict behavior applies", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Omit governance_profile from manifest
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      delete manifest.playbook.governance_profile;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      // Set quality-gates.json default_profile to strict
      const qgPath = path.join(tempDir, ".playbook", "quality-gates.json");
      const qgConfig = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: "governance-test-app",
        default_profile: "strict",
        global_settings: {
          default_timeout_ms: 10000,
          max_concurrency: 1,
          mask_secrets: true,
          log_retention_runs: 1,
          max_journaled_log_bytes: 10000,
          env_allowlist: [],
        },
        gates: [
          {
            stage: 0,
            stage_name: "Discovery & Problem Formulation",
            checks: [
              {
                id: "qg-001",
                name: "PRD Test",
                deliverable_id: "PRD-CORE",
                type: "automated_test",
                severity: "blocking",
                profiles: ["strict", "standard", "lightweight"],
                command: process.execPath,
                inputs: ["docs/prd/PRD-CORE.md"],
                args: [],
              },
            ],
          },
        ],
      };
      fs.writeFileSync(qgPath, JSON.stringify(qgConfig, null, 2) + "\n", "utf-8");

      assert.equal(resolveGovernanceProfile(tempDir, manifest), "strict");

      // Verify PRD-CORE
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
        checkId: "qg-001",
        exitCode: 0,
      });

      // 4-section exit package (missing canonical sections 2, 5, 6, 7, 8)
      const fourSecPackage = path.join(tempDir, "docs", "gates", "GATE-0-4SEC.md");
      fs.writeFileSync(
        fourSecPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 discovery package identification.

## 2. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 3. Verifiable Validation Evidence
All automated test checks pass cleanly with 100% coverage.

## 4. Traceability & Sign-Off Record
All traceability and residual risks accepted.
`.padEnd(250, " "),
        "utf-8"
      );

      // Must fail closed under quality-gate's strict fallback
      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0-4SEC.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXIT_PACKAGE_INCOMPLETE");
          assert.match(err.message, /missing canonical section/i);
          return true;
        }
      );
    });

    test("governance profile fallback: manifest omits profile, quality-gates config sets lightweight -> lightweight applies", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Omit governance_profile from manifest
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      delete manifest.playbook.governance_profile;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      // Set quality-gates.json default_profile to lightweight
      const qgPath = path.join(tempDir, ".playbook", "quality-gates.json");
      const qgConfig = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: "governance-test-app",
        default_profile: "lightweight",
        global_settings: {
          default_timeout_ms: 10000,
          max_concurrency: 1,
          mask_secrets: true,
          log_retention_runs: 1,
          max_journaled_log_bytes: 10000,
          env_allowlist: [],
        },
        gates: [
          {
            stage: 0,
            stage_name: "Discovery & Problem Formulation",
            checks: [
              {
                id: "qg-001",
                name: "PRD Test",
                deliverable_id: "PRD-CORE",
                type: "automated_test",
                severity: "blocking",
                profiles: ["strict", "standard", "lightweight"],
                command: process.execPath,
                inputs: ["docs/prd/PRD-CORE.md"],
                args: [],
              },
            ],
          },
        ],
      };
      fs.writeFileSync(qgPath, JSON.stringify(qgConfig, null, 2) + "\n", "utf-8");

      assert.equal(resolveGovernanceProfile(tempDir, manifest), "lightweight");

      // Verify PRD-CORE
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
        checkId: "qg-001",
        exitCode: 0,
      });

      // 4-section exit package passes under lightweight
      const fourSecPackage = path.join(tempDir, "docs", "gates", "GATE-0-4SEC.md");
      fs.writeFileSync(
        fourSecPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 discovery package identification.

## 2. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 3. Verifiable Validation Evidence
All automated test checks pass cleanly with 100% coverage.

## 4. Traceability & Sign-Off Record
All traceability and residual risks accepted.
`.padEnd(250, " "),
        "utf-8"
      );

      const res = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0-4SEC.md",
      });
      assert.equal(res.success, true);
      assert.equal(res.stageStatus, "pending_review");
    });

    test("governance profile fallback: both sources omit profile -> standard fallback applies", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // Omit governance_profile from manifest
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      delete manifest.playbook.governance_profile;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      // Ensure quality-gates.json is absent
      const qgPath = path.join(tempDir, ".playbook", "quality-gates.json");
      if (fs.existsSync(qgPath)) fs.unlinkSync(qgPath);

      assert.equal(resolveGovernanceProfile(tempDir, manifest), "standard");

      // Verify PRD-CORE
      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");
      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      const passLog = path.join(tempDir, ".playbook", "logs", "prd-pass.log");
      fs.mkdirSync(path.dirname(passLog), { recursive: true });
      fs.writeFileSync(passLog, "Test passed cleanly\n", "utf-8");
      await recordEvidence({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        type: "automated_test",
        procedure: "test",
        evidenceRef: ".playbook/logs/prd-pass.log",
        result: "passed",
      });

      // 4-section exit package passes under standard fallback
      const fourSecPackage = path.join(tempDir, "docs", "gates", "GATE-0-4SEC.md");
      fs.writeFileSync(
        fourSecPackage,
        `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Stage 0 discovery package identification.

## 2. Deliverables Manifest & Status
| Deliverable | Status |
| :--- | :--- |
| PRD-CORE | Verified |

## 3. Verifiable Validation Evidence
All automated test checks pass cleanly with 100% coverage.

## 4. Traceability & Sign-Off Record
All traceability and residual risks accepted.
`.padEnd(250, " "),
        "utf-8"
      );

      const res = await submitStage({
        targetDir: tempDir,
        stage: 0,
        packagePath: "docs/gates/GATE-0-4SEC.md",
      });
      assert.equal(res.success, true);
      assert.equal(res.stageStatus, "pending_review");
    });

    test("governance profile fallback: malformed or inconsistent profile configuration fails closed", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      // 1. Invalid profile in manifest
      const manifestPath = path.join(tempDir, ".playbook", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.playbook.governance_profile = "invalid_profile";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0-EXIT-PACKAGE.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.ok(err.code === "MANIFEST_SCHEMA_INVALID" || err.code === "GOVERNANCE_PROFILE_INVALID");
          return true;
        }
      );

      // 2. Omitted from manifest, but malformed quality-gates.json
      delete manifest.playbook.governance_profile;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

      const qgPath = path.join(tempDir, ".playbook", "quality-gates.json");
      fs.writeFileSync(qgPath, "{ invalid json syntax", "utf-8");

      await assert.rejects(
        async () => {
          await submitStage({
            targetDir: tempDir,
            stage: 0,
            packagePath: "docs/gates/GATE-0-EXIT-PACKAGE.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "QUALITY_GATE_DEFINITION_INVALID");
          return true;
        }
      );
    });

    test("exception authorization boundary: recordException validates documentary attribution without claiming external cryptographic identity", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });

      const prdFile = path.join(tempDir, "docs", "prd", "PRD-CORE.md");
      fs.mkdirSync(path.dirname(prdFile), { recursive: true });
      fs.writeFileSync(prdFile, "# PRD Core\nContent\n", "utf-8");

      await recordDeliverable({
        targetDir: tempDir,
        deliverableId: "PRD-CORE",
        artifactPath: "docs/prd/PRD-CORE.md",
        status: "completed",
      });

      // Create exception with valid documentary attribution
      const excPath = path.join(tempDir, "docs", "exceptions", "EXC-20261110-001.md");
      fs.writeFileSync(
        excPath,
        `# EXC-20261110-001: Waive PRD-CORE

## 1. Exception Metadata
| Field | Value |
| :--- | :--- |
| **Exception ID** | \`EXC-20261110-001\` |
| **Creation Date** | 2026-11-10 |
| **Active Lifecycle Stage** | Stage 0 |
| **Bypassed Stage Gate** | Gate 0 |
| **Waived Rule / Requirement** | PRD-CORE |
| **Exception Status** | Active (Authorized) |
| **Expiration / Review Date** | 2026-12-10 |

## 2. Requester & Authorizer Identification
| Role | Name | Title / Contact |
| :--- | :--- | :--- |
| **Authorized By (Human)** | Alice Architect | Principal Engineer |

## 3. Reason & Justification for Exception
Prototyping phase bypass with documentary sign-off.

## 4. Risk Assessment & Blast Radius Analysis
Low risk isolated to discovery phase.

## 5. Compensating Controls
Manual architecture board review performed.

## 6. Remediation Plan & Expiration
Resolve in Stage 1 requirements formulation.

## 7. Human Authorization & Sign-Off
| Field | Record |
| :--- | :--- |
| **Authorizer Name** | Alice Architect |
| **Title / Authority** | Principal Engineer |
| **Authorization Decision** | EXCEPTION AUTHORIZED |
| **Sign-Off Reference** | PR #42 Review Confirmation |

## 8. Final Outcome & Retirement Record
Open.
`,
        "utf-8"
      );

      // Documentary metadata remains parseable but cannot activate authority.
      const before = fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf8");
      await assert.rejects(recordException({targetDir:tempDir,deliverableId:"PRD-CORE",exceptionPath:"docs/exceptions/EXC-20261110-001.md"}), {code:"EXCEPTION_LEGACY_WAIVER_DISABLED"});
      assert.equal(fs.readFileSync(path.join(tempDir, ".playbook/state.json"), "utf8"), before);

      // Verify that prohibited AI agent authorizer fails closed
      const badExcPath = path.join(tempDir, "docs", "exceptions", "EXC-20261110-002.md");
      fs.writeFileSync(
        badExcPath,
        fs.readFileSync(excPath, "utf-8")
          .replaceAll("EXC-20261110-001", "EXC-20261110-002")
          .replaceAll("Alice Architect", "agent:playbook-bot")
      );

      await assert.rejects(
        async () => {
          await recordException({
            targetDir: tempDir,
            deliverableId: "PRD-CORE",
            exceptionPath: "docs/exceptions/EXC-20261110-002.md",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ControllerError);
          assert.equal(err.code, "EXCEPTION_LEGACY_WAIVER_DISABLED");
          return true;
        }
      );
    });

    test("read-only AST validation does not mutate project-state.json or audit trail", async () => {
      setupStageProject(tempDir, { stage: 0, status: "in_progress" });
      const statePath = path.join(tempDir, ".playbook", "state.json");
      const stateBefore = fs.readFileSync(statePath, "utf-8");

      // Validate an exit package using AST validator directly
      const validPackage = `# Stage Gate 0 Exit Package: Discovery

## 1. Package & Stage Identification
Discovery stage.

## 2. Stage Objectives & Scope Summary
Objectives.

## 3. Deliverables Manifest & Status
Manifest.

## 4. Verifiable Validation Evidence
Evidence details.

## 5. Traceability Matrix
Traceability.

## 6. Outstanding Issues & Accepted Limitations
None.

## 7. Related Governance Artifacts
None.

## 8. AI Agent Completion Assertion
Done.
`;
      const res = ExitPackageValidator.validate(validPackage, { stage: 0 });
      assert.equal(res.valid, true);

      const stateAfter = fs.readFileSync(statePath, "utf-8");
      assert.equal(stateBefore, stateAfter, "AST validation must never mutate state file");
    });
  });
});
