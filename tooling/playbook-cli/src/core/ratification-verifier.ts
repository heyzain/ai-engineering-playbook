import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AMENDMENT, RATIFICATION_PHRASE, assertRatifier, canonicalInventory } from "./ratification.js";
const REQUIRED_PATHS = ["docs/adr/amendment-grandfathered-inventory.json",
    "docs/adr/ADR-20261110-001-two-phase-exception-lifecycle.md", "docs/adr/ARCHITECTURE-SPEC.md",
    "docs/adr/ADR-20261117-001-release-closure.md", "docs/architecture/operational-controller/design.md",
    "governance/state-machine.md", "governance/ENGINEERING_CONTROLLER.md", "templates/exception-record-template.md",
    ".playbook/state.json", ".playbook/manifest.json"];
/** Read-only adapter; test doubles never create human approval or change state. */
export interface RatificationGitReader {
    tree(commit: string): string;
    blob(commit: string, relativePath: string): string;
    inventory(commit: string): string;
}
function invalid(message: string): never {
    throw new Error(`RATIFICATION_BINDING_INVALID: ${message}`);
}
/** Validates documentary provenance only. This cannot authenticate the local writer. */
export function validateRatificationBinding(value: unknown, git: RatificationGitReader): {
    commit: string;
    tree: string;
    inventorySha256: string;
    assurance: "Level A";
    remoteWaiverAuthority: false;
} {
    if (!value || typeof value !== "object" || Array.isArray(value))
        invalid("Missing record.");
    const record = value as Record<string, unknown>;
    if (record.amendment_id !== AMENDMENT || record.decision !== "ratified_for_local_use" || record.assurance !== "Level A") {
        invalid("Unsupported amendment, decision or assurance.");
    }
    const commit = record.ratified_commit_sha, tree = record.ratified_tree_sha;
    if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit) || typeof tree !== "string" || !/^[a-f0-9]{40}$/.test(tree)) {
        invalid("Commit/tree must be immutable Git SHA-1 object IDs, not mutable refs.");
    }
    if (typeof record.ratifier !== "string" || typeof record.role !== "string" || record.confirmation !== RATIFICATION_PHRASE) {
        invalid("Missing operator attestation.");
    }
    assertRatifier(record.ratifier, record.role, record.confirmation);
    if (typeof record.ratified_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.ratified_at) ||
        !Number.isFinite(Date.parse(record.ratified_at)) || new Date(record.ratified_at).toISOString() !== record.ratified_at)
        invalid("Invalid UTC ratification time.");
    const blobs = record.specification_blobs;
    if (!blobs || typeof blobs !== "object" || Array.isArray(blobs))
        invalid("Missing specification bindings.");
    const bindings = blobs as Record<string, unknown>;
    if (Object.keys(bindings).length !== REQUIRED_PATHS.length || REQUIRED_PATHS.some(p => typeof bindings[p] !== "string" || !/^[a-f0-9]{40}$/.test(bindings[p] as string))) {
        invalid("Exact required specification bindings are missing or invalid.");
    }
    if (git.tree(commit) !== tree)
        throw new Error("RATIFICATION_TREE_MISMATCH");
    for (const file of REQUIRED_PATHS) {
        if (git.blob(commit, file) !== bindings[file])
            throw new Error(`RATIFICATION_BLOB_MISMATCH: ${file}`);
    }
    const inventory = canonicalInventory(JSON.parse(git.inventory(commit)));
    if (inventory.json !== "[]" || inventory.sha256 !== record.inventory_sha256)
        invalid("Empty inventory digest/scope mismatch.");
    return { commit, tree, inventorySha256: inventory.sha256, assurance: "Level A", remoteWaiverAuthority: false };
}
/** Files/Git are untrusted. Missing objects or malformed records always fail closed. */
export function verifyLocalRatification(targetDir: string) {
    const root = fs.realpathSync(targetDir), filename = path.join(root, "docs/adr/RATIFY-20261110-001.md");
    if (!fs.lstatSync(filename).isFile() || fs.realpathSync(filename) !== filename)
        invalid("Unsafe ratification path.");
    const text = fs.readFileSync(filename, "utf8");
    const blocks = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
    if (blocks.length !== 1)
        invalid("Exactly one JSON binding required.");
    const run = (...args: string[]) => execFileSync("git", args, {
        cwd: root, encoding: "utf8", windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024
    }).trim();
    return validateRatificationBinding(JSON.parse(blocks[0][1]), {
        tree: commit => run("rev-parse", `${commit}^{tree}`),
        blob: (commit, file) => run("rev-parse", `${commit}:${file}`),
        inventory: commit => run("show", `${commit}:${REQUIRED_PATHS[0]}`),
    });
}
