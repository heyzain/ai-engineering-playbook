import { LinterError } from "./errors.js";
import { validateSeverity, validateEnforcement } from "./enforcement.js";
import type { GovernanceRule } from "./types.js";

export const RULE_ID_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;

/**
 * Validates a GovernanceRule definition before registration.
 */
export function validateRuleDefinition(rule: unknown): asserts rule is GovernanceRule {
  if (!rule || typeof rule !== "object") {
    throw new LinterError("INVALID_RULE_DEFINITION", "Rule definition must be a non-null object.");
  }

  const r = rule as Partial<GovernanceRule>;

  if (typeof r.id !== "string" || !r.id.trim()) {
    throw new LinterError("INVALID_RULE_ID", "Rule ID must be a non-empty string.");
  }

  const trimmedId = r.id.trim();
  if (!RULE_ID_PATTERN.test(trimmedId) || trimmedId.length < 3) {
    throw new LinterError(
      "INVALID_RULE_ID",
      `Invalid rule identifier '${trimmedId}'. Must be uppercase alphanumeric with hyphens (e.g. 'RULE-DOC-REF-INTEGRITY').`,
      { id: trimmedId }
    );
  }

  if (typeof r.category !== "string" || !r.category.trim()) {
    throw new LinterError("INVALID_RULE_DEFINITION", `Rule '${trimmedId}' must declare a valid category.`);
  }

  if (typeof r.name !== "string" || !r.name.trim()) {
    throw new LinterError("INVALID_RULE_DEFINITION", `Rule '${trimmedId}' must declare a human-readable name.`);
  }

  if (typeof r.description !== "string" || !r.description.trim()) {
    throw new LinterError("INVALID_RULE_DEFINITION", `Rule '${trimmedId}' must declare a description.`);
  }

  validateSeverity(r.severity);
  validateEnforcement(r.defaultEnforcement);

  if (!Array.isArray(r.targetGlobs) || r.targetGlobs.length === 0) {
    throw new LinterError(
      "INVALID_RULE_DEFINITION",
      `Rule '${trimmedId}' must declare at least one target glob pattern in targetGlobs.`
    );
  }

  for (const glob of r.targetGlobs) {
    if (typeof glob !== "string" || !glob.trim()) {
      throw new LinterError(
        "INVALID_RULE_DEFINITION",
        `Rule '${trimmedId}' contains an invalid target glob pattern '${String(glob)}'.`
      );
    }
  }

  if (r.excludeGlobs !== undefined) {
    if (!Array.isArray(r.excludeGlobs)) {
      throw new LinterError(
        "INVALID_RULE_DEFINITION",
        `Rule '${trimmedId}' excludeGlobs must be an array of strings if provided.`
      );
    }
    for (const glob of r.excludeGlobs) {
      if (typeof glob !== "string" || !glob.trim()) {
        throw new LinterError(
          "INVALID_RULE_DEFINITION",
          `Rule '${trimmedId}' contains an invalid exclude glob pattern '${String(glob)}'.`
        );
      }
    }
  }

  if (typeof r.version !== "string" || !r.version.trim()) {
    throw new LinterError("INVALID_RULE_DEFINITION", `Rule '${trimmedId}' must declare a version string.`);
  }

  if (typeof r.evaluate !== "function") {
    throw new LinterError("INVALID_RULE_DEFINITION", `Rule '${trimmedId}' must provide an evaluate() function.`);
  }
}

/**
 * Deterministic registry managing governance rule definitions.
 */
export class RuleRegistry {
  private readonly rules = new Map<string, GovernanceRule>();

  /**
   * Registers a new governance rule.
   * Throws DUPLICATE_RULE_ID if a rule with the same ID is already registered.
   */
  public register(rule: GovernanceRule): void {
    validateRuleDefinition(rule);

    if (this.rules.has(rule.id)) {
      throw new LinterError(
        "DUPLICATE_RULE_ID",
        `Rule with ID '${rule.id}' is already registered in this registry. Rule IDs must be unique.`,
        { id: rule.id }
      );
    }

    this.rules.set(rule.id, Object.freeze({ ...rule }));
  }

  /**
   * Retrieves a rule by its ID, returning undefined if not found.
   */
  public get(ruleId: string): GovernanceRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Retrieves a rule by its ID or throws RULE_NOT_FOUND.
   */
  public getOrThrow(ruleId: string): GovernanceRule {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new LinterError("RULE_NOT_FOUND", `Rule with ID '${ruleId}' was not found in the registry.`, {
        ruleId,
      });
    }
    return rule;
  }

  /**
   * Checks whether a rule ID is registered.
   */
  public has(ruleId: string): boolean {
    return this.rules.has(ruleId);
  }

  /**
   * Returns all registered rules in deterministic order (sorted alphabetically by rule ID).
   */
  public list(): GovernanceRule[] {
    return Array.from(this.rules.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Filters rules based on a predicate, returning matches sorted alphabetically by rule ID.
   */
  public filter(predicate: (rule: GovernanceRule) => boolean): GovernanceRule[] {
    return Array.from(this.rules.values())
      .filter(predicate)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Returns the count of registered rules.
   */
  public get size(): number {
    return this.rules.size;
  }

  /**
   * Clears all registered rules (useful in test teardown).
   */
  public clear(): void {
    this.rules.clear();
  }
}
