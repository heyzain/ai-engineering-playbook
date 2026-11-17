export type MobileRuleId =
  | "RULE-RN-COMPANION"
  | "RULE-RN-ACCESSIBILITY"
  | "RULE-MOB-SEC-STORAGE"
  | "RULE-EXPO-PLUGINS"
  | "RULE-EXPO-ROUTER";

export type RuleFindingSeverity = "blocking" | "warning";

export interface MobileRuleFinding {
  ruleId: MobileRuleId;
  code: string;
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
  severity: RuleFindingSeverity;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface MobileRuleEvaluationResult {
  ruleId: MobileRuleId;
  passed: boolean;
  findings: MobileRuleFinding[];
  scannedFilesCount: number;
  skippedFilesCount: number;
  executionTimeMs: number;
  limitations: string[];
}

export interface MobileRifSuiteResult {
  passed: boolean;
  totalFindings: number;
  blockingFindings: number;
  warningFindings: number;
  results: Record<MobileRuleId, MobileRuleEvaluationResult>;
}

export interface EvaluateMobileRifOptions {
  projectDir: string;
  rules?: MobileRuleId[];
  maxFileSizeBytes?: number;
  customExclusions?: string[];
  platformExclusiveModules?: Record<string, "ios" | "android"> | string[];
}
