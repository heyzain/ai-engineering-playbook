import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { DefaultRuleExecutionContext } from "../src/core/linters/execution-context.js";
import { RuleRegistry } from "../src/core/linters/rule-registry.js";
import { LinterEngine } from "../src/core/linters/engine.js";
import { StackManager, StackError } from "../src/core/stacks/stack-manager.js";
import {
  ruleStkCanonicalMetadata,
  ruleStkDependencyDag,
  ruleStkPackageOverrides,
  STACK_RULES,
} from "../src/core/linters/rules/stack/index.js";
import {
  DOCUMENTATION_RULES,
  SCHEMA_RULES,
  INVARIANT_RULES,
  ALL_PRODUCTION_RULES,
} from "../src/core/linters/rules/index.js";
import type { RuleFinding } from "../src/core/linters/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupCanonicalStack(
  projectDir: string,
  stackId: string,
  options?: {
    version?: string;
    frameworkTarget?: string;
    description?: string;
    dependencies?: string[];
    packageOverrides?: Record<string, unknown>;
    skipItems?: string[];
    qgDependencies?: string[];
    rifDependencies?: string[];
  }
) {
  const stackBase = path.join(projectDir, "stacks", stackId);
  fs.mkdirSync(stackBase, { recursive: true });

  const skip = new Set(options?.skipItems || []);

  // 1. stack.json
  if (!skip.has("stack.json")) {
    const metadata: Record<string, unknown> = {
      $schema: "https://ai-engineering-playbook.org/schemas/stack-metadata.schema.json",
      id: stackId,
      name: stackId.charAt(0).toUpperCase() + stackId.slice(1),
      version: options?.version ?? "1.0.0",
      description: options?.description ?? `${stackId} technology stack`,
      frameworkTarget: options?.frameworkTarget ?? `${stackId} LTS`,
      dependencies: options?.dependencies ?? [],
    };
    if (options?.packageOverrides) {
      metadata.packageOverrides = options.packageOverrides;
    }
    fs.writeFileSync(path.join(stackBase, "stack.json"), JSON.stringify(metadata, null, 2), "utf-8");
  }

  // 2. spec.md
  if (!skip.has("spec.md")) {
    fs.writeFileSync(
      path.join(stackBase, "spec.md"),
      `# ${stackId} Architectural Specification\n\nNormative rules and directory idioms for ${stackId}.\n`,
      "utf-8"
    );
  }

  // 3. README.md
  if (!skip.has("README.md")) {
    fs.writeFileSync(
      path.join(stackBase, "README.md"),
      `# ${stackId} Stack\n\nAdoption guide and documentation.\n`,
      "utf-8"
    );
  }

  // 4. quality-gates.partial.json
  if (!skip.has("quality-gates.partial.json")) {
    const qg: Record<string, unknown> = {
      stack: stackId,
      version: "1.0.0",
      gates: [
        {
          stage: 4,
          checks: [
            {
              id: `${stackId}-test`,
              name: `${stackId} Test Suite`,
              type: "automated_test",
              deliverable_id: "CODE-IMPL",
              command: "npm",
              args: ["test"],
            },
          ],
        },
      ],
    };
    if (options?.qgDependencies) {
      qg.dependencies = options.qgDependencies;
    }
    fs.writeFileSync(
      path.join(stackBase, "quality-gates.partial.json"),
      JSON.stringify(qg, null, 2),
      "utf-8"
    );
  }

  // 5. rif-patterns.json
  if (!skip.has("rif-patterns.json")) {
    const rif: Record<string, unknown> = {
      stack: stackId,
      version: "1.0.0",
      text_patterns: ["src/**/*.{ts,tsx}"],
      binary_patterns: ["assets/**"],
      exclude_patterns: ["node_modules/**", "dist/**"],
    };
    if (options?.rifDependencies) {
      rif.dependencies = options.rifDependencies;
    }
    fs.writeFileSync(path.join(stackBase, "rif-patterns.json"), JSON.stringify(rif, null, 2), "utf-8");
  }

  // 6. template/
  if (!skip.has("template")) {
    const templateDir = path.join(stackBase, "template");
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, "package.json"),
      JSON.stringify({ name: `app-${stackId}`, version: "0.1.0" }, null, 2),
      "utf-8"
    );
  }
}

describe("Task 008B.5: Category D Technology Stack Governance Rules", () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-stack-test-"));
  });

  test.afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RULE-STK-CANONICAL-METADATA
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. RULE-STK-CANONICAL-METADATA", () => {
    test("passes cleanly on valid canonical stack structure and metadata", async () => {
      setupCanonicalStack(tmpDir, "react-native");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly when project contains no stacks/ directory (agnostic project)", async () => {
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags missing canonical items with MISSING_CANONICAL_STACK_FILE", async () => {
      setupCanonicalStack(tmpDir, "broken-stack", {
        skipItems: ["rif-patterns.json", "template"],
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length >= 2);
      assert.ok(findings.some((f) => f.diagnosticCode === "MISSING_CANONICAL_STACK_FILE" && f.filePath?.includes("rif-patterns.json")));
      assert.ok(findings.some((f) => f.diagnosticCode === "MISSING_CANONICAL_STACK_FILE" && f.filePath?.includes("template")));
      assert.ok(findings.every((f) => f.blocksOperation));
    });

    test("flags template item if created as regular file instead of directory with INCOMPLETE_STACK_STRUCTURE", async () => {
      setupCanonicalStack(tmpDir, "file-template-stack", { skipItems: ["template"] });
      const stackBase = path.join(tmpDir, "stacks", "file-template-stack");
      fs.writeFileSync(path.join(stackBase, "template"), "not a directory", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" && f.message.includes("must be a directory")));
    });

    test("flags malformed JSON in stack.json with INCOMPLETE_STACK_STRUCTURE", async () => {
      setupCanonicalStack(tmpDir, "bad-json-stack", { skipItems: ["stack.json"] });
      const stackBase = path.join(tmpDir, "stacks", "bad-json-stack");
      fs.writeFileSync(path.join(stackBase, "stack.json"), "{ invalid: json", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" && f.message.includes("malformed")));
    });

    test("flags stack.json missing required properties (name, version, etc.)", async () => {
      setupCanonicalStack(tmpDir, "missing-props-stack", { skipItems: ["stack.json"] });
      const stackBase = path.join(tmpDir, "stacks", "missing-props-stack");
      fs.writeFileSync(
        path.join(stackBase, "stack.json"),
        JSON.stringify({ id: "missing-props-stack" }, null, 2),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length >= 4); // missing name, version, frameworkTarget, description
      assert.ok(findings.some((f) => f.message.includes("missing required 'name'")));
      assert.ok(findings.some((f) => f.message.includes("missing required 'frameworkTarget'")));
    });

    test("flags stack.json id mismatch with directory name", async () => {
      setupCanonicalStack(tmpDir, "dir-name-stack", { skipItems: ["stack.json"] });
      const stackBase = path.join(tmpDir, "stacks", "dir-name-stack");
      fs.writeFileSync(
        path.join(stackBase, "stack.json"),
        JSON.stringify(
          {
            id: "different-id",
            name: "Mismatched",
            version: "1.0.0",
            frameworkTarget: "Target",
            description: "Desc",
          },
          null,
          2
        ),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" && f.message.includes("does not match parent directory")));
    });

    test("flags non-kebab-case stack.json id", async () => {
      setupCanonicalStack(tmpDir, "camelCaseStack", { skipItems: ["stack.json"] });
      const stackBase = path.join(tmpDir, "stacks", "camelCaseStack");
      fs.writeFileSync(
        path.join(stackBase, "stack.json"),
        JSON.stringify(
          {
            id: "camelCaseStack",
            name: "Camel",
            version: "1.0.0",
            frameworkTarget: "Target",
            description: "Desc",
          },
          null,
          2
        ),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" && f.message.includes("Must be lowercase alphanumeric")));
    });

    test("flags invalid semver version in stack.json", async () => {
      setupCanonicalStack(tmpDir, "bad-version-stack", {
        version: "v1-latest",
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" && f.message.includes("invalid or missing semver 'version'")));
    });

    test("flags empty spec.md with INCOMPLETE_STACK_STRUCTURE", async () => {
      setupCanonicalStack(tmpDir, "empty-spec-stack", { skipItems: ["spec.md"] });
      const stackBase = path.join(tmpDir, "stacks", "empty-spec-stack");
      fs.writeFileSync(path.join(stackBase, "spec.md"), "   ", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" && f.message.includes("spec.md' is empty")));
    });

    test("flags non-array dependencies in stack.json with INCOMPLETE_STACK_STRUCTURE", async () => {
      setupCanonicalStack(tmpDir, "non-array-deps-stack", { skipItems: ["stack.json"] });
      const stackBase = path.join(tmpDir, "stacks", "non-array-deps-stack");
      fs.writeFileSync(
        path.join(stackBase, "stack.json"),
        JSON.stringify(
          {
            id: "non-array-deps-stack",
            name: "Non Array Deps",
            version: "1.0.0",
            frameworkTarget: "Target",
            description: "Desc",
            dependencies: "react-native", // Prohibited: must be array!
          },
          null,
          2
        ),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "INCOMPLETE_STACK_STRUCTURE" &&
            f.message.includes("declares 'dependencies' which is not an array")
        )
      );
    });

    test("flags conflict between spec.md declared dependencies and stack.json dependencies", async () => {
      setupCanonicalStack(tmpDir, "conflict-spec-stack", {
        dependencies: ["react-native"],
        skipItems: ["spec.md"],
      });
      const stackBase = path.join(tmpDir, "stacks", "conflict-spec-stack");
      fs.writeFileSync(
        path.join(stackBase, "spec.md"),
        `# Spec\n\n> **Dependencies**: nextjs\n\nNormative stack specification.`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "STACK_METADATA_CONFLICT" &&
            f.message.includes("Conflict detected in stack 'conflict-spec-stack'")
        )
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. RULE-STK-DEPENDENCY-DAG
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. RULE-STK-DEPENDENCY-DAG", () => {
    test("passes cleanly on valid acyclic stack dependency DAG", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", { dependencies: ["react-native"] });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags subordinate quality-gates.partial.json declaring dependencies", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"],
        qgDependencies: ["react-native"], // PROHIBITED in subordinate file!
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "SUBORDINATE_DEPENDENCY_DECLARATION" && f.filePath?.includes("quality-gates.partial.json")));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags subordinate rif-patterns.json declaring dependencies", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"],
        rifDependencies: ["react-native"], // PROHIBITED in subordinate file!
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "SUBORDINATE_DEPENDENCY_DECLARATION" && f.filePath?.includes("rif-patterns.json")));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags missing dependency stack with MISSING_STACK_DEPENDENCY", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"], // react-native does NOT exist in stacks/
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MISSING_STACK_DEPENDENCY" && f.message.includes("requires dependency 'react-native', but 'react-native' does not exist")));
    });

    test("flags circular dependency cycle (A -> B -> A) with CYCLIC_STACK_DEPENDENCY", async () => {
      setupCanonicalStack(tmpDir, "stack-a", { dependencies: ["stack-b"] });
      setupCanonicalStack(tmpDir, "stack-b", { dependencies: ["stack-a"] });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "CYCLIC_STACK_DEPENDENCY" && f.message.includes("Circular dependency detected")));
    });

    test("flags multi-node circular dependency cycle (A -> B -> C -> A)", async () => {
      setupCanonicalStack(tmpDir, "node-a", { dependencies: ["node-b"] });
      setupCanonicalStack(tmpDir, "node-b", { dependencies: ["node-c"] });
      setupCanonicalStack(tmpDir, "node-c", { dependencies: ["node-a"] });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "CYCLIC_STACK_DEPENDENCY" && f.message.includes("Circular dependency detected")));
    });

    test("flags self-dependency in stack.json with CYCLIC_STACK_DEPENDENCY", async () => {
      setupCanonicalStack(tmpDir, "self-dep-stack", {
        dependencies: ["self-dep-stack"], // Prohibited self-dependency
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "CYCLIC_STACK_DEPENDENCY" &&
            f.message.includes("cannot declare a self-dependency on itself")
        )
      );
    });

    test("flags duplicate dependency declaration in stack.json with DUPLICATE_STACK_DEPENDENCY", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "dup-dep-stack", {
        dependencies: ["react-native", "react-native"], // Duplicate
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "DUPLICATE_STACK_DEPENDENCY" &&
            f.message.includes("Duplicate dependency declaration")
        )
      );
    });

    test("flags invalid dependency identifier format in stack.json with INVALID_STACK_DEPENDENCY_ID", async () => {
      setupCanonicalStack(tmpDir, "bad-format-stack", {
        dependencies: ["INVALID_UPPERCASE"],
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "INVALID_STACK_DEPENDENCY_ID" &&
            f.message.includes("Must be lowercase alphanumeric with hyphens")
        )
      );
    });

    test("flags non-string dependency identifier in stack.json with INVALID_STACK_DEPENDENCY_ID", async () => {
      setupCanonicalStack(tmpDir, "non-string-stack", { skipItems: ["stack.json"] });
      const stackBase = path.join(tmpDir, "stacks", "non-string-stack");
      fs.writeFileSync(
        path.join(stackBase, "stack.json"),
        JSON.stringify(
          {
            id: "non-string-stack",
            name: "Non String Dep",
            version: "1.0.0",
            frameworkTarget: "Target",
            description: "Desc",
            dependencies: [123],
          },
          null,
          2
        ),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "INVALID_STACK_DEPENDENCY_ID" &&
            f.message.includes("Must be a non-empty string")
        )
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RULE-STK-PACKAGE-OVERRIDES
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. RULE-STK-PACKAGE-OVERRIDES", () => {
    test("passes cleanly on valid concrete semver packageOverrides", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"],
        packageOverrides: {
          dependencies: {
            react: "19.3.0",
            "react-native": "0.88.1",
          },
          devDependencies: {
            "@types/react": "19.3.0",
            typescript: "~6.0.3",
          },
          removeDevDependencies: ["@types/react-native"],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags invalid semver in packageOverrides.dependencies with INVALID_PACKAGE_OVERRIDE_SEMVER", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          dependencies: {
            react: "latest", // INVALID semver
          },
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INVALID_PACKAGE_OVERRIDE_SEMVER" && f.message.includes("dependency 'react'")));
    });

    test("flags placeholder or wildcard semver in devDependencies", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          devDependencies: {
            typescript: "*", // Wildcard prohibited
          },
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INVALID_PACKAGE_OVERRIDE_SEMVER" && f.message.includes("devDependency 'typescript'")));
    });

    test("flags attempt to delete foundation dependency of declared prerequisite without justification", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"],
        packageOverrides: {
          dependencies: {
            react: "19.3.0",
          },
          removeDependencies: ["react-native"], // PROHIBITED: removes foundation runtime!
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "FOUNDATION_DEPENDENCY_DELETION" && f.message.includes("removes foundation package 'react-native'")));
    });

    test("flags non-array removeDependencies in packageOverrides", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          removeDependencies: "react-native", // Should be an array!
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "INVALID_PACKAGE_OVERRIDE_STRUCTURE" && f.message.includes("must be an array")));
    });

    test("flags comparison inequalities (>=, <=, >, <) in packageOverrides as non-concrete semver", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          dependencies: {
            "react-native": ">= 0.88.0 < 0.89.0", // Prohibited comparison range: must be concrete version
          },
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "INVALID_PACKAGE_OVERRIDE_SEMVER" &&
            f.message.includes("specifies invalid or non-concrete semver version '>= 0.88.0 < 0.89.0'")
        )
      );
    });

    test("flags loose wildcards (1.x, 1.*) in packageOverrides as non-concrete semver", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          devDependencies: {
            typescript: "1.x", // Prohibited wildcard
          },
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "INVALID_PACKAGE_OVERRIDE_SEMVER" &&
            f.message.includes("specifies invalid or non-concrete semver version '1.x'")
        )
      );
    });

    test("flags contradictory declaration in both dependencies and removeDependencies", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          dependencies: {
            "some-pkg": "1.0.0",
          },
          removeDependencies: ["some-pkg"], // Contradictory: overridden and removed simultaneously!
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "CONTRADICTORY_PACKAGE_OVERRIDE" &&
            f.message.includes("declared in both 'packageOverrides.dependencies' and 'packageOverrides.removeDependencies'")
        )
      );
    });

    test("flags contradictory declaration in both devDependencies and removeDevDependencies", async () => {
      setupCanonicalStack(tmpDir, "expo", {
        packageOverrides: {
          devDependencies: {
            "some-dev-pkg": "^2.0.0",
          },
          removeDevDependencies: ["some-dev-pkg"], // Contradictory!
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "CONTRADICTORY_PACKAGE_OVERRIDE" &&
            f.message.includes("declared in both 'packageOverrides.devDependencies' and 'packageOverrides.removeDevDependencies'")
        )
      );
    });

    test("flags transitive foundation dependency deletion without justification", async () => {
      setupCanonicalStack(tmpDir, "foundation-tier");
      setupCanonicalStack(tmpDir, "middle-tier", { dependencies: ["foundation-tier"] });
      setupCanonicalStack(tmpDir, "app-tier", {
        dependencies: ["middle-tier"], // Transitive prerequisite is foundation-tier
        packageOverrides: {
          dependencies: {
            react: "19.3.0",
          },
          removeDependencies: ["foundation-tier"], // Prohibited: removes transitive foundation stack!
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(
        findings.some(
          (f) =>
            f.diagnosticCode === "FOUNDATION_DEPENDENCY_DELETION" &&
            f.message.includes("removes foundation package 'foundation-tier' required by prerequisite stack 'foundation-tier'")
        )
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Engine Integration & Regression Consistency
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Engine Integration & Regression Consistency", () => {
    test("runs all 3 Category D rules via LinterEngine producing clean passed status on valid stack repo", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"],
        packageOverrides: {
          dependencies: {
            react: "19.3.0",
            "react-native": "0.88.1",
          },
        },
      });

      const registry = new RuleRegistry();
      for (const rule of STACK_RULES) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 3);

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.executedRuleCount, 3);
    });

    test("executes Category A, B, C, and D rules concurrently without mutual interference", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Valid Readme\n[Valid Link](README.md)\n");

      const playbookDir = path.join(tmpDir, ".playbook");
      fs.mkdirSync(playbookDir, { recursive: true });
      fs.writeFileSync(
        path.join(playbookDir, "manifest.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
          schema_version: "1.0.0",
          project_id: "test-full-stack-project",
          project_name: "Test Stack Project",
          active_milestone_id: "M-1.0.0",
          description: "Test description",
          playbook: {
            version: "1.0.0",
            governance_profile: "standard",
            approval_mode: "solo",
          },
          tech_stack: {
            ecosystem: "node",
            primary_language: "typescript",
            runtimes: ["node20"],
            frameworks: ["react-native"],
            package_manager: "npm",
          },
          paths: {
            docs_root: "docs",
            prd_dir: "docs/prd",
            adr_dir: "docs/adr",
            rfc_dir: "docs/rfcs",
            gates_dir: "docs/gates",
            exceptions_dir: "docs/exceptions",
            state_file: ".playbook/state.json",
          },
          active_lifecycle_stage: 0,
          capabilities: ["automated_testing"],
          technology_stacks: ["react-native"],
        }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(playbookDir, "state.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
          schema_version: "1.0.0",
          project_id: "test-full-stack-project",
          playbook_version: "1.0.0",
          milestone_id: "M-1.0.0",
          milestone_name: "MVP",
          lifecycle_status: "active",
          current_stage: 0,
          stage_status: "not_started",
          current_stage_detail: {
            stage: 0,
            stage_name: "Discovery & Problem Formulation",
            started_at: "2026-11-07T00:00:00.000Z",
            deliverables: [],
            rfcs: [],
            adrs: [],
            exceptions: [],
            exit_package: {
              status: "not_drafted",
              path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
              submitted_at: null,
            },
            human_approval: {
              status: "not_requested",
              approved_by: null,
              role: null,
              approval_mode: "solo",
              decision: null,
              signature_reference: null,
              approved_at: null,
              conditions: null,
            },
          },
          stage_history: [],
          archived_milestones: [],
          last_updated: {
            timestamp: "2026-11-07T00:00:00.000Z",
            updated_by: "human-operator",
            actor_type: "human",
            reason: "Init",
          },
        }),
        "utf-8"
      );
      fs.writeFileSync(
        path.join(playbookDir, "quality-gates.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
          schema_version: "1.0.0",
          project_id: "test-full-stack-project",
          default_profile: "standard",
          global_settings: {
            default_timeout_ms: 30000,
            max_concurrency: 2,
            mask_secrets: true,
            log_retention_runs: 10,
            max_journaled_log_bytes: 1048576,
            env_allowlist: ["PATH", "NODE_ENV"],
          },
          gates: [],
        }),
        "utf-8"
      );

      const registry = new RuleRegistry();
      const rulesAtoD = ALL_PRODUCTION_RULES.filter((r) => r.category !== "security");
      for (const rule of rulesAtoD) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 17); // 5 Doc + 4 Schema + 5 Invariant + 3 Stack = 17

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.executedRuleCount, 17);
    });

    test("evaluates real repository stacks (nextjs, react-native, expo) with 0 Category D findings", async () => {
      // Evaluate actual repository root
      const repoRoot = path.resolve(__dirname, "../../../");
      const context = new DefaultRuleExecutionContext(repoRoot);

      const findingsMetadata = ((await ruleStkCanonicalMetadata.evaluate(context)) || []) as RuleFinding[];
      const findingsDag = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      const findingsOverrides = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];

      assert.strictEqual(findingsMetadata.length, 0, `Unexpected canonical metadata findings: ${JSON.stringify(findingsMetadata)}`);
      assert.strictEqual(findingsDag.length, 0, `Unexpected DAG findings: ${JSON.stringify(findingsDag)}`);
      assert.strictEqual(findingsOverrides.length, 0, `Unexpected override findings: ${JSON.stringify(findingsOverrides)}`);
    });

    test("strictly read-only: does not mutate stacks or state files during linting", async () => {
      setupCanonicalStack(tmpDir, "react-native");
      const stackJsonPath = path.join(tmpDir, "stacks", "react-native", "stack.json");
      const beforeContent = fs.readFileSync(stackJsonPath, "utf-8");

      const registry = new RuleRegistry();
      for (const rule of STACK_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      await engine.run({ projectDir: tmpDir });

      assert.strictEqual(fs.readFileSync(stackJsonPath, "utf-8"), beforeContent);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", "journal.json")), false);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", ".lock")), false);
    });

    test("demonstrates full StackManager parity for valid composition, cycles, and subordinate declarations", async () => {
      // 1. Valid composition: react-native foundation and expo extension
      setupCanonicalStack(tmpDir, "react-native");
      setupCanonicalStack(tmpDir, "expo", {
        dependencies: ["react-native"],
        packageOverrides: {
          dependencies: {
            react: "19.3.0",
            "react-native": "0.88.1",
          },
          devDependencies: {
            "@types/react": "19.3.0",
            typescript: "~6.0.3",
          },
          removeDevDependencies: ["@types/react-native"],
        },
      });

      const stacksDir = path.join(tmpDir, "stacks");
      const stackMgr = new StackManager({ stacksDir });

      // StackManager resolves successfully
      const resolved = stackMgr.resolveDependencies(["expo"]);
      assert.deepStrictEqual(resolved, ["react-native", "expo"]);

      // Governance linter evaluates cleanly with 0 findings
      const context = new DefaultRuleExecutionContext(tmpDir);
      const findingsDag = ((await ruleStkDependencyDag.evaluate(context)) || []) as RuleFinding[];
      const findingsOverrides = ((await ruleStkPackageOverrides.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findingsDag.length, 0);
      assert.strictEqual(findingsOverrides.length, 0);

      // 2. Cycle parity: StackManager throws CIRCULAR_DEPENDENCY_DETECTED, rule flags CYCLIC_STACK_DEPENDENCY
      const cycleTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cycle-parity-"));
      try {
        setupCanonicalStack(cycleTmp, "cycle-a", { dependencies: ["cycle-b"] });
        setupCanonicalStack(cycleTmp, "cycle-b", { dependencies: ["cycle-a"] });

        const cycleMgr = new StackManager({ stacksDir: path.join(cycleTmp, "stacks") });
        assert.throws(
          () => cycleMgr.resolveDependencies(["cycle-a"]),
          (err: unknown) => err instanceof StackError && err.code === "CIRCULAR_DEPENDENCY_DETECTED"
        );

        const cycleContext = new DefaultRuleExecutionContext(cycleTmp);
        const cycleFindings = ((await ruleStkDependencyDag.evaluate(cycleContext)) || []) as RuleFinding[];
        assert.ok(cycleFindings.length > 0);
        assert.ok(cycleFindings.some((f) => f.diagnosticCode === "CYCLIC_STACK_DEPENDENCY"));
      } finally {
        fs.rmSync(cycleTmp, { recursive: true, force: true });
      }

      // 3. Subordinate declaration parity: StackManager throws STACK_METADATA_CONFLICT, rule flags SUBORDINATE_DEPENDENCY_DECLARATION
      const subTmp = fs.mkdtempSync(path.join(os.tmpdir(), "stack-sub-parity-"));
      try {
        setupCanonicalStack(subTmp, "sub-stack", { qgDependencies: ["some-dep"] });

        const subMgr = new StackManager({ stacksDir: path.join(subTmp, "stacks") });
        assert.throws(
          () => subMgr.getStackInfo("sub-stack"),
          (err: unknown) => err instanceof StackError && err.code === "STACK_METADATA_CONFLICT"
        );

        const subContext = new DefaultRuleExecutionContext(subTmp);
        const subFindings = ((await ruleStkDependencyDag.evaluate(subContext)) || []) as RuleFinding[];
        assert.ok(subFindings.length > 0);
        assert.ok(subFindings.some((f) => f.diagnosticCode === "SUBORDINATE_DEPENDENCY_DECLARATION"));
      } finally {
        fs.rmSync(subTmp, { recursive: true, force: true });
      }
    });
  });
});
