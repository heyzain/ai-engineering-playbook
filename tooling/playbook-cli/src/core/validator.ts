import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidationResult, ValidationIssue } from "../types/validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SchemaValidator {
  private ajv: Ajv2020;
  private validateManifestFn: ValidateFunction;
  private validateStateFn: ValidateFunction;
  private manifestSchema: Record<string, unknown>;
  private stateSchema: Record<string, unknown>;

  constructor(customSchemaDir?: string) {
    const schemaDir = customSchemaDir || this.resolveSchemaDir();

    const manifestSchemaPath = path.join(schemaDir, "project-manifest.schema.json");
    const stateSchemaPath = path.join(schemaDir, "project-state.schema.json");

    if (!fs.existsSync(manifestSchemaPath)) {
      throw new Error(`Manifest schema not found at: ${manifestSchemaPath}`);
    }
    if (!fs.existsSync(stateSchemaPath)) {
      throw new Error(`State schema not found at: ${stateSchemaPath}`);
    }

    this.manifestSchema = JSON.parse(fs.readFileSync(manifestSchemaPath, "utf-8"));
    this.stateSchema = JSON.parse(fs.readFileSync(stateSchemaPath, "utf-8"));

    // Handle CJS/ESM interop
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvConstructor: any = Ajv2020 || (Ajv2020 as any).default;
    this.ajv = new AjvConstructor({
      allErrors: true,
      strict: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addFormatsFn: any = (addFormats as any).default || addFormats;
    addFormatsFn(this.ajv);

    this.validateManifestFn = this.ajv.compile(this.manifestSchema);
    this.validateStateFn = this.ajv.compile(this.stateSchema);
  }

  private resolveSchemaDir(): string {
    const candidateDirs = [
      path.resolve(__dirname, "../schemas"),
      path.resolve(__dirname, "../../schemas"),
      path.resolve(__dirname, "../../../../schemas"),
    ];

    for (const dir of candidateDirs) {
      if (fs.existsSync(path.join(dir, "project-manifest.schema.json"))) {
        return dir;
      }
    }

    throw new Error(
      `Could not locate JSON schemas directory. Checked candidate paths:\n${candidateDirs.join("\n")}`
    );
  }

  public validateManifest(data: unknown): ValidationResult {
    const valid = Boolean(this.validateManifestFn(data));
    const errors: ValidationIssue[] = [];

    if (!valid && this.validateManifestFn.errors) {
      for (const err of this.validateManifestFn.errors) {
        errors.push({
          instancePath: err.instancePath || "/",
          schemaPath: err.schemaPath || "",
          keyword: err.keyword || "unknown",
          message: err.message || "Unknown validation error",
          params: (err.params as Record<string, unknown>) || {},
        });
      }
    }

    return {
      valid,
      target: "manifest",
      errors,
      formattedErrors: this.formatErrors("manifest", errors),
    };
  }

  public validateState(data: unknown): ValidationResult {
    const valid = Boolean(this.validateStateFn(data));
    const errors: ValidationIssue[] = [];

    if (!valid && this.validateStateFn.errors) {
      for (const err of this.validateStateFn.errors) {
        errors.push({
          instancePath: err.instancePath || "/",
          schemaPath: err.schemaPath || "",
          keyword: err.keyword || "unknown",
          message: err.message || "Unknown validation error",
          params: (err.params as Record<string, unknown>) || {},
        });
      }
    }

    return {
      valid,
      target: "state",
      errors,
      formattedErrors: this.formatErrors("state", errors),
    };
  }

  public formatErrors(target: "manifest" | "state", errors: ValidationIssue[]): string {
    if (errors.length === 0) {
      return `[${target}] Schema validation passed.`;
    }

    const lines: string[] = [
      `[${target}] Schema validation failed with ${errors.length} error${errors.length > 1 ? "s" : ""}:`,
    ];

    for (const [index, err] of errors.entries()) {
      const field = err.instancePath === "/" || !err.instancePath ? "root" : err.instancePath;
      lines.push(`  ${index + 1}. Field: ${field} - ${err.message} (${err.keyword})`);
    }

    return lines.join("\n");
  }

  public getManifestSchema(): Record<string, unknown> {
    return this.manifestSchema;
  }

  public getStateSchema(): Record<string, unknown> {
    return this.stateSchema;
  }
}
