export interface ValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  target: "manifest" | "state";
  errors: ValidationIssue[];
  formattedErrors: string;
}
