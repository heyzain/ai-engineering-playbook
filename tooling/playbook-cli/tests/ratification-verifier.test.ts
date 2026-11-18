import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRatificationBinding, type RatificationGitReader } from "../src/core/ratification-verifier.js";
import { canonicalInventory, RATIFICATION_PHRASE } from "../src/core/ratification.js";
const commit = "a".repeat(40), tree = "b".repeat(40), blob = "c".repeat(40);
const paths = ["docs/adr/amendment-grandfathered-inventory.json",
    "docs/adr/ADR-20261110-001-two-phase-exception-lifecycle.md", "docs/adr/ARCHITECTURE-SPEC.md",
    "docs/adr/ADR-20261117-001-release-closure.md", "docs/architecture/operational-controller/design.md",
    "governance/state-machine.md", "governance/ENGINEERING_CONTROLLER.md", "templates/exception-record-template.md",
    ".playbook/state.json", ".playbook/manifest.json"];
function fixture() {
    return {
        amendment_id: "AMEND-20261110-001", decision: "ratified_for_local_use", assurance: "Level A",
        ratified_commit_sha: commit, ratified_tree_sha: tree, inventory_sha256: canonicalInventory([]).sha256,
        specification_blobs: Object.fromEntries(paths.map(p => [p, blob])), ratifier: "Example Engineer",
        role: "Lead Architect", ratified_at: "2026-11-17T00:00:00.000Z", confirmation: RATIFICATION_PHRASE
    };
}
const reader: RatificationGitReader = { tree: () => tree, blob: () => blob, inventory: () => "[]" };
test("validates every bound object without asserting authenticated identity", () => {
    const result = validateRatificationBinding(fixture(), reader);
    assert.equal(result.assurance, "Level A");
    assert.equal(result.remoteWaiverAuthority, false);
    assert.equal(result.commit, commit);
});
test("rejects missing, malformed and altered bindings", () => {
    for (const change of [{ amendment_id: "other" }, { decision: "approved" }, { assurance: "Level B" },
        { ratified_commit_sha: "HEAD" }, { ratified_tree_sha: "" }, { inventory_sha256: "0".repeat(64) },
        { ratifier: "Codex" }, { role: "Developer" }, { confirmation: "yes" }, { ratified_at: "invalid" }]) {
        assert.throws(() => validateRatificationBinding({ ...fixture(), ...change }, reader));
    }
    assert.throws(() => validateRatificationBinding(null, reader));
});
test("rejects missing required specifications and unexpected inventory scope", () => {
    const record = fixture();
    delete record.specification_blobs[paths[1]];
    assert.throws(() => validateRatificationBinding(record, reader), /BINDING_INVALID/);
    assert.throws(() => validateRatificationBinding(fixture(), { ...reader, inventory: () => '["EXC-20261117-001"]' }));
});
test("rejects mismatching Git tree, blob and unavailable reference objects", () => {
    assert.throws(() => validateRatificationBinding(fixture(), { ...reader, tree: () => "d".repeat(40) }), /TREE_MISMATCH/);
    assert.throws(() => validateRatificationBinding(fixture(), { ...reader, blob: () => "d".repeat(40) }), /BLOB_MISMATCH/);
    assert.throws(() => validateRatificationBinding(fixture(), { ...reader, tree: () => { throw new Error("missing object"); } }));
});
