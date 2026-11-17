export interface StackMetadata {
  id: string;
  name: string;
  version: string;
  frameworkTarget: string;
  description: string;
  dependencies?: string[];
  compatibility?: Record<string, string>;
  packageOverrides?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    removeDependencies?: string[];
    removeDevDependencies?: string[];
  };
}

export interface StackInfo extends StackMetadata {
  hasTemplate: boolean;
  hasQualityGates: boolean;
  hasRifPatterns: boolean;
  specPath: string;
}

export interface StackPartialGate {
  stage: number;
  stage_name?: string;
  checks: Array<{
    id: string;
    name: string;
    type: string;
    deliverable_id: string;
    command: string;
    args: string[];
    inputs?: string[];
    exclude?: string[];
    text_patterns?: string[];
    binary_patterns?: string[];
    timeout_ms?: number;
    severity?: "blocking" | "warning" | "advisory";
  }>;
}

export interface StackQualityGatesPartial {
  stack: string;
  version: string;
  dependencies?: string[];
  gates: StackPartialGate[];
}

export interface StackRifPatterns {
  stack: string;
  version: string;
  dependencies?: string[];
  rules?: string[];
  platform_exclusive_modules?: Record<string, "ios" | "android"> | string[];
  text_patterns?: string[];
  binary_patterns?: string[];
  exclude_patterns?: string[];
}

export interface ScaffoldStackOptions {
  stackName: string;
  targetDir: string;
  projectId?: string;
  force?: boolean;
  autoResolveDependencies?: boolean;
}

export interface ScaffoldStackResult {
  success: boolean;
  stackName: string;
  targetDir: string;
  createdFiles: string[];
  overwrittenFiles: string[];
  manifestUpdated: boolean;
  appliedStacks?: string[];
}

export interface ComposeQualityGatesOptions {
  targetDir: string;
  stackNames?: string[];
}

export interface ComposeQualityGatesResult {
  success: boolean;
  targetDir: string;
  addedChecks: Array<{ stage: number; checkId: string; stackName: string }>;
  totalChecks: number;
  composedStacks?: string[];
}
