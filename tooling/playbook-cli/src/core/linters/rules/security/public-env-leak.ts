import path from "node:path";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";
import {
  redactSecretValue,
  SENSITIVE_KEYWORD_REGEX,
  PRIVATE_KEY_BLOCK_REGEX,
  KNOWN_PLACEHOLDER_REGEX,
  isHighEntropySecret,
} from "./helpers.js";

const LIVE_CREDENTIAL_PATTERNS = [
  // GitHub tokens (classic and fine-grained)
  /^gh[pous]_[A-Za-z0-9_]{36,}/,
  // AWS Access Key ID
  /^AKIA[0-9A-Z]{16}$/,
  // Stripe live secret key
  /^sk_live_[0-9a-zA-Z]{24,}/,
  // Slack token
  /^xox[baprs]-[0-9a-zA-Z]{10,}/,
  // OpenAI / Anthropic key
  /^sk-[A-Za-z0-9_-]{32,}/,
  // JWT token
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // Database connection string with plaintext credentials
  /^(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:(?!password|changeme|xxx|dummy|<[^>]+>)[^@\s]+@[^\s]+/i,
];

/**
 * Checks whether a value matches recognized live credential formats.
 */
function isLiveCredential(val: string): boolean {
  const trimmed = val.trim();
  for (const pat of LIVE_CREDENTIAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return true;
    }
  }
  return false;
}

export const ruleSecPublicEnvLeak: GovernanceRule = {
  id: "RULE-SEC-PUBLIC-ENV-LEAK",
  category: "security",
  name: "Public Environment Variable & Secret Leak Detection",
  description:
    "Detects high-entropy private credentials, API keys, private keys, database connection strings, or password variables assigned to EXPO_PUBLIC_*, NEXT_PUBLIC_*, or unencrypted .env files.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: [".env*", "**/*.env*", "stacks/**/.env*"],
  evaluationMethod: "regex_pattern",
  version: "1.0.0",
  remediation:
    "Move private secrets to secure backend environments or secrets management; never expose credentials via public client prefixes (NEXT_PUBLIC_*, EXPO_PUBLIC_*).",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const envFiles = context.listFiles([".env*", "**/*.env*", "stacks/**/.env*"], []);

    if (envFiles.length === 0) {
      return findings;
    }

    for (const filePath of envFiles) {
      const baseName = path.posix.basename(filePath);
      const isExampleFile =
        baseName.endsWith(".example") ||
        baseName.endsWith(".sample") ||
        baseName === ".env.template";

      let content = "";
      try {
        content = context.readFile(filePath);
      } catch {
        continue;
      }

      if (!content.trim()) {
        continue;
      }

      // ── 1. PEM Cryptographic Private Key Block Check ─────────────────────
      if (PRIVATE_KEY_BLOCK_REGEX.test(content)) {
        const lines = content.split(/\r?\n/);
        let keyBlockLine = 1;
        for (let i = 0; i < lines.length; i++) {
          if (PRIVATE_KEY_BLOCK_REGEX.test(lines[i])) {
            keyBlockLine = i + 1;
            break;
          }
        }

        findings.push({
          ruleId: ruleSecPublicEnvLeak.id,
          diagnosticCode: "PUBLIC_ENV_SECRET_LEAK",
          severity: ruleSecPublicEnvLeak.severity,
          enforcement: ruleSecPublicEnvLeak.defaultEnforcement,
          message: `Embedded private cryptographic key block detected in environment file '${filePath}'. Private keys must never be committed to repository environment files.`,
          filePath,
          line: keyBlockLine,
          column: 1,
          expected: "No private cryptographic key blocks in environment files",
          actual: "-----BEGIN [REDACTED] PRIVATE KEY-----",
          remediation: `Remove private key from '${filePath}' and store in a secure vault/KMS.`,
          blocksOperation: true,
        });
      }

      // ── 2. Line-by-Line Key/Value Secret Analysis ─────────────────────────
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i].trim();
        if (!rawLine || rawLine.startsWith("#")) {
          continue;
        }

        const eqIdx = rawLine.indexOf("=");
        if (eqIdx <= 0) {
          continue;
        }

        let key = rawLine.slice(0, eqIdx).trim();
        if (key.startsWith("export ")) {
          key = key.slice("export ".length).trim();
        }

        let val = rawLine.slice(eqIdx + 1).trim();
        // Strip outer quotes if present
        if (
          (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
          (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
        ) {
          val = val.slice(1, -1).trim();
        }

        const isPublicPrefix =
          key.startsWith("NEXT_PUBLIC_") || key.startsWith("EXPO_PUBLIC_");

        // Scenario A: Sensitive variable exposed with public client prefix
        if (isPublicPrefix) {
          const afterPrefix = key.replace(/^(NEXT_PUBLIC_|EXPO_PUBLIC_)/, "");
          const isSensitiveKey = SENSITIVE_KEYWORD_REGEX.test(afterPrefix);
          const isHighEntropy = isHighEntropySecret(val);
          const isLiveCred = isLiveCredential(val);

          if (isSensitiveKey || isHighEntropy || isLiveCred) {
            findings.push({
              ruleId: ruleSecPublicEnvLeak.id,
              diagnosticCode: "PUBLIC_ENV_SECRET_LEAK",
              severity: ruleSecPublicEnvLeak.severity,
              enforcement: ruleSecPublicEnvLeak.defaultEnforcement,
              message: `Prohibited sensitive credential '${key}' declared with public client bundle prefix in '${filePath}'. Variables with 'NEXT_PUBLIC_' or 'EXPO_PUBLIC_' are inlined into client JavaScript bundles and must never contain private secrets, keys, or passwords.`,
              filePath,
              line: i + 1,
              column: 1,
              expected: "Private backend environment variable without client prefix, or public non-sensitive configuration",
              actual: `${key}=${redactSecretValue(val)}`,
              remediation: `Remove public prefix from '${key}' in '${filePath}' and keep private credentials strictly on the server.`,
              blocksOperation: true,
            });
            continue;
          }
        }

        // Scenario B: Live high-entropy credential or live token format in ANY file (including .env.example)
        if (isLiveCredential(val) || isHighEntropySecret(val)) {
          findings.push({
            ruleId: ruleSecPublicEnvLeak.id,
            diagnosticCode: "PUBLIC_ENV_SECRET_LEAK",
            severity: ruleSecPublicEnvLeak.severity,
            enforcement: ruleSecPublicEnvLeak.defaultEnforcement,
            message: `Actual live credential detected for '${key}' in environment file '${filePath}'. Genuine secrets must never be committed to source control.`,
            filePath,
            line: i + 1,
            column: 1,
            expected: isExampleFile ? `Placeholder value for '${key}' (e.g. 'your-secret-here')` : "Empty or encrypted secret reference",
            actual: `${key}=${redactSecretValue(val)}`,
            remediation: `Revoke this credential immediately, rotate the secret, and use placeholder documentation.`,
            blocksOperation: true,
          });
          continue;
        }

        // Scenario C: Unencrypted sensitive credentials in non-example environment files
        if (!isExampleFile && SENSITIVE_KEYWORD_REGEX.test(key)) {
          // If value is non-empty and not a placeholder
          if (val.length > 0 && !KNOWN_PLACEHOLDER_REGEX.test(val)) {
            findings.push({
              ruleId: ruleSecPublicEnvLeak.id,
              diagnosticCode: "PUBLIC_ENV_SECRET_LEAK",
              severity: ruleSecPublicEnvLeak.severity,
              enforcement: ruleSecPublicEnvLeak.defaultEnforcement,
              message: `Sensitive credential '${key}' detected in unencrypted environment file '${filePath}'. Plaintext secrets in version-controlled environment files violate credential hygiene policies.`,
              filePath,
              line: i + 1,
              column: 1,
              expected: "Secrets managed via secure environment variables or vault references",
              actual: `${key}=${redactSecretValue(val)}`,
              remediation: `Remove '${key}' from '${filePath}' and inject via secure CI/CD secrets or cloud secret managers.`,
              blocksOperation: true,
            });
          }
        }
      }
    }

    return findings;
  },
};
