import YAML from "yaml";

export interface ParsedYamlResult {
  readonly success: boolean;
  readonly doc?: YAML.Document;
  readonly lineCounter?: YAML.LineCounter;
  readonly syntaxError?: Error;
}

/**
 * Safely parses a YAML string into a Document with CST line/column tracking.
 * Catches syntax errors without throwing, guaranteeing resilient lint evaluation.
 */
export function parseYamlSafely(content: string): ParsedYamlResult {
  try {
    const lineCounter = new YAML.LineCounter();
    const doc = YAML.parseDocument(content, { lineCounter, keepSourceTokens: true });
    if (doc.errors && doc.errors.length > 0) {
      return {
        success: false,
        doc,
        lineCounter,
        syntaxError: doc.errors[0],
      };
    }
    return {
      success: true,
      doc,
      lineCounter,
    };
  } catch (err: unknown) {
    return {
      success: false,
      syntaxError: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Extracts 1-based line and column coordinates from a YAML AST node or pair.
 */
export function getYamlNodeLocation(
  node: unknown,
  lineCounter?: YAML.LineCounter
): { line: number; column: number } {
  if (!lineCounter || !node || typeof node !== "object") {
    return { line: 1, column: 1 };
  }

  const candidate = node as { range?: [number, number, number?] };
  if (Array.isArray(candidate.range) && candidate.range.length >= 1) {
    const offset = candidate.range[0];
    const pos = lineCounter.linePos(offset);
    return {
      line: Math.max(1, pos.line),
      column: Math.max(1, pos.col),
    };
  }

  return { line: 1, column: 1 };
}

/**
 * Canonical 40-character hexadecimal commit SHA pattern.
 * Third-party actions must strictly pin to this format to eliminate tag-mutation vulnerabilities.
 */
export const COMMIT_SHA_40_REGEX = /^[a-fA-F0-9]{40}$/;

/**
 * Evaluates whether an action reference is a local repository action (e.g. './.github/actions/foo').
 */
export function isLocalAction(usesStr: string): boolean {
  const trimmed = (usesStr || "").trim();
  return trimmed.startsWith("./") || trimmed.startsWith("../");
}

/**
 * Evaluates whether an action reference is a Docker container action (e.g. 'docker://alpine:3.18').
 */
export function isDockerAction(usesStr: string): boolean {
  const trimmed = (usesStr || "").trim();
  return trimmed.startsWith("docker://");
}

/**
 * Validates whether an action reference specifies a third-party GitHub repository action.
 */
export function isThirdPartyAction(usesStr: string): boolean {
  const trimmed = (usesStr || "").trim();
  if (!trimmed) return false;
  if (isLocalAction(trimmed) || isDockerAction(trimmed)) {
    return false;
  }
  return trimmed.includes("/");
}

/**
 * Redacts a secret string for safe emission in findings and diagnostics.
 * Preserves a short prefix or URI schema for debuggability while
 * concealing all secret entropy. Never prints plaintext secrets.
 */
export function redactSecretValue(val: string): string {
  if (!val) return "[REDACTED]";
  const trimmed = val.trim();
  if (trimmed.length <= 4) {
    return "***";
  }
  if (trimmed.includes("://") && trimmed.includes("@")) {
    return trimmed.replace(/:[^:@\s]+@/, ":***@");
  }
  if (trimmed.startsWith("ghp_") || trimmed.startsWith("gho_") || trimmed.startsWith("ghs_")) {
    return `${trimmed.slice(0, 4)}***`;
  }
  if (trimmed.startsWith("sk_live_") || trimmed.startsWith("sk_test_")) {
    return `${trimmed.slice(0, 8)}***`;
  }
  if (trimmed.startsWith("AKIA")) {
    return `${trimmed.slice(0, 4)}***`;
  }
  return `${trimmed.slice(0, 2)}***`;
}

/**
 * Calculates Shannon entropy for a given string to identify random, high-entropy secrets.
 * Formula: H = -sum(p * log2(p))
 */
export function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Checks whether a string value qualifies as a high-entropy secret token.
 * Requires:
 * 1. Sufficient length (at least 20 chars).
 * 2. High Shannon entropy (>= 4.2).
 * 3. Not a standard URL, email, filesystem path, or known benign placeholder.
 * 4. Not prose with whitespace.
 */
export function isHighEntropySecret(val: string): boolean {
  const trimmed = val.trim();
  if (trimmed.length < 20) return false;
  if (KNOWN_PLACEHOLDER_REGEX.test(trimmed)) return false;
  // Ignore URIs with schemes (http, https, postgresql, mongodb, etc.), emails, and filesystem paths
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:|\/|[a-zA-Z]:\\)/i.test(trimmed)) return false;
  // Ignore human-readable prose / sentences with whitespace
  if (trimmed.includes(" ")) return false;
  const entropy = calculateShannonEntropy(trimmed);
  return entropy >= 4.2;
}

/**
 * Sensitive credential keywords that indicate high-risk secret declarations.
 */
export const SENSITIVE_KEYWORD_REGEX =
  /(SECRET|PRIVATE|PASSWD|PASSWORD|TOKEN|CREDENTIAL|SIGNING_KEY|API_KEY|PRIVATE_KEY|AUTH_SECRET|MASTER_KEY)/i;

/**
 * Standard PEM private cryptographic key header block.
 */
export const PRIVATE_KEY_BLOCK_REGEX =
  /-----BEGIN\s+(?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)?\s*PRIVATE\s+KEY-----/;

/**
 * Known benign dummy placeholder tokens used in template documentation (.env.example).
 */
export const KNOWN_PLACEHOLDER_REGEX =
  /^(?:TODO|TBD|your[_-]?secret|your[_-]?token|your[_-]?key|your[_-]?password|change[_-]?me|placeholder|example|dummy|xxx|<[^>]+>|""|'')$/i;
