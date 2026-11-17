import type { GovernanceRule } from "../../types.js";
import { ruleSecWorkflowPerms } from "./workflow-perms.js";
import { ruleSecActionPinning } from "./action-pinning.js";
import { ruleSecPrTargetBan } from "./pr-target-ban.js";
import { ruleSecPublicEnvLeak } from "./public-env-leak.js";

export {
  ruleSecWorkflowPerms,
  ruleSecActionPinning,
  ruleSecPrTargetBan,
  ruleSecPublicEnvLeak,
};

/**
 * All Category E Security & Workflow Governance Rules.
 */
export const SECURITY_RULES: readonly GovernanceRule[] = Object.freeze([
  ruleSecWorkflowPerms,
  ruleSecActionPinning,
  ruleSecPrTargetBan,
  ruleSecPublicEnvLeak,
]);
