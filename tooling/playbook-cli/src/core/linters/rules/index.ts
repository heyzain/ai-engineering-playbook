export * from "./documentation/index.js";
export * from "./schema/index.js";
export * from "./invariants/index.js";
export * from "./stack/index.js";
export * from "./security/index.js";

import { DOCUMENTATION_RULES } from "./documentation/index.js";
import { SCHEMA_RULES } from "./schema/index.js";
import { INVARIANT_RULES } from "./invariants/index.js";
import { STACK_RULES } from "./stack/index.js";
import { SECURITY_RULES } from "./security/index.js";
import type { GovernanceRule } from "../types.js";

/**
 * Complete collection of all production governance rules currently implemented.
 */
export const ALL_PRODUCTION_RULES: readonly GovernanceRule[] = Object.freeze([
  ...DOCUMENTATION_RULES,
  ...SCHEMA_RULES,
  ...INVARIANT_RULES,
  ...STACK_RULES,
  ...SECURITY_RULES,
]);
