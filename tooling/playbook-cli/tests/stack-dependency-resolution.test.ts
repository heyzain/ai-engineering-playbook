import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { StackManager, StackError } from "../src/core/stacks/stack-manager.js";
import { DEFAULT_PATHS } from "../src/constants.js";
import type { ProjectManifest } from "../src/types/manifest.js";
import type { QualityGatesConfig } from "../src/types/quality-gates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Task 007D.1 — Stack Dependency Architecture & Deterministic Resolution", () => {
  let tmpDir: string;
  let mockStacksDir: string;
  let repoStacksDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-dep-test-"));
    mockStacksDir = path.join(tmpDir, "mock-stacks");
    fs.mkdirSync(mockStacksDir, { recursive: true });

    // Locate canonical repo stacks directory
    let curr = path.resolve(__dirname);
    repoStacksDir = "";
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(curr, "stacks");
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "nextjs"))) {
        repoStacksDir = candidate;
        break;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
    if (!repoStacksDir) {
      repoStacksDir = path.resolve(process.cwd(), "stacks");
    }
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  function createMockStack(
    stacksRoot: string,
    stackId: string,
    options: {
      dependencies?: string[];
      hasTemplate?: boolean;
      templateFiles?: Record<string, string>;
      gateChecks?: Array<{ id: string; command: string }>;
      writeStackJson?: boolean;
      customStackJson?: Record<string, unknown>;
      specDependencies?: string[];
      customQgPartial?: Record<string, unknown>;
      customRifPatterns?: Record<string, unknown>;
    } = {}
  ): string {
    const stackDir = path.join(stacksRoot, stackId);
    fs.mkdirSync(stackDir, { recursive: true });

    // spec.md
    const specDeps = options.specDependencies !== undefined ? options.specDependencies : options.dependencies;
    const depStr = specDeps && specDeps.length > 0
      ? `> **Dependencies**: ${specDeps.map((d) => `\`${d}\``).join(", ")}`
      : "> **Dependencies**: None";

    const specContent = [
      `# ${stackId} Specification`,
      "",
      `> **Stack Identifier**: \`${stackId}\``,
      `> **Specification Version**: \`1.0.0\``,
      depStr,
      "",
      "## 1. Scope",
      `- Target Versions: Universal \`1.0.0\``,
    ].join("\n");
    fs.writeFileSync(path.join(stackDir, "spec.md"), specContent, "utf-8");

    // stack.json (authoritative machine-readable contract)
    if (options.writeStackJson !== false) {
      const stackJson = options.customStackJson || {
        id: stackId,
        name: stackId,
        version: "1.0.0",
        description: `${stackId} technology stack`,
        frameworkTarget: "Universal",
        dependencies: options.dependencies || [],
      };
      fs.writeFileSync(
        path.join(stackDir, "stack.json"),
        JSON.stringify(stackJson, null, 2),
        "utf-8"
      );
    }

    // quality-gates.partial.json
    const qgPartial = options.customQgPartial || {
      stack: stackId,
      version: "1.0.0",
      gates: [
        {
          stage: 4,
          stage_name: "Implementation & Verification",
          checks: (options.gateChecks || [
            { id: `${stackId}-check`, command: `npm run check-${stackId}` },
          ]).map((c) => ({
            id: c.id,
            name: `${stackId} Verification Check`,
            type: "automated_test",
            deliverable_id: "DELIV-1",
            command: c.command,
            args: [],
            severity: "blocking" as const,
          })),
        },
      ],
    };
    fs.writeFileSync(
      path.join(stackDir, "quality-gates.partial.json"),
      JSON.stringify(qgPartial, null, 2),
      "utf-8"
    );

    // rif-patterns.json
    const rifPatterns = options.customRifPatterns || {
      stack: stackId,
      version: "1.0.0",
      exclude_patterns: [`.${stackId}-cache/**`],
      text_patterns: [`*.${stackId}.ts`],
    };
    fs.writeFileSync(
      path.join(stackDir, "rif-patterns.json"),
      JSON.stringify(rifPatterns, null, 2),
      "utf-8"
    );

    // template/
    if (options.hasTemplate !== false) {
      const templateDir = path.join(stackDir, "template");
      fs.mkdirSync(templateDir, { recursive: true });

      const files = options.templateFiles || {
        "package.json.template": JSON.stringify(
          { name: `{{PROJECT_ID}}-${stackId}`, version: "1.0.0" },
          null,
          2
        ),
        [`${stackId}-config.json`]: JSON.stringify({ stack: stackId }),
      };

      for (const [relPath, content] of Object.entries(files)) {
        const full = path.join(templateDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf-8");
      }
    }

    return stackDir;
  }

  function createProjectWithManifest(
    projectDir: string,
    initialStacks: string[] = []
  ): string {
    const playbookDir = path.join(projectDir, DEFAULT_PATHS.playbookDir);
    fs.mkdirSync(playbookDir, { recursive: true });

    const manifest: ProjectManifest = {
      $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
      schema_version: "1.0.0",
      project_id: "test-dep-app",
      project_name: "Test Dependency App",
      active_milestone_id: "M-1.0.0",
      playbook: {
        version: "1.0.0",
        governance_profile: "standard",
        approval_mode: "solo",
      },
      tech_stack: {
        ecosystem: "node",
        primary_language: "typescript",
      },
      paths: {
        docs_root: "docs",
        prd_dir: "docs/prd",
        adr_dir: "docs/adr",
        rfc_dir: "docs/rfcs",
        gates_dir: "docs/gates",
        exceptions_dir: "governance/exceptions",
        state_file: ".playbook/state.json",
      },
      active_lifecycle_stage: 0,
      capabilities: ["automated_testing", "static_type_checking"],
      technology_stacks: initialStacks,
    };
    fs.writeFileSync(
      path.join(playbookDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8"
    );

    const qgConfig: QualityGatesConfig = {
      $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
      schema_version: "1.0.0",
      project_id: "test-dep-app",
      default_profile: "standard",
      global_settings: {
        default_timeout_ms: 30000,
        max_concurrency: 2,
        mask_secrets: true,
        log_retention_runs: 5,
        max_journaled_log_bytes: 1048576,
        env_allowlist: ["NODE_ENV", "PATH"],
      },
      gates: [
        {
          stage: 4,
          stage_name: "Implementation & Verification",
          checks: [
            {
              id: "core-typecheck",
              name: "TypeScript Check",
              type: "build_typecheck",
              deliverable_id: "DELIV-1",
              command: "tsc --noEmit",
              args: [],
              severity: "blocking",
            },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(playbookDir, "quality-gates.json"),
      JSON.stringify(qgConfig, null, 2),
      "utf-8"
    );

    return projectDir;
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Dependency Resolution & Topological Ordering
  // ─────────────────────────────────────────────────────────────

  test("resolves single stack without dependencies (backward compatibility)", () => {
    createMockStack(mockStacksDir, "stack-a", { dependencies: [] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    const resolved = manager.resolveDependencies(["stack-a"]);
    assert.deepEqual(resolved, ["stack-a"]);
  });

  test("resolves two-tier dependency chain (B -> A results in [A, B])", () => {
    createMockStack(mockStacksDir, "foundation", { dependencies: [] });
    createMockStack(mockStacksDir, "extension", { dependencies: ["foundation"] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    const resolved = manager.resolveDependencies(["extension"]);
    assert.deepEqual(resolved, ["foundation", "extension"]);
  });

  test("resolves three-tier transitive dependency chain (C -> B -> A results in [A, B, C])", () => {
    createMockStack(mockStacksDir, "tier-a", { dependencies: [] });
    createMockStack(mockStacksDir, "tier-b", { dependencies: ["tier-a"] });
    createMockStack(mockStacksDir, "tier-c", { dependencies: ["tier-b"] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    const resolved = manager.resolveDependencies(["tier-c"]);
    assert.deepEqual(resolved, ["tier-a", "tier-b", "tier-c"]);
  });

  test("deduplicates redundant inputs and preserves prerequisites first", () => {
    createMockStack(mockStacksDir, "foundation", { dependencies: [] });
    createMockStack(mockStacksDir, "extension", { dependencies: ["foundation"] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    // Explicitly passing both in reverse order: ["extension", "foundation"]
    const resolved = manager.resolveDependencies(["extension", "foundation"]);
    assert.deepEqual(resolved, ["foundation", "extension"]);

    // Explicitly passing duplicates
    const resolvedDupes = manager.resolveDependencies([
      "extension",
      "foundation",
      "extension",
    ]);
    assert.deepEqual(resolvedDupes, ["foundation", "extension"]);
  });

  test("resolves diamond dependency graph without duplicate evaluations", () => {
    // D depends on B and C; both B and C depend on A
    createMockStack(mockStacksDir, "stack-base", { dependencies: [] });
    createMockStack(mockStacksDir, "stack-left", { dependencies: ["stack-base"] });
    createMockStack(mockStacksDir, "stack-right", { dependencies: ["stack-base"] });
    createMockStack(mockStacksDir, "stack-top", {
      dependencies: ["stack-left", "stack-right"],
    });

    const manager = new StackManager({ stacksDir: mockStacksDir });
    const resolved = manager.resolveDependencies(["stack-top"]);

    assert.equal(resolved[0], "stack-base");
    assert.ok(resolved.indexOf("stack-left") > resolved.indexOf("stack-base"));
    assert.ok(resolved.indexOf("stack-right") > resolved.indexOf("stack-base"));
    assert.equal(resolved[resolved.length - 1], "stack-top");
    assert.equal(resolved.filter((s) => s === "stack-base").length, 1);
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Error Conditions & Fail-Closed Detection
  // ─────────────────────────────────────────────────────────────

  test("fails closed with STACK_DEPENDENCY_MISSING when a required prerequisite is absent", () => {
    createMockStack(mockStacksDir, "orphan-extension", {
      dependencies: ["non-existent-foundation"],
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.resolveDependencies(["orphan-extension"]),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_DEPENDENCY_MISSING");
        assert.match(err.message, /requires dependency 'non-existent-foundation'/);
        assert.equal((err.details as any).missingDependency, "non-existent-foundation");
        return true;
      }
    );
  });

  test("detects direct circular dependency (A -> B -> A) and halts closed", () => {
    createMockStack(mockStacksDir, "circle-a", { dependencies: ["circle-b"] });
    createMockStack(mockStacksDir, "circle-b", { dependencies: ["circle-a"] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.resolveDependencies(["circle-a"]),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "CIRCULAR_DEPENDENCY_DETECTED");
        assert.match(err.message, /Circular dependency detected/);
        return true;
      }
    );
  });

  test("detects transitive circular dependency (A -> B -> C -> A) and halts closed", () => {
    createMockStack(mockStacksDir, "loop-1", { dependencies: ["loop-2"] });
    createMockStack(mockStacksDir, "loop-2", { dependencies: ["loop-3"] });
    createMockStack(mockStacksDir, "loop-3", { dependencies: ["loop-1"] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.resolveDependencies(["loop-1"]),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "CIRCULAR_DEPENDENCY_DETECTED");
        return true;
      }
    );
  });

  test("detects self-referential circular dependency (A -> A)", () => {
    createMockStack(mockStacksDir, "self-loop", { dependencies: ["self-loop"] });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.resolveDependencies(["self-loop"]),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "CIRCULAR_DEPENDENCY_DETECTED");
        return true;
      }
    );
  });

  test("detects indirect dependency cycle A -> B -> C -> D -> B and isolates sub-cycle", () => {
    createMockStack(mockStacksDir, "stack-a", { dependencies: ["stack-b"] });
    createMockStack(mockStacksDir, "stack-b", { dependencies: ["stack-c"] });
    createMockStack(mockStacksDir, "stack-c", { dependencies: ["stack-d"] });
    createMockStack(mockStacksDir, "stack-d", { dependencies: ["stack-b"] });

    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.resolveDependencies(["stack-a"]),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "CIRCULAR_DEPENDENCY_DETECTED");
        assert.deepEqual((err.details as any).cycle, ["stack-b", "stack-c", "stack-d", "stack-b"]);
        return true;
      }
    );
  });

  test("fails with DUPLICATE_DEPENDENCY_DECLARATION when stack.json contains duplicates", () => {
    createMockStack(mockStacksDir, "dupe-stack", {
      customStackJson: {
        id: "dupe-stack",
        name: "Dupe Stack",
        version: "1.0.0",
        frameworkTarget: "Universal",
        dependencies: ["base-rn", "base-rn"],
      },
      specDependencies: ["base-rn", "base-rn"],
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("dupe-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "DUPLICATE_DEPENDENCY_DECLARATION");
        assert.match(err.message, /declared more than once/);
        return true;
      }
    );
  });

  test("fails with INVALID_DEPENDENCY_ID when dependency identifier is malformed", () => {
    createMockStack(mockStacksDir, "bad-id-stack", {
      customStackJson: {
        id: "bad-id-stack",
        name: "Bad Id Stack",
        version: "1.0.0",
        frameworkTarget: "Universal",
        dependencies: ["Invalid_Camel_Case!"],
      },
      specDependencies: ["Invalid_Camel_Case!"],
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("bad-id-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "INVALID_DEPENDENCY_ID");
        assert.match(err.message, /lowercase alphanumeric with hyphens/);
        return true;
      }
    );
  });

  test("fails with CIRCULAR_DEPENDENCY_DETECTED when stack declares self-dependency in stack.json", () => {
    createMockStack(mockStacksDir, "self-declared", {
      dependencies: ["self-declared"],
      specDependencies: ["self-declared"],
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("self-declared"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "CIRCULAR_DEPENDENCY_DETECTED");
        assert.match(err.message, /cannot declare a self-dependency on itself/);
        assert.deepEqual((err.details as any).cycle, ["self-declared", "self-declared"]);
        return true;
      }
    );
  });

  test("fails with STACK_METADATA_CONFLICT when stack.json and spec.md have divergent dependencies", () => {
    createMockStack(mockStacksDir, "conflict-stack", {
      dependencies: ["dep-a"],
      specDependencies: ["dep-b"],
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("conflict-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_METADATA_CONFLICT");
        assert.match(err.message, /stack\.json declares dependencies .* but spec\.md declares/);
        return true;
      }
    );
  });

  test("fails with DUPLICATE_DEPENDENCY_DECLARATION when spec.md contains duplicates in legacy fallback", () => {
    createMockStack(mockStacksDir, "dupe-spec-stack", {
      writeStackJson: false,
      specDependencies: ["base-rn", "base-rn"],
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("dupe-spec-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "DUPLICATE_DEPENDENCY_DECLARATION");
        assert.match(err.message, /declared more than once/);
        return true;
      }
    );
  });

  test("fails with STACK_METADATA_CONFLICT when quality-gates.partial.json declares dependencies matching stack.json", () => {
    createMockStack(mockStacksDir, "qg-match-stack", {
      dependencies: ["dep-a"],
      specDependencies: ["dep-a"],
      customQgPartial: {
        stack: "qg-match-stack",
        dependencies: ["dep-a"], // exact match must still fail!
      },
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("qg-match-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_METADATA_CONFLICT");
        assert.match(err.message, /subordinate file 'quality-gates\.partial\.json' must not declare dependencies/);
        return true;
      }
    );
  });

  test("fails with STACK_METADATA_CONFLICT when quality-gates.partial.json declares dependencies diverging from stack.json", () => {
    createMockStack(mockStacksDir, "qg-diverge-stack", {
      dependencies: ["dep-a"],
      specDependencies: ["dep-a"],
      customQgPartial: {
        stack: "qg-diverge-stack",
        dependencies: ["dep-conflict"],
      },
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("qg-diverge-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_METADATA_CONFLICT");
        assert.match(err.message, /subordinate file 'quality-gates\.partial\.json' must not declare dependencies/);
        return true;
      }
    );
  });

  test("fails with STACK_METADATA_CONFLICT when rif-patterns.json declares dependencies matching stack.json", () => {
    createMockStack(mockStacksDir, "rif-match-stack", {
      dependencies: ["dep-a"],
      specDependencies: ["dep-a"],
      customRifPatterns: {
        stack: "rif-match-stack",
        dependencies: ["dep-a"], // exact match must still fail!
      },
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("rif-match-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_METADATA_CONFLICT");
        assert.match(err.message, /subordinate file 'rif-patterns\.json' must not declare dependencies/);
        return true;
      }
    );
  });

  test("fails with STACK_METADATA_CONFLICT when rif-patterns.json declares dependencies diverging from stack.json", () => {
    createMockStack(mockStacksDir, "rif-diverge-stack", {
      dependencies: ["dep-a"],
      specDependencies: ["dep-a"],
      customRifPatterns: {
        stack: "rif-diverge-stack",
        dependencies: ["dep-conflict"],
      },
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("rif-diverge-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_METADATA_CONFLICT");
        assert.match(err.message, /subordinate file 'rif-patterns\.json' must not declare dependencies/);
        return true;
      }
    );
  });

  test("fails with STACK_METADATA_CONFLICT when subordinate metadata declares dependencies in legacy mode", () => {
    createMockStack(mockStacksDir, "subordinate-legacy-stack", {
      writeStackJson: false,
      dependencies: ["dep-a"],
      specDependencies: ["dep-a"],
      customQgPartial: {
        stack: "subordinate-legacy-stack",
        dependencies: ["dep-a"],
      },
    });
    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () => manager.getStackInfo("subordinate-legacy-stack"),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "STACK_METADATA_CONFLICT");
        assert.match(err.message, /subordinate file 'quality-gates\.partial\.json' must not declare dependencies/);
        return true;
      }
    );
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Metadata Inspection, Idempotence & Ordering Stability
  // ─────────────────────────────────────────────────────────────

  test("guarantees stable, deterministic ordering across repeated resolution calls", () => {
    createMockStack(mockStacksDir, "core-base", { dependencies: [] });
    createMockStack(mockStacksDir, "dep-1", { dependencies: ["core-base"] });
    createMockStack(mockStacksDir, "dep-2", { dependencies: ["core-base"] });
    createMockStack(mockStacksDir, "composite-app", { dependencies: ["dep-1", "dep-2"] });

    const manager = new StackManager({ stacksDir: mockStacksDir });
    const baseline = manager.resolveDependencies(["composite-app"]);

    for (let i = 0; i < 25; i++) {
      const repeated = manager.resolveDependencies(["composite-app"]);
      assert.deepEqual(repeated, baseline);
    }
  });

  test("legacy fallback resolves dependencies from spec.md when stack.json is absent", () => {
    createMockStack(mockStacksDir, "legacy-base", { writeStackJson: false, dependencies: [] });
    createMockStack(mockStacksDir, "legacy-ext", {
      writeStackJson: false,
      dependencies: ["legacy-base"],
      specDependencies: ["legacy-base"],
    });

    const manager = new StackManager({ stacksDir: mockStacksDir });
    const info = manager.getStackInfo("legacy-ext");
    assert.deepEqual(info.dependencies, ["legacy-base"]);

    const resolved = manager.resolveDependencies(["legacy-ext"]);
    assert.deepEqual(resolved, ["legacy-base", "legacy-ext"]);
  });

  test("getStackInfo extracts dependencies from spec.md markdown formatting", () => {
    const stackDir = path.join(mockStacksDir, "doc-dep-stack");
    fs.mkdirSync(stackDir, { recursive: true });

    const specContent = [
      "# Doc Dep Stack Specification",
      "",
      "> **Stack Identifier**: `doc-dep-stack`",
      "> **Specification Version**: `1.0.0`",
      "> **Dependencies**: `react-native`, `core-tools`",
      "",
      "## 1. Scope",
    ].join("\n");
    fs.writeFileSync(path.join(stackDir, "spec.md"), specContent, "utf-8");

    const manager = new StackManager({ stacksDir: mockStacksDir });
    const info = manager.getStackInfo("doc-dep-stack");

    assert.equal(info.id, "doc-dep-stack");
    assert.deepEqual(info.dependencies, ["react-native", "core-tools"]);
  });

  test("listStacks includes dependencies in all discovered StackInfo objects", () => {
    createMockStack(mockStacksDir, "base-stack", { dependencies: [] });
    createMockStack(mockStacksDir, "ext-stack", { dependencies: ["base-stack"] });

    const manager = new StackManager({ stacksDir: mockStacksDir });
    const stacks = manager.listStacks();

    const base = stacks.find((s) => s.id === "base-stack");
    const ext = stacks.find((s) => s.id === "ext-stack");

    assert.ok(base);
    assert.ok(ext);
    assert.deepEqual(base.dependencies, []);
    assert.deepEqual(ext.dependencies, ["base-stack"]);
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Multi-Stack Scaffolding & Layered Overlays
  // ─────────────────────────────────────────────────────────────

  test("scaffolds multiple stacks in resolved dependency order with layered overlay", () => {
    const projectDir = path.join(tmpDir, "project-multi-apply");
    createProjectWithManifest(projectDir);

    createMockStack(mockStacksDir, "base-rn", {
      dependencies: [],
      templateFiles: {
        "package.json.template": JSON.stringify(
          { name: "{{PROJECT_ID}}", foundation: "rn-base" },
          null,
          2
        ),
        "src/shared.ts": "export const foundation = true;\n",
      },
    });

    createMockStack(mockStacksDir, "expo-ext", {
      dependencies: ["base-rn"],
      templateFiles: {
        "app.json": JSON.stringify({ expo: { name: "{{PROJECT_ID}}" } }, null, 2),
        // Overlays package.json with extension configuration
        "package.json.template": JSON.stringify(
          { name: "{{PROJECT_ID}}", foundation: "rn-base", extension: "expo" },
          null,
          2
        ),
        "app/index.tsx": "export default function App() { return null; }\n",
      },
    });

    const manager = new StackManager({ stacksDir: mockStacksDir });

    // Apply the extension stack; should auto-resolve and apply base-rn first!
    const result = manager.scaffoldStack({
      stackName: "expo-ext",
      targetDir: projectDir,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.appliedStacks, ["base-rn", "expo-ext"]);

    // Verify files from both foundation and extension were generated
    assert.ok(fs.existsSync(path.join(projectDir, "src", "shared.ts")));
    assert.ok(fs.existsSync(path.join(projectDir, "app.json")));
    assert.ok(fs.existsSync(path.join(projectDir, "app", "index.tsx")));

    // Verify extension overlay on package.json
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf-8")
    );
    assert.equal(pkg.foundation, "rn-base");
    assert.equal(pkg.extension, "expo");

    // Verify manifest was updated with both stacks
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, DEFAULT_PATHS.playbookDir, "manifest.json"),
        "utf-8"
      )
    ) as ProjectManifest;
    assert.ok(manifest.technology_stacks?.includes("base-rn"));
    assert.ok(manifest.technology_stacks?.includes("expo-ext"));
  });

  test("multi-stack scaffolding protects pre-existing files on disk when force is false", () => {
    const projectDir = path.join(tmpDir, "project-collision");
    createProjectWithManifest(projectDir);

    createMockStack(mockStacksDir, "base-rn", {
      dependencies: [],
      templateFiles: { "src/shared.ts": "original base content\n" },
    });
    createMockStack(mockStacksDir, "expo-ext", {
      dependencies: ["base-rn"],
      templateFiles: { "app.json": "{}\n" },
    });

    // Create a pre-existing file in the destination that collides with base-rn
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "src", "shared.ts"),
      "user authored content\n",
      "utf-8"
    );

    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () =>
        manager.scaffoldStack({
          stackName: "expo-ext",
          targetDir: projectDir,
          force: false,
        }),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "COLLISION_DETECTED");
        return true;
      }
    );

    // Verify user file was preserved and nothing from expo-ext was created
    assert.equal(
      fs.readFileSync(path.join(projectDir, "src", "shared.ts"), "utf-8"),
      "user authored content\n"
    );
    assert.ok(!fs.existsSync(path.join(projectDir, "app.json")));
  });

  test("multi-stack scaffolding rolls back atomically when manifest update fails", () => {
    const projectDir = path.join(tmpDir, "project-rollback");
    createProjectWithManifest(projectDir);

    createMockStack(mockStacksDir, "base-rn", {
      dependencies: [],
      templateFiles: { "src/base.ts": "base\n" },
    });
    createMockStack(mockStacksDir, "expo-ext", {
      dependencies: ["base-rn"],
      templateFiles: { "app/index.tsx": "app\n" },
    });

    // Corrupt manifest.json so registerStackInManifest fails during JSON parsing
    const manifestPath = path.join(
      projectDir,
      DEFAULT_PATHS.playbookDir,
      "manifest.json"
    );
    fs.writeFileSync(manifestPath, "MALFORMED_JSON_CONTENT{{{", "utf-8");

    const manager = new StackManager({ stacksDir: mockStacksDir });

    assert.throws(
      () =>
        manager.scaffoldStack({
          stackName: "expo-ext",
          targetDir: projectDir,
          force: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof StackError);
        assert.equal(err.code, "MANIFEST_UPDATE_FAILED");
        return true;
      }
    );

    // Verify rollback: newly created files and directories should be wiped clean
    assert.ok(!fs.existsSync(path.join(projectDir, "src", "base.ts")));
    assert.ok(!fs.existsSync(path.join(projectDir, "app", "index.tsx")));
    assert.ok(!fs.existsSync(path.join(projectDir, "app")));
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Dependency-Aware Quality Gate Composition
  // ─────────────────────────────────────────────────────────────

  test("composeQualityGates resolves dependencies and orders gate checks deterministically", () => {
    const projectDir = path.join(tmpDir, "project-compose");
    createProjectWithManifest(projectDir);

    createMockStack(mockStacksDir, "base-rn", {
      dependencies: [],
      gateChecks: [
        { id: "rn-typecheck", command: "tsc --noEmit" },
        { id: "rn-lint", command: "eslint ." },
      ],
    });

    createMockStack(mockStacksDir, "expo-ext", {
      dependencies: ["base-rn"],
      gateChecks: [
        { id: "expo-doctor", command: "npx expo-doctor" },
        { id: "expo-prebuild-check", command: "npx expo prebuild --clean" },
      ],
    });

    const manager = new StackManager({ stacksDir: mockStacksDir });

    // Request composition specifying only the extension stack
    const result = manager.composeQualityGates({
      targetDir: projectDir,
      stackNames: ["expo-ext"],
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.composedStacks, ["base-rn", "expo-ext"]);
    assert.equal(result.addedChecks.length, 4);

    const qgConfig = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, DEFAULT_PATHS.playbookDir, "quality-gates.json"),
        "utf-8"
      )
    ) as QualityGatesConfig;

    const stage4 = qgConfig.gates.find((g) => g.stage === 4);
    assert.ok(stage4);

    const checkIds = stage4.checks.map((c) => c.id);
    assert.ok(checkIds.includes("rn-typecheck"));
    assert.ok(checkIds.includes("rn-lint"));
    assert.ok(checkIds.includes("expo-doctor"));
    assert.ok(checkIds.includes("expo-prebuild-check"));
    assert.ok(checkIds.includes("core-typecheck")); // pre-existing check preserved
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Regression: Existing Next.js Reference Stack
  // ─────────────────────────────────────────────────────────────

  test("existing Next.js stack remains fully compatible with zero dependencies", () => {
    if (!fs.existsSync(path.join(repoStacksDir, "nextjs"))) {
      return; // Skip if repo stacks directory is not accessible in this context
    }

    const manager = new StackManager({ stacksDir: repoStacksDir });
    const info = manager.getStackInfo("nextjs");

    assert.equal(info.id, "nextjs");
    assert.deepEqual(info.dependencies, []);

    const resolved = manager.resolveDependencies(["nextjs"]);
    assert.deepEqual(resolved, ["nextjs"]);

    const projectDir = path.join(tmpDir, "project-nextjs");
    createProjectWithManifest(projectDir);

    const result = manager.scaffoldStack({
      stackName: "nextjs",
      targetDir: projectDir,
      force: true,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.appliedStacks, ["nextjs"]);
    assert.ok(fs.existsSync(path.join(projectDir, "src", "app", "page.tsx")));
  });
});
