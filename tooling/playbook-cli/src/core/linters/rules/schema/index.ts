import type { GovernanceRule } from "../../types.js";
import { ruleSchemaManifestValidity } from "./manifest-validity.js";
import { ruleSchemaStateValidity } from "./state-validity.js";
import { ruleSchemaGatesValidity } from "./gates-validity.js";
import { ruleCfgStackDeclaration } from "./stack-declaration.js";

export * from "./manifest-validity.js";
export * from "./state-validity.js";
export * from "./gates-validity.js";
export * from "./stack-declaration.js";
export * from "./helpers.js";

/**
 * All Category B Schema and Configuration Integrity rules.
 */
export const SCHEMA_RULES: GovernanceRule[] = [
  ruleSchemaManifestValidity,
  ruleSchemaStateValidity,
  ruleSchemaGatesValidity,
  ruleCfgStackDeclaration,
];
