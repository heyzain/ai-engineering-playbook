import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS } from "../constants.js";
import { SchemaValidator } from "../core/validator.js";

export interface ValidateCommandOptions {
  cwd?: string;
  target?: "manifest" | "state" | "all";
}

export function runValidate(options: ValidateCommandOptions = {}): {
  success: boolean;
  message: string;
} {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const validator = new SchemaValidator();
  const target = options.target || "all";

  const manifestPath = path.join(targetDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.join(targetDir, DEFAULT_PATHS.stateFile);

  const errors: string[] = [];

  if (target === "all" || target === "manifest") {
    if (!fs.existsSync(manifestPath)) {
      errors.push(`Manifest file not found at: ${manifestPath}`);
    } else {
      try {
        const manifestData = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const result = validator.validateManifest(manifestData);
        if (!result.valid) {
          errors.push(result.formattedErrors);
        } else {
          console.log(`[manifest] Valid: ${manifestPath}`);
        }
      } catch (err) {
        errors.push(`Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (target === "all" || target === "state") {
    if (!fs.existsSync(statePath)) {
      errors.push(`State file not found at: ${statePath}`);
    } else {
      try {
        const stateData = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        const result = validator.validateState(stateData);
        if (!result.valid) {
          errors.push(result.formattedErrors);
        } else {
          console.log(`[state] Valid: ${statePath}`);
        }
      } catch (err) {
        errors.push(`Failed to parse ${statePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    const message = errors.join("\n\n");
    console.error(message);
    return { success: false, message };
  }

  const successMessage = "All governance files conform to official JSON Schemas.";
  console.log(`\n✓ ${successMessage}`);
  return { success: true, message: successMessage };
}
