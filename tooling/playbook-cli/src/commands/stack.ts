import fs from "node:fs";
import path from "node:path";
import { StackManager, StackError } from "../core/stacks/stack-manager.js";
import type { StackInfo } from "../types/stacks.js";

export interface StackCommandOptions {
  cwd?: string;
  force?: boolean;
  json?: boolean;
  stacksDir?: string;
  compose?: boolean;
  stacks?: string[];
}

export function runStackList(options: StackCommandOptions = {}): {
  success: boolean;
  exitCode: number;
  data?: StackInfo[];
  error?: string;
} {
  const manager = new StackManager({ stacksDir: options.stacksDir });

  try {
    const stacks = manager.listStacks();

    if (options.json) {
      console.log(JSON.stringify({ success: true, count: stacks.length, stacks }, null, 2));
    } else {
      console.log("\nSupported Technology Stacks:");
      console.log("============================");
      if (stacks.length === 0) {
        console.log("  No technology stacks discovered.");
      } else {
        for (const stack of stacks) {
          console.log(`\n• ${stack.name} [${stack.id}] (v${stack.version})`);
          console.log(`  Target:       ${stack.frameworkTarget}`);
          console.log(`  Dependencies: ${stack.dependencies && stack.dependencies.length > 0 ? stack.dependencies.join(", ") : "None"}`);
          console.log(`  Template:     ${stack.hasTemplate ? "Available" : "None"}`);
          console.log(`  Gates:        ${stack.hasQualityGates ? "Available" : "None"}`);
          console.log(`  RIF Patterns: ${stack.hasRifPatterns ? "Available" : "None"}`);
        }
      }
      console.log("");
    }

    return { success: true, exitCode: 0, data: stacks };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(`\n✖ Error listing stacks: ${msg}`);
    }
    return { success: false, exitCode: 1, error: msg };
  }
}

export function runStackApply(
  stackName: string,
  options: StackCommandOptions = {}
): {
  success: boolean;
  exitCode: number;
  data?: unknown;
  error?: string;
} {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const manager = new StackManager({ stacksDir: options.stacksDir });

  try {
    // 1. Validate stack identifier
    const validatedId = manager.validateStackId(stackName);

    // 2. Scaffold template files
    const scaffoldResult = manager.scaffoldStack({
      stackName: validatedId,
      targetDir,
      force: options.force,
    });

    // 3. Compose quality gates if quality-gates.json exists and not disabled
    let composeResult = null;
    const qgPath = path.join(targetDir, ".playbook", "quality-gates.json");
    if (options.compose !== false && fs.existsSync(qgPath)) {
      composeResult = manager.composeQualityGates({
        targetDir,
        stackNames: scaffoldResult.appliedStacks || [validatedId],
      });
    }

    const resultData = {
      ...scaffoldResult,
      qualityGatesComposed: composeResult !== null,
      composedGates: composeResult?.addedChecks || [],
    };

    if (options.json) {
      console.log(JSON.stringify(resultData, null, 2));
    } else {
      const depMsg =
        scaffoldResult.appliedStacks && scaffoldResult.appliedStacks.length > 1
          ? ` (resolved: ${scaffoldResult.appliedStacks.join(" -> ")})`
          : "";
      console.log(`\n✔ Successfully applied '${validatedId}' technology stack${depMsg} to ${targetDir}`);
      if (scaffoldResult.appliedStacks && scaffoldResult.appliedStacks.length > 1) {
        console.log(`  Applied stacks:    ${scaffoldResult.appliedStacks.join(", ")}`);
      }
      console.log(`  Files created:     ${scaffoldResult.createdFiles.length}`);
      if (scaffoldResult.overwrittenFiles.length > 0) {
        console.log(`  Files overwritten: ${scaffoldResult.overwrittenFiles.length}`);
      }
      console.log(`  Manifest updated:  ${scaffoldResult.manifestUpdated ? "Yes" : "No (.playbook/manifest.json not found)"}`);
      if (composeResult) {
        console.log(`  Quality gates:     ${composeResult.addedChecks.length} checks composed`);
      }
      console.log("");
    }

    return { success: true, exitCode: 0, data: resultData };
  } catch (err: unknown) {
    const code = err instanceof StackError ? err.code : "STACK_ERROR";
    const msg = err instanceof Error ? err.message : String(err);
    const details = err instanceof StackError ? err.details : undefined;

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message: msg, details }, null, 2));
    } else {
      console.error(`\n✖ [${code}] ${msg}`);
      if (code === "COLLISION_DETECTED" && details && typeof details === "object" && "conflictingFiles" in details) {
        console.error("  Conflicting files:");
        for (const f of (details as { conflictingFiles: string[] }).conflictingFiles) {
          console.error(`    - ${f}`);
        }
        console.error("  Use --force to overwrite existing files.");
      }
    }
    return { success: false, exitCode: 1, error: code };
  }
}

export function runStackCompose(options: StackCommandOptions = {}): {
  success: boolean;
  exitCode: number;
  data?: unknown;
  error?: string;
} {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const manager = new StackManager({ stacksDir: options.stacksDir });

  try {
    const result = manager.composeQualityGates({
      targetDir,
      stackNames: options.stacks,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✔ Quality gate composition complete for ${targetDir}`);
      console.log(`  Added checks: ${result.addedChecks.length}`);
      for (const check of result.addedChecks) {
        console.log(`    - [Stage ${check.stage}] ${check.checkId} (${check.stackName})`);
      }
      console.log(`  Total checks: ${result.totalChecks}\n`);
    }

    return { success: true, exitCode: 0, data: result };
  } catch (err: unknown) {
    const code = err instanceof StackError ? err.code : "COMPOSE_ERROR";
    const msg = err instanceof Error ? err.message : String(err);

    if (options.json) {
      console.log(JSON.stringify({ success: false, error: code, message: msg }, null, 2));
    } else {
      console.error(`\n✖ [${code}] ${msg}\n`);
    }
    return { success: false, exitCode: 1, error: code };
  }
}
