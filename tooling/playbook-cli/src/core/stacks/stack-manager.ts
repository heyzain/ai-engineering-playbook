import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaValidator } from "../validator.js";
import { DEFAULT_PATHS } from "../../constants.js";
import type {
  StackInfo,
  StackQualityGatesPartial,
  StackRifPatterns,
  ScaffoldStackOptions,
  ScaffoldStackResult,
  ComposeQualityGatesOptions,
  ComposeQualityGatesResult,
} from "../../types/stacks.js";
import type { QualityGatesConfig, QualityGateStage, QualityGateCheck } from "../../types/quality-gates.js";
import type { ProjectManifest } from "../../types/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class StackError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "StackError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Evaluates whether a semantic version satisfies a range or exact version constraint.
 * Supports exact versions, prefixes (^, ~, v), and compound comparison ranges (e.g. '>= 0.88.0 < 0.89.0').
 */
export function satisfiesVersionConstraint(rawVersion: string, constraint: string): boolean {
  if (!rawVersion || !constraint) return false;
  const cleanVer = rawVersion.trim().replace(/^[\^~v]/, "");
  const trimmedConstraint = constraint.trim();

  // If exact match ignoring ^, ~, v
  if (cleanVer === trimmedConstraint.replace(/^[\^~v]/, "")) {
    return true;
  }

  const parseSemver = (v: string): number[] => {
    const parts = v.split(".").map((p) => {
      const num = parseInt(p, 10);
      return isNaN(num) ? 0 : num;
    });
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };

  const compareSemver = (a: string, b: string): number => {
    const pA = parseSemver(a);
    const pB = parseSemver(b);
    for (let i = 0; i < 3; i++) {
      if (pA[i] > pB[i]) return 1;
      if (pA[i] < pB[i]) return -1;
    }
    return 0;
  };

  const clauseRegex = /(>=|<=|>|<|=|\^|~)?\s*([0-9]+(?:\.[0-9]+)*(?:-[0-9A-Za-z.-]+)?)/g;
  let match: RegExpExecArray | null;
  let hasClauses = false;
  let allPassed = true;

  while ((match = clauseRegex.exec(trimmedConstraint)) !== null) {
    hasClauses = true;
    const op = match[1] || "=";
    const targetVer = match[2];
    const cmp = compareSemver(cleanVer, targetVer);

    if (op === ">=") {
      if (cmp < 0) allPassed = false;
    } else if (op === "<=") {
      if (cmp > 0) allPassed = false;
    } else if (op === ">") {
      if (cmp <= 0) allPassed = false;
    } else if (op === "<") {
      if (cmp >= 0) allPassed = false;
    } else if (op === "=") {
      if (cmp !== 0) allPassed = false;
    } else if (op === "^") {
      const pC = parseSemver(cleanVer);
      const pT = parseSemver(targetVer);
      if (cmp < 0 || pC[0] !== pT[0]) allPassed = false;
    } else if (op === "~") {
      const pC = parseSemver(cleanVer);
      const pT = parseSemver(targetVer);
      if (cmp < 0 || pC[0] !== pT[0] || pC[1] !== pT[1]) allPassed = false;
    }
  }

  return hasClauses ? allPassed : false;
}

export class StackManager {
  private readonly stacksDir: string;
  private readonly validator: SchemaValidator;

  constructor(options?: { stacksDir?: string; validator?: SchemaValidator }) {
    this.validator = options?.validator || new SchemaValidator();
    this.stacksDir = this.resolveStacksDir(options?.stacksDir);
  }

  /**
   * Resolves the canonical stacks root directory across repository, build, and installation layouts.
   */
  private resolveStacksDir(customPath?: string): string {
    if (customPath) {
      const resolved = path.resolve(customPath);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }

    if (process.env.PLAYBOOK_STACKS_DIR) {
      const envPath = path.resolve(process.env.PLAYBOOK_STACKS_DIR);
      if (fs.existsSync(envPath)) {
        return envPath;
      }
    }

    // Walk up from __dirname looking for a directory that contains stacks/nextjs or stacks/react-native
    let curr = path.resolve(__dirname);
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(curr, "stacks");
      if (fs.existsSync(candidate) && (fs.existsSync(path.join(candidate, "nextjs")) || fs.existsSync(path.join(candidate, "react-native")))) {
        return candidate;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    // Walk up from process.cwd() looking for stacks/nextjs or stacks/react-native
    curr = path.resolve(process.cwd());
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(curr, "stacks");
      if (fs.existsSync(candidate) && (fs.existsSync(path.join(candidate, "nextjs")) || fs.existsSync(path.join(candidate, "react-native")))) {
        return candidate;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    // Fallback candidates based on relative directory topology:
    const candidates = [
      path.resolve(__dirname, "../../../../../../stacks"),
      path.resolve(__dirname, "../../../../../stacks"),
      path.resolve(__dirname, "../../../../stacks"),
      path.resolve(__dirname, "../../../stacks"),
      path.resolve(__dirname, "../../stacks"),
      path.resolve(process.cwd(), "stacks"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }

    // Default to the first candidate path even if not yet populated
    return candidates[0];
  }

  getStacksDir(): string {
    return this.stacksDir;
  }

  /**
   * Validates a stack identifier against the standard kebab-case pattern and verifies its existence on disk.
   */
  validateStackId(stackName: string): string {
    const trimmed = (stackName || "").trim();
    const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

    if (!trimmed || !pattern.test(trimmed)) {
      throw new StackError(
        "INVALID_STACK_ID",
        `Invalid stack identifier '${stackName}'. Must be lowercase alphanumeric with hyphens (e.g. 'nextjs').`
      );
    }

    const stackPath = path.join(this.stacksDir, trimmed);
    if (!fs.existsSync(stackPath) || !fs.statSync(stackPath).isDirectory()) {
      throw new StackError(
        "STACK_NOT_FOUND",
        `Technology stack '${trimmed}' not found in stacks directory: ${this.stacksDir}`
      );
    }

    return trimmed;
  }

  /**
   * Retrieves comprehensive metadata for a specific stack.
   * Authoritative source of truth: stack.json (StackMetadata).
   * Legacy fallback: spec.md.
   * Conflicting declarations produce an actionable STACK_METADATA_CONFLICT error.
   */
  getStackInfo(stackName: string): StackInfo {
    const validId = this.validateStackId(stackName);
    const stackDir = path.join(this.stacksDir, validId);
    const specPath = path.join(stackDir, "spec.md");
    const templatePath = path.join(stackDir, "template");
    const qgPath = path.join(stackDir, "quality-gates.partial.json");
    const rifPath = path.join(stackDir, "rif-patterns.json");
    const stackJsonPath = path.join(stackDir, "stack.json");

    let name = validId.charAt(0).toUpperCase() + validId.slice(1);
    let description = `${validId} technology stack`;
    let frameworkTarget = "Universal";
    let version = "1.0.0";
    let dependencies: string[] = [];
    let compatibility: Record<string, string> | undefined;
    let packageOverrides: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    } | undefined;

    // Helper to validate and deduplicate a list of dependency identifiers
    const validateDependencyList = (deps: unknown[], source: string): string[] => {
      const seen = new Set<string>();
      const result: string[] = [];
      const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

      for (const item of deps) {
        if (typeof item !== "string" || !item.trim()) {
          throw new StackError(
            "INVALID_DEPENDENCY_ID",
            `Invalid dependency identifier '${String(item)}' in ${source} for stack '${validId}'. Must be lowercase alphanumeric with hyphens.`
          );
        }
        const trimmed = item.trim();
        if (!pattern.test(trimmed)) {
          throw new StackError(
            "INVALID_DEPENDENCY_ID",
            `Invalid dependency identifier '${trimmed}' in ${source} for stack '${validId}'. Must be lowercase alphanumeric with hyphens.`
          );
        }
        if (trimmed === validId) {
          throw new StackError(
            "CIRCULAR_DEPENDENCY_DETECTED",
            `Stack '${validId}' cannot declare a self-dependency on itself in ${source}.`,
            { cycle: [validId, validId] }
          );
        }
        if (seen.has(trimmed)) {
          throw new StackError(
            "DUPLICATE_DEPENDENCY_DECLARATION",
            `Duplicate dependency declaration in ${source} for stack '${validId}': '${trimmed}' is declared more than once.`
          );
        }
        seen.add(trimmed);
        result.push(trimmed);
      }
      return result;
    };

    // Helper to parse dependencies from spec.md
    const parseSpecDependencies = (specContent: string): string[] | null => {
      const depMatch =
        specContent.match(/> \*\*Dependencies\*\*:\s*([^\n\r]+)/i) ||
        specContent.match(/(?:^|\n)dependencies:\s*\[?([^\]\n\r]+)\]?/i) ||
        specContent.match(/(?:^|\n)Dependencies:\s*\[?([^\]\n\r]+)\]?/i);

      if (!depMatch || !depMatch[1]) return null;
      const raw = depMatch[1].trim();
      if (!raw || raw.toLowerCase() === "none" || raw === "[]") return [];

      const parsed = raw
        .split(/[,;\s]+/)
        .map((d) => d.replace(/[`"'[\]]/g, "").trim())
        .filter(Boolean);

      return validateDependencyList(parsed, "spec.md");
    };

    let specDeps: string[] | null = null;
    if (fs.existsSync(specPath)) {
      try {
        const specContent = fs.readFileSync(specPath, "utf-8");
        const targetMatch = specContent.match(/Target Versions?\*?\*?:\s*(.*)/i);
        if (targetMatch) {
          frameworkTarget = targetMatch[1].replace(/[`*]/g, "").trim();
        }
        const versionMatch = specContent.match(/Specification Version:\s*`([^`]+)`/i);
        if (versionMatch) {
          version = versionMatch[1].trim();
        }
        specDeps = parseSpecDependencies(specContent);
      } catch (err: unknown) {
        if (err instanceof StackError) throw err;
        // ignore read error
      }
    }

    // 1. Authoritative machine-readable contract: stack.json
    if (fs.existsSync(stackJsonPath)) {
      let stackJson: any;
      try {
        stackJson = JSON.parse(fs.readFileSync(stackJsonPath, "utf-8"));
      } catch (err: unknown) {
        throw new StackError(
          "STACK_METADATA_MALFORMED",
          `Failed to parse stack.json for stack '${validId}': ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (stackJson.name) name = stackJson.name;
      if (stackJson.description) description = stackJson.description;
      if (stackJson.version) version = stackJson.version;
      if (stackJson.frameworkTarget) frameworkTarget = stackJson.frameworkTarget;

      if (stackJson.compatibility && typeof stackJson.compatibility === "object" && !Array.isArray(stackJson.compatibility)) {
        compatibility = stackJson.compatibility;
      }
      if (stackJson.packageOverrides && typeof stackJson.packageOverrides === "object") {
        packageOverrides = stackJson.packageOverrides;
      }

      if (stackJson.dependencies !== undefined) {
        if (!Array.isArray(stackJson.dependencies)) {
          throw new StackError(
            "STACK_METADATA_MALFORMED",
            `'dependencies' in stack.json for stack '${validId}' must be an array of strings.`
          );
        }
        dependencies = validateDependencyList(stackJson.dependencies, "stack.json");
      }

      // Conflict detection: If spec.md also explicitly defines dependencies, they must match stack.json
      if (specDeps !== null) {
        const setJson = new Set(dependencies);
        const setSpec = new Set(specDeps);
        const differs = setJson.size !== setSpec.size || [...setJson].some((d) => !setSpec.has(d));
        if (differs) {
          throw new StackError(
            "STACK_METADATA_CONFLICT",
            `Conflict detected in stack '${validId}': stack.json declares dependencies [${dependencies.join(", ")}] but spec.md declares [${specDeps.join(", ")}]. Authoritative stack.json and human-readable spec.md must be consistent.`
          );
        }
      }
    } else {
      // 2. Legacy / compatibility fallback: when stack.json is absent, spec.md is used
      if (specDeps !== null) {
        dependencies = specDeps;
      }
    }

    // Subordinate metadata files (quality-gates.partial.json and rif-patterns.json) must not declare dependencies.
    // Reject presence unconditionally with STACK_METADATA_CONFLICT, even if its value matches stack.json.
    if (fs.existsSync(qgPath)) {
      try {
        const qgContent = JSON.parse(fs.readFileSync(qgPath, "utf-8"));
        if (qgContent && typeof qgContent === "object" && "dependencies" in qgContent && qgContent.dependencies !== undefined) {
          throw new StackError(
            "STACK_METADATA_CONFLICT",
            `Conflict detected in stack '${validId}': subordinate file 'quality-gates.partial.json' must not declare dependencies. 'stack.json' is the sole authoritative dependency declaration.`
          );
        }
      } catch (err: unknown) {
        if (err instanceof StackError) throw err;
      }
    }

    if (fs.existsSync(rifPath)) {
      try {
        const rifContent = JSON.parse(fs.readFileSync(rifPath, "utf-8"));
        if (rifContent && typeof rifContent === "object" && "dependencies" in rifContent && rifContent.dependencies !== undefined) {
          throw new StackError(
            "STACK_METADATA_CONFLICT",
            `Conflict detected in stack '${validId}': subordinate file 'rif-patterns.json' must not declare dependencies. 'stack.json' is the sole authoritative dependency declaration.`
          );
        }
      } catch (err: unknown) {
        if (err instanceof StackError) throw err;
      }
    }

    return {
      id: validId,
      name,
      version,
      frameworkTarget,
      description,
      dependencies,
      compatibility,
      packageOverrides,
      hasTemplate: fs.existsSync(templatePath) && fs.statSync(templatePath).isDirectory(),
      hasQualityGates: fs.existsSync(qgPath),
      hasRifPatterns: fs.existsSync(rifPath),
      specPath: fs.existsSync(specPath) ? specPath : "",
    };
  }

  /**
   * Deterministically resolves a set of technology stacks and all transitive prerequisites.
   * Enforces topological sorting (prerequisites first), cycle detection, missing dependency detection,
   * deduplication, and stable ordering.
   */
  resolveDependencies(stackNames: string[]): string[] {
    if (!stackNames || stackNames.length === 0) {
      return [];
    }

    const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const rawName of stackNames) {
      const trimmed = (rawName || "").trim();
      if (!trimmed) continue;
      if (!pattern.test(trimmed)) {
        throw new StackError(
          "INVALID_STACK_ID",
          `Invalid stack identifier '${trimmed}'. Must be lowercase alphanumeric with hyphens.`
        );
      }
    }

    const state = new Map<string, "visiting" | "visited">();
    const resolved: string[] = [];
    const activePath: string[] = [];

    const visit = (stackId: string) => {
      const currentState = state.get(stackId);

      if (currentState === "visiting") {
        const cycleStartIndex = activePath.indexOf(stackId);
        const cycle = cycleStartIndex >= 0 ? [...activePath.slice(cycleStartIndex), stackId] : [...activePath, stackId];
        throw new StackError(
          "CIRCULAR_DEPENDENCY_DETECTED",
          `Circular dependency detected in technology stacks: ${cycle.join(" -> ")}`,
          { cycle }
        );
      }

      if (currentState === "visited") {
        return;
      }

      state.set(stackId, "visiting");
      activePath.push(stackId);

      // Verify and inspect stack
      const info = this.getStackInfo(stackId);
      const deps = info.dependencies || [];

      for (const dep of deps) {
        // Validate that dependency exists in stacksDir
        const depPath = path.join(this.stacksDir, dep);
        if (!fs.existsSync(depPath) || !fs.statSync(depPath).isDirectory()) {
          throw new StackError(
            "STACK_DEPENDENCY_MISSING",
            `Technology stack '${stackId}' requires dependency '${dep}', but '${dep}' was not found in stacks directory: ${this.stacksDir}`,
            { stack: stackId, missingDependency: dep }
          );
        }

        visit(dep);
      }

      state.set(stackId, "visited");
      activePath.pop();

      if (!resolved.includes(stackId)) {
        resolved.push(stackId);
      }
    };

    for (const rawName of stackNames) {
      const trimmed = (rawName || "").trim();
      if (!trimmed) continue;
      visit(trimmed);
    }

    return resolved;
  }

  /**
   * Lists all supported technology stacks found under the stacks directory.
   */
  listStacks(): StackInfo[] {
    if (!fs.existsSync(this.stacksDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.stacksDir, { withFileTypes: true });
    const stacks: StackInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const info = this.getStackInfo(entry.name);
        stacks.push(info);
      } catch {
        // ignore non-stack directories
      }
    }

    return stacks.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Loads quality-gates.partial.json for a specific stack.
   */
  loadStackQualityGates(stackName: string): StackQualityGatesPartial {
    const validId = this.validateStackId(stackName);
    const qgPath = path.join(this.stacksDir, validId, "quality-gates.partial.json");

    if (!fs.existsSync(qgPath)) {
      throw new StackError(
        "STACK_GATES_NOT_FOUND",
        `Quality gates partial not found for stack '${validId}' at: ${qgPath}`
      );
    }

    try {
      const raw = fs.readFileSync(qgPath, "utf-8");
      return JSON.parse(raw) as StackQualityGatesPartial;
    } catch (err: unknown) {
      throw new StackError(
        "STACK_GATES_MALFORMED",
        `Failed to parse quality-gates.partial.json for stack '${validId}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Loads rif-patterns.json for a specific stack.
   */
  loadStackRifPatterns(stackName: string): StackRifPatterns {
    const validId = this.validateStackId(stackName);
    const rifPath = path.join(this.stacksDir, validId, "rif-patterns.json");

    if (!fs.existsSync(rifPath)) {
      return { stack: validId, version: "1.0.0" };
    }

    try {
      const raw = fs.readFileSync(rifPath, "utf-8");
      return JSON.parse(raw) as StackRifPatterns;
    } catch (err: unknown) {
      throw new StackError(
        "STACK_RIF_MALFORMED",
        `Failed to parse rif-patterns.json for stack '${validId}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Deterministically composes rif-patterns.json across a dependency-ordered list of stacks.
   */
  composeStackRifPatterns(stackNames: string[]): StackRifPatterns {
    const chain = this.resolveDependencies(stackNames);
    const textSet = new Set<string>();
    const binarySet = new Set<string>();
    const excludeSet = new Set<string>();
    const rulesSet = new Set<string>();
    const exclusiveModules: Record<string, "ios" | "android"> = {};

    for (const stackName of chain) {
      const patterns = this.loadStackRifPatterns(stackName);
      if (patterns.text_patterns) {
        for (const p of patterns.text_patterns) textSet.add(p);
      }
      if (patterns.binary_patterns) {
        for (const p of patterns.binary_patterns) binarySet.add(p);
      }
      if (patterns.exclude_patterns) {
        for (const p of patterns.exclude_patterns) excludeSet.add(p);
      }
      if (patterns.rules) {
        for (const r of patterns.rules) rulesSet.add(r);
      }
      if (patterns.platform_exclusive_modules) {
        if (Array.isArray(patterns.platform_exclusive_modules)) {
          for (const m of patterns.platform_exclusive_modules) {
            exclusiveModules[m] = "ios";
          }
        } else {
          Object.assign(exclusiveModules, patterns.platform_exclusive_modules);
        }
      }
    }

    const primaryStack = chain[chain.length - 1] || "composite";
    return {
      stack: primaryStack,
      version: "1.0.0",
      rules: Array.from(rulesSet).sort(),
      text_patterns: Array.from(textSet).sort(),
      binary_patterns: Array.from(binarySet).sort(),
      exclude_patterns: Array.from(excludeSet).sort(),
      platform_exclusive_modules: Object.keys(exclusiveModules).length > 0 ? exclusiveModules : undefined,
    };
  }

  /**
   * Validates pre-existing project dependencies against stack compatibility constraints.
   * If a target directory already has a package.json and contains incompatible dependencies,
   * fails closed with STACK_INCOMPATIBLE_DEPENDENCY.
   */
  validatePreExistingCompatibility(targetDir: string, stackNames: string[]): void {
    const pkgPath = path.join(targetDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return;
    }

    let existingPkg: any;
    try {
      existingPkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      return;
    }

    const allDeps: Record<string, string> = {
      ...(existingPkg.dependencies || {}),
      ...(existingPkg.devDependencies || {}),
    };

    for (const stackName of stackNames) {
      const info = this.getStackInfo(stackName);
      if (!info.compatibility) continue;

      for (const [pkg, constraint] of Object.entries(info.compatibility)) {
        if (pkg === "node") {
          const current = process.version;
          if (!satisfiesVersionConstraint(current, constraint)) {
            throw new StackError(
              "STACK_INCOMPATIBLE_DEPENDENCY",
              `Incompatible runtime environment: current Node.js version '${current}' does not satisfy stack '${stackName}' requirement '${constraint}'.`,
              { stack: stackName, package: "node", currentVersion: current, requiredConstraint: constraint }
            );
          }
          continue;
        }

        if (allDeps[pkg] !== undefined) {
          const currentVer = allDeps[pkg];
          if (!satisfiesVersionConstraint(currentVer, constraint)) {
            throw new StackError(
              "STACK_INCOMPATIBLE_DEPENDENCY",
              `Incompatible pre-existing dependency: '${pkg}' version '${currentVer}' in target directory does not satisfy stack '${stackName}' compatibility constraint '${constraint}'.`,
              { stack: stackName, package: pkg, currentVersion: currentVer, requiredConstraint: constraint }
            );
          }
        }
      }
    }
  }

  /**
   * Deterministically merges an incoming stack's package.json with a prior stack's package.json.
   * Requires explicit packageOverrides in stack.json for any conflicting dependency versions.
   */
  mergePackageJson(
    existingContent: string,
    incomingContent: string,
    priorStackName: string,
    currentStackInfo: StackInfo
  ): string {
    const existingPkg = JSON.parse(existingContent);
    const incomingPkg = JSON.parse(incomingContent);

    const overrides = currentStackInfo.packageOverrides || {};
    const allowedDepOverrides = overrides.dependencies || {};
    const allowedDevOverrides = overrides.devDependencies || {};

    // Check for conflicting dependencies
    if (existingPkg.dependencies && incomingPkg.dependencies) {
      for (const [dep, incVer] of Object.entries(incomingPkg.dependencies)) {
        const existVer = existingPkg.dependencies[dep];
        if (existVer && existVer !== incVer) {
          if (!allowedDepOverrides[dep] || allowedDepOverrides[dep] !== incVer) {
            throw new StackError(
              "STACK_UNRESOLVED_DEPENDENCY_CONFLICT",
              `Conflicting dependency declaration for '${dep}' between stack '${priorStackName}' ('${existVer}') and stack '${currentStackInfo.id}' ('${incVer}') without explicit packageOverrides in stack.json.`,
              { dependency: dep, priorVersion: existVer, incomingVersion: incVer, stack: currentStackInfo.id }
            );
          }
        }
      }
    }

    // Check for conflicting devDependencies
    if (existingPkg.devDependencies && incomingPkg.devDependencies) {
      for (const [dep, incVer] of Object.entries(incomingPkg.devDependencies)) {
        const existVer = existingPkg.devDependencies[dep];
        if (existVer && existVer !== incVer) {
          if (!allowedDevOverrides[dep] || allowedDevOverrides[dep] !== incVer) {
            throw new StackError(
              "STACK_UNRESOLVED_DEPENDENCY_CONFLICT",
              `Conflicting devDependency declaration for '${dep}' between stack '${priorStackName}' ('${existVer}') and stack '${currentStackInfo.id}' ('${incVer}') without explicit packageOverrides in stack.json.`,
              { devDependency: dep, priorVersion: existVer, incomingVersion: incVer, stack: currentStackInfo.id }
            );
          }
        }
      }
    }

    const removeDeps = new Set(overrides.removeDependencies || []);
    const removeDevDeps = new Set(overrides.removeDevDependencies || []);

    const mergedDeps: Record<string, string> = {
      ...(existingPkg.dependencies || {}),
      ...(incomingPkg.dependencies || {}),
    };
    for (const d of removeDeps) {
      delete mergedDeps[d];
    }

    const mergedDevDeps: Record<string, string> = {
      ...(existingPkg.devDependencies || {}),
      ...(incomingPkg.devDependencies || {}),
    };
    for (const d of removeDevDeps) {
      delete mergedDevDeps[d];
    }

    const merged = {
      ...existingPkg,
      ...incomingPkg,
      scripts: {
        ...(existingPkg.scripts || {}),
        ...(incomingPkg.scripts || {}),
      },
      dependencies: mergedDeps,
      devDependencies: mergedDevDeps,
    };

    return JSON.stringify(merged, null, 2) + "\n";
  }

  /**
   * Scaffolds an offline starter template into the target project directory.
   * Enforces path traversal prevention, symlink escape protection, collision checking,
   * atomic file generation with rollback on failure, and manifest synchronization.
   * If the stack has prerequisites, auto-resolves dependencies and applies them in topological order.
   */
  scaffoldStack(options: ScaffoldStackOptions): ScaffoldStackResult {
    const stackName = this.validateStackId(options.stackName);
    const targetDir = path.resolve(options.targetDir);

    // Auto-resolve dependencies if enabled (default: true)
    if (options.autoResolveDependencies !== false) {
      const resolvedStacks = this.resolveDependencies([stackName]);
      if (resolvedStacks.length > 1) {
        return this.scaffoldMultipleStacks({
          resolvedStacks,
          requestedStack: stackName,
          targetDir,
          projectId: options.projectId,
          force: options.force,
        });
      }
    }

    // Pre-existing project compatibility check
    this.validatePreExistingCompatibility(targetDir, [stackName]);

    const templateDir = path.join(this.stacksDir, stackName, "template");

    if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
      throw new StackError(
        "TEMPLATE_NOT_FOUND",
        `Starter template not found for stack '${stackName}' at: ${templateDir}`
      );
    }

    // 1. Scan all template source files
    const templateFiles: Array<{ relPath: string; fullSource: string; destRelPath: string }> = [];
    this.collectTemplateFiles(templateDir, templateDir, templateFiles);

    // 2. Traversal and symlink escape verification
    for (const item of templateFiles) {
      const resolvedDest = path.resolve(targetDir, item.destRelPath);
      const relToTarget = path.relative(targetDir, resolvedDest);

      if (relToTarget.startsWith("..") || path.isAbsolute(relToTarget)) {
        throw new StackError(
          "PATH_TRAVERSAL_DETECTED",
          `Template file '${item.relPath}' escapes target directory boundary: ${resolvedDest}`
        );
      }

      // Symlink escape check on source
      const srcLstat = fs.lstatSync(item.fullSource);
      if (srcLstat.isSymbolicLink()) {
        const linkTarget = fs.realpathSync(item.fullSource);
        const relToTemplate = path.relative(templateDir, linkTarget);
        if (relToTemplate.startsWith("..") || path.isAbsolute(relToTemplate)) {
          throw new StackError(
            "SYMLINK_ESCAPE_DETECTED",
            `Template symlink '${item.relPath}' escapes template root boundary pointing to: ${linkTarget}`
          );
        }
      }
    }

    // 3. Collision detection
    const conflictingFiles: string[] = [];
    for (const item of templateFiles) {
      const destPath = path.join(targetDir, item.destRelPath);
      if (fs.existsSync(destPath)) {
        conflictingFiles.push(item.destRelPath);
      }
    }

    if (conflictingFiles.length > 0 && !options.force) {
      throw new StackError(
        "COLLISION_DETECTED",
        `Target directory contains ${conflictingFiles.length} conflicting files. Pass force: true to overwrite.`,
        { conflictingFiles }
      );
    }

    // 4. Atomic Execution with Rollback tracking
    const createdFiles: string[] = [];
    const createdDirs: string[] = [];
    const overwrittenFiles: string[] = [];
    const backupContents = new Map<string, Buffer>();

    const ensureDirectoryWithTracking = (dirPath: string) => {
      if (fs.existsSync(dirPath)) return;
      const parent = path.dirname(dirPath);
      if (!fs.existsSync(parent) && parent !== dirPath) {
        ensureDirectoryWithTracking(parent);
      }
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath);
        createdDirs.push(dirPath);
      }
    };

    const projectId =
      options.projectId ||
      this.readProjectIdFromManifest(targetDir) ||
      path.basename(targetDir).toLowerCase().replace(/[^a-z0-9]+/g, "-");

    let manifestUpdated = false;
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");

    try {
      // If manifest exists, back it up in case manifest registration fails
      if (fs.existsSync(manifestPath)) {
        backupContents.set(manifestPath, fs.readFileSync(manifestPath));
      }

      for (const item of templateFiles) {
        const destPath = path.join(targetDir, item.destRelPath);
        const destDir = path.dirname(destPath);

        // Ensure destination directory with tracking
        ensureDirectoryWithTracking(destDir);

        // Backup existing file for rollback if overwritten
        if (fs.existsSync(destPath)) {
          backupContents.set(destPath, fs.readFileSync(destPath));
          overwrittenFiles.push(item.destRelPath);
        } else {
          createdFiles.push(item.destRelPath);
        }

        // Read template content and substitute variables
        let content = fs.readFileSync(item.fullSource, "utf-8");
        const normalizedProjectId = projectId.replace(/[^a-zA-Z0-9_]/g, "_");
        content = content.replace(/\{\{PROJECT_ID\}\}/g, projectId);
        content = content.replace(/\{\{PROJECT_ID_NORMALIZED\}\}/g, normalizedProjectId);

        fs.writeFileSync(destPath, content, "utf-8");
      }

      // 5. Update project manifest within the atomic transaction block
      manifestUpdated = this.registerStackInManifest(targetDir, stackName);
    } catch (err: unknown) {
      // Rollback newly created files
      for (const created of createdFiles) {
        try {
          const p = path.join(targetDir, created);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // best-effort cleanup
        }
      }
      // Restore overwritten files and original manifest
      for (const [filePath, originalBuffer] of backupContents.entries()) {
        try {
          fs.writeFileSync(filePath, originalBuffer);
        } catch {
          // best-effort cleanup
        }
      }
      // Rollback newly created empty directories in reverse creation order
      for (let i = createdDirs.length - 1; i >= 0; i--) {
        try {
          const dir = createdDirs[i];
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
          }
        } catch {
          // best-effort cleanup
        }
      }

      if (err instanceof StackError) throw err;
      throw new StackError(
        "SCAFFOLD_FAILED",
        `Failed to scaffold stack '${stackName}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      success: true,
      stackName,
      targetDir,
      createdFiles,
      overwrittenFiles,
      manifestUpdated,
      appliedStacks: [stackName],
    };
  }

  /**
   * Scaffolds multiple stacks in resolved dependency order with atomic transaction protection.
   */
  private scaffoldMultipleStacks(options: {
    resolvedStacks: string[];
    requestedStack: string;
    targetDir: string;
    projectId?: string;
    force?: boolean;
  }): ScaffoldStackResult {
    const { resolvedStacks, requestedStack, targetDir, force } = options;

    // Pre-existing project compatibility check
    this.validatePreExistingCompatibility(targetDir, resolvedStacks);

    // 1. Validate templates exist and collect files for each stack in order
    const stackTemplates: Array<{
      stackName: string;
      templateDir: string;
      files: Array<{ relPath: string; fullSource: string; destRelPath: string }>;
    }> = [];

    for (const stack of resolvedStacks) {
      const templateDir = path.join(this.stacksDir, stack, "template");
      if (fs.existsSync(templateDir) && fs.statSync(templateDir).isDirectory()) {
        const files: Array<{ relPath: string; fullSource: string; destRelPath: string }> = [];
        this.collectTemplateFiles(templateDir, templateDir, files);
        stackTemplates.push({ stackName: stack, templateDir, files });
      }
    }

    // 2. Traversal and symlink escape verification across all files
    for (const st of stackTemplates) {
      for (const item of st.files) {
        const resolvedDest = path.resolve(targetDir, item.destRelPath);
        const relToTarget = path.relative(targetDir, resolvedDest);
        if (relToTarget.startsWith("..") || path.isAbsolute(relToTarget)) {
          throw new StackError(
            "PATH_TRAVERSAL_DETECTED",
            `Template file '${item.relPath}' from stack '${st.stackName}' escapes target directory boundary: ${resolvedDest}`
          );
        }
        const srcLstat = fs.lstatSync(item.fullSource);
        if (srcLstat.isSymbolicLink()) {
          const linkTarget = fs.realpathSync(item.fullSource);
          const relToTemplate = path.relative(st.templateDir, linkTarget);
          if (relToTemplate.startsWith("..") || path.isAbsolute(relToTemplate)) {
            throw new StackError(
              "SYMLINK_ESCAPE_DETECTED",
              `Template symlink '${item.relPath}' from stack '${st.stackName}' escapes template root boundary pointing to: ${linkTarget}`
            );
          }
        }
      }
    }

    // 3. Collision detection: check against files already existing on disk prior to this scaffolding run
    const preExistingConflicts = new Set<string>();
    for (const st of stackTemplates) {
      for (const item of st.files) {
        const destPath = path.join(targetDir, item.destRelPath);
        if (fs.existsSync(destPath)) {
          preExistingConflicts.add(item.destRelPath);
        }
      }
    }

    if (preExistingConflicts.size > 0 && !force) {
      throw new StackError(
        "COLLISION_DETECTED",
        `Target directory contains ${preExistingConflicts.size} conflicting files. Pass force: true to overwrite.`,
        { conflictingFiles: Array.from(preExistingConflicts) }
      );
    }

    // 4. Atomic Multi-Stack Execution with Rollback tracking
    const createdFiles = new Set<string>();
    const createdDirs: string[] = [];
    const overwrittenFiles = new Set<string>();
    const backupContents = new Map<string, Buffer>();

    const ensureDirectoryWithTracking = (dirPath: string) => {
      if (fs.existsSync(dirPath)) return;
      const parent = path.dirname(dirPath);
      if (!fs.existsSync(parent) && parent !== dirPath) {
        ensureDirectoryWithTracking(parent);
      }
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath);
        createdDirs.push(dirPath);
      }
    };

    const projectId =
      options.projectId ||
      this.readProjectIdFromManifest(targetDir) ||
      path.basename(targetDir).toLowerCase().replace(/[^a-z0-9]+/g, "-");

    let manifestUpdated = false;
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");

    try {
      if (fs.existsSync(manifestPath)) {
        backupContents.set(manifestPath, fs.readFileSync(manifestPath));
      }

      // Apply each stack in topological order
      const writtenStackForFile = new Map<string, string>();

      for (const st of stackTemplates) {
        const currentStackInfo = this.getStackInfo(st.stackName);

        for (const item of st.files) {
          const destPath = path.join(targetDir, item.destRelPath);
          const destDir = path.dirname(destPath);

          ensureDirectoryWithTracking(destDir);

          // If file already existed on disk before this multi-stack run, back it up
          if (fs.existsSync(destPath) && !createdFiles.has(item.destRelPath) && !backupContents.has(destPath)) {
            backupContents.set(destPath, fs.readFileSync(destPath));
            overwrittenFiles.add(item.destRelPath);
          } else if (!fs.existsSync(destPath)) {
            createdFiles.add(item.destRelPath);
          }

          let content = fs.readFileSync(item.fullSource, "utf-8");
          const normalizedProjectId = projectId.replace(/[^a-zA-Z0-9_]/g, "_");
          content = content.replace(/\{\{PROJECT_ID\}\}/g, projectId);
          content = content.replace(/\{\{PROJECT_ID_NORMALIZED\}\}/g, normalizedProjectId);

          if (item.destRelPath === "package.json" && fs.existsSync(destPath) && writtenStackForFile.has(item.destRelPath)) {
            const priorStack = writtenStackForFile.get(item.destRelPath)!;
            const existingContent = fs.readFileSync(destPath, "utf-8");
            content = this.mergePackageJson(existingContent, content, priorStack, currentStackInfo);
          }

          fs.writeFileSync(destPath, content, "utf-8");
          writtenStackForFile.set(item.destRelPath, st.stackName);
        }
      }

      // 5. Update manifest with all resolved stacks in order
      manifestUpdated = this.registerStackInManifest(targetDir, resolvedStacks);
    } catch (err: unknown) {
      // Rollback
      for (const created of createdFiles) {
        try {
          const p = path.join(targetDir, created);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // best-effort cleanup
        }
      }
      for (const [filePath, originalBuffer] of backupContents.entries()) {
        try {
          fs.writeFileSync(filePath, originalBuffer);
        } catch {
          // best-effort cleanup
        }
      }
      for (let i = createdDirs.length - 1; i >= 0; i--) {
        try {
          const dir = createdDirs[i];
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
          }
        } catch {
          // best-effort cleanup
        }
      }

      if (err instanceof StackError) throw err;
      throw new StackError(
        "SCAFFOLD_FAILED",
        `Failed to scaffold multiple stacks [${resolvedStacks.join(", ")}]: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      success: true,
      stackName: requestedStack,
      targetDir,
      createdFiles: Array.from(createdFiles),
      overwrittenFiles: Array.from(overwrittenFiles),
      manifestUpdated,
      appliedStacks: resolvedStacks,
    };
  }

  /**
   * Registers one or more technology stacks into .playbook/manifest.json if the file exists.
   * Preserves all existing fields and validates conformance to project-manifest.schema.json.
   */
  registerStackInManifest(targetDir: string, stackName: string | string[]): boolean {
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return false;
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as ProjectManifest;

      if (!manifest.technology_stacks) {
        manifest.technology_stacks = [];
      }

      const names = Array.isArray(stackName) ? stackName : [stackName];
      for (const name of names) {
        if (!manifest.technology_stacks.includes(name)) {
          manifest.technology_stacks.push(name);
        }
      }
      try {
        manifest.technology_stacks = this.resolveDependencies(manifest.technology_stacks);
      } catch {
        manifest.technology_stacks.sort();
      }

      const validation = this.validator.validateManifest(manifest);
      if (!validation.valid) {
        throw new StackError(
          "MANIFEST_VALIDATION_FAILED",
          `Updated manifest failed schema validation: ${validation.errors.map((e) => e.message).join("; ")}`,
          { errors: validation.errors }
        );
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      return true;
    } catch (err: unknown) {
      if (err instanceof StackError) throw err;
      const stackStr = Array.isArray(stackName) ? stackName.join(", ") : stackName;
      throw new StackError(
        "MANIFEST_UPDATE_FAILED",
        `Failed to update manifest.json with stack '${stackStr}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Composes Quality Gate checks from declared stacks into .playbook/quality-gates.json.
   * Dependencies are resolved topologically so prerequisites are evaluated first.
   */
  composeQualityGates(options: ComposeQualityGatesOptions): ComposeQualityGatesResult {
    const targetDir = path.resolve(options.targetDir);
    const qgPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "quality-gates.json");

    let config: QualityGatesConfig;

    if (!fs.existsSync(qgPath)) {
      const playbookDir = path.join(targetDir, DEFAULT_PATHS.playbookDir);
      if (!fs.existsSync(playbookDir)) {
        fs.mkdirSync(playbookDir, { recursive: true });
      }
      const projectId = this.readProjectIdFromManifest(targetDir) || path.basename(targetDir);
      config = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
        schema_version: "1.0.0",
        project_id: projectId,
        default_profile: "standard",
        global_settings: {
          default_timeout_ms: 30000,
          max_concurrency: 4,
          mask_secrets: true,
          log_retention_runs: 5,
          max_journaled_log_bytes: 2097152,
          env_allowlist: ["NODE_ENV", "PATH"],
        },
        gates: [
          {
            stage: 4,
            stage_name: "Implementation & Verification",
            checks: [
              {
                id: "core-typecheck",
                name: "Base TypeScript Check",
                type: "build_typecheck",
                deliverable_id: "CODE-IMPL",
                command: "tsc",
                args: ["--noEmit"],
                severity: "blocking",
              },
            ],
          },
        ],
      };
    } else {
      let raw: string;
      try {
        raw = fs.readFileSync(qgPath, "utf-8");
        config = JSON.parse(raw) as QualityGatesConfig;
      } catch (err: unknown) {
        throw new StackError(
          "CONFIG_MALFORMED",
          `Cannot parse target quality-gates.json: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Determine target stacks
    let stacksToCompose = options.stackNames || [];
    if (stacksToCompose.length === 0) {
      const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
          stacksToCompose = m.technology_stacks || [];
        } catch {
          // ignore read error
        }
      }
    }

    if (stacksToCompose.length === 0) {
      return {
        success: true,
        targetDir,
        addedChecks: [],
        totalChecks: this.countTotalChecks(config),
        composedStacks: [],
      };
    }

    // Resolve dependencies topologically
    const resolvedStacks = this.resolveDependencies(stacksToCompose);

    const addedChecks: Array<{ stage: number; checkId: string; stackName: string }> = [];

    // Ensure gates array exists
    if (!config.gates) {
      config.gates = [];
    }

    for (const stackName of resolvedStacks) {
      const partial = this.loadStackQualityGates(stackName);

      for (const partialGate of partial.gates) {
        let targetGate = config.gates.find((g) => g.stage === partialGate.stage);
        if (!targetGate) {
          targetGate = {
            stage: partialGate.stage,
            stage_name: partialGate.stage_name || `Stage ${partialGate.stage}`,
            checks: [],
          };
          config.gates.push(targetGate);
        }

        const existingCheckIds = new Set(targetGate.checks.map((c) => c.id));

        for (const check of partialGate.checks) {
          if (existingCheckIds.has(check.id)) {
            // Already present; check if identical or conflicting
            const existingCheck = targetGate.checks.find((c) => c.id === check.id);
            if (existingCheck && existingCheck.command !== check.command) {
              throw new StackError(
                "GATE_COLLISION_DETECTED",
                `Check ID collision: '${check.id}' in stage ${partialGate.stage} conflicts with existing check command '${existingCheck.command}' vs '${check.command}'`
              );
            }
            continue;
          }

          targetGate.checks.push(check as QualityGateCheck);
          existingCheckIds.add(check.id);
          addedChecks.push({
            stage: partialGate.stage,
            checkId: check.id,
            stackName,
          });
        }

        // Deterministic sort within each stage: alphabetical by check ID
        targetGate.checks.sort((a, b) => a.id.localeCompare(b.id));
      }
    }

    // Deterministic sort of stages: ascending by stage number
    config.gates.sort((a, b) => a.stage - b.stage);

    // Validate the composed configuration against quality-gates.schema.json
    const validation = this.validator.validateQualityGates(config);
    if (!validation.valid) {
      throw new StackError(
        "GATE_VALIDATION_FAILED",
        `Composed quality-gates.json failed schema validation: ${validation.errors.map((e) => e.message).join("; ")}`,
        { errors: validation.errors }
      );
    }

    // Atomic write
    const tmpFile = `${qgPath}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), "utf-8");
      fs.renameSync(tmpFile, qgPath);
    } finally {
      if (fs.existsSync(tmpFile)) {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // ignore cleanup error
        }
      }
    }

    return {
      success: true,
      targetDir,
      addedChecks,
      totalChecks: this.countTotalChecks(config),
      composedStacks: resolvedStacks,
    };
  }

  /**
   * Retrieves merged RIF exclusions and patterns for all active stacks declared in project manifest.
   */
  getMergedRifPatterns(targetDir: string): {
    exclude_patterns: string[];
    text_patterns: string[];
    binary_patterns: string[];
  } {
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return { exclude_patterns: [], text_patterns: [], binary_patterns: [] };
    }

    let stacks: string[] = [];
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
      stacks = manifest.technology_stacks || [];
    } catch {
      return { exclude_patterns: [], text_patterns: [], binary_patterns: [] };
    }

    const excludeSet = new Set<string>();
    const textSet = new Set<string>();
    const binarySet = new Set<string>();

    for (const stackName of stacks) {
      try {
        const patterns = this.loadStackRifPatterns(stackName);
        for (const p of patterns.exclude_patterns || []) excludeSet.add(p);
        for (const p of patterns.text_patterns || []) textSet.add(p);
        for (const p of patterns.binary_patterns || []) binarySet.add(p);
      } catch {
        // ignore missing pattern files
      }
    }

    return {
      exclude_patterns: Array.from(excludeSet).sort(),
      text_patterns: Array.from(textSet).sort(),
      binary_patterns: Array.from(binarySet).sort(),
    };
  }

  private countTotalChecks(config: QualityGatesConfig): number {
    return (config.gates || []).reduce((sum, g) => sum + (g.checks ? g.checks.length : 0), 0);
  }

  private collectTemplateFiles(
    currentDir: string,
    templateRoot: string,
    results: Array<{ relPath: string; fullSource: string; destRelPath: string }>
  ): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(templateRoot, fullPath);

      if (entry.isDirectory()) {
        this.collectTemplateFiles(fullPath, templateRoot, results);
      } else if (entry.isFile()) {
        // Map package.json.template -> package.json and normalize to POSIX relative paths
        const destRel = relPath.endsWith(".template")
          ? relPath.slice(0, -".template".length)
          : relPath;

        results.push({
          relPath: relPath.replace(/\\/g, "/"),
          fullSource: fullPath,
          destRelPath: destRel.replace(/\\/g, "/"),
        });
      }
    }
  }

  private readProjectIdFromManifest(targetDir: string): string | null {
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
        return m.project_id || null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
