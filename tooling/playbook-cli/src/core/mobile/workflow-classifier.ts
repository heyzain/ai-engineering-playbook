import fs from "node:fs";
import path from "node:path";
import type { ProjectManifest } from "../../types/manifest.js";
import { DEFAULT_PATHS } from "../../constants.js";

export type MobileWorkflowType =
  | "expo-managed"
  | "expo-committed-cng"
  | "bare-react-native";

export interface MobileWorkflowClassificationResult {
  status: "COMPLETE" | "INCOMPLETE";
  workflow?: MobileWorkflowType;
  errorCode?: "AMBIGUOUS_WORKFLOW_CONFIGURATION";
  message?: string;
  source: "manifest" | "introspection";
  details?: Record<string, unknown>;
}

/**
 * Checks if native folders (ios/ or android/) exist on disk and are tracked/committed to Git
 * (not ephemeral / not gitignored).
 */
export function areNativeDirectoriesCommitted(projectDir: string): {
  exists: boolean;
  committed: boolean;
} {
  const iosPath = path.join(projectDir, "ios");
  const androidPath = path.join(projectDir, "android");
  const iosExists = fs.existsSync(iosPath) && fs.statSync(iosPath).isDirectory();
  const androidExists = fs.existsSync(androidPath) && fs.statSync(androidPath).isDirectory();

  if (!iosExists && !androidExists) {
    return { exists: false, committed: false };
  }

  // Check .gitignore
  const gitignorePath = path.join(projectDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    try {
      const gitignore = fs.readFileSync(gitignorePath, "utf-8");
      const lines = gitignore.split(/\r?\n/).map((l) => l.trim());

      // If both/any existing native dirs are ignored, they are ephemeral (Expo Managed)
      const isIosIgnored = lines.some((l) => /^\/?ios(\/|\*|$)/.test(l));
      const isAndroidIgnored = lines.some((l) => /^\/?android(\/|\*|$)/.test(l));

      if ((iosExists && isIosIgnored) || (androidExists && isAndroidIgnored)) {
        return { exists: true, committed: false };
      }
    } catch {
      // ignore read error
    }
  }

  // Native directories exist and are not gitignored -> committed CNG or bare RN
  return { exists: true, committed: true };
}

/**
 * Authoritative Mobile Workflow Classifier.
 *
 * Implements the three workflow categories:
 * 1. Expo Managed (Ephemeral CNG)
 * 2. Expo Prebuild / Committed CNG
 * 3. Bare React Native CLI
 *
 * Precedence Protocol:
 * - Phase 1: Authoritative Manifest Evaluation (.playbook/manifest.json)
 * - Phase 2: Conflict & Ambiguity Detection (Fail-Closed with AMBIGUOUS_WORKFLOW_CONFIGURATION / INCOMPLETE)
 * - Phase 3: Introspection Fallback (Manifest Uninitialized / Discovery)
 */
export function classifyMobileWorkflow(
  projectDir: string,
  manifest?: ProjectManifest
): MobileWorkflowClassificationResult {
  const targetDir = path.resolve(projectDir);
  let effectiveManifest: ProjectManifest | null = manifest || null;

  if (!effectiveManifest) {
    const manifestPath = path.join(targetDir, DEFAULT_PATHS.playbookDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        effectiveManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
      } catch {
        // malformed manifest handled by schema validator
      }
    }
  }

  // Inspect package.json
  let hasExpoInPackage = false;
  let hasRnInPackage = false;
  const pkgPath = path.join(targetDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      hasExpoInPackage = "expo" in allDeps;
      hasRnInPackage = "react-native" in allDeps;
    } catch {
      // ignore parse error
    }
  }

  // Inspect app.json / app.config
  const hasAppConfig =
    fs.existsSync(path.join(targetDir, "app.json")) ||
    fs.existsSync(path.join(targetDir, "app.config.js")) ||
    fs.existsSync(path.join(targetDir, "app.config.ts"));

  const nativeStatus = areNativeDirectoriesCommitted(targetDir);

  // ─────────────────────────────────────────────────────────────
  // Phase 1 & 2: Authoritative Manifest Evaluation & Ambiguity Check
  // ─────────────────────────────────────────────────────────────
  if (effectiveManifest) {
    const declaredStacks = effectiveManifest.technology_stacks || [];
    const hasExpoStack = declaredStacks.includes("expo");
    const hasBareRnStack = declaredStacks.includes("react-native") && !hasExpoStack;

    // Check manifest metadata override if present
    const declaredWorkflowMetadata = (effectiveManifest.metadata as any)?.mobile_workflow as
      | MobileWorkflowType
      | undefined;

    // Check Conflict: Manifest declares bare React Native but package.json contains 'expo' and app.json exists
    if (hasBareRnStack) {
      if (hasExpoInPackage && hasAppConfig) {
        return {
          status: "INCOMPLETE",
          errorCode: "AMBIGUOUS_WORKFLOW_CONFIGURATION",
          message:
            "Conflicting mobile workflow configuration: manifest declares bare React Native ('react-native'), but package.json contains 'expo' dependency and Expo configuration (app.json) is present on disk.",
          source: "manifest",
          details: {
            declaredStacks,
            hasExpoInPackage,
            hasAppConfig,
          },
        };
      }

      if (
        declaredWorkflowMetadata === "expo-managed" ||
        declaredWorkflowMetadata === "expo-committed-cng"
      ) {
        return {
          status: "INCOMPLETE",
          errorCode: "AMBIGUOUS_WORKFLOW_CONFIGURATION",
          message: `Conflicting mobile workflow configuration: manifest technology_stacks declares bare React Native, but metadata.mobile_workflow declares '${declaredWorkflowMetadata}'.`,
          source: "manifest",
          details: {
            declaredStacks,
            declaredWorkflowMetadata,
          },
        };
      }

      return {
        status: "COMPLETE",
        workflow: "bare-react-native",
        source: "manifest",
      };
    }

    // Check Conflict: Manifest declares 'expo' stack
    if (hasExpoStack) {
      // Must not lack 'expo' in package.json if package.json exists
      if (fs.existsSync(pkgPath) && !hasExpoInPackage) {
        return {
          status: "INCOMPLETE",
          errorCode: "AMBIGUOUS_WORKFLOW_CONFIGURATION",
          message:
            "Conflicting mobile workflow configuration: manifest declares 'expo' stack, but package.json lacks 'expo' dependency.",
          source: "manifest",
          details: {
            declaredStacks,
            hasExpoInPackage,
          },
        };
      }

      if (declaredWorkflowMetadata === "bare-react-native") {
        return {
          status: "INCOMPLETE",
          errorCode: "AMBIGUOUS_WORKFLOW_CONFIGURATION",
          message:
            "Conflicting mobile workflow configuration: manifest technology_stacks contains 'expo', but metadata.mobile_workflow declares 'bare-react-native'.",
          source: "manifest",
          details: {
            declaredStacks,
            declaredWorkflowMetadata,
          },
        };
      }

      // Check conflict between declaredWorkflowMetadata and native directories
      if (declaredWorkflowMetadata === "expo-managed" && nativeStatus.committed) {
        return {
          status: "INCOMPLETE",
          errorCode: "AMBIGUOUS_WORKFLOW_CONFIGURATION",
          message:
            "Conflicting mobile workflow configuration: manifest specifies 'expo-managed' workflow, but native ios/android directories are committed in Git.",
          source: "manifest",
          details: {
            declaredWorkflowMetadata,
            nativeStatus,
          },
        };
      }

      if (declaredWorkflowMetadata === "expo-committed-cng" && !nativeStatus.exists) {
        return {
          status: "INCOMPLETE",
          errorCode: "AMBIGUOUS_WORKFLOW_CONFIGURATION",
          message:
            "Conflicting mobile workflow configuration: manifest specifies 'expo-committed-cng' workflow, but native ios/android directories are absent from disk.",
          source: "manifest",
          details: {
            declaredWorkflowMetadata,
            nativeStatus,
          },
        };
      }

      // Determine managed vs committed CNG based on filesystem/git status or metadata
      let workflow: MobileWorkflowType;
      if (declaredWorkflowMetadata) {
        workflow = declaredWorkflowMetadata;
      } else if (nativeStatus.committed) {
        workflow = "expo-committed-cng";
      } else {
        workflow = "expo-managed";
      }

      return {
        status: "COMPLETE",
        workflow,
        source: "manifest",
        details: {
          nativeCommitted: nativeStatus.committed,
          hasAppConfig,
        },
      };
    }

    // Manifest exists but neither react-native nor expo declared
    return {
      status: "COMPLETE",
      workflow: undefined,
      source: "manifest",
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Phase 3: Introspection Fallback (Manifest Uninitialized)
  // ─────────────────────────────────────────────────────────────
  if (!fs.existsSync(pkgPath)) {
    return {
      status: "COMPLETE",
      workflow: undefined,
      source: "introspection",
    };
  }

  if (hasExpoInPackage) {
    const workflow: MobileWorkflowType = nativeStatus.committed
      ? "expo-committed-cng"
      : "expo-managed";

    return {
      status: "COMPLETE",
      workflow,
      source: "introspection",
      details: {
        nativeCommitted: nativeStatus.committed,
        hasAppConfig,
      },
    };
  }

  if (hasRnInPackage) {
    return {
      status: "COMPLETE",
      workflow: "bare-react-native",
      source: "introspection",
      details: {
        hasRnInPackage,
      },
    };
  }

  return {
    status: "COMPLETE",
    workflow: undefined,
    source: "introspection",
  };
}
