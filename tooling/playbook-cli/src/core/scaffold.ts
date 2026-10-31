import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS } from "../constants.js";
import type { ProjectManifest } from "../types/manifest.js";
import type { ProjectState } from "../types/state.js";
import { SchemaValidator } from "./validator.js";

export interface ScaffoldOptions {
  targetDir: string;
  manifest: ProjectManifest;
  state: ProjectState;
  force?: boolean;
  createGitkeeps?: boolean;
}

export interface ScaffoldResult {
  manifestPath: string;
  statePath: string;
  createdDirs: string[];
  overwritten: boolean;
}

export class OverwriteProtectionError extends Error {
  public readonly existingFiles: string[];
  constructor(message: string, existingFiles: string[]) {
    super(message);
    this.name = "OverwriteProtectionError";
    this.existingFiles = existingFiles;
  }
}

export class ProjectScaffolder {
  private validator: SchemaValidator;

  constructor(validator?: SchemaValidator) {
    this.validator = validator || new SchemaValidator();
  }

  /**
   * Checks whether governance files already exist in target directory.
   */
  public checkExisting(targetDir: string): { exists: boolean; files: string[] } {
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.manifestFile);
    const statePath = path.join(targetDir, DEFAULT_PATHS.stateFile);

    const existing: string[] = [];
    if (fs.existsSync(manifestPath)) {
      existing.push(manifestPath);
    }
    if (fs.existsSync(statePath)) {
      existing.push(statePath);
    }

    return {
      exists: existing.length > 0,
      files: existing,
    };
  }

  /**
   * Scaffolds downstream project directory layout and writes initial manifest and state.
   */
  public scaffold(options: ScaffoldOptions): ScaffoldResult {
    const { targetDir, manifest, state, force = false, createGitkeeps = true } = options;

    // 1. Overwrite Protection Guard
    const existing = this.checkExisting(targetDir);
    if (existing.exists && !force) {
      throw new OverwriteProtectionError(
        `Governance configuration already exists in ${targetDir} (${existing.files.map((f) => path.basename(f)).join(", ")} found). Initialization aborted to prevent state corruption. Pass --force to overwrite.`,
        existing.files
      );
    }

    // 2. Validate manifest and state against JSON schemas BEFORE touching disk
    const manifestValidation = this.validator.validateManifest(manifest);
    if (!manifestValidation.valid) {
      throw new Error(`Manifest schema validation failed:\n${manifestValidation.formattedErrors}`);
    }

    const stateValidation = this.validator.validateState(state);
    if (!stateValidation.valid) {
      throw new Error(`State schema validation failed:\n${stateValidation.formattedErrors}`);
    }

    // 3. Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 4. Create standard downstream directories per downstream-storage-convention.md
    const dirsToCreate = [
      path.join(targetDir, DEFAULT_PATHS.playbookDir),
      path.join(targetDir, DEFAULT_PATHS.logsDir),
      path.join(targetDir, DEFAULT_PATHS.docsRoot),
      path.join(targetDir, DEFAULT_PATHS.prdDir),
      path.join(targetDir, DEFAULT_PATHS.adrDir),
      path.join(targetDir, DEFAULT_PATHS.rfcDir),
      path.join(targetDir, DEFAULT_PATHS.gatesDir),
      path.join(targetDir, DEFAULT_PATHS.exceptionsDir),
    ];

    const gitkeepDirs = [
      path.join(targetDir, DEFAULT_PATHS.logsDir),
      path.join(targetDir, DEFAULT_PATHS.prdDir),
      path.join(targetDir, DEFAULT_PATHS.adrDir),
      path.join(targetDir, DEFAULT_PATHS.rfcDir),
      path.join(targetDir, DEFAULT_PATHS.gatesDir),
      path.join(targetDir, DEFAULT_PATHS.exceptionsDir),
    ];

    const manifestPath = path.join(targetDir, DEFAULT_PATHS.manifestFile);
    const statePath = path.join(targetDir, DEFAULT_PATHS.stateFile);

    const createdDirs: string[] = [];
    const createdFiles: string[] = [];

    try {
      for (const dir of dirsToCreate) {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          createdDirs.push(dir);
        }
      }

      // 5. Optionally place .gitkeep files in leaf documentation and log folders
      if (createGitkeeps) {
        for (const dir of gitkeepDirs) {
          const gitkeepFile = path.join(dir, ".gitkeep");
          if (!fs.existsSync(gitkeepFile)) {
            fs.writeFileSync(gitkeepFile, "", "utf-8");
            createdFiles.push(gitkeepFile);
          }
        }
      }

      // 6. Write manifest and state files
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
      createdFiles.push(manifestPath);

      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      createdFiles.push(statePath);

      return {
        manifestPath,
        statePath,
        createdDirs,
        overwritten: existing.exists && force,
      };
    } catch (err) {
      // Atomic Rollback: Clean up partially written files and empty directories
      for (const file of createdFiles) {
        try {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        } catch {
          // ignore cleanup errors
        }
      }
      for (const dir of [...createdDirs].reverse()) {
        try {
          if (fs.existsSync(dir)) {
            const contents = fs.readdirSync(dir);
            if (contents.length === 0) {
              fs.rmdirSync(dir);
            }
          }
        } catch {
          // ignore cleanup errors
        }
      }
      throw err;
    }
  }
}
