#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { createHash } from "node:crypto";
import { SchemaValidator } from "../core/validator.js";
import { WriteAheadTransactionManager } from "../core/transaction/index.js";
import { AMENDMENT, RATIFICATION_PHRASE, canonicalInventory, assertRatificationTerminal,
  assertRatifier, assertNoLegacyWaivers, ratificationRecord } from "../core/ratification.js";

const INVENTORY = "docs/adr/amendment-grandfathered-inventory.json";
const RECORD = "docs/adr/RATIFY-20261110-001.md";
const BOUND_PATHS = [INVENTORY, "docs/adr/ADR-20261110-001-two-phase-exception-lifecycle.md",
  "docs/adr/ARCHITECTURE-SPEC.md", "docs/adr/ADR-20261117-001-release-closure.md",
  "docs/architecture/operational-controller/design.md", "governance/state-machine.md",
  "governance/ENGINEERING_CONTROLLER.md", "templates/exception-record-template.md",
  ".playbook/state.json", ".playbook/manifest.json"];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
}

function binding(root: string) {
  const commit = git(root, "rev-parse", "HEAD"), tree = git(root, "rev-parse", "HEAD^{tree}");
  const blobs: Record<string, string> = {};
  for (const file of BOUND_PATHS) {
    const absolute = path.join(root, file);
    if (fs.lstatSync(absolute).isSymbolicLink() || fs.realpathSync(absolute) !== path.resolve(absolute)) {
      throw new Error(`UNSAFE_PATH: ${file}`);
    }
    blobs[file] = git(root, "rev-parse", `HEAD:${file}`);
    if (git(root, "hash-object", `--path=${file}`, "--", file) !== blobs[file]) {
      throw new Error(`UNCOMMITTED_INPUT: ${file} differs from HEAD.`);
    }
  }
  const rawInventory = git(root, "show", `HEAD:${INVENTORY}`);
  const inventory = canonicalInventory(JSON.parse(rawInventory));
  if (inventory.json !== "[]") throw new Error("LEGACY_INVENTORY_UNSUPPORTED: This bootstrap requires an empty inventory.");
  const state = JSON.parse(fs.readFileSync(path.join(root, ".playbook/state.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".playbook/manifest.json"), "utf8"));
  const validator = new SchemaValidator();
  if (!validator.validateState(state).valid || !validator.validateManifest(manifest).valid) throw new Error("SCHEMA_INVALID");
  if (manifest.project_id !== "ai-engineering-playbook" || manifest.playbook.approval_mode !== "solo" ||
      state.current_stage !== 3 || state.stage_status !== "in_progress" ||
      !state.stage_history.some((s: {stage: number; status: string}) => s.stage === 2 && s.status === "approved")) {
    throw new Error("RATIFICATION_INELIGIBLE: Requires this solo project's approved architecture and active implementation stage.");
  }
  assertNoLegacyWaivers(state);
  return {commit, tree, inventorySha256: inventory.sha256, blobs};
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("INVALID_ARGUMENTS: Run from the repository root without flags; no automated confirmation is accepted.");
  assertRatificationTerminal();
  const root = fs.realpathSync(process.cwd());
  if (fs.realpathSync(git(root, "rev-parse", "--show-toplevel")) !== root) throw new Error("ROOT_REQUIRED");
  if (git(root, "status", "--porcelain").length) throw new Error("CLEAN_CHECKPOINT_REQUIRED: Commit reviewed prerequisite work first.");
  if (fs.existsSync(path.join(root, RECORD))) throw new Error("RATIFICATION_EXISTS: Refusing overwrite.");
  const initial = binding(root);
  console.log(`${AMENDMENT}\nDecision: Level A ratification for isolated local single-developer use only.\n` +
    `Commit: ${initial.commit}\nTree: ${initial.tree}\nInventory: []\nInventory SHA-256: ${initial.inventorySha256}\n` +
    "No authenticated identity or Level B authority is established. No exception is waived and no schema is migrated.\n");
  const prompts = readline.createInterface({ input: process.stdin, output: process.stdout });
  let name: string, role: string, phrase: string;
  try {
    name = (await prompts.question("Operator name: ")).trim();
    role = (await prompts.question("Declared authority (Lead Architect): ")).trim();
    phrase = await prompts.question(`Type ${RATIFICATION_PHRASE}: `);
  } finally { prompts.close(); }
  assertRatifier(name, role, phrase);
  assertRatificationTerminal();
  if (git(root, "status", "--porcelain").length || JSON.stringify(binding(root)) !== JSON.stringify(initial)) {
    throw new Error("RATIFICATION_INPUT_CHANGED: Review a clean checkpoint again.");
  }
  const ratifiedAt = new Date().toISOString();
  const content = ratificationRecord({...initial, ratifier: name, role, ratifiedAt});
  const auditPath = `.playbook/logs/ratification-${Date.now()}.json`;
  const tx = new WriteAheadTransactionManager({ targetDir: root });
  const result = await tx.withTransaction("RATIFY_AMENDMENT", [
    {operation: "write", targetPath: RECORD, content, createOnly: true},
    {operation: "write", targetPath: auditPath, createOnly: true,
      content: JSON.stringify({amendment: AMENDMENT, ...initial, ratifier: name, role, ratifiedAt,
        recordSha256: createHash("sha256").update(content).digest("hex"), assurance: "operator-attested Level A"}, null, 2) + "\n"},
  ], async () => {
    assertRatificationTerminal();
    if (JSON.stringify(binding(root)) !== JSON.stringify(initial)) throw new Error("RATIFICATION_INPUT_CHANGED");
  });
  console.log(`Documentary record: ${RECORD}\nAudit: ${auditPath}\nTransaction: ${result.txId}\nCommit these records before continuing affected exception work.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
