/**
 * Safe Environment Variable Helper
 * Ensures public environment variables are explicitly declared and validated,
 * preventing accidental server secret leakage into browser bundles (SEC-NEXT-01).
 */

export function getPublicEnv(key: string, defaultValue = ""): string {
  if (!key.startsWith("NEXT_PUBLIC_")) {
    throw new Error(
      `[SEC-NEXT-01] Forbidden access: '${key}' does not have the 'NEXT_PUBLIC_' prefix. Server secrets must never be accessed via client helpers.`
    );
  }

  // Reject accidental sensitive keys with public prefix
  if (/(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i.test(key)) {
    throw new Error(
      `[SEC-NEXT-01] Forbidden variable name: '${key}' contains sensitive token terms. Secrets cannot be exposed with 'NEXT_PUBLIC_'.`
    );
  }

  return process.env[key] ?? defaultValue;
}
