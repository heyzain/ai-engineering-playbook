import test, { describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  RuleRegistry,
  LinterEngine,
  DefaultRuleExecutionContext,
  ruleDocRefIntegrity,
  ruleDocAdrIntegrity,
  ruleDocStageBounds,
  ruleDocMandatorySections,
  ruleDocDeprecatedCommands,
  DOCUMENTATION_RULES,
} from "../src/core/linters/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Task 008B.2: Category A Documentation & Reference Consistency Rules", () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-doc-test-"));
  });

  test.afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RULE-DOC-REF-INTEGRITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. RULE-DOC-REF-INTEGRITY", () => {
    test("passes on valid relative markdown links, images, and external URLs", async () => {
      fs.writeFileSync(path.join(tmpDir, "target.md"), "# Target Document");
      fs.mkdirSync(path.join(tmpDir, "sub"));
      fs.writeFileSync(path.join(tmpDir, "sub", "child.md"), "# Child Document");

      const sourceContent = `
# Source Document
- [Target Link](target.md)
- [Target with Anchor](target.md#section-one)
- [Child Link](sub/child.md)
- [Intra-doc Anchor](#local-anchor)
- [External Web Link](https://example.com/spec)
- [External Mailto](mailto:support@example.com)
- [Antigravity Link](conversation://some-convo-id)
![Valid Image](target.md)
\`\`\`markdown
[Code Block Link](nonexistent-ignored.md)
\`\`\`
      `;
      fs.writeFileSync(path.join(tmpDir, "source.md"), sourceContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocRefIntegrity.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0, `Expected 0 findings, got: ${JSON.stringify(findings)}`);
    });

    test("flags broken internal markdown links with BROKEN_DOCUMENT_LINK", async () => {
      const sourceContent = `
# Broken Reference
Check the [Missing Specification](docs/missing-spec.md) for details.
      `;
      fs.writeFileSync(path.join(tmpDir, "broken.md"), sourceContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocRefIntegrity.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "BROKEN_DOCUMENT_LINK");
      assert.strictEqual(findings[0].severity, "error");
      assert.strictEqual(findings[0].blocksOperation, true);
      assert.strictEqual(findings[0].line, 3);
      assert.match(findings[0].message, /missing-spec\.md/);
    });

    test("flags path traversal attempts escaping project root with PATH_TRAVERSAL_LINK", async () => {
      const sourceContent = `
# Traversal Attempt
Refer to [Root Escape](../../outside.md) for secrets.
      `;
      fs.writeFileSync(path.join(tmpDir, "traversal.md"), sourceContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocRefIntegrity.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "PATH_TRAVERSAL_LINK");
      assert.strictEqual(findings[0].severity, "error");
      assert.strictEqual(findings[0].blocksOperation, true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. RULE-DOC-ADR-INTEGRITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. RULE-DOC-ADR-INTEGRITY", () => {
    test("passes on valid ADR filenames, statuses, and cross-document references", async () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });

      const adr1 = `
# ADR-20261106-001: Adopt Modular Linters

## 1. ADR Metadata
| Field | Value |
| :--- | :--- |
| **ADR ID** | \`ADR-20261106-001\` |
| **Status** | \`Accepted\` |
| **Date** | 2026-11-06 |
      `;
      fs.writeFileSync(path.join(adrDir, "ADR-20261106-001-adopt-modular-linters.md"), adr1);

      // Reference ADR-20261106-001 in README.md
      fs.writeFileSync(
        path.join(tmpDir, "README.md"),
        "# System\nDecisions governed by ADR-20261106-001."
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocAdrIntegrity.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0, `Expected 0 findings, got: ${JSON.stringify(findings)}`);
    });

    test("flags invalid ADR filename convention with INVALID_ADR_FILENAME", async () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });

      fs.writeFileSync(
        path.join(adrDir, "bad-name.md"),
        "# ADR\n**Status** | Accepted"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocAdrIntegrity.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "INVALID_ADR_FILENAME");
      assert.strictEqual(findings[0].severity, "error");
    });

    test("flags duplicate ADR identifiers with DUPLICATE_ADR_ID", async () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });

      const adrContent = "# Title\n**Status** | Accepted";
      fs.writeFileSync(path.join(adrDir, "ADR-20261106-001-first.md"), adrContent);
      fs.writeFileSync(path.join(adrDir, "ADR-20261106-001-second.md"), adrContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocAdrIntegrity.evaluate(context) || []) as any[];

      const dupFinding = findings.find((f) => f.diagnosticCode === "DUPLICATE_ADR_ID");
      assert.ok(dupFinding, "Expected DUPLICATE_ADR_ID finding");
      assert.strictEqual(dupFinding.severity, "error");
    });

    test("flags invalid ADR status with INVALID_ADR_STATUS", async () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });

      const adrContent = `
# ADR-20261106-001: Test Status
| Field | Value |
| :--- | :--- |
| **Status** | \`Finished\` |
      `;
      fs.writeFileSync(path.join(adrDir, "ADR-20261106-001-test.md"), adrContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocAdrIntegrity.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "INVALID_ADR_STATUS");
      assert.strictEqual(findings[0].severity, "error");
    });

    test("flags unresolved ADR references with UNRESOLVED_ADR_REFERENCE", async () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });

      // Valid ADR exists: ADR-20261106-001
      fs.writeFileSync(
        path.join(adrDir, "ADR-20261106-001-test.md"),
        "# Title\n**Status** | `Accepted`"
      );

      // Document references non-existent ADR-20261199-999
      fs.writeFileSync(
        path.join(tmpDir, "spec.md"),
        "# Spec\nRefer to decision ADR-20261199-999 for details."
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocAdrIntegrity.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "UNRESOLVED_ADR_REFERENCE");
      assert.strictEqual(findings[0].severity, "error");
      assert.strictEqual(findings[0].filePath, "spec.md");
      assert.strictEqual(findings[0].line, 2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RULE-DOC-STAGE-BOUNDS
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. RULE-DOC-STAGE-BOUNDS", () => {
    test("passes on canonical stage references (Stage 0 to Stage 6) and false-positive numbers", async () => {
      const doc = `
# Engineering Guide
- Stage 0: Discovery
- Stage 1: Requirements
- Stage 2: Architecture
- Stage 3: Implementation
- Stage 4: Unit Verification
- Stage 5: Integration
- Stage 6: Deployment & Closure
- Date: 2026-11-07
- Version: Node.js 22.13.0
- Issue: Task 007
- Rule: Section 7 of constitution
- Explicit prohibition: Advancing to a non-existent Stage 7 is strictly prohibited.
- Negative test: Stage 8 is forbidden.
      `;
      fs.writeFileSync(path.join(tmpDir, "guide.md"), doc);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocStageBounds.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0, `Expected 0 findings, got: ${JSON.stringify(findings)}`);
    });

    test("flags out-of-bounds stage reference with INVALID_STAGE_BOUNDS", async () => {
      const doc = `
# Lifecycle Roadmap
The post-deployment work begins in Stage 7 and continues through Stage 8.
      `;
      fs.writeFileSync(path.join(tmpDir, "roadmap.md"), doc);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocStageBounds.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 2);
      assert.strictEqual(findings[0].diagnosticCode, "INVALID_STAGE_BOUNDS");
      assert.strictEqual(findings[0].actual, "Stage 7");
      assert.strictEqual(findings[1].actual, "Stage 8");
      assert.strictEqual(findings[0].severity, "error");
      assert.strictEqual(findings[0].blocksOperation, true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RULE-DOC-MANDATORY-SECTIONS
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. RULE-DOC-MANDATORY-SECTIONS", () => {
    test("passes on PRD and ADR files with all mandatory heading sections", async () => {
      const prdDir = path.join(tmpDir, "docs", "prd");
      fs.mkdirSync(prdDir, { recursive: true });

      const prdContent = `
# Product Requirements Document
## 1. Document Metadata
## 2. Problem Statement
## 3. Target Users & Personas
## 4. Scope Boundaries
## 5. Functional Requirements
## 6. Acceptance Criteria
      `;
      fs.writeFileSync(path.join(prdDir, "PRD-20261106-core.md"), prdContent);

      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      const adrContent = `
# ADR
## 1. ADR Metadata
## 2. Context and Problem Statement
## 3. Decision Drivers
## 4. Considered Options
## 5. Decision Outcome
## 6. Consequences & Trade-Offs
      `;
      fs.writeFileSync(path.join(adrDir, "ADR-20261106-001.md"), adrContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocMandatorySections.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0, `Expected 0 findings, got: ${JSON.stringify(findings)}`);
    });

    test("flags missing mandatory section in PRD with MISSING_MANDATORY_SECTION", async () => {
      const prdDir = path.join(tmpDir, "docs", "prd");
      fs.mkdirSync(prdDir, { recursive: true });

      // Omit Acceptance Criteria
      const incompletePrd = `
# PRD
## 1. Document Metadata
## 2. Problem Statement
## 3. Target Users & Personas
## 4. Scope Boundaries
## 5. Functional Requirements
      `;
      fs.writeFileSync(path.join(prdDir, "PRD-incomplete.md"), incompletePrd);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocMandatorySections.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].diagnosticCode, "MISSING_MANDATORY_SECTION");
      assert.strictEqual(findings[0].severity, "warning");
      assert.strictEqual(findings[0].blocksOperation, false);
      assert.match(findings[0].message, /Acceptance Criteria/);
    });

    test("does not apply PRD requirements to unrelated documents or root README", async () => {
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Root Readme\nJust a normal readme.");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocMandatorySections.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. RULE-DOC-DEPRECATED-COMMANDS
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. RULE-DOC-DEPRECATED-COMMANDS", () => {
    test("passes on canonical command usage and explanatory deprecation references", async () => {
      const doc = `
# Instructions
Run quality gates:
\`\`\`bash
playbook gate run --stage 4
playbook hook install
playbook stack compose
playbook inspect
\`\`\`

Note: Use \`playbook gate run\` instead of \`playbook run\`.
Historical: \`playbook test\` is deprecated and replaced by \`playbook gate run\`.
      `;
      fs.writeFileSync(path.join(tmpDir, "workflow.md"), doc);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocDeprecatedCommands.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0, `Expected 0 findings, got: ${JSON.stringify(findings)}`);
    });

    test("flags deprecated CLI command in operational instructions with DEPRECATED_CLI_COMMAND", async () => {
      const doc = `
# Developer Runbook
To execute gates, run:
\`playbook run\`
To check hook status, run:
\`playbook hooks status\`
      `;
      fs.writeFileSync(path.join(tmpDir, "runbook.md"), doc);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocDeprecatedCommands.evaluate(context) || []) as any[];

      assert.strictEqual(findings.length, 2);
      assert.strictEqual(findings[0].diagnosticCode, "DEPRECATED_CLI_COMMAND");
      assert.strictEqual(findings[0].severity, "warning");
      assert.strictEqual(findings[0].blocksOperation, false);
      assert.strictEqual(findings[0].actual, "playbook run");
      assert.strictEqual(findings[1].actual, "playbook hooks");
    });

    test("exempts historical ADRs under docs/adr/ from deprecated command checks", async () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });

      const adrContent = `
# ADR
Historically we ran \`playbook run\`.
      `;
      fs.writeFileSync(path.join(adrDir, "ADR-20261101-001.md"), adrContent);

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = (await ruleDocDeprecatedCommands.evaluate(context)) || [];

      assert.strictEqual(findings.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Engine Integration with Category A Production Rules
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Engine Integration with Category A Rules", () => {
    test("runs all 5 Category A rules via LinterEngine producing canonical results", async () => {
      const registry = new RuleRegistry();
      for (const rule of DOCUMENTATION_RULES) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 5);

      // Create a valid doc structure
      fs.mkdirSync(path.join(tmpDir, "docs", "adr"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "docs", "adr", "ADR-20261106-001-system.md"),
        `# ADR-20261106-001: System
## 1. ADR Metadata
| Field | Value |
| :--- | :--- |
| **Status** | \`Accepted\` |
## 2. Context and Problem Statement
Context
## 3. Decision Drivers
Drivers
## 4. Considered Options
Options
## 5. Decision Outcome
Decision
## 6. Consequences & Trade-Offs
Consequences
`
      );

      fs.writeFileSync(
        path.join(tmpDir, "README.md"),
        "# Readme\nDocumented under ADR-20261106-001 and [System ADR](docs/adr/ADR-20261106-001-system.md)."
      );

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(res.status, "passed");
      assert.strictEqual(res.executedRuleCount, 5);
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.summary.blocking, 0);
    });

    test("repeated execution produces identical canonical output", async () => {
      const registry = new RuleRegistry();
      for (const rule of DOCUMENTATION_RULES) {
        registry.register(rule);
      }

      // Add a broken link file
      fs.writeFileSync(path.join(tmpDir, "bad.md"), "# Bad\n[Missing](nonexistent.md)");

      const engine = new LinterEngine(registry);
      const res1 = await engine.run({ projectDir: tmpDir });
      const res2 = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(res1.status, "failed");
      assert.strictEqual(res2.status, "failed");
      assert.deepStrictEqual(res1.findings, res2.findings);
      assert.deepStrictEqual(res1.summary, res2.summary);
    });

    test("does not mutate any project files during linting", async () => {
      const docPath = path.join(tmpDir, "untouched.md");
      const docContent = "# Untouched\nJust testing read-only guarantees.";
      fs.writeFileSync(docPath, docContent);
      const hashBefore = crypto.createHash("sha256").update(fs.readFileSync(docPath)).digest("hex");

      const registry = new RuleRegistry();
      for (const rule of DOCUMENTATION_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      await engine.run({ projectDir: tmpDir });

      const hashAfter = crypto.createHash("sha256").update(fs.readFileSync(docPath)).digest("hex");
      assert.strictEqual(hashBefore, hashAfter);
    });
  });
});
