import test, { describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  RuleRegistry,
  validateRuleDefinition,
  DefaultRuleExecutionContext,
  FindingAggregator,
  validateFinding,
  sortFindings,
  deduplicateFindings,
  resolveDefaultEnforcement,
  resolveFindingEnforcement,
  LinterEngine,
  LinterError,
  type GovernanceRule,
  type RuleFinding,
  type LinterEngineConfig,
} from "../src/core/linters/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Task 008B.1: Governance Linter Core Engine & Diagnostic Contracts", () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-test-"));
  });

  test.afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Rule Registry
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. RuleRegistry & Definition Validation", () => {
    test("registers valid governance rules successfully", () => {
      const registry = new RuleRegistry();
      const rule: GovernanceRule = {
        id: "RULE-TEST-VALID-01",
        category: "documentation",
        name: "Test Valid Rule",
        description: "Valid test rule description.",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["**/*.md"],
        evaluationMethod: "markdown_ast",
        version: "1.0.0",
        evaluate: () => [],
      };

      registry.register(rule);
      assert.strictEqual(registry.size, 1);
      assert.strictEqual(registry.has("RULE-TEST-VALID-01"), true);
      assert.strictEqual(registry.get("RULE-TEST-VALID-01")?.name, "Test Valid Rule");
    });

    test("rejects invalid rule IDs", () => {
      const registry = new RuleRegistry();
      const invalidIds = ["invalid_id", "rule with spaces", "rule!", "A", "-RULE", "RULE-", ""];

      for (const id of invalidIds) {
        assert.throws(
          () => {
            registry.register({
              id,
              category: "schema",
              name: "Invalid ID Rule",
              description: "Desc",
              severity: "warning",
              defaultEnforcement: "warning",
              targetGlobs: ["*.json"],
              evaluationMethod: "json_schema",
              version: "1.0.0",
              evaluate: () => [],
            });
          },
          (err: any) => err instanceof LinterError && err.code === "INVALID_RULE_ID",
          `Should have rejected invalid rule ID: ${id}`
        );
      }
    });

    test("rejects duplicate rule IDs with DUPLICATE_RULE_ID", () => {
      const registry = new RuleRegistry();
      const rule1: GovernanceRule = {
        id: "RULE-DUP-TEST",
        category: "invariant",
        name: "First Instance",
        description: "Desc 1",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*.md"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [],
      };
      const rule2: GovernanceRule = {
        id: "RULE-DUP-TEST",
        category: "invariant",
        name: "Second Instance",
        description: "Desc 2",
        severity: "warning",
        defaultEnforcement: "warning",
        targetGlobs: ["*.md"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [],
      };

      registry.register(rule1);
      assert.throws(
        () => registry.register(rule2),
        (err: any) => err instanceof LinterError && err.code === "DUPLICATE_RULE_ID"
      );
    });

    test("rejects incomplete or malformed rule definitions", () => {
      const registry = new RuleRegistry();
      const baseValid: GovernanceRule = {
        id: "RULE-DEF-TEST",
        category: "documentation",
        name: "Def Test",
        description: "Desc",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*.md"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [],
      };

      // Missing targetGlobs
      assert.throws(
        () => registry.register({ ...baseValid, targetGlobs: [] }),
        (err: any) => err instanceof LinterError && err.code === "INVALID_RULE_DEFINITION"
      );

      // Missing evaluate function
      assert.throws(
        () => registry.register({ ...baseValid, evaluate: null as any }),
        (err: any) => err instanceof LinterError && err.code === "INVALID_RULE_DEFINITION"
      );

      // Invalid severity
      assert.throws(
        () => registry.register({ ...baseValid, severity: "critical" as any }),
        (err: any) => err instanceof LinterError && err.code === "INVALID_SEVERITY"
      );
    });

    test("getOrThrow throws RULE_NOT_FOUND on missing rule", () => {
      const registry = new RuleRegistry();
      assert.throws(
        () => registry.getOrThrow("RULE-NONEXISTENT"),
        (err: any) => err instanceof LinterError && err.code === "RULE_NOT_FOUND"
      );
    });

    test("list() returns rules in deterministic alphabetical order by ID", () => {
      const registry = new RuleRegistry();
      const ids = ["RULE-ZULU", "RULE-ALPHA", "RULE-MIKE", "RULE-BRAVO"];
      for (const id of ids) {
        registry.register({
          id,
          category: "stack",
          name: id,
          description: "Desc",
          severity: "info",
          defaultEnforcement: "advisory",
          targetGlobs: ["*"],
          evaluationMethod: "structural",
          version: "1.0.0",
          evaluate: () => [],
        });
      }

      const list = registry.list();
      assert.deepStrictEqual(
        list.map((r) => r.id),
        ["RULE-ALPHA", "RULE-BRAVO", "RULE-MIKE", "RULE-ZULU"]
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Severity and Enforcement Semantics
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Severity & Enforcement Semantics", () => {
    test("resolves default operational enforcement deterministically", () => {
      assert.strictEqual(resolveDefaultEnforcement("error"), "blocking");
      assert.strictEqual(resolveDefaultEnforcement("warning"), "warning");
      assert.strictEqual(resolveDefaultEnforcement("info"), "advisory");
    });

    test("prohibits downgrading 'error' severity to non-blocking", () => {
      assert.throws(
        () => resolveFindingEnforcement("error", "warning"),
        (err: any) => err instanceof LinterError && err.code === "INVALID_ENFORCEMENT"
      );
      assert.throws(
        () => resolveFindingEnforcement("error", "advisory"),
        (err: any) => err instanceof LinterError && err.code === "INVALID_ENFORCEMENT"
      );
    });

    test("promotes warning to blocking in strict mode", () => {
      const normal = resolveFindingEnforcement("warning", undefined, false);
      assert.strictEqual(normal.enforcement, "warning");
      assert.strictEqual(normal.blocksOperation, false);

      const strict = resolveFindingEnforcement("warning", undefined, true);
      assert.strictEqual(strict.enforcement, "blocking");
      assert.strictEqual(strict.blocksOperation, true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Finding Validation & Deterministic Sorting
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Finding Validation & Deterministic Sorting", () => {
    test("validates finding integrity and rejects malformed fields", () => {
      // Valid finding
      const valid = validateFinding(
        {
          ruleId: "RULE-TEST",
          diagnosticCode: "ERR_CODE",
          severity: "error",
          enforcement: "blocking",
          message: "A test message",
          blocksOperation: true,
        },
        "RULE-TEST"
      );
      assert.strictEqual(valid.ruleId, "RULE-TEST");
      assert.strictEqual(valid.diagnosticCode, "ERR_CODE");

      // Rule ID mismatch
      assert.throws(
        () =>
          validateFinding(
            {
              ruleId: "RULE-WRONG",
              diagnosticCode: "CODE",
              severity: "error",
              enforcement: "blocking",
              message: "Msg",
              blocksOperation: true,
            },
            "RULE-TEST"
          ),
        (err: any) => err instanceof LinterError && err.code === "MALFORMED_FINDING"
      );

      // Contradictory blocksOperation
      assert.throws(
        () =>
          validateFinding(
            {
              ruleId: "RULE-TEST",
              diagnosticCode: "CODE",
              severity: "error",
              enforcement: "blocking",
              message: "Msg",
              blocksOperation: false, // Contradicts blocking enforcement
            },
            "RULE-TEST"
          ),
        (err: any) => err instanceof LinterError && err.code === "MALFORMED_FINDING"
      );
    });

    test("sorts findings deterministically by path, line, col, ruleId, diagnosticCode", () => {
      const findings: RuleFinding[] = [
        {
          ruleId: "RULE-B",
          diagnosticCode: "CODE_1",
          severity: "warning",
          enforcement: "warning",
          message: "File b line 10",
          filePath: "src/b.ts",
          line: 10,
          column: 5,
          blocksOperation: false,
        },
        {
          ruleId: "RULE-A",
          diagnosticCode: "CODE_2",
          severity: "error",
          enforcement: "blocking",
          message: "Root level finding",
          filePath: null,
          blocksOperation: true,
        },
        {
          ruleId: "RULE-A",
          diagnosticCode: "CODE_1",
          severity: "warning",
          enforcement: "warning",
          message: "File b line 2",
          filePath: "src/b.ts",
          line: 2,
          column: 1,
          blocksOperation: false,
        },
        {
          ruleId: "RULE-C",
          diagnosticCode: "CODE_1",
          severity: "info",
          enforcement: "advisory",
          message: "File a line 1",
          filePath: "src/a.ts",
          line: 1,
          column: 1,
          blocksOperation: false,
        },
      ];

      const sorted = sortFindings(findings);
      assert.strictEqual(sorted[0].filePath, null); // null paths first
      assert.strictEqual(sorted[1].filePath, "src/a.ts");
      assert.strictEqual(sorted[2].filePath, "src/b.ts");
      assert.strictEqual(sorted[2].line, 2); // line 2 before line 10
      assert.strictEqual(sorted[3].filePath, "src/b.ts");
      assert.strictEqual(sorted[3].line, 10);
    });

    test("deduplicates identical findings deterministically", () => {
      const finding: RuleFinding = {
        ruleId: "RULE-DUP",
        diagnosticCode: "DUP_CODE",
        severity: "error",
        enforcement: "blocking",
        message: "Duplicate violation",
        filePath: "docs/spec.md",
        line: 5,
        column: 1,
        blocksOperation: true,
      };

      const deduplicated = deduplicateFindings([finding, finding, { ...finding }]);
      assert.strictEqual(deduplicated.length, 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Rule Execution Context & Path Safety
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. RuleExecutionContext & Path Safety", () => {
    test("rejects path traversal attempts escaping project root", () => {
      const context = new DefaultRuleExecutionContext(tmpDir);

      const traversalPaths = ["../outside.txt", "../../etc/passwd", "src/../../outside.txt", "....//escape"];
      for (const p of traversalPaths) {
        assert.throws(
          () => context.readFile(p),
          (err: any) => err instanceof LinterError && err.code === "PATH_TRAVERSAL_DETECTED",
          `Should have blocked path traversal: ${p}`
        );
      }
    });

    test("rejects absolute and drive-qualified paths", () => {
      const context = new DefaultRuleExecutionContext(tmpDir);

      assert.throws(
        () => context.readFile("C:\\Windows\\win.ini"),
        (err: any) => err instanceof LinterError && err.code === "PATH_TRAVERSAL_DETECTED"
      );
      assert.throws(
        () => context.readFile("/etc/hosts"),
        (err: any) => err instanceof LinterError && err.code === "PATH_TRAVERSAL_DETECTED"
      );
    });

    test("safely handles oversized files", () => {
      const context = new DefaultRuleExecutionContext(tmpDir, { maxFileSizeBytes: 100 });
      const bigFilePath = path.join(tmpDir, "big.txt");
      fs.writeFileSync(bigFilePath, Buffer.alloc(200, "A"));

      assert.throws(
        () => context.readFile("big.txt"),
        (err: any) => err instanceof LinterError && err.code === "FILE_TOO_LARGE"
      );
    });

    test("safely rejects invalid UTF-8 bytes", () => {
      const context = new DefaultRuleExecutionContext(tmpDir);
      const invalidUtf8Path = path.join(tmpDir, "invalid.txt");
      // Invalid UTF-8 sequence (continuation byte without leading byte)
      fs.writeFileSync(invalidUtf8Path, Buffer.from([0x80, 0x81, 0x82]));

      assert.throws(
        () => context.readFile("invalid.txt"),
        (err: any) => err instanceof LinterError && err.code === "INVALID_UTF8"
      );
    });

    test("strips UTF-8 BOM transparently", () => {
      const context = new DefaultRuleExecutionContext(tmpDir);
      const bomFilePath = path.join(tmpDir, "bom.txt");
      fs.writeFileSync(bomFilePath, "\uFEFFHello World");

      const text = context.readFile("bom.txt");
      assert.strictEqual(text, "Hello World");
    });

    test("listFiles respects globs, exclusions, and file count limits", () => {
      const context = new DefaultRuleExecutionContext(tmpDir, { maxFilesScanned: 5 });
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), "content");
      }
      fs.mkdirSync(path.join(tmpDir, "sub"));
      fs.writeFileSync(path.join(tmpDir, "sub", "doc.md"), "# Header");

      const files = context.listFiles(["**/*.txt"]);
      assert.deepStrictEqual(files, ["file1.txt", "file2.txt", "file3.txt"]);

      // Exceeded files limit
      const tightContext = new DefaultRuleExecutionContext(tmpDir, { maxFilesScanned: 2 });
      assert.throws(
        () => tightContext.listFiles(),
        (err: any) => err instanceof LinterError && err.code === "FILE_COUNT_EXCEEDED"
      );
    });

    test("detects and blocks symlink escapes", () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-test-"));
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "super secret");

      const symlinkPath = path.join(tmpDir, "escape-link.txt");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
      } catch {
        // Symlinks on Windows may require elevated privileges; skip if unpermitted
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }

      const context = new DefaultRuleExecutionContext(tmpDir);
      assert.throws(
        () => context.readFile("escape-link.txt"),
        (err: any) => err instanceof LinterError && err.code === "SYMLINK_ESCAPE_DETECTED"
      );

      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. LinterEngine Execution Lifecycle
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. LinterEngine Execution Lifecycle", () => {
    test("clean execution with no findings produces 'passed' status", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-CLEAN",
        category: "documentation",
        name: "Always Pass",
        description: "Always passes",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [],
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(res.status, "passed");
      assert.strictEqual(res.findings.length, 0);
      assert.strictEqual(res.summary.blocking, 0);
      assert.strictEqual(res.executedRuleCount, 1);
    });

    test("execution with non-blocking warnings produces 'passed' status", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-WARN",
        category: "documentation",
        name: "Warning Rule",
        description: "Emits a warning",
        severity: "warning",
        defaultEnforcement: "warning",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [
          {
            ruleId: "RULE-WARN",
            diagnosticCode: "WARN_CODE",
            severity: "warning",
            enforcement: "warning",
            message: "This is a warning",
            blocksOperation: false,
          },
        ],
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(res.status, "passed");
      assert.strictEqual(res.findings.length, 1);
      assert.strictEqual(res.summary.warnings, 1);
      assert.strictEqual(res.summary.blocking, 0);
    });

    test("strict mode elevates warnings to blocking, producing 'failed' status", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-WARN",
        category: "documentation",
        name: "Warning Rule",
        description: "Emits a warning",
        severity: "warning",
        defaultEnforcement: "warning",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [
          {
            ruleId: "RULE-WARN",
            diagnosticCode: "WARN_CODE",
            severity: "warning",
            enforcement: "warning",
            message: "Warning message",
            blocksOperation: false,
          },
        ],
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir, strict: true });

      assert.strictEqual(res.status, "failed");
      assert.strictEqual(res.findings.length, 1);
      assert.strictEqual(res.findings[0].enforcement, "blocking");
      assert.strictEqual(res.findings[0].blocksOperation, true);
      assert.strictEqual(res.summary.blocking, 1);
    });

    test("blocking errors produce 'failed' status", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-BLOCKING",
        category: "invariant",
        name: "Blocking Rule",
        description: "Emits blocking error",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [
          {
            ruleId: "RULE-BLOCKING",
            diagnosticCode: "ERR_BLOCK",
            severity: "error",
            enforcement: "blocking",
            message: "Blocking failure",
            blocksOperation: true,
          },
        ],
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(res.status, "failed");
      assert.strictEqual(res.summary.blocking, 1);
    });

    test("evaluator exception does not silently pass and records evaluationFailure", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-CRASHING",
        category: "schema",
        name: "Crashing Rule",
        description: "Throws an unhandled exception",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => {
          throw new Error("Unexpected crash in evaluator AST parser");
        },
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir });

      // Must fail closed!
      assert.strictEqual(res.status, "failed");
      assert.strictEqual(res.evaluationFailures.length, 1);
      assert.strictEqual(res.evaluationFailures[0].ruleId, "RULE-CRASHING");
      assert.match(res.evaluationFailures[0].error, /Unexpected crash in evaluator AST parser/);
    });

    test("rule timeout marks execution as 'incomplete'", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-SLOW",
        category: "stack",
        name: "Slow Rule",
        description: "Never completes in time",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => new Promise((resolve) => setTimeout(resolve, 500)),
      });

      const engine = new LinterEngine(registry);
      // Run with tight 50ms timeout
      const res = await engine.run({ projectDir: tmpDir, limits: { timeoutMs: 50 } });

      assert.strictEqual(res.status, "incomplete");
      assert.strictEqual(res.evaluationFailures.length, 1);
      assert.strictEqual(res.evaluationFailures[0].code, "RULE_TIMEOUT");
    });

    test("repeated execution is idempotent producing identical output", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-REPEAT-1",
        category: "documentation",
        name: "Repeat 1",
        description: "Desc",
        severity: "warning",
        defaultEnforcement: "warning",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [
          {
            ruleId: "RULE-REPEAT-1",
            diagnosticCode: "CODE_R1",
            severity: "warning",
            enforcement: "warning",
            message: "Msg 1",
            filePath: "docs/a.md",
            blocksOperation: false,
          },
        ],
      });
      registry.register({
        id: "RULE-REPEAT-2",
        category: "schema",
        name: "Repeat 2",
        description: "Desc",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [
          {
            ruleId: "RULE-REPEAT-2",
            diagnosticCode: "CODE_R2",
            severity: "error",
            enforcement: "blocking",
            message: "Msg 2",
            filePath: "config.json",
            blocksOperation: true,
          },
        ],
      });

      const engine = new LinterEngine(registry);
      const res1 = await engine.run({ projectDir: tmpDir });
      const res2 = await engine.run({ projectDir: tmpDir });

      // Findings must be structurally identical
      assert.strictEqual(res1.status, res2.status);
      assert.strictEqual(res1.findings.length, res2.findings.length);
      assert.deepStrictEqual(res1.findings, res2.findings);
      assert.deepStrictEqual(res1.summary, res2.summary);
    });

    test("filters rules accurately by category and rule ID", async () => {
      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-CAT-DOC",
        category: "documentation",
        name: "Doc Rule",
        description: "Desc",
        severity: "info",
        defaultEnforcement: "advisory",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [],
      });
      registry.register({
        id: "RULE-CAT-SEC",
        category: "security",
        name: "Sec Rule",
        description: "Desc",
        severity: "error",
        defaultEnforcement: "blocking",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: () => [],
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir, categories: ["security"] });

      assert.strictEqual(res.executedRuleCount, 1);
      assert.strictEqual(res.skippedRuleCount, 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Security and Governance Non-Interference
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Governance Non-Interference & Read-Only Guarantees", () => {
    test("linter execution does not mutate project state, manifest, or WAL files", async () => {
      const playbookDir = path.join(tmpDir, ".playbook");
      fs.mkdirSync(playbookDir, { recursive: true });

      const manifestPath = path.join(playbookDir, "manifest.json");
      const statePath = path.join(playbookDir, "state.json");
      const manifestData = JSON.stringify({ project_id: "test", active_lifecycle_stage: 1 }, null, 2);
      const stateData = JSON.stringify({ current_stage: 1, current_stage_detail: {} }, null, 2);

      fs.writeFileSync(manifestPath, manifestData);
      fs.writeFileSync(statePath, stateData);

      const manifestHashBefore = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
      const stateHashBefore = crypto.createHash("sha256").update(fs.readFileSync(statePath)).digest("hex");

      const registry = new RuleRegistry();
      registry.register({
        id: "RULE-AUDIT-TEST",
        category: "invariant",
        name: "Audit Rule",
        description: "Desc",
        severity: "info",
        defaultEnforcement: "advisory",
        targetGlobs: ["*"],
        evaluationMethod: "structural",
        version: "1.0.0",
        evaluate: (ctx) => {
          // Read state safely
          const s = ctx.readFile(".playbook/state.json");
          assert.strictEqual(typeof s, "string");
          return [];
        },
      });

      const engine = new LinterEngine(registry);
      const res = await engine.run({ projectDir: tmpDir });
      assert.strictEqual(res.status, "passed");

      // Verify zero file modifications
      const manifestHashAfter = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
      const stateHashAfter = crypto.createHash("sha256").update(fs.readFileSync(statePath)).digest("hex");

      assert.strictEqual(manifestHashBefore, manifestHashAfter, "Manifest must not be mutated");
      assert.strictEqual(stateHashBefore, stateHashAfter, "State must not be mutated");

      // Verify no locks or journal files were created
      assert.strictEqual(fs.existsSync(path.join(playbookDir, ".lock")), false);
      assert.strictEqual(fs.existsSync(path.join(playbookDir, "journal.json")), false);
    });
  });
});
