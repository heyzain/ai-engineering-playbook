export * from "./ref-integrity.js";
export * from "./adr-integrity.js";
export * from "./stage-bounds.js";
export * from "./mandatory-sections.js";
export * from "./deprecated-commands.js";

import { ruleDocRefIntegrity } from "./ref-integrity.js";
import { ruleDocAdrIntegrity } from "./adr-integrity.js";
import { ruleDocStageBounds } from "./stage-bounds.js";
import { ruleDocMandatorySections } from "./mandatory-sections.js";
import { ruleDocDeprecatedCommands } from "./deprecated-commands.js";
import type { GovernanceRule } from "../../types.js";

/**
 * All production rules in Category A (Documentation & Reference Consistency).
 */
export const DOCUMENTATION_RULES: readonly GovernanceRule[] = Object.freeze([
  ruleDocRefIntegrity,
  ruleDocAdrIntegrity,
  ruleDocStageBounds,
  ruleDocMandatorySections,
  ruleDocDeprecatedCommands,
]);
