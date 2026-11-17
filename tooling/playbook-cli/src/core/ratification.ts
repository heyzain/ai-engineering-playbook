import { createHash } from "node:crypto";
import { isForbiddenAgentName } from "./controller/markdown-ast.js";

export const AMENDMENT = "AMEND-20261110-001";
export const RATIFICATION_PHRASE = `CONFIRM RATIFICATION ${AMENDMENT}`;

/** Canonicalization is deliberately restricted to ASCII exception-ID arrays. */
export function canonicalInventory(value: unknown): { json: string; sha256: string } {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !/^EXC-[0-9]{8}-[0-9]{3}$/.test(id)) ||
      new Set(value).size !== value.length || JSON.stringify(value) !== JSON.stringify([...value].sort())) {
    throw new Error("INVENTORY_INVALID: Expected unique, sorted ASCII exception IDs.");
  }
  const json = JSON.stringify(value);
  return { json, sha256: createHash("sha256").update(json).digest("hex") };
}

/** No isTTY injection or command-line override is accepted by the executable. */
export function assertRatificationTerminal(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("TTY_REQUIRED: Ratification requires an actual operator terminal.");
  }
}

export function assertRatifier(name: string, role: string, phrase: string): void {
  if (!/^[A-Za-z][A-Za-z .'-]{2,100}$/.test(name) || isForbiddenAgentName(name) || /\bcodex\b/i.test(name)) {
    throw new Error("RATIFIER_INVALID: Supply a substantive operator name, not an agent label.");
  }
  if (role !== "Lead Architect") throw new Error("ROLE_REQUIRED: Declare Lead Architect authority.");
  if (phrase !== RATIFICATION_PHRASE) throw new Error("CONFIRMATION_MISMATCH: Exact amendment phrase required.");
}

/** Bootstrap supports this repository's empty inventory, not legacy authority migration. */
export function assertNoLegacyWaivers(state: unknown): void {
  const detail = (state as {current_stage_detail?: {exceptions?: {status?: string}[]; deliverables?: {status?: string}[]}})?.current_stage_detail;
  if (!detail || !Array.isArray(detail.exceptions) || !Array.isArray(detail.deliverables)) {
    throw new Error("STATE_INVALID: Stage detail, exceptions and deliverables are required.");
  }
  if (detail.exceptions.some((item) => item.status === "active") || detail.deliverables.some((item) => item.status === "waived")) {
    throw new Error("LEGACY_WAIVERS_PRESENT: Bootstrap cannot ratify a legacy migration; explicit reviewed inventory binding is required.");
  }
}

export interface RatificationBinding {
  commit: string;
  tree: string;
  inventorySha256: string;
  blobs: Record<string, string>;
  ratifier: string;
  role: string;
  ratifiedAt: string;
}

/** Rendering is pure; creating documentary text alone is never authorization. */
export function ratificationRecord(binding: RatificationBinding): string {
  return `# Documentary ratification: ${AMENDMENT}\n\n` +
    "Operator-attested Level A, isolated local single-developer use only. This is not authenticated identity. Level B assurance is not established.\n\n" +
    "```json\n" + JSON.stringify({
      amendment_id: AMENDMENT, decision: "ratified_for_local_use", assurance: "Level A",
      ratified_commit_sha: binding.commit, ratified_tree_sha: binding.tree,
      inventory_sha256: binding.inventorySha256, specification_blobs: binding.blobs,
      ratifier: binding.ratifier, role: binding.role, ratified_at: binding.ratifiedAt,
      confirmation: RATIFICATION_PHRASE,
    }, null, 2) + "\n```\n\nThe operator reviewed the exact commit, tree and empty inventory in an interactive terminal. This record does not waive a deliverable, advance a stage, migrate schemas, or activate remote/team waiver authority. Future consumers must reverify the referenced Git objects and inventory; file existence alone is insufficient.\n";
}
