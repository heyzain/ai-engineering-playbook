import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PATHS } from "../../constants.js";
import type { ProjectManifest } from "../../types/manifest.js";
import type { ProjectState } from "../../types/state.js";
import type { InspectionRawData } from "./types.js";

/**
 * Safely and strictly reads project governance files in read-only mode.
 * Never modifies or creates files on disk.
 */
export function inspectRawProject(targetDir: string): InspectionRawData {
  const resolvedDir = path.resolve(targetDir);
  const manifestPath = path.join(resolvedDir, DEFAULT_PATHS.manifestFile);
  const statePath = path.join(resolvedDir, DEFAULT_PATHS.stateFile);

  const manifestExists = fs.existsSync(manifestPath);
  const stateExists = fs.existsSync(statePath);

  let manifestRaw: string | null = null;
  let manifestParsed: ProjectManifest | null = null;
  let manifestParseError: string | null = null;

  if (manifestExists) {
    try {
      manifestRaw = fs.readFileSync(manifestPath, "utf-8");
      manifestParsed = JSON.parse(manifestRaw) as ProjectManifest;
    } catch (err: unknown) {
      manifestParseError = err instanceof Error ? err.message : String(err);
    }
  }

  let stateRaw: string | null = null;
  let stateParsed: ProjectState | null = null;
  let stateParseError: string | null = null;

  if (stateExists) {
    try {
      stateRaw = fs.readFileSync(statePath, "utf-8");
      stateParsed = JSON.parse(stateRaw) as ProjectState;
    } catch (err: unknown) {
      stateParseError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    targetDir: resolvedDir,
    manifestPath,
    statePath,
    manifestExists,
    stateExists,
    manifestRaw,
    stateRaw,
    manifestParsed,
    stateParsed,
    manifestParseError,
    stateParseError,
  };
}
