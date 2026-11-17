import type { GovernanceRule } from "../../types.js";
import { ruleStkCanonicalMetadata } from "./canonical-metadata.js";
import { ruleStkDependencyDag } from "./dependency-dag.js";
import { ruleStkPackageOverrides } from "./package-overrides.js";

export { ruleStkCanonicalMetadata, ruleStkDependencyDag, ruleStkPackageOverrides };

/**
 * All Category D Technology Stack Governance Rules.
 */
export const STACK_RULES: readonly GovernanceRule[] = Object.freeze([
  ruleStkCanonicalMetadata,
  ruleStkDependencyDag,
  ruleStkPackageOverrides,
]);
